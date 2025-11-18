"""Device service: health polling, WebSocket management, and reconciliation."""

from __future__ import annotations

import contextlib
import json
import logging
import os
import threading
import time
from typing import Callable
from urllib.parse import urljoin

from flask import Flask, url_for

import sqlite3
import socket
from uuid import uuid4

from ...database import get_db
from ...hardware import LightStripConfig
from ..datetime_utils import now_iso
from ..json_utils import safe_json_dict, safe_json_list, safe_scene_data
from ..url_utils import build_device_base_url
from .persistence import DevicePersistenceService

LOGGER = logging.getLogger(__name__)


class DeviceService:
    """Encapsulates device health polling, WebSocket management, and reconciliation."""

    def __init__(
        self,
        app: Flask,
        *,
        fetch_remote_json: Callable[[str, float], tuple[dict, float]],
        persistence_service: DevicePersistenceService | None = None,
    ) -> None:
        self.app = app
        self._fetch_remote_json = fetch_remote_json
        self._persistence_service = persistence_service or DevicePersistenceService(app)
        self._thread: threading.Thread | None = None

    def _poll_device_health(self, device_id: str, ip_address: str) -> None:
        timeout = self.app.config.get("HANDSHAKE_TIMEOUT_SECONDS", 5.0)

        port: int | None = None
        if ip_address in ("127.0.0.1", "localhost", "::1") or device_id.startswith("device-local"):
            device_port_env = os.getenv("HOUSE_LIGHTS_DEVICE_PORT")
            if device_port_env:
                try:
                    port = int(device_port_env)
                except ValueError:
                    pass
            if port is None:
                flask_port_env = os.getenv("FLASK_RUN_PORT", "5001")
                try:
                    port = int(flask_port_env)
                except ValueError:
                    port = 5001

        try:
            base_url = build_device_base_url(ip_address, port=port)
        except ValueError:
            LOGGER.warning("Skipping health poll for %s due to invalid IP %s", device_id, ip_address)
            return

        try:
            health_payload, latency_ms = self._fetch_remote_json(
                urljoin(f"{base_url}/", "api/device/health"),
                timeout=timeout,
            )
        except Exception as exc:
            LOGGER.debug("Health poll failed for %s: %s", device_id, exc)
            self.update_device_health_metadata(
                device_id,
                {"lastHealthError": {"at": now_iso(), "error": str(exc)}},
            )
            return

        try:
            meta_payload, _ = self._fetch_remote_json(
                urljoin(f"{base_url}/", "api/device/meta"),
                timeout=timeout,
            )
        except Exception:
            meta_payload = None

        metadata_patch = {
            "lastHealth": {
                "payload": health_payload,
                "latencyMs": latency_ms,
                "polledAt": now_iso(),
            },
        }
        if meta_payload is not None:
            metadata_patch["lastMeta"] = meta_payload

        # Update metadata row
        self.update_device_health_metadata(device_id, metadata_patch)

        # Reconcile strips if metadata available
        # Only update strips for existing devices - do NOT create new devices during health polling
        if meta_payload and isinstance(meta_payload, dict):
            db = get_db(self.app)
            device_row = db.execute(
                """
                SELECT position_x, position_y, device_type, strip_mode, ip_address
                FROM devices
                WHERE id = ?
                """,
                (device_id,),
            ).fetchone()
            # Only reconcile strips if device exists in database
            # Do not call persist_device_graph which would create devices if metadata deviceId differs
            if device_row:
                position_payload = {
                    "x": device_row["position_x"],
                    "y": device_row["position_y"],
                }
                try:
                    # Only update strips if device exists - don't create devices during health polling
                    self._persistence_service.persist_device_graph(
                        device_id=device_id,
                        ip_address=device_row["ip_address"] or ip_address,
                        position=position_payload,
                        device_type=device_row["device_type"],
                        strip_mode=meta_payload.get("stripMode") or device_row["strip_mode"],
                        strips=meta_payload.get("strips"),
                    )
                except Exception:
                    LOGGER.exception("Failed to reconcile strips for device %s during health poll.", device_id)

            clock_skew_ms = None
            remote_unix = health_payload.get("unixTimeMs") if isinstance(health_payload, dict) else None
            if isinstance(remote_unix, (int, float)):
                clock_skew_ms = int(remote_unix) - int(time.time() * 1000)

            db = get_db(self.app)
            db.execute(
                """
                UPDATE device_health
                SET last_latency_ms = ?, clock_skew_ms = COALESCE(?, clock_skew_ms)
                WHERE device_id = ?
                """,
                (
                    int(latency_ms) if latency_ms is not None else None,
                    int(clock_skew_ms) if clock_skew_ms is not None else None,
                    device_id,
                ),
            )
            db.commit()

    def _poll_all_devices_health(self) -> None:
        db = get_db(self.app)
        devices = db.execute(
            "SELECT id, ip_address FROM devices ORDER BY updated_at DESC"
        ).fetchall()
        for device_row in devices:
            device_id = device_row["id"]
            ip_address = device_row["ip_address"]
            if not ip_address:
                continue
            try:
                self._poll_device_health(device_id, ip_address)
            except Exception as exc:
                LOGGER.warning("Health polling error for %s: %s", device_id, exc)

    def start_health_poller(self) -> None:
        if not self.app.config.get("IS_CONTROLLER", True):
            return
        interval = self.app.config.get("HEALTH_POLL_INTERVAL_SECONDS", 60.0)
        if interval <= 0:
            LOGGER.info("Health poller disabled (interval %s).", interval)
            return

        def _poller() -> None:
            with self.app.app_context():
                while True:
                    try:
                        self._poll_all_devices_health()
                    except Exception:
                        LOGGER.exception("Health poller iteration failed.")
                    time.sleep(interval)

        self._thread = threading.Thread(target=_poller, name="health-poller", daemon=True)
        self._thread.start()
        self.app.config["HEALTH_POLL_THREAD"] = self._thread

    def device_identity_payload(self) -> dict[str, object]:
        """Build device identity payload from environment."""
        device_id = os.getenv("HOUSE_LIGHTS_DEVICE_ID") or socket.gethostname()
        hardware_id = os.getenv("HOUSE_LIGHTS_HARDWARE_ID") or device_id
        device_name = os.getenv("HOUSE_LIGHTS_DEVICE_NAME") or device_id
        device_type = os.getenv("HOUSE_LIGHTS_DEVICE_TYPE") or (
            "controller" if self.app.config.get("IS_CONTROLLER") else "follower"
        )
        strip_mode = os.getenv("HOUSE_LIGHTS_DEVICE_STRIP_MODE", "auto")
        firmware_version = os.getenv("HOUSE_LIGHTS_FIRMWARE_VERSION") or os.getenv(
            "HOUSE_LIGHTS_VERSION"
        )
        capabilities = safe_json_dict(os.getenv("HOUSE_LIGHTS_DEVICE_CAPABILITIES"))
        return {
            "deviceId": device_id,
            "deviceName": device_name,
            "hardwareId": hardware_id,
            "deviceType": device_type,
            "stripMode": strip_mode,
            "firmwareVersion": firmware_version,
            "capabilities": capabilities,
            "isController": self.app.config.get("IS_CONTROLLER"),
        }

    def load_auto_strip_snapshot(
        self, db: sqlite3.Connection, device_id: str
    ) -> list[dict[str, object]] | None:
        """Load strip snapshot from health or handshake data."""
        health_row = db.execute(
            "SELECT metadata FROM device_health WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        if health_row:
            metadata = safe_json_dict(health_row["metadata"])
            last_meta = metadata.get("lastMeta")
            if isinstance(last_meta, dict):
                strips_payload = last_meta.get("strips")
                if isinstance(strips_payload, list) and strips_payload:
                    return strips_payload

        handshake_row = db.execute(
            """
            SELECT strip_summary
            FROM device_handshakes
            WHERE device_id = ? AND status = 'success'
            ORDER BY responded_at DESC
            LIMIT 1
            """,
            (device_id,),
        ).fetchone()
        if handshake_row:
            strips_payload = safe_json_list(handshake_row["strip_summary"])
            if strips_payload:
                return strips_payload  # type: ignore[return-value]

        return None

    def update_device_health_metadata(
        self,
        device_id: str,
        metadata_patch: dict[str, object] | None = None,
        *,
        ws_connected: bool | None = None,
    ) -> None:
        """Update device health metadata in the database."""
        try:
            db = get_db(self.app)
        except RuntimeError:
            return

        row = db.execute(
            "SELECT metadata FROM device_health WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        merged = safe_json_dict(row["metadata"]) if row else {}
        if metadata_patch:
            merged.update(metadata_patch)

        ws_value = None
        if ws_connected is True:
            ws_value = 1
        elif ws_connected is False:
            ws_value = 0

        if row:
            db.execute(
                """
                UPDATE device_health
                SET last_seen_at = CURRENT_TIMESTAMP,
                    last_heartbeat_at = CURRENT_TIMESTAMP,
                    ws_connected = COALESCE(?, ws_connected),
                    metadata = ?
                WHERE device_id = ?
                """,
                (ws_value, json.dumps(merged), device_id),
            )
        else:
            db.execute(
                """
                INSERT INTO device_health (
                    device_id,
                    last_seen_at,
                    last_heartbeat_at,
                    last_latency_ms,
                    clock_skew_ms,
                    ws_connected,
                    playlist_hash,
                    metadata
                ) VALUES (
                    ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, ?, NULL, ?
                )
                """,
                (device_id, ws_value if ws_value is not None else 1, json.dumps(merged)),
            )
        db.commit()

    def _controller_clock_payload(self) -> dict[str, object]:
        """Generate controller clock payload for WebSocket commands."""
        return {"iso": now_iso(), "unixTimeMs": int(time.time() * 1000)}

    def register_ws_client(
        self, device_id: str, ws_conn, handshake_payload: dict[str, object]
    ) -> None:
        """Register a WebSocket client connection."""
        with self.app.config["WS_CLIENT_LOCK"]:
            self.app.config["WS_CLIENTS"][device_id] = {
                "socket": ws_conn,
                "handshake": handshake_payload,
                "connected_at": now_iso(),
            }
        metadata_patch = {
            "handshake": handshake_payload,
            "wsConnectedAt": now_iso(),
        }
        self.update_device_health_metadata(device_id, metadata_patch, ws_connected=True)

    def unregister_ws_client(self, device_id: str, *, close_socket: bool = False) -> None:
        """Unregister a WebSocket client connection."""
        with self.app.config["WS_CLIENT_LOCK"]:
            entry = self.app.config["WS_CLIENTS"].pop(device_id, None)
        ws_conn = entry.get("socket") if entry else None
        self.update_device_health_metadata(
            device_id, {"wsDisconnectedAt": now_iso()}, ws_connected=False
        )
        if close_socket and ws_conn is not None:
            with contextlib.suppress(Exception):
                ws_conn.close()

    def send_ws_command(
        self,
        *,
        command: str,
        payload: dict[str, object],
        device_ids: list[str] | None = None,
    ) -> dict[str, bool]:
        """Send a WebSocket command to one or more devices."""
        with self.app.config["WS_CLIENT_LOCK"]:
            if device_ids is None:
                targets = self.app.config["WS_CLIENTS"].copy()
            else:
                targets = {
                    device_id: self.app.config["WS_CLIENTS"].get(device_id)
                    for device_id in device_ids
                    if self.app.config["WS_CLIENTS"].get(device_id)
                }

        message = json.dumps(
            {
                "type": "command",
                "command": command,
                "payload": payload,
                "controllerClock": self._controller_clock_payload(),
            }
        )

        results: dict[str, bool] = {}
        for device_id, entry in targets.items():
            if not entry:
                results[device_id] = False
                continue
            socket_obj = entry.get("socket")
            try:
                socket_obj.send(message)
                results[device_id] = True
            except Exception:
                LOGGER.warning("Failed to send WS command to %s; dropping connection.", device_id)
                results[device_id] = False
                self.unregister_ws_client(device_id, close_socket=True)
        return results

    def notify_playlist_ready(
        self,
        device_id: str,
        *,
        playlist_id: str,
        playlist_hash: str,
        entry_count: int,
    ) -> str:
        """Notify a device that a playlist is ready for download."""
        try:
            download_url = url_for("download_device_playlist", device_id=device_id, _external=True)
        except RuntimeError:
            download_url = f"/api/v2/devices/{device_id}/playlist/download"
        command_payload = {
            "playlistId": playlist_id,
            "playlistHash": playlist_hash,
            "entryCount": entry_count,
            "downloadUrl": download_url,
        }
        self.send_ws_command(
            command="playlist_ready",
            payload=command_payload,
            device_ids=[device_id],
        )
        return download_url

    def build_device_playlists_from_scene_playlist(
        self, target_device_ids: list[str] | None = None
    ) -> dict[str, str]:
        """
        Build device playlists from scene playlist entries.
        Creates a snapshot copy of all keyframes for each scene at the time of building.
        Returns dict mapping device_id to playlist_hash.
        """
        from ..playlists.service import PlaylistService
        from ..keyframes.service import KeyframeService
        
        db = get_db(self.app)
        playlist_service = PlaylistService(self.app)
        keyframe_service = KeyframeService(self.app)
        
        # Get all scene playlist entries ordered by position
        playlist_entries = playlist_service.get_playlist()
        if not playlist_entries:
            LOGGER.debug("No scene playlist entries found, skipping playlist build")
            return {}
        
        # Get target device IDs
        if target_device_ids is None:
            device_rows = db.execute("SELECT id FROM devices").fetchall()
            device_ids = [row["id"] for row in device_rows]
        else:
            device_ids = target_device_ids
        
        if not device_ids:
            LOGGER.debug("No devices found, skipping playlist build")
            return {}
        
        # Build playlist payload with complete scene data (snapshot)
        playlist_payload_entries = []
        for entry in playlist_entries:
            scene_id = entry.get("sceneId")
            if not isinstance(scene_id, str):
                LOGGER.warning("Invalid sceneId in playlist entry: %s", entry)
                continue
            
            # Load all keyframes for this scene (snapshot at build time)
            keyframes = keyframe_service.list_keyframes(scene_id)
            
            playlist_entry = {
                "id": entry.get("id"),
                "sceneId": scene_id,
                "position": entry.get("position"),
                "playDurationSeconds": entry.get("playDurationSeconds"),
                "fadeDurationSeconds": entry.get("fadeDurationSeconds"),
                "keyframes": keyframes,  # Complete snapshot copy
            }
            playlist_payload_entries.append(playlist_entry)
        
        # Build complete playlist payload
        playlist_payload = {
            "entries": playlist_payload_entries,
            "metadata": {},
            "schedule": {},
        }
        
        # Compute playlist hash
        playlist_hash = playlist_service.compute_playlist_hash(playlist_payload)
        
        # Store playlist for each device
        playlist_hashes: dict[str, str] = {}
        playlist_id = f"playlist-{uuid4().hex}"
        
        for device_id in device_ids:
            # Delete existing playlist for this device
            db.execute("DELETE FROM device_playlists WHERE device_id = ?", (device_id,))
            
            # Insert new playlist
            db.execute(
                """
                INSERT INTO device_playlists (id, device_id, playlist_hash, payload, expires_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (playlist_id, device_id, playlist_hash, json.dumps(playlist_payload), None),
            )
            
            # Update device_health with playlist_hash
            db.execute(
                "UPDATE device_health SET playlist_hash = ? WHERE device_id = ?",
                (playlist_hash, device_id),
            )
            
            playlist_hashes[device_id] = playlist_hash
        
        db.commit()
        
        LOGGER.info(
            "Built device playlists - devices=%d, entries=%d, hash=%s",
            len(device_ids),
            len(playlist_payload_entries),
            playlist_hash,
        )
        
        return playlist_hashes

    def maybe_dispatch_playlists(self, target_device_ids: list[str] | None = None) -> None:
        """Send playlist-ready commands when in scheduled mode."""
        if self.app.config.get("LIVE_MODE_ENABLED"):
            LOGGER.debug("Live mode enabled; skipping playlist dispatch.")
            return
        light_state = self.app.config.get("LIGHT_STATE", {})
        if not light_state.get("is_on"):
            LOGGER.debug("Lights are off; skipping playlist dispatch.")
            return

        # Build playlists from scene playlist entries first
        playlist_hashes = self.build_device_playlists_from_scene_playlist(target_device_ids)
        if not playlist_hashes:
            LOGGER.debug("No playlists built, skipping dispatch")
            return

        db = get_db(self.app)
        if target_device_ids is None:
            device_rows = db.execute("SELECT id FROM devices").fetchall()
            device_ids = [row["id"] for row in device_rows]
        else:
            device_ids = target_device_ids

        for device_id in device_ids:
            row = db.execute(
                """
                SELECT id, playlist_hash, payload
                FROM device_playlists
                WHERE device_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (device_id,),
            ).fetchone()
            if not row:
                continue
            playlist_payload = safe_scene_data(row["payload"])
            entries = playlist_payload.get("entries")
            if not isinstance(entries, list):
                entries = []
            self.notify_playlist_ready(
                device_id,
                playlist_id=row["id"],
                playlist_hash=row["playlist_hash"],
                entry_count=len(entries),
            )


__all__ = ["DeviceService"]



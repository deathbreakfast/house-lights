"""Flask Blueprint for device routes."""

from __future__ import annotations

import json
import os
import time
from uuid import uuid4
from urllib.parse import urljoin

from flask import Blueprint, abort, jsonify, request, url_for, current_app
from requests import RequestException

from .management_service import DeviceManagementService
from .persistence import DevicePersistenceService
from .repository import DeviceRepository
from ...database import get_db
from ...hardware import LightStripConfig
from ..config import (
    MAX_SIMULATED_STRIPS,
    MAX_LED_COUNT_PER_STRIP,
    SIMULATOR_PIN_POOL,
    STUDIO_BACKGROUND_SCENE_ID,
)
from ..datetime_utils import now_iso
from ..json_utils import safe_json_dict, safe_scene_data
from ..logging_utils import log_device_debug
from ..network_utils import resolve_device_ip
from ..url_utils import build_device_base_url

def _get_device_service(app):
    """Get DeviceService from app config."""
    return app.config.get("DEVICE_SERVICE")

def _send_ws_command(app, *, command: str, payload: dict, device_ids: list[str] | None = None):
    """Send WebSocket command (delegates to DeviceService)."""
    device_service = _get_device_service(app)
    if device_service:
        return device_service.send_ws_command(
            command=command, payload=payload, device_ids=device_ids
        )
    return {}

def _compute_playlist_hash(payload: dict) -> str:
    """Compute hash for playlist payload."""
    import hashlib
    payload_str = json.dumps(payload, sort_keys=True)
    return hashlib.sha256(payload_str.encode()).hexdigest()[:16]

def _update_device_health_metadata(app, device_id: str, metadata_patch: dict[str, object] | None = None):
    """Update device health metadata."""
    device_service = _get_device_service(app)
    if device_service:
        device_service.update_device_health_metadata(device_id, metadata_patch)

def _maybe_dispatch_playlists(app, target_device_ids: list[str] | None = None):
    """Dispatch playlists (delegates to DeviceService)."""
    device_service = _get_device_service(app)
    if device_service:
        device_service.maybe_dispatch_playlists(target_device_ids)

def _device_identity_payload(app) -> dict[str, object]:
    """Get device identity payload."""
    device_service = _get_device_service(app)
    if device_service:
        return device_service._controller_identity_payload()
    return {
        "deviceId": app.config.get("LOCAL_DEVICE_ID", "controller-local"),
    }

def _active_strip_configs(app) -> list[LightStripConfig]:
    """Get active strip configurations."""
    return app.config.get("STRIP_CONFIGS", [])

def _simulator_enabled(app) -> bool:
    """Check if simulator is enabled."""
    return not app.config.get("STRIP_CONFIGS", [])

def _fetch_remote_json(app, url: str, timeout: float = 5.0):
    """Fetch remote JSON."""
    import requests
    try:
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
        payload = response.json()
        latency_ms = response.elapsed.total_seconds() * 1000
        return payload, latency_ms
    except requests.RequestException as exc:
        raise ValueError(f"Failed to fetch {url}: {exc}") from exc

def _ensure_scene_exists(app, scene_id: str):
    """Ensure scene exists."""
    from ..scenes.service import SceneService
    scene_service = SceneService(app)
    scene_service.ensure_scene_exists(scene_id)

def create_device_blueprint(app) -> Blueprint:
    """Create and configure the device blueprint."""
    bp = Blueprint("devices", __name__, url_prefix="/api/v2/devices")
    
    # Store app reference for use in route handlers
    bp.app = app
    management_service = DeviceManagementService(app)
    persistence_service = DevicePersistenceService(app)
    repository = DeviceRepository(app)

    @bp.get("")
    def get_all_devices():
        """Get all devices (global scope)."""
        import sqlite3
        db = get_db(app)
        
        devices = repository.get_all_devices()
        device_ids = [device_row["id"] for device_row in devices]
        health_map: dict[str, sqlite3.Row] = {}
        if device_ids:
            placeholders = ",".join("?" for _ in device_ids)
            health_rows = db.execute(
                f"""
                SELECT device_id, last_seen_at, last_latency_ms, clock_skew_ms,
                       ws_connected, playlist_hash, metadata
                FROM device_health
                WHERE device_id IN ({placeholders})
                """,
                device_ids,
            ).fetchall()
            health_map = {row["device_id"]: row for row in health_rows}
        
        result = []
        for device_row in devices:
            device_id = device_row["id"]
            # Get strips for this device
            strips = repository.get_device_strips(device_id)
            
            strips_with_leds = []
            for strip in strips:
                leds = repository.get_strip_leds(strip["id"])
                
                strips_with_leds.append({
                    "id": strip["id"],
                    "gpioPin": strip["gpio_pin"],
                    "ledCount": strip["led_count"],
                    "leds": [
                        {
                            "id": led["id"],
                            "position": {"x": led["position_x"], "y": led["position_y"]},
                            "color": led["color"],
                            "opacity": led["opacity"],
                        }
                        for led in leds
                    ],
                })
            
            health_row = health_map.get(device_id)
            health_metadata = None
            if health_row and health_row["metadata"]:
                try:
                    health_metadata = json.loads(health_row["metadata"])
                except Exception:
                    pass
            
            device_data = {
                "id": device_id,
                "position": {
                    "x": device_row["position_x"],
                    "y": device_row["position_y"],
                },
                "ipAddress": device_row["ip_address"],
                "type": device_row["device_type"],
                "stripMode": device_row["strip_mode"],
                "strips": strips_with_leds,
            }
            
            if health_metadata:
                device_data["connectionState"] = health_metadata.get("connectionState", "idle")
                device_data["connectionError"] = health_metadata.get("connectionError")
                if "lastHealth" in health_metadata:
                    device_data["health"] = health_metadata["lastHealth"]
            
            result.append(device_data)
        
        return jsonify(result)

    @bp.post("")
    def create_device():
        """Create a new device (global scope)."""
        from uuid import uuid4
        data = request.get_json()
        if not data:
            abort(400, description="Device data required")
        
        device_id = data.get("id") or f"device-{uuid4().hex}"
        position = data.get("position", {"x": 400, "y": 300})
        ip_address = data.get("ipAddress", "192.168.1.100")
        device_type = data.get("type", "wifi")
        strip_mode = data.get("stripMode", "auto")
        strips = data.get("strips", [])
        
        log_device_debug(
            app,
            "Create device request",
            device_id=device_id,
            device_type=device_type,
            strip_mode=strip_mode,
            strip_count=len(strips),
        )
        
        db = get_db(app)
        persisted_id = persistence_service.persist_device_graph(
            device_id=device_id,
            ip_address=ip_address,
            position=position,
            device_type=device_type,
            strip_mode=strip_mode,
            strips=strips,
        )
        db.commit()
        
        log_device_debug(
            app,
            "Device created successfully",
            device_id=persisted_id,
        )
        
        return jsonify({"id": persisted_id}), 201

    @bp.get("/meta")
    @bp.get("/api/device/meta")
    def get_device_meta_info():
        """Expose local device metadata for controller handshakes."""
        identity = _device_identity_payload(app)
        strips = _active_strip_configs(app)
        from_simulator = _simulator_enabled(app)
        strip_payloads = [
            {
                "id": f"{identity['deviceId']}-{config.pin}",
                "gpioPin": config.pin,
                "pin": config.pin,
                "ledCount": config.led_count,
                "name": config.name,
                "simulated": from_simulator,
            }
            for config in strips
        ]
        ip_address = resolve_device_ip()
        payload = {
            **identity,
            "ipAddress": ip_address,
            "controllerHost": os.getenv("HOUSE_LIGHTS_CONTROLLER_HOST"),
            "timestamp": now_iso(),
            "unixTimeMs": int(time.time() * 1000),
            "strips": strip_payloads,
            "limits": {
                "max_strips": MAX_SIMULATED_STRIPS,
                "max_leds_per_strip": MAX_LED_COUNT_PER_STRIP,
            },
        }
        return jsonify(payload)

    @bp.get("/health")
    @bp.get("/api/device/health")
    def get_device_health():
        """Expose lightweight health data for polling."""
        identity = _device_identity_payload(app)
        uptime_seconds = int(max(0, time.time() - app.config.get("APP_START_TIME", time.time())))
        light_state = app.config.get("LIGHT_STATE", {})
        payload = {
            "deviceId": identity["deviceId"],
            "status": "ok",
            "powerOn": bool(light_state.get("is_on")),
            "liveMode": bool(app.config.get("LIVE_MODE_ENABLED", False)),
            "uptimeSeconds": uptime_seconds,
            "timestamp": now_iso(),
            "unixTimeMs": int(time.time() * 1000),
        }
        return jsonify(payload)

    @bp.post("/handshake")
    def initiate_device_handshake():
        """Connect to a remote device and persist its metadata."""
        data = request.get_json(silent=True) or {}

        ip_address = data.get("ipAddress") or data.get("address")
        if not isinstance(ip_address, str) or not ip_address.strip():
            abort(400, description="ipAddress is required.")
        ip_address = ip_address.strip()

        base_url = data.get("baseUrl")
        protocol = data.get("protocol")
        port = data.get("port")
        port_value: int | None = None
        if port is not None:
            try:
                port_value = int(port)
            except (TypeError, ValueError):
                abort(400, description="port must be numeric when provided.")

        if base_url:
            base_url = base_url.rstrip("/")
        else:
            try:
                base_url = build_device_base_url(ip_address, protocol=protocol, port=port_value)
            except ValueError as exc:
                abort(400, description=str(exc))

        timeout = app.config.get("HANDSHAKE_TIMEOUT_SECONDS", 5.0)
        handshake_id = f"hs-{uuid4().hex}"
        controller_unix_ms = int(time.time() * 1000)
        controller_iso = now_iso()

        metadata_payload: dict[str, object] | None = None
        health_payload: dict[str, object] | None = None
        latency_ms: float | None = None
        clock_skew_ms: int | None = None
        error_message: str | None = None

        meta_url = urljoin(f"{base_url}/", "api/device/meta")
        health_url = urljoin(f"{base_url}/", "api/device/health")

        try:
            metadata_payload, latency_ms = _fetch_remote_json(app, meta_url, timeout=timeout)
            remote_unix = metadata_payload.get("unixTimeMs")
            if isinstance(remote_unix, (int, float)):
                clock_skew_ms = int(remote_unix) - controller_unix_ms
            try:
                health_payload, _ = _fetch_remote_json(app, health_url, timeout=timeout)
            except Exception as health_exc:
                import logging
                logging.getLogger(__name__).debug("Device health fetch failed for %s: %s", base_url, health_exc)
        except (RequestException, ValueError) as exc:
            import logging
            logging.getLogger(__name__).warning("Handshake failed for %s: %s", base_url, exc)
            error_message = str(exc)

        db = get_db(app)

        persisted_id: str | None = None
        device_payload = metadata_payload or {}
        strips_payload = device_payload.get("strips")
        if not isinstance(strips_payload, list):
            strips_payload = []

        if error_message is None:
            device_id = (
                device_payload.get("deviceId")
                if isinstance(device_payload.get("deviceId"), str)
                else data.get("deviceId")
            )
            if not isinstance(device_id, str) or not device_id.strip():
                device_id = f"device-{uuid4().hex}"

            persisted_id = persistence_service.persist_device_graph(
                device_id=device_id,
                ip_address=ip_address,
                position=data.get("position"),
                device_type=device_payload.get("deviceType", "follower"),
                strip_mode=device_payload.get("stripMode", "auto"),
                strips=strips_payload,
            )
            db.commit()

        capabilities_blob = (
            device_payload.get("capabilities") if isinstance(device_payload, dict) else {}
        )
        if not isinstance(capabilities_blob, dict):
            capabilities_blob = {}
        playlist_hash = None
        if isinstance(device_payload, dict):
            playlist_hash = device_payload.get("playlistHash")
        if not playlist_hash and isinstance(health_payload, dict):
            playlist_hash = health_payload.get("playlistHash")

        metadata_blob = {
            "meta": metadata_payload,
            "health": health_payload,
        }

        db.execute(
            """
            INSERT INTO device_handshakes (
                id, device_id, ip_address, hardware_id, firmware_version,
                capabilities, strip_summary, status, clock_skew_ms, responded_at, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
            """,
            (
                handshake_id,
                persisted_id,
                ip_address,
                device_payload.get("hardwareId") if isinstance(device_payload, dict) else None,
                device_payload.get("firmwareVersion") if isinstance(device_payload, dict) else None,
                json.dumps(capabilities_blob or {}),
                json.dumps(strips_payload or []),
                "success" if error_message is None else "failed",
                clock_skew_ms,
                error_message,
            ),
        )

        if error_message is None and persisted_id:
            db.execute(
                """
                INSERT INTO device_health (
                    device_id, last_seen_at, last_heartbeat_at, last_latency_ms,
                    clock_skew_ms, ws_connected, playlist_hash, metadata
                ) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 0, ?, ?)
                ON CONFLICT(device_id) DO UPDATE SET
                    last_seen_at = CURRENT_TIMESTAMP,
                    last_heartbeat_at = CURRENT_TIMESTAMP,
                    last_latency_ms = excluded.last_latency_ms,
                    clock_skew_ms = excluded.clock_skew_ms,
                    playlist_hash = excluded.playlist_hash,
                    metadata = excluded.metadata
                """,
                (
                    persisted_id,
                    int(latency_ms) if latency_ms is not None else None,
                    clock_skew_ms,
                    playlist_hash,
                    json.dumps(metadata_blob),
                ),
            )

        db.commit()

        return jsonify(
            {
                "deviceId": persisted_id,
                "handshakeId": handshake_id,
                "status": "success" if error_message is None else "failed",
                "error": error_message,
            }
        ), 201 if persisted_id else 500

    @bp.get("/<device_id>/status")
    def get_device_status(device_id: str):
        """Return last known status for a device."""
        try:
            status = management_service.get_device_status(device_id)
            return jsonify(status)
        except ValueError as e:
            abort(404, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to retrieve device status: {str(e)}")

    @bp.post("/<device_id>/commands")
    def send_device_command(device_id: str):
        """Send a realtime command to a device via WebSocket."""
        request_payload = request.get_json(silent=True) or {}
        command = request_payload.get("command")
        if not isinstance(command, str) or not command.strip():
            abort(400, description="command is required.")
        command_payload = request_payload.get("payload")
        if command_payload is None:
            command_payload = {}
        if not isinstance(command_payload, dict):
            abort(400, description="payload must be an object.")

        results = _send_ws_command(
            app,
            command=command.strip(),
            payload=command_payload,
            device_ids=[device_id],
        )
        success = results.get(device_id, False)
        status_code = 202 if success else 503
        return (
            jsonify(
                {
                    "deviceId": device_id,
                    "command": command,
                    "via": "websocket",
                    "sent": success,
                }
            ),
            status_code,
        )

    @bp.post("/<device_id>/playlist")
    def upload_device_playlist(device_id: str):
        """Store a device-specific playlist and notify the device."""
        payload = request.get_json(silent=True) or {}
        entries = payload.get("entries")
        if not isinstance(entries, list) or not entries:
            abort(400, description="entries array is required.")
        metadata = payload.get("metadata")
        if metadata is not None and not isinstance(metadata, dict):
            abort(400, description="metadata must be an object if provided.")
        schedule = payload.get("schedule")
        if schedule is not None and not isinstance(schedule, dict):
            abort(400, description="schedule must be an object if provided.")

        playlist_id = payload.get("id")
        if not isinstance(playlist_id, str) or not playlist_id.strip():
            playlist_id = f"playlist-{uuid4().hex}"
        playlist_payload = {
            "entries": entries,
            "metadata": metadata or {},
            "schedule": schedule or {},
        }
        playlist_hash = payload.get("playlistHash")
        if not isinstance(playlist_hash, str) or not playlist_hash:
            playlist_hash = _compute_playlist_hash(playlist_payload)
        expires_at = payload.get("expiresAt")

        db = get_db(app)
        db.execute("DELETE FROM device_playlists WHERE device_id = ?", (device_id,))
        db.execute(
            """
            INSERT INTO device_playlists (id, device_id, playlist_hash, payload, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (playlist_id, device_id, playlist_hash, json.dumps(playlist_payload), expires_at),
        )
        result = db.execute(
            "UPDATE device_health SET playlist_hash = ? WHERE device_id = ?",
            (playlist_hash, device_id),
        )
        if result.rowcount == 0:
            db.execute(
                """
                INSERT INTO device_health (
                    device_id, last_seen_at, last_heartbeat_at, last_latency_ms,
                    clock_skew_ms, ws_connected, playlist_hash, metadata
                ) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 0, ?, ?)
                """,
                (device_id, playlist_hash, json.dumps({"playlistHash": playlist_hash})),
            )
        db.commit()

        _update_device_health_metadata(
            app,
            device_id,
            {"lastPlaylistUpload": now_iso(), "playlistHash": playlist_hash},
        )

        _maybe_dispatch_playlists(app, [device_id])
        download_url = url_for("devices.download_device_playlist", device_id=device_id, _external=True)

        return jsonify(
            {
                "id": playlist_id,
                "playlistHash": playlist_hash,
                "entries": len(entries),
                "downloadUrl": download_url,
            }
        ), 201

    @bp.get("/<device_id>/playlist")
    def get_device_playlist(device_id: str):
        """Return the latest stored playlist for UI inspection."""
        db = get_db(app)
        row = db.execute(
            """
            SELECT id, playlist_hash, payload, created_at, downloaded_at
            FROM device_playlists
            WHERE device_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (device_id,),
        ).fetchone()
        if not row:
            abort(404, description="No playlist stored for this device.")
        playlist_payload = safe_scene_data(row["payload"])
        playlist_payload.update(
            {
                "id": row["id"],
                "playlistHash": row["playlist_hash"],
                "createdAt": row["created_at"],
                "downloadedAt": row["downloaded_at"],
            }
        )
        return jsonify(playlist_payload)

    @bp.get("/<device_id>/playlist/download")
    def download_device_playlist(device_id: str):
        """Allow devices to fetch and clear their pending playlist."""
        db = get_db(app)
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
            abort(404, description="No playlist available for download.")
        
        playlist_payload = safe_scene_data(row["payload"])
        playlist_payload["id"] = row["id"]
        playlist_payload["playlistHash"] = row["playlist_hash"]
        
        db.execute(
            "UPDATE device_playlists SET downloaded_at = CURRENT_TIMESTAMP WHERE id = ?",
            (row["id"],),
        )
        db.commit()
        
        return jsonify(playlist_payload)

    @bp.patch("/<device_id>")
    def update_device(device_id: str):
        """Update a device's properties."""
        data = request.get_json()
        if not data:
            abort(400, description="Device data required")
        
        log_device_debug(
            app,
            "Update device request",
            device_id=device_id,
            payload=data,
        )
        
        try:
            updated = management_service.update_device(
                device_id,
                position=data.get("position"),
                ip_address=data.get("ipAddress"),
                device_type=data.get("type"),
                strip_mode=data.get("stripMode"),
                strips=data.get("strips"),
            )
            log_device_debug(
                app,
                "Device updated successfully",
                device_id=device_id,
                updated_fields=list(data.keys()),
            )
            return jsonify(updated)
        except ValueError as e:
            log_device_debug(
                app,
                "Device update failed - not found",
                device_id=device_id,
                error=str(e),
            )
            abort(404, description=str(e))
        except Exception as e:
            log_device_debug(
                app,
                "Device update failed - server error",
                device_id=device_id,
                error=str(e),
            )
            abort(500, description=f"Failed to update device: {str(e)}")

    @bp.patch("/<device_id>/leds")
    def bulk_update_device_leds(device_id: str):
        """Bulk update LED colors/opacities for a device."""
        data = request.get_json() or {}
        leds = data.get("leds")
        if not isinstance(leds, list) or not leds:
            abort(400, description="leds array is required.")
        
        try:
            updates = management_service.bulk_update_leds(device_id, leds)
            return jsonify({"updated": updates})
        except Exception as e:
            abort(500, description=f"Failed to update LEDs: {str(e)}")

    @bp.delete("/<device_id>")
    def delete_device(device_id: str):
        """Delete a device."""
        try:
            if management_service.delete_device(device_id):
                return jsonify({"id": device_id}), 200
            else:
                abort(404, description="Device not found")
        except Exception as e:
            abort(500, description=f"Failed to delete device: {str(e)}")

    @bp.post("/playback")
    def control_device_playback():
        """Play or pause playlists across devices."""
        payload = request.get_json(silent=True) or {}
        action = payload.get("action")
        if action not in {"play", "pause"}:
            abort(400, description="action must be 'play' or 'pause'.")
        
        device_ids = payload.get("deviceIds")
        if device_ids is not None and not isinstance(device_ids, list):
            abort(400, description="deviceIds must be an array if provided.")
        
        results = _send_ws_command(
            app,
            command=action,
            payload={},
            device_ids=device_ids,
        )
        
        return jsonify(
            {
                "action": action,
                "deviceIds": device_ids,
                "results": results,
            }
        )

    return bp


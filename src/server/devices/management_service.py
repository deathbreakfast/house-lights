"""Service for device management business logic."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask

from .repository import DeviceRepository
from .persistence import DevicePersistenceService
from ..json_utils import safe_json_dict, safe_json_list

class DeviceManagementService:
    """Service for device management business logic."""

    def __init__(self, app: Flask) -> None:
        self.app = app
        self.repository = DeviceRepository(app)
        self.persistence_service = DevicePersistenceService(app)

    def _log_device_debug(self, message: str, **kwargs) -> None:
        """Log device debug information."""
        from ..logging_utils import log_device_debug
        log_device_debug(self.app, message, **kwargs)

    def _parse_db_timestamp(self, timestamp_str: str | None) -> datetime | None:
        """Parse database timestamp string."""
        if not timestamp_str:
            return None
        try:
            return datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return None

    def get_device_status(self, device_id: str) -> dict[str, object]:
        """Get comprehensive device status."""
        device_row = self.repository.get_device(device_id)
        if not device_row:
            raise ValueError("Device not found")

        health_row = self.repository.get_device_health(device_id)
        handshake_row = self.repository.get_device_handshake(device_id)

        metadata_blob = safe_json_dict(health_row["metadata"]) if health_row else {}
        last_seen_at = health_row["last_seen_at"] if health_row else None
        parsed_seen = self._parse_db_timestamp(last_seen_at)
        online = False
        if parsed_seen:
            age = (
                datetime.now(timezone.utc) - parsed_seen
            ).total_seconds()
            online = age <= self.app.config.get("DEVICE_HEALTH_MAX_AGE_SECONDS", 45)

        handshake_payload = None
        if handshake_row:
            handshake_payload = {
                "id": handshake_row["id"],
                "status": handshake_row["status"],
                "clockSkewMs": handshake_row["clock_skew_ms"],
                "respondedAt": handshake_row["responded_at"],
                "hardwareId": handshake_row["hardware_id"],
                "firmwareVersion": handshake_row["firmware_version"],
                "capabilities": safe_json_dict(handshake_row["capabilities"]),
                "strips": safe_json_list(handshake_row["strip_summary"]),
                "error": handshake_row["error"],
            }

        return {
            "deviceId": device_id,
            "sceneId": device_row["scene_id"],
            "ipAddress": device_row["ip_address"],
            "deviceType": device_row["device_type"],
            "stripMode": device_row["strip_mode"],
            "online": online,
            "lastSeenAt": last_seen_at,
            "lastLatencyMs": health_row["last_latency_ms"] if health_row else None,
            "clockSkewMs": health_row["clock_skew_ms"] if health_row else None,
            "wsConnected": bool(health_row["ws_connected"]) if health_row else False,
            "playlistHash": health_row["playlist_hash"] if health_row else None,
            "metadata": metadata_blob,
            "handshake": handshake_payload,
        }

    def get_all_devices(self) -> list[dict[str, object]]:
        """Get all devices (global scope) with full details."""
        # Seed local device if needed
        self.persistence_service.seed_local_device()
        
        devices = self.repository.get_all_devices()
        device_ids = [row["id"] for row in devices]
        health_map = self.repository.get_devices_health_batch(device_ids)

        result = []
        for device_row in devices:
            device_id = device_row["id"]
            strips = self.repository.get_device_strips(device_id)
            
            strips_with_leds = []
            for strip in strips:
                strip_id = strip["id"]
                leds = self.repository.get_strip_leds(strip_id)
                
                strips_with_leds.append({
                    "id": strip_id,
                    "gpioPin": strip["gpio_pin"],
                    "ledCount": strip["led_count"],
                    "leds": [
                        {
                            "id": led["id"],
                            "position": {
                                "x": led["position_x"],
                                "y": led["position_y"],
                            },
                            "color": led["color"],
                            "opacity": led["opacity"],
                        }
                        for led in leds
                    ],
                })

            # Ensure local device strips if needed (identified by IP address)
            ip_address = device_row["ip_address"]
            is_local_device = ip_address in ("127.0.0.1", "localhost", "::1")
            if (
                not strips_with_leds
                and is_local_device
                and self.app.config.get("IS_CONTROLLER", True)
                and (device_row["strip_mode"] or "auto").lower() == "auto"
            ):
                from ...hardware import LightStripConfig
                env_configs: list[LightStripConfig] = self.app.config.get("STRIP_CONFIGS", [])
                if env_configs:
                    strips_with_leds = self.persistence_service.ensure_local_device_strips(
                        device_id=device_id,
                        strip_configs=env_configs,
                    )

            health_row = health_map.get(device_id)
            health_payload = None
            if health_row:
                metadata = safe_json_dict(health_row["metadata"])
                last_seen_at = health_row["last_seen_at"]
                parsed_seen = self._parse_db_timestamp(last_seen_at)
                is_online = False
                if parsed_seen:
                    age = (datetime.now(timezone.utc) - parsed_seen).total_seconds()
                    is_online = age <= self.app.config.get("DEVICE_HEALTH_MAX_AGE_SECONDS", 45)
                health_payload = {
                    "online": is_online,
                    "lastSeenAt": last_seen_at,
                    "latencyMs": health_row["last_latency_ms"],
                    "clockSkewMs": health_row["clock_skew_ms"],
                    "wsConnected": bool(health_row["ws_connected"]),
                    "playlistHash": health_row["playlist_hash"],
                    "metadata": metadata,
                }
            
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
            
            if health_payload:
                device_data["health"] = health_payload
                connection_state = health_payload.get("metadata", {}).get("connectionState", "idle")
                device_data["connectionState"] = connection_state
                if "connectionError" in health_payload.get("metadata", {}):
                    device_data["connectionError"] = health_payload["metadata"]["connectionError"]
                if "lastHealth" in health_payload.get("metadata", {}):
                    device_data["health"] = health_payload["metadata"]["lastHealth"]
            
            result.append(device_data)

        return result

    def create_device(
        self,
        *,
        device_id: str | None = None,
        position: dict[str, float] | None = None,
        ip_address: str = "192.168.1.100",
        device_type: str = "wifi",
        strip_mode: str = "auto",
        strips: list[dict[str, object]] | None = None,
    ) -> str:
        """Create a new device (global scope)."""
        if not device_id:
            from uuid import uuid4
            device_id = f"device-{uuid4().hex}"

        self.persistence_service.persist_device_graph(
            device_id=device_id,
            ip_address=ip_address,
            position=position or {"x": 400, "y": 300},
            device_type=device_type,
            strip_mode=strip_mode,
            strips=strips or [],
        )
        db = self.persistence_service._get_db()
        db.commit()
        return device_id

    def update_device(
        self,
        device_id: str,
        *,
        position: dict[str, float] | None = None,
        ip_address: str | None = None,
        device_type: str | None = None,
        strip_mode: str | None = None,
        strips: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        """Update device properties."""
        device_row = self.repository.get_device(device_id)
        if not device_row:
            raise ValueError("Device not found")

        self._log_device_debug(
            "Updating device properties",
            device_id=device_id,
            has_position=position is not None,
            has_ip_address=ip_address is not None,
            has_device_type=device_type is not None,
            has_strip_mode=strip_mode is not None,
            has_strips=strips is not None,
            strip_count=len(strips) if strips else 0,
        )

        # Update basic properties
        updated_row = self.repository.update_device(
            device_id,
            position=position,
            ip_address=ip_address,
            device_type=device_type,
            strip_mode=strip_mode,
        )

        # If strips provided, update device graph
        if strips is not None:
            self.persistence_service.persist_device_graph(
                device_id=device_id,
                ip_address=ip_address or device_row["ip_address"],
                position=position or {"x": device_row["position_x"], "y": device_row["position_y"]},
                device_type=device_type or device_row["device_type"],
                strip_mode=strip_mode or device_row["strip_mode"],
                strips=strips,
            )
            db = self.persistence_service._get_db()
            db.commit()

        if not updated_row:
            raise ValueError("Device not found")

        return {
            "id": updated_row["id"],
            "position": {
                "x": updated_row["position_x"],
                "y": updated_row["position_y"],
            },
            "ipAddress": updated_row["ip_address"],
            "type": updated_row["device_type"],
            "stripMode": updated_row["strip_mode"],
        }

    def delete_device(self, device_id: str) -> bool:
        """Delete a device."""
        return self.repository.delete_device(device_id)

    def bulk_update_leds(
        self,
        device_id: str,
        leds: list[dict[str, object]],
    ) -> int:
        """Bulk update LED colors/opacities for a device."""
        updates = 0
        for led_update in leds:
            led_id = led_update.get("id")
            if not isinstance(led_id, str):
                continue

            # Verify LED belongs to device
            led_row = self.repository.get_led_by_id_and_device(led_id, device_id)
            if not led_row:
                continue

            color = led_update.get("color", led_row["color"])
            opacity = led_update.get("opacity", led_row["opacity"])

            if self.repository.update_led(led_id, color=color, opacity=opacity):
                updates += 1

        return updates


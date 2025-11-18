"""Service for keyframe business logic."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask

from .repository import KeyframeRepository
from ..json_utils import safe_scene_data

LOGGER = logging.getLogger(__name__)


class KeyframeService:
    """Service for keyframe business logic."""

    def __init__(self, app: Flask) -> None:
        self.app = app
        self.repository = KeyframeRepository(app)

    def _get_device_id_for_led(self, led_id: str) -> str | None:
        """Get device_id for an LED ID, trying parse first, then database lookup."""
        # Try to parse device_id from LED ID structure
        # LED IDs are typically: "{device_id}-{strip_id}-led-{index}" or "{device_id}-pin-{pin}-led-{index}"
        # Strip IDs are typically: "{device_id}-pin-{pin}"
        # So device_id is usually the prefix before the first "-pin-" or before "-led-"
        parts = led_id.split("-")
        
        # Try to find where device_id ends
        # If we see "pin" or "led", everything before that could be the device_id
        for i, part in enumerate(parts):
            if part == "pin" and i > 0:
                # Device ID is everything before "-pin-"
                device_id = "-".join(parts[:i])
                return device_id
            elif part == "led" and i > 0:
                # Could be "{device_id}-pin-{pin}-led-{index}" or "{device_id}-{strip_id}-led-{index}"
                # Look back to see if we have "pin" before "led"
                if i >= 2 and parts[i - 2] == "pin":
                    # Format: {device_id}-pin-{pin}-led-{index}
                    device_id = "-".join(parts[:i - 2])
                else:
                    # Format: {device_id}-{strip_id}-led-{index}
                    # Strip ID itself might contain device_id, but harder to parse
                    # For now, try first part
                    device_id = parts[0] if parts else None
                
                if device_id:
                    return device_id
        
        # Fallback: try database lookup
        try:
            from ...database import get_db
            db = get_db(self.app)
            row = db.execute(
                """
                SELECT led_strips.device_id
                FROM leds
                JOIN led_strips ON leds.strip_id = led_strips.id
                WHERE leds.id = ?
                LIMIT 1
                """,
                (led_id,),
            ).fetchone()
            if row:
                return row["device_id"]
        except Exception as exc:
            LOGGER.debug("Database lookup failed for LED %s: %s", led_id, exc)
        
        # Last resort: assume first part is device_id
        if parts:
            return parts[0]
        
        return None

    def _serialize_keyframe_row(self, row) -> dict[str, object]:
        """Serialize a keyframe row to API format."""
        return {
            "id": row["id"],
            "sceneId": row["scene_id"],
            "timestamp": row["timestamp_ms"],
            "effects": {
                "fadeIn": row["effects_fade_in"],
                "fadeOut": row["effects_fade_out"],
            },
            "ledStates": json.loads(row["led_states"]),
        }

    def list_keyframes(self, scene_id: str) -> list[dict[str, object]]:
        """List all keyframes for a scene."""
        rows = self.repository.list_keyframes(scene_id)
        return [self._serialize_keyframe_row(row) for row in rows]

    def create_keyframe(
        self,
        scene_id: str,
        *,
        keyframe_id: str | None = None,
        timestamp: int,
        led_states: dict[str, object],
        effects: dict[str, object] | None = None,
    ) -> dict[str, object]:
        """Create a new keyframe."""
        if not isinstance(led_states, dict):
            raise ValueError("ledStates is required and must be an object.")

        if keyframe_id is None:
            from uuid import uuid4
            keyframe_id = f"kf-{uuid4().hex}"

        effects = effects or {}
        fade_in = int(effects.get("fadeIn", 0) or 0)
        fade_out = int(effects.get("fadeOut", 0) or 0)

        row = self.repository.create_keyframe(
            scene_id=scene_id,
            keyframe_id=keyframe_id,
            timestamp_ms=timestamp,
            fade_in=fade_in,
            fade_out=fade_out,
            led_states=json.dumps(led_states),
        )

        if not row:
            raise ValueError("Failed to create keyframe")

        return self._serialize_keyframe_row(row)

    def update_keyframe(
        self,
        scene_id: str,
        keyframe_id: str,
        *,
        timestamp: int | None = None,
        led_states: dict[str, object] | None = None,
        effects: dict[str, object] | None = None,
    ) -> dict[str, object]:
        """Update an existing keyframe."""
        fade_in: int | None = None
        fade_out: int | None = None

        if effects is not None:
            if "fadeIn" in effects:
                fade_in = int(effects["fadeIn"] or 0)
            if "fadeOut" in effects:
                fade_out = int(effects["fadeOut"] or 0)

        led_states_json: str | None = None
        if led_states is not None:
            if not isinstance(led_states, dict):
                raise ValueError("ledStates must be an object.")
            led_states_json = json.dumps(led_states)

        row = self.repository.update_keyframe(
            scene_id=scene_id,
            keyframe_id=keyframe_id,
            timestamp_ms=timestamp,
            fade_in=fade_in,
            fade_out=fade_out,
            led_states=led_states_json,
        )

        if not row:
            raise ValueError("Keyframe not found")

        return self._serialize_keyframe_row(row)

    def delete_keyframe(self, scene_id: str, keyframe_id: str) -> None:
        """Delete a keyframe."""
        if not self.repository.delete_keyframe(scene_id, keyframe_id):
            raise ValueError("Keyframe not found")

    def apply_keyframe(
        self,
        scene_id: str,
        timestamp_ms: int,
        led_states: dict[str, object] | None = None,
    ) -> dict[str, object]:
        """Apply a keyframe to the playback engine."""
        import logging
        logger = logging.getLogger(__name__)
        
        playback_state = self.app.config.setdefault("PLAYBACK_STATE", {})
        scene_state = playback_state.setdefault(scene_id, {})
        
        led_states = led_states or {}
        led_count = len(led_states)
        
        logger.info(
            "Applying keyframe - scene_id=%s, timestamp=%s, led_count=%s",
            scene_id,
            timestamp_ms,
            led_count,
        )
        
        scene_state["last_frame"] = {
            "timestamp": timestamp_ms,
            "ledStates": led_states,
            "receivedAt": self._get_now_iso(),
        }

        # Send WebSocket command if led_states provided
        if led_states:
            device_service = self.app.config.get("DEVICE_SERVICE")
            if device_service:
                # Group LED states by device_id to send only relevant LEDs to each device
                led_states_by_device: dict[str, dict[str, object]] = {}
                
                for led_id, led_state in led_states.items():
                    device_id = self._get_device_id_for_led(led_id)
                    if device_id:
                        if device_id not in led_states_by_device:
                            led_states_by_device[device_id] = {}
                        led_states_by_device[device_id][led_id] = led_state
                    else:
                        logger.warning("Could not determine device_id for LED %s, skipping", led_id)
                
                logger.debug(
                    "Grouped LED states by device - scene_id=%s, timestamp=%s, total_leds=%s, devices=%s",
                    scene_id,
                    timestamp_ms,
                    led_count,
                    list(led_states_by_device.keys()),
                )
                
                # Send filtered LED states to each device via WebSocket
                all_results: dict[str, bool] = {}
                ws_clients = self.app.config.get("WS_CLIENTS", {})
                
                for target_device_id, device_led_states in led_states_by_device.items():
                    if target_device_id in ws_clients:
                        # Send to specific device via WebSocket
                        logger.debug(
                            "Sending live_frame to device %s with %d LEDs",
                            target_device_id,
                            len(device_led_states),
                        )
                        device_results = device_service.send_ws_command(
                            command="live_frame",
                            payload={
                                "sceneId": scene_id,
                                "timestamp": timestamp_ms,
                                "ledStates": device_led_states,  # Only this device's LEDs
                            },
                            device_ids=[target_device_id],
                        )
                        all_results.update(device_results)
                
                logger.info("live_frame commands sent - results=%s", all_results)
                
                # Always apply to local hardware if this is the controller (regardless of WebSocket clients)
                if self.app.config.get("IS_CONTROLLER", False):
                    local_device_id = device_service.local_device_id_for_scene(scene_id)
                    local_led_states = led_states_by_device.get(local_device_id, {})
                    if local_led_states:
                        from ...hardware import apply_live_frame_to_hardware
                        logger.debug(
                            "Applying %d LEDs to local hardware (device_id=%s)",
                            len(local_led_states),
                            local_device_id,
                        )
                        apply_live_frame_to_hardware(self.app, local_led_states)
                    else:
                        logger.debug(
                            "No LED states for local device %s in this frame",
                            local_device_id,
                        )
            else:
                logger.warning("DEVICE_SERVICE not available, cannot send live_frame command")
        else:
            logger.warning("No led_states provided, skipping WebSocket command")

        return {"status": "queued"}

    def _get_now_iso(self) -> str:
        """Get current ISO timestamp."""
        from ..datetime_utils import now_iso
        return now_iso()


"""Service for keyframe business logic."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask

from .repository import KeyframeRepository
from ..json_utils import safe_scene_data

class KeyframeService:
    """Service for keyframe business logic."""

    def __init__(self, app: Flask) -> None:
        self.app = app
        self.repository = KeyframeRepository(app)

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
                logger.debug(
                    "Sending live_frame WebSocket command - scene_id=%s, timestamp=%s, led_count=%s",
                    scene_id,
                    timestamp_ms,
                    led_count,
                )
                results = device_service.send_ws_command(
                    command="live_frame",
                    payload={
                        "sceneId": scene_id,
                        "timestamp": timestamp_ms,
                        "ledStates": led_states,
                    },
                )
                logger.info("live_frame command sent - results=%s", results)
            else:
                logger.warning("DEVICE_SERVICE not available, cannot send live_frame command")
        else:
            logger.warning("No led_states provided, skipping WebSocket command")

        return {"status": "queued"}

    def _get_now_iso(self) -> str:
        """Get current ISO timestamp."""
        from ..datetime_utils import now_iso
        return now_iso()


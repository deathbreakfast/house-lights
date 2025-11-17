"""Flask Blueprint for keyframe routes."""

from __future__ import annotations

from flask import Blueprint, abort, jsonify, request

from .service import KeyframeService

def create_keyframe_blueprint(app) -> Blueprint:
    """Create and configure the keyframe blueprint."""
    bp = Blueprint("keyframes", __name__, url_prefix="/api/v2/scenes/<scene_id>/keyframes")
    
    # Store app reference for use in route handlers
    bp.app = app
    keyframe_service = KeyframeService(app)

    @bp.get("")
    def list_keyframes(scene_id: str):
        """Return all keyframes for a scene."""
        try:
            keyframes = keyframe_service.list_keyframes(scene_id)
            return jsonify(keyframes)
        except Exception as e:
            abort(500, description=f"Failed to retrieve keyframes: {str(e)}")

    @bp.post("")
    def create_keyframe(scene_id: str):
        """Persist a keyframe for a scene."""
        data = request.get_json() or {}
        
        try:
            keyframe = keyframe_service.create_keyframe(
                scene_id=scene_id,
                keyframe_id=data.get("id"),
                timestamp=int(data.get("timestamp", 0)),
                led_states=data.get("ledStates", {}),
                effects=data.get("effects"),
            )
            return jsonify(keyframe), 201
        except ValueError as e:
            abort(400, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to create keyframe: {str(e)}")

    @bp.patch("/<keyframe_id>")
    def update_keyframe(scene_id: str, keyframe_id: str):
        """Update an existing keyframe."""
        data = request.get_json() or {}
        
        if not data:
            abort(400, description="No fields provided to update.")
        
        try:
            keyframe = keyframe_service.update_keyframe(
                scene_id=scene_id,
                keyframe_id=keyframe_id,
                timestamp=data.get("timestamp"),
                led_states=data.get("ledStates"),
                effects=data.get("effects"),
            )
            return jsonify(keyframe)
        except ValueError as e:
            abort(404 if "not found" in str(e).lower() else 400, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to update keyframe: {str(e)}")

    @bp.delete("/<keyframe_id>")
    def delete_keyframe(scene_id: str, keyframe_id: str):
        """Delete a keyframe from a scene."""
        try:
            keyframe_service.delete_keyframe(scene_id, keyframe_id)
            return jsonify({"status": "deleted"})
        except ValueError as e:
            abort(404, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to delete keyframe: {str(e)}")

    @bp.post("/<int:timestamp_ms>/apply")
    def apply_keyframe(scene_id: str, timestamp_ms: int):
        """Record a frame application request (stub for hardware playback)."""
        payload = request.get_json(silent=True) or {}
        led_states = payload.get("ledStates", {})
        
        try:
            result = keyframe_service.apply_keyframe(
                scene_id=scene_id,
                timestamp_ms=timestamp_ms,
                led_states=led_states,
            )
            return jsonify(result)
        except Exception as e:
            abort(500, description=f"Failed to apply keyframe: {str(e)}")

    return bp


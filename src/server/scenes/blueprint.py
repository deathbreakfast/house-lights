"""Flask Blueprint for scene routes."""

from __future__ import annotations

import sqlite3
from flask import Blueprint, abort, jsonify, request, url_for
from pathlib import Path

from .service import SceneService
from ...database import get_db
from ..config import STUDIO_BACKGROUND_SCENE_ID
from ..json_utils import safe_scene_data
from ..logging_utils import log_device_debug

def create_scene_blueprint(app) -> Blueprint:
    """Create and configure the scene blueprint."""
    bp = Blueprint("scenes", __name__, url_prefix="/api/v2/scenes")
    
    # Store app reference for use in route handlers
    bp.app = app
    scene_service = SceneService(app)

    @bp.get("")
    def list_scenes():
        """Return all user-defined scenes."""
        scenes = scene_service.list_scenes(exclude_scene_id=STUDIO_BACKGROUND_SCENE_ID)
        return jsonify(scenes)

    @bp.post("")
    def create_scene():
        """Create a new scene."""
        payload = request.get_json(silent=True) or {}
        name = payload.get("name") or "New Scene"
        scene_id = payload.get("id")
        
        try:
            scene = scene_service.create_scene(scene_id=scene_id, name=name)
            return jsonify(scene), 201
        except ValueError as e:
            if "already exists" in str(e):
                abort(409, description=str(e))
            abort(400, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to create scene: {str(e)}")

    @bp.get("/<scene_id>")
    def get_scene(scene_id: str):
        """Return a single scene's metadata."""
        if scene_id == STUDIO_BACKGROUND_SCENE_ID:
            abort(404, description="Scene not found.")
        
        scene = scene_service.get_scene(scene_id)
        if not scene:
            abort(404, description="Scene not found.")
        return jsonify(scene)

    @bp.patch("/<scene_id>")
    def update_scene_metadata(scene_id: str):
        """Update scene metadata such as the name or framerate."""
        import logging
        logger = logging.getLogger(__name__)
        
        logger.info(f"PATCH /api/v2/scenes/{scene_id} - update_scene_metadata called")
        
        if scene_id == STUDIO_BACKGROUND_SCENE_ID:
            abort(400, description="Global scene cannot be modified via this endpoint.")
        
        payload = request.get_json(silent=True) or {}
        logger.info(f"Payload received: {payload}")
        updates = {}
        
        if "name" in payload:
            updates["name"] = payload["name"]
            logger.info(f"Updating scene name: {payload['name']}")
        
        # Handle framerate - store in scene data JSON
        if "framerate" in payload:
            framerate_value = payload["framerate"]
            logger.info(f"Framerate in payload: {framerate_value} (type: {type(framerate_value)})")
            if isinstance(framerate_value, (int, float)) and framerate_value > 0:
                db = get_db(app)
                row = db.execute(
                    "SELECT data FROM scenes WHERE id = ?",
                    (scene_id,),
                ).fetchone()
                if row:
                    import json
                    from ..json_utils import safe_scene_data
                    data = safe_scene_data(row["data"])
                    if not isinstance(data, dict):
                        data = {}
                    data["framerate"] = int(framerate_value)
                    updates["data"] = json.dumps(data)
                    logger.info(f"Updating scene framerate to {framerate_value}")
                else:
                    logger.warning(f"Scene {scene_id} not found in database")
            else:
                logger.warning(f"Invalid framerate value: {framerate_value}")
        
        if not updates:
            logger.warning("No updates supplied in request")
            abort(400, description="No updates supplied.")
        
        try:
            scene = scene_service.update_scene(scene_id, updates)
            logger.info(f"Scene {scene_id} updated successfully")
            return jsonify(scene)
        except ValueError as e:
            logger.error(f"ValueError updating scene: {e}")
            if "not found" in str(e).lower():
                abort(404, description=str(e))
            abort(400, description=str(e))
        except Exception as e:
            logger.error(f"Exception updating scene: {e}", exc_info=True)
            abort(500, description=f"Failed to update scene: {str(e)}")

    @bp.delete("/<scene_id>")
    def delete_scene(scene_id: str):
        """Delete a scene and all of its associated data."""
        if scene_id == STUDIO_BACKGROUND_SCENE_ID:
            abort(400, description="Cannot delete the global studio scene.")
        
        try:
            scene_service.delete_scene(scene_id)
            return jsonify({"status": "deleted"})
        except ValueError as e:
            abort(404, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to delete scene: {str(e)}")


    @bp.get("/<scene_id>/power")
    def get_scene_power(scene_id: str):
        """Get the power state for a scene."""
        db = get_db(app)
        row = db.execute(
            "SELECT power_on FROM scenes WHERE id = ?",
            (scene_id,),
        ).fetchone()
        
        if not row:
            abort(404, description="Scene not found.")
        
        stored_power = bool(row["power_on"])
        hardware_power = bool(app.config.get("LIGHT_STATE", {}).get("is_on", False))
        
        # Return stored power state (database) as the source of truth
        # Hardware state is informational only
        return jsonify(
            {
                "powerOn": stored_power,  # UI should sync with database state
                "storedPowerOn": stored_power,
                "hardwarePowerOn": hardware_power,
            }
        )

    @bp.patch("/<scene_id>/power")
    def update_scene_power(scene_id: str):
        """Update the power state for a scene."""
        payload = request.get_json(silent=True) or {}
        power_on = payload.get("powerOn")
        
        if not isinstance(power_on, bool):
            abort(400, description="powerOn must be a boolean.")
        
        try:
            # Update database state
            power_state = scene_service.update_scene_power_state(scene_id, power_on)
            
            # Also update hardware controller if this is a controller instance
            if app.config.get("IS_CONTROLLER", True):
                light_state = app.config.get("LIGHT_STATE", {})
                light_state["is_on"] = power_on
                controller = app.config.get("LIGHT_CONTROLLER")
                if controller:
                    controller.set_power(power_on)
                    if power_on:
                        # If turning on, apply the selected pattern
                        selected_pattern = light_state.get("selected_pattern")
                        if selected_pattern:
                            controller.apply_pattern(selected_pattern)
            
            log_device_debug(
                app,
                "Power state updated",
                scene_id=scene_id,
                power_on=power_on,
                is_controller=app.config.get("IS_CONTROLLER", True),
            )
            
            return jsonify(power_state)
        except ValueError as e:
            abort(404, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to update power state: {str(e)}")

    return bp


"""Flask Blueprint for audio routes."""

from __future__ import annotations

from flask import Blueprint, abort, jsonify, request, Response, url_for

from .service import AudioService
from ..config import STUDIO_BACKGROUND_SCENE_ID

def create_audio_blueprint(app) -> Blueprint:
    """Create and configure the audio blueprint."""
    bp = Blueprint("audio", __name__, url_prefix="/api/v2/scenes/<scene_id>/audio")
    
    # Store app reference for use in route handlers
    bp.app = app
    audio_service = AudioService(app)

    @bp.post("")
    def upload_audio(scene_id: str):
        """Upload an audio track for a scene."""
        if scene_id == STUDIO_BACKGROUND_SCENE_ID:
            abort(400, description="Global scene cannot store audio.")
        
        if "file" not in request.files:
            abort(400, description="No audio file provided.")
        
        file = request.files["file"]
        if not file or file.filename == "":
            abort(400, description="No audio file selected.")
        
        if not file.content_type or not file.content_type.startswith("audio/"):
            abort(400, description="File must be an audio type.")
        
        try:
            result = audio_service.upload_audio(
                scene_id=scene_id,
                file=file,
                filename=file.filename,
                content_type=file.content_type,
            )
            # Add URL to response
            result["url"] = url_for("audio.get_audio", scene_id=scene_id, _external=False)
            return jsonify(result)
        except ValueError as e:
            if "not found" in str(e).lower():
                abort(404, description=str(e))
            abort(400, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to upload audio: {str(e)}")

    @bp.get("")
    def get_audio(scene_id: str):
        """Stream a scene's audio asset."""
        try:
            result = audio_service.get_audio_file_path(scene_id)
            if not result:
                abort(404, description="No audio attached to this scene.")
            
            file_path, content_type = result
            return Response(
                file_path.read_bytes(),
                mimetype=content_type,
                headers={"Cache-Control": "no-store"},
            )
        except Exception as e:
            abort(500, description=f"Failed to retrieve audio: {str(e)}")

    @bp.delete("")
    def delete_audio(scene_id: str):
        """Remove the audio asset associated with a scene."""
        try:
            audio_service.delete_audio(scene_id)
            return jsonify({"status": "deleted"})
        except ValueError as e:
            abort(404, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to delete audio: {str(e)}")

    return bp


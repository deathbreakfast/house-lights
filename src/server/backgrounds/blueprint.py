"""Flask Blueprint for background image routes."""

from __future__ import annotations

from flask import Blueprint, abort, jsonify, request, Response

from .service import BackgroundService

def create_background_blueprint(app) -> Blueprint:
    """Create and configure the background blueprint."""
    bp = Blueprint("backgrounds", __name__, url_prefix="/api/v2")
    
    # Store app reference for use in route handlers
    bp.app = app
    background_service = BackgroundService(app)

    @bp.post("/background")
    def upload_background():
        """Upload the global background image."""
        if "file" not in request.files:
            abort(400, description="No image file provided.")
        
        file = request.files["file"]
        if not file or file.filename == "":
            abort(400, description="No image file selected.")
        
        if not file.content_type or not file.content_type.startswith("image/"):
            abort(400, description="File must be an image type.")
        
        try:
            result = background_service.upload_background(
                file=file,
                filename=file.filename,
                content_type=file.content_type,
            )
            return jsonify(result)
        except ValueError as e:
            abort(400, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to upload background: {str(e)}")

    @bp.get("/images/<image_id>")
    def get_image(image_id: str):
        """Retrieve a background image by ID."""
        try:
            result = background_service.get_image_file(image_id)
            if not result:
                abort(404, description="Image not found.")
            
            file_path, content_type = result
            return Response(
                file_path.read_bytes(),
                mimetype=content_type,
                headers={"Cache-Control": "public, max-age=3600"},
            )
        except Exception as e:
            abort(500, description=f"Failed to retrieve image: {str(e)}")

    @bp.get("/background")
    def get_background():
        """Get the global background image."""
        try:
            result = background_service.get_background()
            if result is None:
                return jsonify(None), 200
            return jsonify(result)
        except Exception as e:
            abort(500, description=f"Failed to retrieve background: {str(e)}")

    @bp.patch("/background/scale")
    def update_background_scale():
        """Update the scale of the global background image."""
        data = request.get_json()
        if not data or "scale" not in data:
            abort(400, description="Scale value required")
        
        try:
            scale = int(data["scale"])
            result = background_service.update_background_scale(scale)
            return jsonify(result)
        except ValueError as e:
            abort(400, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to update background scale: {str(e)}")

    return bp


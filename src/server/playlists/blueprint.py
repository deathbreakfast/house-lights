"""Flask Blueprint for playlist routes."""

from __future__ import annotations

from flask import Blueprint, abort, jsonify, request

from .service import PlaylistService

def create_playlist_blueprint(app) -> Blueprint:
    """Create and configure the playlist blueprint."""
    bp = Blueprint("playlists", __name__, url_prefix="/api/v2")
    
    # Store app reference for use in route handlers
    bp.app = app
    playlist_service = PlaylistService(app)

    @bp.get("/scene-playlist")
    def get_scene_playlist():
        """Return the ordered scene playlist."""
        try:
            entries = playlist_service.get_playlist()
            return jsonify(entries)
        except Exception as e:
            abort(500, description=f"Failed to retrieve playlist: {str(e)}")

    @bp.put("/scene-playlist")
    def save_scene_playlist():
        """Persist the ordered scene playlist."""
        payload = request.get_json(silent=True) or {}
        entries = payload.get("entries")
        
        if entries is None:
            abort(400, description="entries array is required.")
        
        try:
            updated_entries = playlist_service.update_playlist(entries)
            return jsonify(updated_entries)
        except ValueError as e:
            abort(400, description=str(e))
        except Exception as e:
            abort(500, description=f"Failed to update playlist: {str(e)}")

    return bp


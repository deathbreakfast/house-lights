"""Service for scene business logic."""

from __future__ import annotations

import contextlib
import json
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from flask import Flask, url_for

from .repository import SceneRepository
from ..json_utils import safe_scene_data

if TYPE_CHECKING:
    from datetime import datetime

LOGGER = __import__("logging").getLogger(__name__)


class SceneService:
    """Service for scene business logic."""

    def __init__(self, app: Flask) -> None:
        self.app = app
        self.repository = SceneRepository(app)

    def create_scene(
        self, scene_id: str | None = None, name: str = "New Scene"
    ) -> dict:
        """Create a new scene."""
        if not scene_id:
            scene_id = f"scene-{uuid4().hex}"
        
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Scene name must be a non-empty string.")
        
        name = name.strip()
        
        try:
            self.repository.create(scene_id, name)
        except Exception as e:
            if "UNIQUE constraint" in str(e) or "IntegrityError" in str(type(e).__name__):
                raise ValueError(f"Scene with id '{scene_id}' already exists.") from e
            raise
        
        scene = self.get_scene(scene_id)
        if not scene:
            raise RuntimeError("Failed to retrieve created scene.")
        return scene

    def get_scene(self, scene_id: str) -> dict | None:
        """Get a scene by ID."""
        row = self.repository.get_by_id(scene_id)
        if not row:
            return None
        return self._serialize_scene_row(row)

    def list_scenes(self, exclude_scene_id: str | None = None) -> list[dict]:
        """List all scenes."""
        rows = self.repository.list_all(exclude_scene_id=exclude_scene_id)
        return [self._serialize_scene_row(row) for row in rows]

    def update_scene(self, scene_id: str, updates: dict) -> dict:
        """Update scene metadata."""
        if "name" in updates:
            name = updates["name"]
            if not isinstance(name, str):
                raise ValueError("Scene name must be a string.")
            name = name.strip()
            if not name:
                raise ValueError("Scene name cannot be empty.")
            updates["name"] = name
        
        self.repository.update(scene_id, updates)
        
        scene = self.get_scene(scene_id)
        if not scene:
            raise ValueError("Scene not found.")
        return scene

    def delete_scene(self, scene_id: str) -> None:
        """Delete a scene and its associated audio asset."""
        row = self.repository.get_by_id(scene_id)
        if not row:
            raise ValueError("Scene not found.")
        
        # Delete associated audio asset
        data = safe_scene_data(row["data"])
        if isinstance(data, dict):
            self._delete_audio_asset(data.get("audio"))
        
        deleted = self.repository.delete(scene_id)
        if not deleted:
            raise ValueError("Scene not found.")

    def ensure_scene_exists(
        self, scene_id: str, *, name: str | None = None
    ) -> None:
        """Ensure a scene exists, creating it if necessary."""
        if self.repository.exists(scene_id):
            return
        
        self.repository.create(
            scene_id,
            name or f"Scene {scene_id}",
        )

    def get_scene_power_state(self, scene_id: str) -> dict:
        """Get power state for a scene."""
        power_on = self.repository.get_power_state(scene_id)
        if power_on is None:
            raise ValueError("Scene not found.")
        return {"powerOn": power_on}

    def update_scene_power_state(self, scene_id: str, is_on: bool) -> dict:
        """Update power state for a scene."""
        updated = self.repository.update_power_state(scene_id, is_on)
        if not updated:
            raise ValueError("Scene not found.")
        return {"powerOn": is_on}

    def _serialize_scene_row(self, row) -> dict:
        """Serialize a scene database row to API format."""
        data = safe_scene_data(row["data"])
        audio_meta = data.get("audio") if isinstance(data, dict) else None
        audio_payload: dict | None = None
        
        if isinstance(audio_meta, dict) and audio_meta.get("id"):
            audio_path = audio_meta.get("file_path")
            if audio_path and Path(audio_path).exists():
                audio_payload = {
                    "id": audio_meta.get("id"),
                    "filename": audio_meta.get("filename"),
                    "contentType": audio_meta.get("content_type"),
                    # Audio routes moved to Audio Blueprint
                    "url": url_for("audio.get_audio", scene_id=row["id"], _external=False),
                }
        
        # Extract framerate from scene data if present
        framerate = None
        if isinstance(data, dict):
            framerate_value = data.get("framerate")
            if isinstance(framerate_value, (int, float)) and framerate_value > 0:
                framerate = int(framerate_value)
        
        return {
            "id": row["id"],
            "name": row["name"],
            "audio": audio_payload,
            "framerate": framerate,
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def _delete_audio_asset(self, audio_meta: dict | None) -> None:
        """Delete an audio asset file."""
        if not isinstance(audio_meta, dict):
            return
        file_path = audio_meta.get("file_path")
        if not file_path:
            return
        with contextlib.suppress(OSError):
            Path(file_path).unlink()


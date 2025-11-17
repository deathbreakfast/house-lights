"""Service for audio business logic."""

from __future__ import annotations

import contextlib
import json
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

if TYPE_CHECKING:
    from flask import Flask
    from werkzeug.datastructures import FileStorage

from ..scenes.repository import SceneRepository
from ..json_utils import safe_scene_data
from ..config import STUDIO_BACKGROUND_SCENE_ID

class AudioService:
    """Service for audio business logic."""

    def __init__(self, app: Flask) -> None:
        self.app = app
        self.scene_repository = SceneRepository(app)

    def upload_audio(
        self,
        scene_id: str,
        file: FileStorage,
        filename: str,
        content_type: str,
    ) -> dict[str, object]:
        """Upload an audio file for a scene."""
        if scene_id == STUDIO_BACKGROUND_SCENE_ID:
            raise ValueError("Global scene cannot store audio.")

        # Verify scene exists
        scene_row = self.scene_repository.get_scene(scene_id)
        if not scene_row:
            raise ValueError("Scene not found.")

        # Generate audio ID and file path
        audio_id = str(uuid4())
        file_ext = Path(filename).suffix or ".bin"
        audio_filename = f"{audio_id}{file_ext}"
        audio_dir = self.app.config.get("V2_AUDIO_DIR")
        if not audio_dir:
            raise ValueError("Audio storage directory not configured.")
        file_path = Path(audio_dir) / audio_filename

        # Save file
        file.save(str(file_path))

        # Update scene data
        data = safe_scene_data(scene_row["data"])
        
        # Delete existing audio if present
        if isinstance(data, dict):
            self._delete_audio_asset(data.get("audio"))
            data["audio"] = {
                "id": audio_id,
                "filename": filename,
                "content_type": content_type or "application/octet-stream",
                "file_path": str(file_path),
            }
        else:
            data = {
                "audio": {
                    "id": audio_id,
                    "filename": filename,
                    "content_type": content_type or "application/octet-stream",
                    "file_path": str(file_path),
                }
            }

        self.scene_repository.update_scene(scene_id, data=json.dumps(data))

        return {
            "id": audio_id,
            "filename": filename,
            "contentType": content_type,
        }

    def get_audio_metadata(self, scene_id: str) -> dict[str, object] | None:
        """Get audio metadata for a scene."""
        scene_row = self.scene_repository.get_scene(scene_id)
        if not scene_row:
            return None

        data = safe_scene_data(scene_row["data"])
        audio_meta = data.get("audio") if isinstance(data, dict) else None
        
        if not isinstance(audio_meta, dict):
            return None

        file_path = Path(audio_meta.get("file_path", ""))
        if not file_path.exists():
            return None

        return {
            "id": audio_meta.get("id"),
            "filename": audio_meta.get("filename"),
            "contentType": audio_meta.get("content_type", "application/octet-stream"),
            "filePath": str(file_path),
        }

    def get_audio_file_path(self, scene_id: str) -> tuple[Path, str] | None:
        """Get audio file path and content type for a scene."""
        metadata = self.get_audio_metadata(scene_id)
        if not metadata:
            return None
        
        file_path = Path(metadata["filePath"])
        content_type = metadata["contentType"]
        
        if not file_path.exists():
            return None

        return (file_path, content_type)

    def delete_audio(self, scene_id: str) -> None:
        """Delete audio from a scene."""
        scene_row = self.scene_repository.get_scene(scene_id)
        if not scene_row:
            raise ValueError("Scene not found.")

        data = safe_scene_data(scene_row["data"])
        if isinstance(data, dict) and "audio" in data:
            self._delete_audio_asset(data.get("audio"))
            data.pop("audio", None)
            self.scene_repository.update_scene(scene_id, data=json.dumps(data))

    def _delete_audio_asset(self, audio_meta: dict | None) -> None:
        """Delete an audio asset file."""
        if not isinstance(audio_meta, dict):
            return
        file_path = audio_meta.get("file_path")
        if not file_path:
            return
        with contextlib.suppress(OSError):
            Path(file_path).unlink()


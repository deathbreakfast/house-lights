"""Service for background image business logic."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

if TYPE_CHECKING:
    from flask import Flask
    from werkzeug.datastructures import FileStorage

from .repository import BackgroundRepository
from ..config import STUDIO_BACKGROUND_SCENE_ID

class BackgroundService:
    """Service for background image business logic."""

    def __init__(self, app: Flask) -> None:
        self.app = app
        self.repository = BackgroundRepository(app)

    def upload_background(
        self,
        file: FileStorage,
        filename: str,
        content_type: str,
    ) -> dict[str, object]:
        """Upload a global background image."""
        if not content_type or not content_type.startswith("image/"):
            raise ValueError("File must be an image type.")

        # Generate image ID and file path
        image_id = str(uuid4())
        file_ext = Path(filename).suffix or ".bin"
        image_filename = f"{image_id}{file_ext}"
        images_dir = self.app.config.get("V2_IMAGES_DIR")
        if not images_dir:
            raise ValueError("Image storage directory not configured.")
        file_path = Path(images_dir) / image_filename

        # Save file
        file.save(str(file_path))

        # Create database record (global scope)
        self.repository.create_background(
            image_id=image_id,
            filename=filename,
            content_type=content_type,
            file_path=str(file_path),
            scale=100,
        )

        return {
            "id": image_id,
            "url": f"/api/v2/images/{image_id}",
            "filename": filename,
            "scale": 100,
        }

    def get_background(self) -> dict[str, object] | None:
        """Get global background image metadata."""
        row = self.repository.get_background()
        if not row:
            return None

        return {
            "id": row["id"],
            "url": f"/api/v2/images/{row['id']}",
            "filename": row["filename"],
            "scale": row["scale"] if row["scale"] is not None else 100,
        }

    def update_background_scale(self, scale: int) -> dict[str, object]:
        """Update the scale of the global background image."""
        if scale < 10 or scale > 1000:
            raise ValueError("Scale must be between 10 and 1000")

        if not self.repository.update_background_scale(scale):
            raise ValueError("Background image not found")

        return {"scale": scale}

    def get_image_file(self, image_id: str) -> tuple[Path, str] | None:
        """Get image file path and content type by ID."""
        row = self.repository.get_image_by_id(image_id)
        if not row:
            return None

        file_path = Path(row["file_path"])
        if not file_path.exists():
            return None

        return (file_path, row["content_type"])


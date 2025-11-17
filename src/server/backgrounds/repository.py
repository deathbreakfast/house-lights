"""Repository for background image database operations."""

from __future__ import annotations

import sqlite3
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask

class BackgroundRepository:
    """Repository for background image database operations."""

    def __init__(self, app: Flask) -> None:
        self.app = app

    def _get_db(self) -> sqlite3.Connection:
        """Get database connection."""
        from ...database import get_db
        return get_db(self.app)

    def get_background(self) -> sqlite3.Row | None:
        """Get the global background image."""
        db = self._get_db()
        return db.execute(
            """
            SELECT id, filename, content_type, scale, file_path
            FROM background_images
            ORDER BY created_at DESC
            LIMIT 1
            """
        ).fetchone()

    def get_image_by_id(self, image_id: str) -> sqlite3.Row | None:
        """Get an image by ID."""
        db = self._get_db()
        return db.execute(
            """
            SELECT id, file_path, content_type, filename
            FROM background_images
            WHERE id = ?
            """,
            (image_id,),
        ).fetchone()

    def create_background(
        self,
        image_id: str,
        filename: str,
        content_type: str,
        file_path: str,
        scale: int = 100,
    ) -> sqlite3.Row:
        """Create a new background image record (global scope)."""
        db = self._get_db()
        # Delete existing background images (only one global background allowed)
        db.execute("DELETE FROM background_images")
        db.execute(
            """
            INSERT INTO background_images (id, filename, content_type, file_path, scale)
            VALUES (?, ?, ?, ?, ?)
            """,
            (image_id, filename, content_type, file_path, scale),
        )
        db.commit()
        return self.get_background()

    def update_background_scale(self, scale: int) -> bool:
        """Update the scale of the global background image."""
        db = self._get_db()
        result = db.execute(
            """
            UPDATE background_images
            SET scale = ?
            """,
            (scale,),
        )
        db.commit()
        return result.rowcount > 0


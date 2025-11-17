"""Repository for playlist database operations."""

from __future__ import annotations

import sqlite3
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask

class PlaylistRepository:
    """Repository for playlist database operations."""

    def __init__(self, app: Flask) -> None:
        self.app = app

    def _get_db(self) -> sqlite3.Connection:
        """Get database connection."""
        from ...database import get_db
        return get_db(self.app)

    def list_playlist_entries(self) -> list[sqlite3.Row]:
        """Get all playlist entries ordered by position."""
        db = self._get_db()
        return db.execute(
            """
            SELECT id, scene_id, position, play_duration_seconds, fade_duration_seconds
            FROM scene_playlist_entries
            ORDER BY position ASC
            """
        ).fetchall()

    def replace_playlist_entries(
        self,
        entries: list[tuple[str, str, int, int, int]],
    ) -> None:
        """
        Replace all playlist entries.
        entries: list of (entry_id, scene_id, position, play_duration_seconds, fade_duration_seconds)
        """
        db = self._get_db()
        # Delete all existing entries
        db.execute("DELETE FROM scene_playlist_entries")
        
        # Insert new entries
        if entries:
            db.executemany(
                """
                INSERT INTO scene_playlist_entries (id, scene_id, position, play_duration_seconds, fade_duration_seconds)
                VALUES (?, ?, ?, ?, ?)
                """,
                entries,
            )
        
        db.commit()

    def scene_exists(self, scene_id: str) -> bool:
        """Check if a scene exists."""
        db = self._get_db()
        row = db.execute("SELECT id FROM scenes WHERE id = ?", (scene_id,)).fetchone()
        return row is not None


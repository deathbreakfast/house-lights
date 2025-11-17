"""Repository for scene database operations."""

from __future__ import annotations

import sqlite3
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask


class SceneRepository:
    """Repository for scene database operations."""

    def __init__(self, app: Flask) -> None:
        self.app = app

    def _get_db(self) -> sqlite3.Connection:
        """Get database connection."""
        from ...database import get_db
        return get_db(self.app)

    def create(
        self, scene_id: str, name: str, data: str = "{}", power_on: int = 0
    ) -> None:
        """Create a new scene."""
        db = self._get_db()
        db.execute(
            """
            INSERT INTO scenes (id, name, power_on, data)
            VALUES (?, ?, ?, ?)
            """,
            (scene_id, name, power_on, data),
        )
        db.commit()

    def get_by_id(self, scene_id: str) -> sqlite3.Row | None:
        """Get a scene by ID."""
        db = self._get_db()
        row = db.execute(
            """
            SELECT id, name, data, created_at, updated_at, power_on
            FROM scenes
            WHERE id = ?
            """,
            (scene_id,),
        ).fetchone()
        return row

    def list_all(self, exclude_scene_id: str | None = None) -> list[sqlite3.Row]:
        """List all scenes, optionally excluding one."""
        db = self._get_db()
        if exclude_scene_id:
            rows = db.execute(
                """
                SELECT id, name, data, created_at, updated_at, power_on
                FROM scenes
                WHERE id != ?
                ORDER BY created_at ASC
                """,
                (exclude_scene_id,),
            ).fetchall()
        else:
            rows = db.execute(
                """
                SELECT id, name, data, created_at, updated_at, power_on
                FROM scenes
                ORDER BY created_at ASC
                """
            ).fetchall()
        return rows

    def update(self, scene_id: str, updates: dict) -> None:
        """Update scene fields."""
        db = self._get_db()
        set_clauses = []
        params: list[object] = []
        
        if "name" in updates:
            set_clauses.append("name = ?")
            params.append(updates["name"])
        
        if "data" in updates:
            set_clauses.append("data = ?")
            params.append(updates["data"])
        
        if "power_on" in updates:
            set_clauses.append("power_on = ?")
            params.append(updates["power_on"])
        
        if not set_clauses:
            return
        
        set_clauses.append("updated_at = CURRENT_TIMESTAMP")
        params.append(scene_id)
        
        db.execute(
            f"""
            UPDATE scenes
            SET {', '.join(set_clauses)}
            WHERE id = ?
            """,
            params,
        )
        db.commit()

    def delete(self, scene_id: str) -> bool:
        """Delete a scene. Returns True if a scene was deleted."""
        db = self._get_db()
        result = db.execute("DELETE FROM scenes WHERE id = ?", (scene_id,))
        db.commit()
        return result.rowcount > 0

    def exists(self, scene_id: str) -> bool:
        """Check if a scene exists."""
        db = self._get_db()
        row = db.execute(
            "SELECT id FROM scenes WHERE id = ?",
            (scene_id,),
        ).fetchone()
        return row is not None

    def get_power_state(self, scene_id: str) -> bool | None:
        """Get power state for a scene. Returns None if scene doesn't exist."""
        db = self._get_db()
        row = db.execute(
            "SELECT power_on FROM scenes WHERE id = ?",
            (scene_id,),
        ).fetchone()
        if row is None:
            return None
        return bool(row["power_on"])

    def update_power_state(self, scene_id: str, power_on: bool) -> bool:
        """Update power state for a scene. Returns True if scene was updated."""
        db = self._get_db()
        result = db.execute(
            """
            UPDATE scenes
            SET power_on = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (1 if power_on else 0, scene_id),
        )
        db.commit()
        return result.rowcount > 0


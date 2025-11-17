"""Repository for keyframe database operations."""

from __future__ import annotations

import sqlite3
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask

class KeyframeRepository:
    """Repository for keyframe database operations."""

    def __init__(self, app: Flask) -> None:
        self.app = app

    def _get_db(self) -> sqlite3.Connection:
        """Get database connection."""
        from ...database import get_db
        return get_db(self.app)

    def list_keyframes(self, scene_id: str) -> list[sqlite3.Row]:
        """Get all keyframes for a scene."""
        db = self._get_db()
        return db.execute(
            """
            SELECT id, scene_id, timestamp_ms, effects_fade_in, effects_fade_out, led_states
            FROM scene_keyframes
            WHERE scene_id = ?
            ORDER BY timestamp_ms ASC
            """,
            (scene_id,),
        ).fetchall()

    def get_keyframe(self, scene_id: str, keyframe_id: str) -> sqlite3.Row | None:
        """Get a keyframe by ID."""
        db = self._get_db()
        return db.execute(
            """
            SELECT id, scene_id, timestamp_ms, effects_fade_in, effects_fade_out, led_states
            FROM scene_keyframes
            WHERE scene_id = ? AND id = ?
            """,
            (scene_id, keyframe_id),
        ).fetchone()

    def create_keyframe(
        self,
        scene_id: str,
        keyframe_id: str,
        timestamp_ms: int,
        fade_in: int,
        fade_out: int,
        led_states: str,
    ) -> sqlite3.Row:
        """Create a new keyframe."""
        db = self._get_db()
        
        # Delete any existing keyframe at the same timestamp (except this one)
        db.execute(
            """
            DELETE FROM scene_keyframes
            WHERE scene_id = ? AND timestamp_ms = ? AND id != ?
            """,
            (scene_id, timestamp_ms, keyframe_id),
        )
        
        insert_sql = """
            INSERT INTO scene_keyframes (id, scene_id, timestamp_ms, effects_fade_in, effects_fade_out, led_states)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                scene_id = excluded.scene_id,
                timestamp_ms = excluded.timestamp_ms,
                effects_fade_in = excluded.effects_fade_in,
                effects_fade_out = excluded.effects_fade_out,
                led_states = excluded.led_states,
                updated_at = CURRENT_TIMESTAMP
        """
        insert_params = (
            keyframe_id,
            scene_id,
            timestamp_ms,
            fade_in,
            fade_out,
            led_states,
        )
        
        try:
            db.execute(insert_sql, insert_params)
        except sqlite3.IntegrityError:
            # Handle case where timestamp conflict occurs
            db.execute(
                """
                DELETE FROM scene_keyframes
                WHERE scene_id = ? AND timestamp_ms = ? AND id != ?
                """,
                (scene_id, timestamp_ms, keyframe_id),
            )
            db.execute(insert_sql, insert_params)
        
        db.commit()
        return self.get_keyframe(scene_id, keyframe_id)

    def update_keyframe(
        self,
        scene_id: str,
        keyframe_id: str,
        *,
        timestamp_ms: int | None = None,
        fade_in: int | None = None,
        fade_out: int | None = None,
        led_states: str | None = None,
    ) -> sqlite3.Row | None:
        """Update a keyframe."""
        db = self._get_db()
        updates = []
        params: list[object] = []

        if timestamp_ms is not None:
            updates.append("timestamp_ms = ?")
            params.append(timestamp_ms)
            # Delete any existing keyframe at the new timestamp (except this one)
            db.execute(
                """
                DELETE FROM scene_keyframes
                WHERE scene_id = ? AND timestamp_ms = ? AND id != ?
                """,
                (scene_id, timestamp_ms, keyframe_id),
            )

        if fade_in is not None:
            updates.append("effects_fade_in = ?")
            params.append(fade_in)

        if fade_out is not None:
            updates.append("effects_fade_out = ?")
            params.append(fade_out)

        if led_states is not None:
            updates.append("led_states = ?")
            params.append(led_states)

        if not updates:
            return self.get_keyframe(scene_id, keyframe_id)

        updates.append("updated_at = CURRENT_TIMESTAMP")
        params.extend([scene_id, keyframe_id])

        result = db.execute(
            f"""
            UPDATE scene_keyframes
            SET {', '.join(updates)}
            WHERE scene_id = ? AND id = ?
            """,
            params,
        )
        db.commit()

        if result.rowcount == 0:
            return None

        return self.get_keyframe(scene_id, keyframe_id)

    def delete_keyframe(self, scene_id: str, keyframe_id: str) -> bool:
        """Delete a keyframe."""
        db = self._get_db()
        result = db.execute(
            """
            DELETE FROM scene_keyframes
            WHERE scene_id = ? AND id = ?
            """,
            (scene_id, keyframe_id),
        )
        db.commit()
        return result.rowcount > 0


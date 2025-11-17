"""Service for playlist business logic."""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask

from .repository import PlaylistRepository

class PlaylistService:
    """Service for playlist business logic."""

    def __init__(self, app: Flask) -> None:
        self.app = app
        self.repository = PlaylistRepository(app)

    def _serialize_playlist_entry(self, row) -> dict[str, object]:
        """Serialize a playlist entry row to API format."""
        return {
            "id": row["id"],
            "sceneId": row["scene_id"],
            "position": row["position"],
            "playDurationSeconds": row["play_duration_seconds"],
            "fadeDurationSeconds": row["fade_duration_seconds"],
        }

    def get_playlist(self) -> list[dict[str, object]]:
        """Get all playlist entries."""
        rows = self.repository.list_playlist_entries()
        return [self._serialize_playlist_entry(row) for row in rows]

    def update_playlist(self, entries: list[dict[str, object]]) -> list[dict[str, object]]:
        """Update the playlist with new entries."""
        if not isinstance(entries, list):
            raise ValueError("entries must be an array.")

        normalized: list[tuple[str, str, int, int, int]] = []
        for position, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise ValueError("Each entry must be an object.")

            scene_id = entry.get("sceneId")
            if not isinstance(scene_id, str) or not scene_id.strip():
                raise ValueError("sceneId is required for each entry.")
            scene_id = scene_id.strip()

            # Verify scene exists
            if not self.repository.scene_exists(scene_id):
                raise ValueError(f"Scene '{scene_id}' does not exist.")

            entry_id = entry.get("id")
            if not isinstance(entry_id, str) or not entry_id.strip():
                from uuid import uuid4
                entry_id = f"playlist-{uuid4().hex}"
            else:
                entry_id = entry_id.strip()

            try:
                play_duration = int(entry.get("playDurationSeconds", 60))
            except (TypeError, ValueError):
                raise ValueError("Durations must be numeric.")
            
            if play_duration <= 0:
                raise ValueError("playDurationSeconds must be greater than zero.")

            try:
                fade_duration = int(entry.get("fadeDurationSeconds", 5))
            except (TypeError, ValueError):
                raise ValueError("Durations must be numeric.")
            
            if fade_duration < 0:
                raise ValueError("fadeDurationSeconds must be zero or greater.")

            normalized.append((entry_id, scene_id, position, play_duration, fade_duration))

        self.repository.replace_playlist_entries(normalized)
        return self.get_playlist()

    def compute_playlist_hash(self, payload: dict[str, object]) -> str:
        """Compute hash for playlist payload."""
        payload_str = json.dumps(payload, sort_keys=True)
        return hashlib.sha256(payload_str.encode()).hexdigest()[:16]


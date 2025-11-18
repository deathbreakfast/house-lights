"""Playlist playback engine for synchronized playback across devices."""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask

from ..datetime_utils import now_iso

LOGGER = logging.getLogger(__name__)


class PlaylistPlaybackEngine:
    """Manages synchronized playlist playback across devices."""

    def __init__(self, app: Flask) -> None:
        """Initialize the playlist playback engine."""
        self.app = app
        self._playback_state: dict[str, dict[str, object]] = {}  # device_id -> state
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start_playback_all(self, synchronized_start_time_ms: int | None = None) -> None:
        """
        Start playlist playback on all devices simultaneously.
        All devices will start within 1ms of each other.
        """
        if synchronized_start_time_ms is None:
            # Use current time + small buffer for synchronization
            synchronized_start_time_ms = int(time.time() * 1000) + 100

        db = self._get_db()
        device_rows = db.execute("SELECT id FROM devices").fetchall()
        device_ids = [row["id"] for row in device_rows]

        if not device_ids:
            LOGGER.warning("No devices found for playlist playback")
            return

        LOGGER.info(
            "Starting synchronized playlist playback - devices=%d, start_time_ms=%s",
            len(device_ids),
            synchronized_start_time_ms,
        )

        with self._lock:
            for device_id in device_ids:
                self._start_playback(device_id, synchronized_start_time_ms)

        # Start playback thread if not already running
        if not self._thread or not self._thread.is_alive():
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._playback_loop, daemon=True, name="PlaylistPlayback"
            )
            self._thread.start()

    def stop_playback_all(self) -> None:
        """Stop playlist playback on all devices simultaneously."""
        LOGGER.info("Stopping playlist playback on all devices")
        with self._lock:
            for device_id in list(self._playback_state.keys()):
                self._stop_playback(device_id)
        self._stop_event.set()

    def start_playback(self, device_id: str, synchronized_start_time_ms: int | None = None) -> None:
        """Start playlist playback for a single device."""
        if synchronized_start_time_ms is None:
            synchronized_start_time_ms = int(time.time() * 1000) + 100

        with self._lock:
            self._start_playback(device_id, synchronized_start_time_ms)

        # Start playback thread if not already running
        if not self._thread or not self._thread.is_alive():
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._playback_loop, daemon=True, name="PlaylistPlayback"
            )
            self._thread.start()

    def stop_playback(self, device_id: str) -> None:
        """Stop playlist playback for a single device."""
        with self._lock:
            self._stop_playback(device_id)

    def _start_playback(self, device_id: str, synchronized_start_time_ms: int) -> None:
        """Internal method to start playback for a device."""
        from ..json_utils import safe_scene_data

        playlist_payload = None
        
        # Check for follower playlist in app config first (for follower devices)
        follower_playlists = self.app.config.get("FOLLOWER_PLAYLISTS", {})
        if device_id in follower_playlists:
            playlist_payload = safe_scene_data(follower_playlists[device_id])
        else:
            # Try database (for controller devices)
            db = self._get_db()
            row = db.execute(
                """
                SELECT payload
                FROM device_playlists
                WHERE device_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (device_id,),
            ).fetchone()

            if row:
                playlist_payload = safe_scene_data(row["payload"])

        if not playlist_payload:
            LOGGER.warning("No playlist found for device %s", device_id)
            return

        entries = playlist_payload.get("entries", [])
        if not isinstance(entries, list) or not entries:
            LOGGER.warning("No playlist entries found for device %s", device_id)
            return

        self._playback_state[device_id] = {
            "playlist": playlist_payload,
            "entries": entries,
            "current_entry_index": 0,
            "start_time_ms": synchronized_start_time_ms,
            "current_scene_start_ms": synchronized_start_time_ms,
            "is_playing": True,
        }

        LOGGER.info(
            "Started playlist playback for device %s - entries=%d, start_time_ms=%s",
            device_id,
            len(entries),
            synchronized_start_time_ms,
        )

    def _stop_playback(self, device_id: str) -> None:
        """Internal method to stop playback for a device."""
        if device_id in self._playback_state:
            self._playback_state[device_id]["is_playing"] = False
            LOGGER.info("Stopped playlist playback for device %s", device_id)

    def _playback_loop(self) -> None:
        """Main playback loop that runs for all devices."""
        frame_interval_ms = 42  # ~24fps default
        last_update_ms = int(time.time() * 1000)

        while not self._stop_event.is_set():
            current_time_ms = int(time.time() * 1000)
            elapsed_ms = current_time_ms - last_update_ms

            if elapsed_ms < frame_interval_ms:
                time.sleep((frame_interval_ms - elapsed_ms) / 1000.0)
                continue

            last_update_ms = current_time_ms

            with self._lock:
                active_devices = [
                    device_id
                    for device_id, state in self._playback_state.items()
                    if state.get("is_playing", False)
                ]

                if not active_devices:
                    # No active devices, stop thread
                    break

                for device_id in active_devices:
                    try:
                        self._update_device_playback(device_id, current_time_ms)
                    except Exception as exc:
                        LOGGER.error(
                            "Error updating playback for device %s: %s", device_id, exc, exc_info=True
                        )

        LOGGER.debug("Playback loop stopped")

    def _update_device_playback(self, device_id: str, current_time_ms: int) -> None:
        """Update playback state for a single device."""
        state = self._playback_state.get(device_id)
        if not state or not state.get("is_playing", False):
            return

        entries = state["entries"]
        current_index = state["current_entry_index"]
        start_time_ms = state["start_time_ms"]
        current_scene_start_ms = state["current_scene_start_ms"]

        if current_index >= len(entries):
            # Loop back to start
            current_index = 0
            current_scene_start_ms = current_time_ms
            state["current_entry_index"] = 0
            state["current_scene_start_ms"] = current_time_ms

        entry = entries[current_index]
        play_duration_seconds = entry.get("playDurationSeconds", 60)
        fade_duration_seconds = entry.get("fadeDurationSeconds", 5)
        keyframes = entry.get("keyframes", [])

        if not isinstance(keyframes, list):
            keyframes = []

        # Calculate elapsed time in current scene
        elapsed_in_scene_ms = current_time_ms - current_scene_start_ms
        elapsed_in_scene_seconds = elapsed_in_scene_ms / 1000.0

        # Check if we need to transition to next scene
        if elapsed_in_scene_seconds >= play_duration_seconds:
            # Time to fade out and move to next scene
            next_index = (current_index + 1) % len(entries)
            next_entry = entries[next_index]

            # Handle fade transition
            self._fade_transition(device_id, entry, next_entry, fade_duration_seconds)

            # Move to next scene
            state["current_entry_index"] = next_index
            state["current_scene_start_ms"] = current_time_ms
            LOGGER.debug(
                "Transitioned device %s from scene %d to %d",
                device_id,
                current_index,
                next_index,
            )
        else:
            # Play current scene
            self._apply_scene_keyframe(device_id, entry, elapsed_in_scene_ms, fade_duration_seconds)

    def _apply_scene_keyframe(
        self, device_id: str, entry: dict[str, object], elapsed_ms: int, fade_duration_seconds: int
    ) -> None:
        """Apply keyframe from playlist entry at the correct timestamp."""
        keyframes = entry.get("keyframes", [])
        if not isinstance(keyframes, list):
            return

        if not keyframes:
            return

        # Find the most recent keyframe that should be active
        # Keyframes are sorted by timestamp (from playlist build)
        active_keyframe = None
        for kf in keyframes:
            if not isinstance(kf, dict):
                continue
            kf_timestamp = kf.get("timestamp", 0)
            if isinstance(kf_timestamp, (int, float)) and kf_timestamp <= elapsed_ms:
                active_keyframe = kf
            else:
                # Keyframes are sorted, so we can stop here
                break

        # If no keyframe found, use the first one
        if not active_keyframe and keyframes:
            first_kf = keyframes[0]
            if isinstance(first_kf, dict):
                active_keyframe = first_kf

        if not active_keyframe:
            return

        led_states = active_keyframe.get("ledStates", {})
        if not isinstance(led_states, dict):
            return

        # Apply keyframe with fade if needed
        self._apply_keyframe_to_device(device_id, led_states)

    def _fade_transition(
        self,
        device_id: str,
        from_entry: dict[str, object],
        to_entry: dict[str, object],
        fade_duration_seconds: int,
    ) -> None:
        """Handle fade transition between scenes."""
        # For now, we'll just switch to the next scene
        # Full fade implementation would interpolate between LED states
        LOGGER.debug(
            "Fade transition for device %s - fade_duration=%ds",
            device_id,
            fade_duration_seconds,
        )

        # Start playing the next scene
        to_keyframes = to_entry.get("keyframes", [])
        if isinstance(to_keyframes, list) and to_keyframes:
            first_keyframe = to_keyframes[0]
            if isinstance(first_keyframe, dict):
                led_states = first_keyframe.get("ledStates", {})
                if isinstance(led_states, dict):
                    self._apply_keyframe_to_device(device_id, led_states)

    def _apply_keyframe_to_device(self, device_id: str, led_states: dict[str, object]) -> None:
        """Apply keyframe LED states to a device."""
        from ..keyframes.service import KeyframeService

        keyframe_service = KeyframeService(self.app)

        # Filter LED states to only those belonging to this device
        device_led_states: dict[str, object] = {}
        for led_id, state in led_states.items():
            device_id_for_led = keyframe_service._get_device_id_for_led(str(led_id))
            if device_id_for_led == device_id:
                device_led_states[str(led_id)] = state

        if not device_led_states:
            return

        # Apply using keyframe service (this will handle local vs remote)
        # Use a dummy scene_id and timestamp since we're playing from playlist
        keyframe_service.apply_keyframe(
            scene_id="playlist", timestamp_ms=int(time.time() * 1000), led_states=device_led_states
        )

    def _get_db(self):
        """Get database connection."""
        from ...database import get_db
        return get_db(self.app)


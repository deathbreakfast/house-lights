"""Repository for device database operations."""

from __future__ import annotations

import sqlite3
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask

class DeviceRepository:
    """Repository for device database operations."""

    def __init__(self, app: Flask) -> None:
        self.app = app

    def _get_db(self) -> sqlite3.Connection:
        """Get database connection."""
        from ...database import get_db
        return get_db(self.app)

    def _log_device_debug(self, message: str, **kwargs) -> None:
        """Log device debug information."""
        from ..logging_utils import log_device_debug
        log_device_debug(self.app, message, **kwargs)

    def get_device(self, device_id: str) -> sqlite3.Row | None:
        """Get a device by ID."""
        db = self._get_db()
        return db.execute(
            """
            SELECT id, position_x, position_y, ip_address, device_type, strip_mode
            FROM devices
            WHERE id = ?
            """,
            (device_id,),
        ).fetchone()

    def get_all_devices(self) -> list[sqlite3.Row]:
        """Get all devices (global scope)."""
        db = self._get_db()
        return db.execute(
            """
            SELECT id, position_x, position_y, ip_address, device_type, strip_mode
            FROM devices
            ORDER BY created_at ASC
            """
        ).fetchall()

    def update_device(
        self,
        device_id: str,
        *,
        position: dict[str, float] | None = None,
        ip_address: str | None = None,
        device_type: str | None = None,
        strip_mode: str | None = None,
    ) -> sqlite3.Row | None:
        """Update device properties."""
        db = self._get_db()
        updates = []
        params: list[object] = []

        if position is not None:
            updates.append("position_x = ?")
            updates.append("position_y = ?")
            params.extend([position["x"], position["y"]])

        if ip_address is not None:
            updates.append("ip_address = ?")
            params.append(ip_address)

        if device_type is not None:
            updates.append("device_type = ?")
            params.append(device_type)

        if strip_mode is not None:
            updates.append("strip_mode = ?")
            params.append(strip_mode.lower())

        if not updates:
            return self.get_device(device_id)

        self._log_device_debug(
            "Updating device in database",
            device_id=device_id,
            update_fields=updates,
        )

        updates.append("updated_at = CURRENT_TIMESTAMP")
        params.append(device_id)

        result = db.execute(
            f"UPDATE devices SET {', '.join(updates)} WHERE id = ?",
            params,
        )
        db.commit()

        if result.rowcount == 0:
            self._log_device_debug(
                "Device update failed - no rows affected",
                device_id=device_id,
            )
            return None

        self._log_device_debug(
            "Device updated in database",
            device_id=device_id,
            rowcount=result.rowcount,
        )

        return self.get_device(device_id)

    def delete_device(self, device_id: str) -> bool:
        """Delete a device."""
        db = self._get_db()
        result = db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        db.commit()
        return result.rowcount > 0

    def get_device_health(self, device_id: str) -> sqlite3.Row | None:
        """Get device health data."""
        db = self._get_db()
        return db.execute(
            """
            SELECT device_id, last_seen_at, last_heartbeat_at, last_latency_ms, clock_skew_ms,
                   ws_connected, playlist_hash, metadata
            FROM device_health
            WHERE device_id = ?
            """,
            (device_id,),
        ).fetchone()

    def get_device_handshake(self, device_id: str) -> sqlite3.Row | None:
        """Get latest device handshake data."""
        db = self._get_db()
        return db.execute(
            """
            SELECT id, status, clock_skew_ms, responded_at, hardware_id, firmware_version,
                   capabilities, strip_summary, error
            FROM device_handshakes
            WHERE device_id = ?
            ORDER BY responded_at DESC
            LIMIT 1
            """,
            (device_id,),
        ).fetchone()

    def get_devices_health_batch(self, device_ids: list[str]) -> dict[str, sqlite3.Row]:
        """Get health data for multiple devices."""
        if not device_ids:
            return {}
        db = self._get_db()
        placeholders = ",".join("?" for _ in device_ids)
        rows = db.execute(
            f"""
            SELECT device_id, last_seen_at, last_latency_ms, clock_skew_ms,
                   ws_connected, playlist_hash, metadata
            FROM device_health
            WHERE device_id IN ({placeholders})
            """,
            device_ids,
        ).fetchall()
        return {row["device_id"]: row for row in rows}

    def get_device_strips(self, device_id: str) -> list[sqlite3.Row]:
        """Get all strips for a device."""
        db = self._get_db()
        return db.execute(
            """
            SELECT id, gpio_pin, led_count
            FROM led_strips
            WHERE device_id = ?
            ORDER BY created_at ASC
            """,
            (device_id,),
        ).fetchall()

    def get_strip_leds(self, strip_id: str) -> list[sqlite3.Row]:
        """Get all LEDs for a strip."""
        db = self._get_db()
        return db.execute(
            """
            SELECT id, position_x, position_y, color, opacity
            FROM leds
            WHERE strip_id = ?
            ORDER BY created_at ASC
            """,
            (strip_id,),
        ).fetchall()

    def update_led(
        self,
        led_id: str,
        *,
        color: str | None = None,
        opacity: float | None = None,
    ) -> bool:
        """Update LED color/opacity."""
        db = self._get_db()
        updates = []
        params: list[object] = []

        if color is not None:
            updates.append("color = ?")
            params.append(color)

        if opacity is not None:
            updates.append("opacity = ?")
            params.append(opacity)

        if not updates:
            return False

        updates.append("updated_at = CURRENT_TIMESTAMP")
        params.append(led_id)

        result = db.execute(
            f"UPDATE leds SET {', '.join(updates)} WHERE id = ?",
            params,
        )
        db.commit()
        return result.rowcount > 0

    def get_led_by_id_and_device(self, led_id: str, device_id: str) -> sqlite3.Row | None:
        """Get LED by ID, ensuring it belongs to the specified device."""
        db = self._get_db()
        return db.execute(
            """
            SELECT leds.id, leds.color, leds.opacity
            FROM leds
            JOIN led_strips ON leds.strip_id = led_strips.id
            WHERE leds.id = ? AND led_strips.device_id = ?
            """,
            (led_id, device_id),
        ).fetchone()


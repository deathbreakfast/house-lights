"""Service for device persistence operations."""

from __future__ import annotations

import logging
import sqlite3
from typing import TYPE_CHECKING
from uuid import uuid4

if TYPE_CHECKING:
    from flask import Flask
    from ...hardware import LightStripConfig

LOGGER = logging.getLogger(__name__)


class DevicePersistenceService:
    """Service for device persistence operations."""

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

    def generate_led_layout(
        self,
        *,
        led_count: int,
        strip_index: int,
        base_x: float,
        base_y: float,
        id_prefix: str | None = None,
    ) -> list[dict[str, object]]:
        """Generate LED layout positions for a strip."""
        spacing = 18
        start_x = base_x - max(0, (led_count - 1) * spacing / 2)
        offset_y = base_y + 60 + strip_index * 30
        layout: list[dict[str, object]] = []
        for index in range(led_count):
            led_id = (
                f"{id_prefix}-led-{index}" if id_prefix else f"led-{uuid4().hex[:8]}"
            )
            layout.append(
                {
                    "id": led_id,
                    "position": {
                        "x": start_x + index * spacing,
                        "y": offset_y,
                    },
                    "color": "#ffffff",
                    "opacity": 1.0,
                }
            )
        return layout

    def persist_device_graph(
        self,
        *,
        device_id: str,
        ip_address: str,
        position: dict[str, float] | None = None,
        device_type: str = "wifi",
        strip_mode: str | None = None,
        strips: list[dict[str, object]] | None = None,
    ) -> str:
        """
        Persist device graph (device, strips, LEDs) to database.
        Returns the device_id.
        """
        db = self._get_db()
        existing_row = db.execute(
            "SELECT position_x, position_y, strip_mode, ip_address, device_type FROM devices WHERE id = ?",
            (device_id,),
        ).fetchone()

        if position is None and existing_row:
            coords = {
                "x": existing_row["position_x"],
                "y": existing_row["position_y"],
            }
        else:
            coords = position or {"x": 400, "y": 300}

        pos_x = float(coords.get("x", 400))
        pos_y = float(coords.get("y", 300))
        existing_mode = (
            existing_row["strip_mode"] if existing_row else (strip_mode or "auto")
        )
        normalized_strip_mode = existing_mode.lower()
        self._log_device_debug(
            "Persist device graph",
            device_id=device_id,
            device_type=device_type,
            incoming_strip_count=len(strips or []),
            normalized_strip_mode=normalized_strip_mode,
        )

        persisted_ip = ip_address or (
            existing_row["ip_address"] if existing_row else ip_address
        )
        persisted_type = device_type or (
            existing_row["device_type"] if existing_row else device_type
        )

        db.execute(
            """
            INSERT INTO devices (id, position_x, position_y, ip_address, device_type, strip_mode)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                position_x = excluded.position_x,
                position_y = excluded.position_y,
                ip_address = excluded.ip_address,
                device_type = excluded.device_type,
                strip_mode = excluded.strip_mode,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                device_id,
                pos_x,
                pos_y,
                persisted_ip,
                persisted_type,
                normalized_strip_mode,
            ),
        )

        incoming_strips = strips or []
        
        # In manual mode, we still persist strips if they're explicitly provided
        # The "manual mode" skip only applies to auto-generation from device metadata
        if normalized_strip_mode == "manual" and not incoming_strips:
            self._log_device_debug(
                "Persist skip (manual mode, no strips provided)",
                device_id=device_id,
            )
            return device_id
        
        if not incoming_strips:
            return device_id

        existing_strips = db.execute(
            """
            SELECT id, gpio_pin, led_count FROM led_strips
            WHERE device_id = ?
            """,
            (device_id,),
        ).fetchall()
        existing_by_id = {row["id"]: row for row in existing_strips}
        existing_by_pin = {row["gpio_pin"]: row for row in existing_strips}

        seen_strip_ids: set[str] = set()

        for strip_index, strip in enumerate(incoming_strips):
            if not isinstance(strip, dict):
                continue
            gpio_pin = int(
                strip.get("gpioPin")
                or strip.get("pin")
                or strip.get("gpio_pin")
                or 18
            )
            led_count = int(
                strip.get("ledCount")
                or strip.get("led_count")
                or (
                    len(strip.get("leds", []))
                    if isinstance(strip.get("leds"), list)
                    else 10
                )
            )

            target_row: sqlite3.Row | None = None
            strip_id = strip.get("id")
            is_new_strip = False
            if isinstance(strip_id, str) and strip_id in existing_by_id:
                target_row = existing_by_id[strip_id]
            elif gpio_pin in existing_by_pin:
                target_row = existing_by_pin[gpio_pin]
                strip_id = target_row["id"]

            if target_row is None:
                is_new_strip = True
                strip_id = strip_id or f"{device_id}-strip-{uuid4().hex[:8]}"
                db.execute(
                    """
                    INSERT INTO led_strips (id, device_id, gpio_pin, led_count)
                    VALUES (?, ?, ?, ?)
                    """,
                    (strip_id, device_id, gpio_pin, led_count),
                )
                target_row = {
                    "id": strip_id,
                    "gpio_pin": gpio_pin,
                    "led_count": led_count,
                }
                self._log_device_debug(
                    "Created strip",
                    device_id=device_id,
                    strip_id=strip_id,
                    gpio_pin=gpio_pin,
                    led_count=led_count,
                )

            seen_strip_ids.add(strip_id)
            metadata_changed = False
            if (
                target_row["gpio_pin"] != gpio_pin
                or target_row["led_count"] != led_count
            ):
                metadata_changed = True
                db.execute(
                    """
                    UPDATE led_strips
                    SET gpio_pin = ?, led_count = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (gpio_pin, led_count, strip_id),
                )

            leds_payload = strip.get("leds")
            should_refresh_leds = False
            
            # Check if LEDs exist for this strip
            existing_led_count = db.execute(
                "SELECT COUNT(*) as count FROM leds WHERE strip_id = ?",
                (strip_id,),
            ).fetchone()["count"]
            
            # Generate LEDs if:
            # 1. LEDs are provided in payload
            # 2. Metadata changed (pin or count changed) and we need to regenerate
            # 3. This is a new strip with no LEDs yet
            if isinstance(leds_payload, list) and leds_payload:
                should_refresh_leds = True
                self._log_device_debug(
                    "Strip metadata changed",
                    device_id=device_id,
                    strip_id=strip_id,
                    gpio_pin=gpio_pin,
                    led_count=led_count,
                )
            elif metadata_changed or (is_new_strip and existing_led_count == 0):
                should_refresh_leds = True
                leds_payload = self.generate_led_layout(
                    led_count=led_count,
                    strip_index=strip_index,
                    base_x=pos_x,
                    base_y=pos_y,
                    id_prefix=f"{device_id}-{strip_id}",
                )

            if should_refresh_leds and isinstance(leds_payload, list):
                db.execute("DELETE FROM leds WHERE strip_id = ?", (strip_id,))
                for led in leds_payload:
                    led_id = led.get("id") or f"led-{uuid4().hex}"
                    led_position = led.get("position", {})
                    db.execute(
                        """
                        INSERT INTO leds (id, strip_id, position_x, position_y, color, opacity)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            position_x = excluded.position_x,
                            position_y = excluded.position_y,
                            color = excluded.color,
                            opacity = excluded.opacity,
                            updated_at = CURRENT_TIMESTAMP
                        """,
                        (
                            led_id,
                            strip_id,
                            float(led_position.get("x", pos_x)),
                            float(led_position.get("y", pos_y)),
                            led.get("color", "#ffffff"),
                            float(led.get("opacity", 1.0)),
                        ),
                    )

        existing_ids = {row["id"] for row in existing_strips}
        to_remove = existing_ids - seen_strip_ids
        for strip_id in to_remove:
            db.execute("DELETE FROM leds WHERE strip_id = ?", (strip_id,))
            db.execute("DELETE FROM led_strips WHERE id = ?", (strip_id,))
            self._log_device_debug(
                "Removed strip",
                device_id=device_id,
                strip_id=strip_id,
            )

        return device_id

    def ensure_local_device_strips(
        self,
        *,
        device_id: str,
        strip_configs: list[LightStripConfig],
    ) -> list[dict[str, object]]:
        """
        Ensure local device has strips based on configuration.
        Returns list of strip payloads that were created/updated.
        """
        if not strip_configs:
            return []

        db = self._get_db()
        device_row = db.execute(
            """
            SELECT id, position_x, position_y, device_type, strip_mode
            FROM devices
            WHERE id = ?
            """,
            (device_id,),
        ).fetchone()

        if not device_row:
            return []

        base_x = float(device_row["position_x"])
        base_y = float(device_row["position_y"])

        existing_strips = db.execute(
            """
            SELECT id, gpio_pin, led_count FROM led_strips
            WHERE device_id = ?
            """,
            (device_id,),
        ).fetchall()
        existing_by_pin = {row["gpio_pin"]: row for row in existing_strips}

        strips_payload: list[dict[str, object]] = []
        tracked_ids: set[str] = set()

        for index, config in enumerate(strip_configs):
            strip_row = existing_by_pin.get(config.pin)
            if strip_row:
                strip_id = strip_row["id"]
                tracked_ids.add(strip_id)
                if strip_row["led_count"] != config.led_count:
                    db.execute(
                        "UPDATE led_strips SET led_count = ? WHERE id = ?",
                        (config.led_count, strip_id),
                    )
            else:
                strip_id = f"{device_id}-pin-{config.pin}"
                tracked_ids.add(strip_id)
                db.execute(
                    """
                    INSERT INTO led_strips (id, device_id, gpio_pin, led_count)
                    VALUES (?, ?, ?, ?)
                    """,
                    (strip_id, device_id, config.pin, config.led_count),
                )

            db.execute("DELETE FROM leds WHERE strip_id = ?", (strip_id,))
            leds_layout = self.generate_led_layout(
                led_count=config.led_count,
                strip_index=index,
                base_x=base_x,
                base_y=base_y,
                id_prefix=f"{device_id}-{strip_id}",
            )
            for led in leds_layout:
                position = led.get("position", {})
                db.execute(
                    """
                    INSERT INTO leds (id, strip_id, position_x, position_y, color, opacity)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        led.get("id") or f"led-{uuid4().hex}",
                        strip_id,
                        float(position.get("x", base_x)),
                        float(position.get("y", base_y)),
                        led.get("color", "#ffffff"),
                        float(led.get("opacity", 1.0)),
                    ),
                )

            strips_payload.append(
                {
                    "id": strip_id,
                    "gpioPin": config.pin,
                    "ledCount": config.led_count,
                    "leds": leds_layout,
                }
            )

        # Remove strips that are no longer in config
        existing_ids = {row["id"] for row in existing_strips}
        to_remove = existing_ids - tracked_ids
        for strip_id in to_remove:
            db.execute("DELETE FROM leds WHERE strip_id = ?", (strip_id,))
            db.execute("DELETE FROM led_strips WHERE id = ?", (strip_id,))

        return strips_payload

    def seed_local_device(self) -> None:
        """Seed a local device if it doesn't exist (global scope)."""
        if not self.app.config.get("IS_CONTROLLER", True):
            return

        env_configs: list[LightStripConfig] = self.app.config.get("STRIP_CONFIGS", [])
        if not env_configs:
            return

        db = self._get_db()
        device_id = "device-local-default"
        ip_address = "127.0.0.1"
        existing = db.execute(
            "SELECT id FROM devices WHERE id = ? AND ip_address IN ('127.0.0.1', 'localhost')",
            (device_id,),
        ).fetchone()
        if existing:
            return

        strips_payload: list[dict[str, object]] = []
        for config in env_configs:
            strip_id = f"{device_id}-pin-{config.pin}"
            strips_payload.append(
                {
                    "id": strip_id,
                    "gpioPin": config.pin,
                    "ledCount": config.led_count,
                }
            )

        self.persist_device_graph(
            device_id=device_id,
            ip_address=ip_address,
            position={"x": 400, "y": 300},
            device_type="wifi",
            strip_mode="auto",
            strips=strips_payload,
        )
        db.commit()


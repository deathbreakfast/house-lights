"""Configuration helpers and shared constants for the House Lights server."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

from ..hardware import LightStripConfig

LOGGER = logging.getLogger(__name__)

SIMULATOR_PIN_POOL: tuple[int, ...] = (18, 13)
MAX_SIMULATED_STRIPS = len(SIMULATOR_PIN_POOL)
MAX_LED_COUNT_PER_STRIP = 250

STUDIO_BACKGROUND_SCENE_ID = "__studio_background__"

DEFAULT_PATTERN_DEFINITIONS: List[Dict[str, object]] = [
    {
        "id": "all_on_white",
        "name": "All On (White)",
        "description": "All strips illuminated with white light.",
        "frame_rate": 8,
        "duration": 10,
        "loop": True,
        "default_color": "#ffffff",
    },
    {
        "id": "xmas_solid",
        "name": "X-Mas (Solid)",
        "description": "Alternating red, green, and blue across every LED.",
        "frame_rate": 8,
        "duration": 10,
        "loop": True,
        "color_cycle": ["#ff0000", "#00ff00", "#0000ff"],
    },
    {
        "id": "xmas_cool_solid",
        "name": "X-Mas (Cool, Solid)",
        "description": "Alternating blue and white across every LED.",
        "frame_rate": 8,
        "duration": 10,
        "loop": True,
        "color_cycle": ["#0000ff", "#ffffff"],
    },
    {
        "id": "halloween_solid",
        "name": "Halloween (Solid)",
        "description": "Alternating orange and purple across every LED.",
        "frame_rate": 8,
        "duration": 10,
        "loop": True,
        "color_cycle": ["#ff4000", "#800080"],
    },
    {
        "id": "valentine_solid",
        "name": "Valentine (Solid)",
        "description": "Alternating white and pink across every LED.",
        "frame_rate": 8,
        "duration": 10,
        "loop": True,
        "color_cycle": ["#ffffff", "#ff69b4"],
    },
]

LEGACY_PATTERN_IDS_TO_REMOVE: set[str] = {"warm_glow", "rainbow_wave"}


@dataclass(frozen=True)
class ConfigEntry:
    """Describe an entry in a GPIO or light-range configuration string."""

    label: str
    detail: Optional[str] = None


def env_flag(name: str, default: bool = False) -> bool:
    """Return True if the environment variable evaluates to truthy, else default."""
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_config_list(raw_value: Optional[str]) -> List[ConfigEntry]:
    """Parse a comma separated list of entries like `18:Window` into ConfigEntry values."""
    if not raw_value:
        return []

    entries: List[ConfigEntry] = []
    for chunk in raw_value.split(","):
        value = chunk.strip()
        if not value:
            continue

        if ":" in value:
            label, detail = value.split(":", 1)
        elif "=" in value:
            label, detail = value.split("=", 1)
        else:
            label, detail = value, ""

        entries.append(ConfigEntry(label=label.strip(), detail=detail.strip() or None))

    return entries


def parse_led_counts(raw_value: Optional[str]) -> Dict[int, int]:
    """Parse pin=count segments into a mapping used for LightStrip definitions."""
    if not raw_value:
        return {}

    counts: Dict[int, int] = {}
    for chunk in raw_value.split(","):
        if "=" not in chunk:
            continue
        pin_raw, count_raw = chunk.split("=", 1)
        try:
            pin = int(pin_raw.strip())
            count = int(count_raw.strip())
        except ValueError:
            LOGGER.warning("Invalid LED count entry '%s'; expected format pin=count.", chunk)
            continue
        if count <= 0:
            LOGGER.warning("Ignoring non-positive LED count %s for pin %s.", count, pin)
            continue
        counts[pin] = count
    return counts


def build_strip_configs(
    gpio_entries: Sequence[ConfigEntry], led_counts: Dict[int, int]
) -> List[LightStripConfig]:
    """Convert parsed GPIO entries into concrete LightStripConfig objects."""
    configs: List[LightStripConfig] = []
    for entry in gpio_entries:
        try:
            pin = int(entry.label)
        except ValueError:
            LOGGER.warning("Skipping GPIO entry with non-numeric pin '%s'.", entry.label)
            continue

        count = led_counts.get(pin)
        if count is None:
            LOGGER.debug(
                "No LED count configured for pin %s; skipping hardware setup for this pin.",
                pin,
            )
            continue

        configs.append(LightStripConfig(pin=pin, led_count=count, name=entry.detail))

    return list(configs)



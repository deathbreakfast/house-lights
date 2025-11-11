"""Hardware integration helpers for House Lights."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Protocol

LOGGER = logging.getLogger(__name__)

try:
    from rpi_ws281x import Color, PixelStrip  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    Color = None  # type: ignore
    PixelStrip = None  # type: ignore


@dataclass(frozen=True)
class LightStripConfig:
    """Describe the configuration of a single LED strip."""

    pin: int
    led_count: int
    name: str | None = None


class LightController(Protocol):
    """Interface for hardware light controllers."""

    def set_power(self, is_on: bool) -> None:
        """Turn the lighting system on or off."""

    def apply_pattern(self, pattern_id: str) -> None:
        """Activate the given lighting pattern."""


class NoopLightController:
    """Fallback controller used when hardware is not available."""

    def __init__(self, strip_configs: list[LightStripConfig]) -> None:
        self.strip_configs = strip_configs

    def set_power(self, is_on: bool) -> None:  # pragma: no cover - logging only
        LOGGER.info(
            "NoopLightController.set_power called with %s; strips=%s",
            is_on,
            self.strip_configs,
        )

    def apply_pattern(self, pattern_id: str) -> None:  # pragma: no cover - logging only
        LOGGER.info(
            "NoopLightController.apply_pattern called with pattern=%s; strips=%s",
            pattern_id,
            self.strip_configs,
        )


class Ws2811LightController:
    """Controller implementation for WS2811-compatible LED strips."""

    def __init__(self, strip_configs: list[LightStripConfig]) -> None:
        if PixelStrip is None or Color is None:
            raise RuntimeError(
                "rpi_ws281x library is not available; cannot initialize WS2811 controller."
            )

        if not strip_configs:
            raise ValueError("At least one strip configuration is required.")

        self._strip_configs = strip_configs
        self._strips: list[PixelStrip] = []
        self._last_pattern: str = "all_on_white"

        for idx, config in enumerate(strip_configs):
            channel = 0 if idx == 0 else 1
            if channel > 1:
                LOGGER.warning(
                    "rpi_ws281x supports only two channels; strip on pin %s will be ignored.",
                    config.pin,
                )
                continue

            strip = PixelStrip(
                config.led_count,
                config.pin,
                freq_hz=800000,
                dma=10,
                invert=False,
                brightness=255,
                channel=channel,
            )
            strip.begin()
            self._strips.append(strip)
            LOGGER.info(
                "Initialized WS2811 strip: pin=%s, leds=%s, channel=%s", config.pin, config.led_count, channel
            )

    def set_power(self, is_on: bool) -> None:
        if is_on:
            LOGGER.info("Powering on lighting; reapplying pattern %s", self._last_pattern)
            self.apply_pattern(self._last_pattern)
            return

        LOGGER.info("Powering off lighting; clearing all strips.")
        for strip in self._strips:
            for idx in range(strip.numPixels()):
                strip.setPixelColor(idx, Color(0, 0, 0))
            strip.show()

    def apply_pattern(self, pattern_id: str) -> None:
        LOGGER.info("Applying pattern %s", pattern_id)
        self._last_pattern = pattern_id

        if pattern_id == "all_on_white":
            self._apply_all_on_white()
        else:
            LOGGER.warning("Pattern %s not implemented for hardware controller.", pattern_id)

    def _apply_all_on_white(self) -> None:
        for strip in self._strips:
            for idx in range(strip.numPixels()):
                strip.setPixelColor(idx, Color(255, 255, 255))
            strip.show()


def should_enable_hardware() -> bool:
    """Returns True if the hardware controller should be activated."""
    raw_value = os.getenv("HOUSE_LIGHTS_ENABLE_HARDWARE", "").strip().lower()
    return raw_value in {"1", "true", "yes", "on"}


def build_controller(strip_configs: list[LightStripConfig]) -> LightController:
    """Construct an appropriate light controller based on environment."""
    if not should_enable_hardware():
        LOGGER.info("Hardware control disabled; using NoopLightController.")
        return NoopLightController(strip_configs)

    try:
        controller = Ws2811LightController(strip_configs)
        LOGGER.info("WS2811 hardware controller initialized.")
        return controller
    except Exception as exc:  # pragma: no cover - defensive logging
        LOGGER.exception("Failed to initialize WS2811 hardware controller: %s", exc)
        LOGGER.warning("Falling back to NoopLightController.")
        return NoopLightController(strip_configs)



"""Hardware integration helpers for House Lights."""

from __future__ import annotations

import logging
import time
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

    def render_pattern(self, pattern_payload: dict, strips: list["LightStripConfig"]) -> None:
        """Render a rich pattern definition onto the configured strips."""

    def set_pixel_test(
        self, strip_pin: int, pixel_index: int, color: tuple[int, int, int] | None
    ) -> None:
        """Set a single pixel to a color for testing purposes; None turns it off."""


class NoopLightController:
    """Fallback controller used when hardware is not available."""

    def __init__(self, strip_configs: list[LightStripConfig]) -> None:
        self.strip_configs = strip_configs
        self._strip_map = {config.pin: config for config in strip_configs}

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

    def render_pattern(
        self, pattern_payload: dict, strips: list[LightStripConfig]
    ) -> None:  # pragma: no cover - logging only
        LOGGER.info(
            "NoopLightController.render_pattern called with pattern=%s; strips=%s payload_keys=%s",
            pattern_payload.get("id"),
            strips,
            list(pattern_payload.keys()),
        )

    def set_pixel_test(
        self, strip_pin: int, pixel_index: int, color: tuple[int, int, int] | None
    ) -> None:  # pragma: no cover - logging only
        strip = self._strip_map.get(strip_pin)
        LOGGER.info(
            "NoopLightController.set_pixel_test pin=%s index=%s color=%s (strip=%s)",
            strip_pin,
            pixel_index,
            color,
            strip,
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
        self._strip_by_pin: dict[int, PixelStrip] = {}

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
            self._strip_by_pin[config.pin] = strip
            LOGGER.info(
                "Initialized WS2811 strip: pin=%s, leds=%s, channel=%s", config.pin, config.led_count, channel
            )

    @staticmethod
    def _clamp_byte(value: float) -> int:
        return max(0, min(255, int(round(value))))

    @staticmethod
    def _hex_to_rgb(value: str) -> tuple[int, int, int]:
        stripped = value.strip().lower()
        if stripped.startswith("#"):
            stripped = stripped[1:]
        if len(stripped) != 6:
            return (255, 255, 255)
        try:
            r = int(stripped[0:2], 16)
            g = int(stripped[2:4], 16)
            b = int(stripped[4:6], 16)
        except ValueError:
            return (255, 255, 255)
        return r, g, b

    @staticmethod
    def _encode_color(red: int, green: int, blue: int) -> int:
        """Map standard RGB tuples to the hardware's GRB encoding."""
        return Color(green, red, blue)

    def set_power(self, is_on: bool) -> None:
        if is_on:
            LOGGER.info("Powering on lighting; reapplying pattern %s", self._last_pattern)
            self.apply_pattern(self._last_pattern)
            return

        LOGGER.info("Powering off lighting; clearing all strips.")
        for strip in self._strips:
            for idx in range(strip.numPixels()):
                strip.setPixelColor(idx, self._encode_color(0, 0, 0))
            strip.show()

    def set_pixel_test(
        self, strip_pin: int, pixel_index: int, color: tuple[int, int, int] | None
    ) -> None:
        strip = self._strip_by_pin.get(strip_pin)
        if strip is None:
            LOGGER.warning(
                "set_pixel_test called for unknown strip pin=%s (available=%s)",
                strip_pin,
                list(self._strip_by_pin),
            )
            return

        if pixel_index < 0 or pixel_index >= strip.numPixels():
            LOGGER.warning(
                "set_pixel_test received out-of-range pixel_index=%s for pin=%s (max=%s)",
                pixel_index,
                strip_pin,
                strip.numPixels(),
            )
            return

        if color is None:
            strip.setPixelColor(pixel_index, self._encode_color(0, 0, 0))
        else:
            r, g, b = color
            strip.setPixelColor(pixel_index, self._encode_color(r, g, b))
        strip.show()

    def apply_pattern(self, pattern_id: str) -> None:
        LOGGER.info("Applying pattern %s", pattern_id)
        self._last_pattern = pattern_id

        if pattern_id == "all_on_white":
            self._apply_all_on_white()
        else:
            LOGGER.warning("Pattern %s not implemented for hardware controller.", pattern_id)

    def render_pattern(self, pattern_payload: dict, strips: list[LightStripConfig]) -> None:
        pattern_id = pattern_payload.get("id") or pattern_payload.get("name") or "<unnamed>"
        LOGGER.info("Rendering pattern payload %s", pattern_id)
        self._last_pattern = pattern_id

        if not self._strips:
            LOGGER.warning("No hardware strips initialized; skipping render.")
            return

        states: dict[int, list[int]] = {}
        for config in strips:
            strip = self._strip_by_pin.get(config.pin)
            if strip is None:
                LOGGER.debug("Skipping pattern render for unknown strip pin=%s", config.pin)
                continue
            states[config.pin] = [self._encode_color(0, 0, 0) for _ in range(config.led_count)]

        keyframes = pattern_payload.get("keyframes") or []
        try:
            sorted_keyframes = sorted(
                keyframes,
                key=lambda frame: float(frame.get("time", 0.0)),
            )
        except Exception:  # pragma: no cover - defensive
            LOGGER.exception("Failed sorting keyframes; applying in original order.")
            sorted_keyframes = keyframes

        frame_rate = pattern_payload.get("frame_rate")
        try:
            frame_rate_value = float(frame_rate)
        except (TypeError, ValueError):
            frame_rate_value = 8.0
        frame_rate_value = max(frame_rate_value, 0.1)
        step_duration = 1.0 / frame_rate_value

        duration_value = pattern_payload.get("duration")
        try:
            duration_seconds = float(duration_value)
        except (TypeError, ValueError):
            duration_seconds = sorted_keyframes[-1]["time"] if sorted_keyframes else 30.0
        duration_seconds = max(duration_seconds, step_duration)

        current_time = 0.0
        start_time = time.monotonic()
        frame_index = 0

        while current_time <= duration_seconds and frame_index < len(sorted_keyframes):
            frame = sorted_keyframes[frame_index]
            frame_time = float(frame.get("time", 0.0))
            if current_time + 1e-6 < frame_time:
                current_time = frame_time
            overrides = frame.get("overrides")
            if isinstance(overrides, dict):
                for key, override in overrides.items():
                    if not isinstance(key, str):
                        continue
                    try:
                        pin_str, index_str = key.split(":")
                        pin = int(pin_str)
                        index = int(index_str)
                    except (ValueError, TypeError):
                        LOGGER.debug("Invalid override key '%s'; expected 'pin:index'.", key)
                        continue
                    strip_state = states.get(pin)
                    if strip_state is None or not (0 <= index < len(strip_state)):
                        continue
                    is_on = True
                    color_hex = "#ffffff"
                    brightness_value = 100
                    if isinstance(override, dict):
                        if override.get("on") is False:
                            is_on = False
                        color_hex = override.get("color", "#ffffff")
                        brightness_value = override.get("brightness", 100)
                    if not is_on:
                        strip_state[index] = self._encode_color(0, 0, 0)
                        continue
                    base_r, base_g, base_b = self._hex_to_rgb(str(color_hex))
                    try:
                        brightness_pct = float(brightness_value)
                    except (TypeError, ValueError):
                        brightness_pct = 100.0
                    brightness_pct = max(0.0, min(100.0, brightness_pct))
                    factor = brightness_pct / 100.0
                    red = self._clamp_byte(base_r * factor)
                    green = self._clamp_byte(base_g * factor)
                    blue = self._clamp_byte(base_b * factor)
                    strip_state[index] = self._encode_color(red, green, blue)

                    strip = self._strip_by_pin.get(pin)
                    if strip is not None and index < strip.numPixels():
                        strip.setPixelColor(index, strip_state[index])

            for config in strips:
                strip = self._strip_by_pin.get(config.pin)
                if strip is None:
                    continue
                strip_state = states.get(config.pin)
                if strip_state is None:
                    continue
                strip.show()

            frame_index += 1
            current_time = frame_time
            deadline = start_time + current_time
            now = time.monotonic()
            if deadline > now:
                time.sleep(deadline - now)

    def _apply_all_on_white(self) -> None:
        for strip in self._strips:
            for idx in range(strip.numPixels()):
                strip.setPixelColor(idx, self._encode_color(255, 255, 255))
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



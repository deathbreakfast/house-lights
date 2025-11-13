"""Hardware integration helpers for House Lights."""

from __future__ import annotations

import logging
import threading
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

    def stop_pattern(self) -> None:
        """Stop any active pattern playback."""

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

    def stop_pattern(self) -> None:  # pragma: no cover - logging only
        LOGGER.info("NoopLightController.stop_pattern called")

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
        self._playback_worker: PatternPlaybackWorker | None = None
        self._playback_lock = threading.Lock()

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
        self.stop_pattern()
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

        with self._playback_lock:
            if self._playback_worker is not None:
                self._playback_worker.stop()
                self._playback_worker = None

            worker = PatternPlaybackWorker(self, pattern_payload, strips, self._strip_by_pin)
            if not worker.frames:
                LOGGER.warning("Pattern %s produced no frames; skipping playback.", pattern_id)
                return
            worker.start()
            self._playback_worker = worker

    def stop_pattern(self) -> None:
        with self._playback_lock:
            if self._playback_worker is not None:
                self._playback_worker.stop()
                self._playback_worker = None

    def _apply_all_on_white(self) -> None:
        for strip in self._strips:
            for idx in range(strip.numPixels()):
                strip.setPixelColor(idx, self._encode_color(255, 255, 255))
            strip.show()


class PatternPlaybackWorker:
    def __init__(
        self,
        controller: "Ws2811LightController",
        pattern_payload: dict,
        pattern_strips: list[LightStripConfig],
        strip_map: dict[int, PixelStrip],
    ) -> None:
        self._controller = controller
        self._stop_event = threading.Event()
        self._strip_map = strip_map
        self.frames, self.durations = self._build_frames(pattern_payload, pattern_strips)
        self.loop_enabled = bool(pattern_payload.get("loop", True))
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._thread.join(timeout=2.0)

    def _run(self) -> None:
        if not self.frames:
            return

        while not self._stop_event.is_set():
            for frame, duration in zip(self.frames, self.durations):
                if self._stop_event.is_set():
                    return
                self._write_frame(frame)
                if duration <= 0:
                    continue
                if self._stop_event.wait(duration):
                    return
            if not self.loop_enabled:
                break

    def _write_frame(self, frame: dict[int, list[int]]) -> None:
        for pin, strip in self._strip_map.items():
            state = frame.get(pin)
            if state is None:
                state = [self._controller._encode_color(0, 0, 0) for _ in range(strip.numPixels())]
            for idx in range(strip.numPixels()):
                color_value = state[idx] if idx < len(state) else self._controller._encode_color(0, 0, 0)
                strip.setPixelColor(idx, color_value)
            strip.show()

    @staticmethod
    def _safe_float(value, fallback: float) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return fallback

    def _build_frames(
        self, pattern_payload: dict, pattern_strips: list[LightStripConfig]
    ) -> tuple[list[dict[int, list[int]]], list[float]]:
        available_strips: dict[int, PixelStrip] = {
            pin: strip for pin, strip in self._strip_map.items() if strip is not None
        }

        if not available_strips:
            return ([], [])

        strip_lengths: dict[int, int] = {
            pin: strip.numPixels() for pin, strip in available_strips.items()
        }

        default_state = self._controller._encode_color(0, 0, 0)

        keyframes = pattern_payload.get("keyframes") or []
        try:
            sorted_keyframes = sorted(
                keyframes, key=lambda frame: self._safe_float(frame.get("time", 0.0), 0.0)
            )
        except Exception:  # pragma: no cover - defensive
            LOGGER.exception("Failed sorting keyframes; applying in original order.")
            sorted_keyframes = keyframes

        frame_rate = self._safe_float(pattern_payload.get("frame_rate"), 8.0)
        frame_rate = max(frame_rate, 0.1)
        minimum_step = 1.0 / frame_rate

        duration = self._safe_float(pattern_payload.get("duration"), 0.0)
        if not sorted_keyframes:
            duration = max(duration, minimum_step)

        frames: list[dict[int, list[int]]] = []
        durations: list[float] = []

        def build_blank_frame() -> dict[int, list[int]]:
            return {
                pin: [default_state for _ in range(strip_lengths[pin])]
                for pin in available_strips
            }

        if not sorted_keyframes:
            frames.append(build_blank_frame())
            durations.append(duration or minimum_step)
            return frames, durations

        last_time = 0.0
        for index, frame in enumerate(sorted_keyframes):
            frame_time = self._safe_float(frame.get("time", last_time), last_time)
            frame_time = max(frame_time, last_time)
            frame_states = build_blank_frame()
            overrides = frame.get("overrides")
            if isinstance(overrides, dict):
                for key, override in overrides.items():
                    if not isinstance(key, str):
                        continue
                    try:
                        pin_str, index_str = key.split(":")
                        pin = int(pin_str)
                        pixel_index = int(index_str)
                    except (ValueError, TypeError):
                        LOGGER.debug("Invalid override key '%s'; expected 'pin:index'.", key)
                        continue
                    if pin not in frame_states:
                        continue
                    strip_len = strip_lengths[pin]
                    if not (0 <= pixel_index < strip_len):
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
                        frame_states[pin][pixel_index] = default_state
                        continue
                    base_r, base_g, base_b = self._controller._hex_to_rgb(str(color_hex))
                    brightness_pct = self._safe_float(brightness_value, 100.0)
                    brightness_pct = max(0.0, min(100.0, brightness_pct))
                    factor = brightness_pct / 100.0
                    red = self._controller._clamp_byte(base_r * factor)
                    green = self._controller._clamp_byte(base_g * factor)
                    blue = self._controller._clamp_byte(base_b * factor)
                    frame_states[pin][pixel_index] = self._controller._encode_color(red, green, blue)

            frames.append(frame_states)

            if index + 1 < len(sorted_keyframes):
                next_time = self._safe_float(sorted_keyframes[index + 1].get("time", frame_time), frame_time)
            else:
                next_time = max(duration, frame_time + minimum_step)
            frame_duration = max(minimum_step, next_time - frame_time)
            durations.append(frame_duration)
            last_time = frame_time

        return frames, durations


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



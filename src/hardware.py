"""Hardware integration helpers for House Lights."""

from __future__ import annotations

import logging
import threading
import time
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

LOGGER = logging.getLogger(__name__)

try:
    from rpi_ws281x import Color, PixelStrip  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    Color = None  # type: ignore
    PixelStrip = None  # type: ignore

if TYPE_CHECKING:
    from flask import Flask


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

    def apply_led_states(self, led_states: dict[str, dict[str, object]]) -> None:
        """Apply LED states directly to hardware (no-op for NoopLightController)."""
        LOGGER.info(
            "NoopLightController.apply_led_states called with %d LED states",
            len(led_states),
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

    def apply_led_states(self, led_states: dict[str, dict[str, object]]) -> None:
        """Apply LED states directly to hardware from a dict mapping LED IDs to {color, opacity}."""
        if not self._strip_by_pin:
            LOGGER.warning("No hardware strips available")
            return
        
        # LED IDs are typically: "{device_id}-{strip_id}-led-{index}" or "{device_id}-pin-{pin}-led-{index}"
        # We need to parse them to extract pin and index
        parsed_count = 0
        skipped_count = 0
        sample_skipped_ids = []
        
        for led_id, led_state in led_states.items():
            try:
                # Parse LED ID to extract pin and index
                # Format: "{device_id}-pin-{pin}-led-{index}" or similar
                parts = led_id.split("-")
                pin: int | None = None
                index: int | None = None
                
                # Look for pin and led index in the ID
                for i, part in enumerate(parts):
                    if part == "pin" and i + 1 < len(parts):
                        try:
                            pin = int(parts[i + 1])
                        except (ValueError, IndexError):
                            pass
                    elif part == "led" and i + 1 < len(parts):
                        try:
                            index = int(parts[i + 1])
                        except (ValueError, IndexError):
                            pass
                
                if pin is None or index is None:
                    skipped_count += 1
                    if len(sample_skipped_ids) < 5:
                        sample_skipped_ids.append(led_id)
                    LOGGER.debug("Failed to parse LED ID %s: pin=%s, index=%s, parts=%s", led_id, pin, index, parts)
                    continue
                
                # Get color and opacity
                color_str = str(led_state.get("color", "#000000"))
                opacity = float(led_state.get("opacity", 1.0))
                
                # Convert hex color to RGB
                rgb = self._hex_to_rgb(color_str)
                r, g, b = rgb
                
                # Apply opacity
                r = int(r * opacity)
                g = int(g * opacity)
                b = int(b * opacity)
                
                # Apply to hardware
                strip = self._strip_by_pin.get(pin)
                if strip and 0 <= index < strip.numPixels():
                    strip.setPixelColor(index, self._encode_color(r, g, b))
                    parsed_count += 1
                else:
                    skipped_count += 1
                    LOGGER.debug("LED ID %s: strip not found for pin=%s or index=%s out of range (strip=%s, pixels=%s)", 
                               led_id, pin, index, strip is not None, strip.numPixels() if strip else 0)
            
            except Exception as exc:
                skipped_count += 1
                LOGGER.warning("Error applying LED state for %s: %s", led_id, exc)
        
        # Log summary
        if skipped_count > 0:
            LOGGER.warning("LED application: %d parsed, %d skipped out of %d total. Sample skipped IDs: %s", 
                          parsed_count, skipped_count, len(led_states), sample_skipped_ids[:5])
        else:
            LOGGER.debug("LED application: %d LEDs successfully applied", parsed_count)
        
        # Show all changes at once
        for strip in self._strips:
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

        previous_frame: dict[int, list[int]] = {
            pin: [default_state] * length for pin, length in strip_lengths.items()
        }

        for frame_idx, keyframe in enumerate(sorted_keyframes):
            frame_time = self._safe_float(keyframe.get("time", 0.0), 0.0)
            frame_duration = self._safe_float(keyframe.get("duration"), minimum_step)

            frame_data = keyframe.get("frames") or {}
            if not isinstance(frame_data, dict):
                frame_data = {}

            current_frame: dict[int, list[int]] = {}
            for pin, length in strip_lengths.items():
                strip_frame = frame_data.get(str(pin)) or frame_data.get(pin)
                if not isinstance(strip_frame, list):
                    strip_frame = previous_frame.get(pin, [default_state] * length)

                strip_frame_list: list[int] = []
                for idx in range(length):
                    if idx < len(strip_frame):
                        pixel_value = strip_frame[idx]
                        if isinstance(pixel_value, dict):
                            color = pixel_value.get("color", "#ffffff")
                            opacity = self._safe_float(pixel_value.get("opacity"), 1.0)
                            rgb = self._controller._hex_to_rgb(str(color))
                            r, g, b = rgb
                            r = int(r * opacity)
                            g = int(g * opacity)
                            b = int(b * opacity)
                            strip_frame_list.append(self._controller._encode_color(r, g, b))
                        elif isinstance(pixel_value, (int, float)):
                            strip_frame_list.append(int(pixel_value))
                        else:
                            strip_frame_list.append(default_state)
            else:
                        strip_frame_list.append(default_state)

                current_frame[pin] = strip_frame_list

            frames.append(current_frame)
            durations.append(frame_duration)
            previous_frame = current_frame

        if not frames:
            single_frame: dict[int, list[int]] = {
                pin: [default_state] * length for pin, length in strip_lengths.items()
            }
            frames.append(single_frame)
            durations.append(duration)

        return (frames, durations)


def build_controller(strip_configs: list[LightStripConfig]) -> LightController:
    """Build a hardware controller for the given strip configurations."""
    if not strip_configs:
        LOGGER.warning("No strip configurations provided; using NoopLightController.")
        return NoopLightController([])

    try:
        return Ws2811LightController(strip_configs)
    except RuntimeError as exc:
        LOGGER.warning("Failed to initialize WS2811 controller: %s; using NoopLightController.", exc)
        return NoopLightController(strip_configs)
    except Exception as exc:  # pragma: no cover - defensive
        LOGGER.exception("Unexpected error initializing hardware controller; using NoopLightController.")
        return NoopLightController(strip_configs)


def apply_live_frame_to_hardware(app: Flask, led_states: dict[str, object]) -> None:
    """Apply live frame LED states directly to local hardware. 
    
    This is called with pre-filtered LED states that belong to the local device.
    """
    controller = app.config.get("LIGHT_CONTROLLER")
    if not controller:
        LOGGER.warning("LIGHT_CONTROLLER not available, cannot apply live frame to hardware")
        return
    
    try:
        # Ensure led_states is in correct format: dict[str, dict[str, object]]
        if not isinstance(led_states, dict):
            LOGGER.warning("led_states must be a dictionary")
            return
        
        # Convert to proper format if needed (values should be dicts with color/opacity)
        formatted_states: dict[str, dict[str, object]] = {}
        for led_id, state in led_states.items():
            if isinstance(state, dict):
                formatted_states[str(led_id)] = state
            else:
                LOGGER.warning("LED state for %s is not a dictionary, skipping", led_id)
        
        if not formatted_states:
            LOGGER.warning("No valid LED states to apply")
            return
        
        # If controller has a method to apply LED states directly, use it
        if hasattr(controller, "apply_led_states"):
            controller.apply_led_states(formatted_states)  # type: ignore
            LOGGER.debug("Applied %d LED states to local hardware (no WebSocket clients connected)", len(formatted_states))
        else:
            LOGGER.warning("Controller does not support apply_led_states method")
    
    except Exception as exc:
        LOGGER.error("Error applying LED states to local hardware: %s", exc, exc_info=True)

"""Pattern storage and management utilities."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Sequence
from uuid import uuid4

from flask import Flask, abort

from ...hardware import LightStripConfig
from ..config import ConfigEntry

LOGGER = logging.getLogger(__name__)


def _now_iso() -> str:
    return (
        datetime.now(tz=timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


@dataclass(frozen=True)
class PatternDefinition:
    """Describe a default pattern to seed into storage."""

    id: str
    name: str
    description: str | None
    frame_rate: float
    duration: float
    loop: bool
    default_color: str | None = None
    color_cycle: Sequence[str] | None = None
    metadata: dict[str, object] | None = None
    brightness: int | None = None


class PatternStore:
    """Encapsulates pattern CRUD and cache interactions."""

    def __init__(self, app: Flask) -> None:
        self.app = app

    @property
    def pattern_dir(self) -> Path:
        return self.app.config["PATTERN_STORAGE_DIR"]

    def is_valid_pattern_id(self, candidate: str | None) -> bool:
        if not candidate:
            return False
        return all(ch.isalnum() or ch in {"-", "_"} for ch in candidate)

    def path_for(self, pattern_id: str) -> Path:
        if not self.is_valid_pattern_id(pattern_id):
            abort(404, description="Invalid pattern identifier.")
        return self.pattern_dir / f"{pattern_id}.json"

    def load_payload(self, pattern_id: str) -> dict | None:
        path = self.path_for(pattern_id)
        if not path.exists():
            return None
        try:
            with path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except json.JSONDecodeError as exc:
            LOGGER.error("Failed to parse pattern file %s: %s", path, exc)
            return None
        keyframes = payload.get("keyframes")
        if isinstance(keyframes, list):
            try:
                keyframes.sort(key=lambda item: item.get("time", 0) or 0)
            except Exception:  # pragma: no cover - defensive
                LOGGER.exception("Failed to sort keyframes for %s", pattern_id)
        payload["id"] = payload.get("id") or pattern_id
        return payload

    def load_file(self, pattern_id: str) -> dict:
        payload = self.load_payload(pattern_id)
        if payload is None:
            abort(404, description=f"Pattern '{pattern_id}' not found.")
        return payload

    def generate_pattern_id(self, name: str | None) -> str:
        if name:
            slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in name).strip("-")
            slug = "-".join(filter(None, slug.split("-")))
            if slug and self.is_valid_pattern_id(slug):
                candidate = slug
                counter = 1
                while self.path_for(candidate).exists():
                    candidate = f"{slug}-{counter}"
                    counter += 1
                return candidate
        return uuid4().hex

    @staticmethod
    def _normalize_keyframes(keyframes: list[dict]) -> list[dict]:
        normalized: list[dict] = []
        for raw in keyframes:
            if not isinstance(raw, dict):
                abort(400, description="Each keyframe must be an object.")
            time_value = raw.get("time")
            if not isinstance(time_value, (int, float)):
                abort(400, description="Keyframe 'time' must be numeric.")
            if time_value < 0:
                abort(400, description="Keyframe 'time' must be zero or greater.")
            overrides = raw.get("overrides", {})
            if not isinstance(overrides, dict):
                abort(400, description="Keyframe 'overrides' must be an object.")
            normalized.append(
                {
                    "id": raw.get("id") or f"kf-{uuid4().hex[:8]}",
                    "time": float(time_value),
                    "overrides": overrides,
                }
            )
        normalized.sort(key=lambda item: item["time"])
        return normalized

    def validate_payload(self, payload: dict, *, require_name: bool = True) -> dict:
        if not isinstance(payload, dict):
            abort(400, description="Pattern payload must be a JSON object.")

        name = payload.get("name")
        if require_name and not isinstance(name, str):
            abort(400, description="Pattern 'name' is required.")
        if isinstance(name, str):
            name = name.strip()
            if not name:
                abort(400, description="Pattern 'name' cannot be empty.")

        frame_rate = payload.get("frame_rate", 8)
        duration = payload.get("duration", 30)

        try:
            frame_rate_value = float(frame_rate)
            duration_value = float(duration)
        except (TypeError, ValueError):
            abort(400, description="'frame_rate' and 'duration' must be numbers.")

        if frame_rate_value <= 0:
            abort(400, description="'frame_rate' must be greater than zero.")
        if duration_value <= 0:
            abort(400, description="'duration' must be greater than zero.")

        loop = bool(payload.get("loop", True))
        strips = payload.get("strips", [])
        if strips is None:
            strips = []
        if not isinstance(strips, list):
            abort(400, description="'strips' must be a list if provided.")

        keyframes_raw = payload.get("keyframes", [])
        if keyframes_raw is None:
            keyframes_raw = []
        if not isinstance(keyframes_raw, list):
            abort(400, description="'keyframes' must be provided as a list.")
        keyframes = self._normalize_keyframes(keyframes_raw)

        metadata = payload.get("metadata")
        if metadata is not None and not isinstance(metadata, dict):
            abort(400, description="'metadata' must be an object if provided.")

        result = {
            "frame_rate": frame_rate_value,
            "duration": duration_value,
            "loop": loop,
            "strips": strips,
            "keyframes": keyframes,
            "metadata": metadata if metadata is not None else {},
        }
        if name is not None:
            result["name"] = name
        return result

    def write_pattern_file(self, pattern_id: str, payload: dict) -> dict:
        pattern_payload = payload.copy()
        pattern_payload["id"] = pattern_id
        pattern_payload.setdefault("loop", True)
        pattern_payload.setdefault("strips", [])
        pattern_payload.setdefault("keyframes", [])
        pattern_payload.setdefault("metadata", {})
        if isinstance(pattern_payload["keyframes"], list):
            pattern_payload["keyframes"] = sorted(
                pattern_payload["keyframes"], key=lambda item: item.get("time", 0)
            )
        timestamp = _now_iso()
        pattern_payload.setdefault("created_at", timestamp)
        pattern_payload["updated_at"] = timestamp
        path = self.pattern_dir / f"{pattern_id}.json"
        with path.open("w", encoding="utf-8") as handle:
            json.dump(pattern_payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        return pattern_payload

    def update_pattern_file(self, pattern_id: str, existing: dict, payload: dict) -> dict:
        updated = existing.copy()
        updated.update(payload)
        updated["id"] = pattern_id
        if isinstance(updated.get("keyframes"), list):
            updated["keyframes"] = sorted(
                updated["keyframes"], key=lambda item: item.get("time", 0)
            )
        updated["updated_at"] = _now_iso()
        path = self.pattern_dir / f"{pattern_id}.json"
        with path.open("w", encoding="utf-8") as handle:
            json.dump(updated, handle, indent=2, sort_keys=True)
            handle.write("\n")
        return updated

    def load_pattern_summaries(self) -> list[dict]:
        summaries: list[dict] = []
        for file_path in sorted(self.pattern_dir.glob("*.json")):
            try:
                with file_path.open("r", encoding="utf-8") as handle:
                    data = json.load(handle)
            except Exception:  # pragma: no cover - defensive
                LOGGER.exception("Failed reading pattern file %s", file_path)
                continue
            pattern_id = data.get("id") or file_path.stem
            summaries.append(
                {
                    "id": pattern_id,
                    "name": data.get("name", pattern_id),
                    "duration": data.get("duration"),
                    "frame_rate": data.get("frame_rate"),
                    "updated_at": data.get("updated_at"),
                }
            )
        return summaries

    def refresh_pattern_cache(self) -> None:
        summaries = self.load_pattern_summaries()
        self.app.config["PATTERN_SUMMARIES"] = summaries
        self.app.config["PATTERNS"] = [(item["id"], item["name"]) for item in summaries]
        light_state = self.app.config.get("LIGHT_STATE")
        if isinstance(light_state, dict):
            current = light_state.get("selected_pattern")
            available_ids = {item["id"] for item in summaries}
            if current not in available_ids:
                light_state["selected_pattern"] = summaries[0]["id"] if summaries else None

    def default_pattern_id(self) -> str | None:
        patterns = self.app.config.get("PATTERNS") or []
        return patterns[0][0] if patterns else None

    def pattern_exists(self, pattern_id: str | None) -> bool:
        if not self.is_valid_pattern_id(pattern_id):
            return False
        return self.path_for(pattern_id).exists()

    def remove_legacy_patterns(self, legacy_ids: Iterable[str]) -> None:
        for legacy_id in legacy_ids:
            path = self.pattern_dir / f"{legacy_id}.json"
            if path.exists():
                try:
                    path.unlink()
                    LOGGER.info("Removed legacy pattern file %s", path)
                except OSError:
                    LOGGER.warning("Unable to remove legacy pattern file %s", path)

    def ensure_default_patterns(
        self,
        strip_templates: Sequence[LightStripConfig],
        *,
        simulated_flag: bool,
        definitions: Sequence[dict[str, object]],
    ) -> None:
        def _normalize_hex_color(raw_color: object, fallback: str = "#ffffff") -> str:
            def _clean(color: str) -> str | None:
                value = color.strip().lower()
                if not value:
                    return None
                if not value.startswith("#"):
                    value = f"#{value}"
                if len(value) != 7:
                    return None
                try:
                    int(value[1:], 16)
                except ValueError:
                    return None
                return value

            default_clean = _clean(fallback) or "#ffffff"
            if not isinstance(raw_color, str):
                return default_clean
            return _clean(raw_color) or default_clean

        def _normalize_brightness(raw_value: object, fallback: int = 100) -> int:
            try:
                value = int(raw_value)
            except (TypeError, ValueError):
                value = fallback
            return max(0, min(100, value))

        for definition in definitions:
            pattern_id = definition.get("id") or uuid4().hex
            metadata = definition.get("metadata") or {}
            description = definition.get("description")
            if description and "description" not in metadata:
                metadata = {**metadata, "description": description}

            default_color = _normalize_hex_color(definition.get("default_color", "#ffffff"))
            brightness_value = _normalize_brightness(definition.get("brightness", 100))

            color_cycle_raw = definition.get("color_cycle")
            color_cycle: list[str] = []
            if isinstance(color_cycle_raw, list):
                for raw_color in color_cycle_raw:
                    color_cycle.append(_normalize_hex_color(raw_color, default_color))
            if not color_cycle:
                color_cycle = [default_color]

            pixel_counter = 0
            overrides: dict[str, dict[str, object]] = {}
            for template in strip_templates:
                for index in range(template.led_count):
                    color_value = color_cycle[pixel_counter % len(color_cycle)]
                    overrides[f"{template.pin}:{index}"] = {
                        "on": True,
                        "color": color_value,
                        "brightness": brightness_value,
                    }
                    pixel_counter += 1

            strips_payload = [
                {
                    "pin": template.pin,
                    "led_count": template.led_count,
                    "name": template.name,
                    "simulated": simulated_flag,
                }
                for template in strip_templates
            ]

            keyframe_payload = {
                "id": f"kf-{uuid4().hex[:8]}",
                "time": 0.0,
                "overrides": overrides,
            }
            payload = {
                "id": pattern_id,
                "name": definition.get("name", pattern_id),
                "frame_rate": float(definition.get("frame_rate", 8)),
                "duration": float(definition.get("duration", 30)),
                "loop": bool(definition.get("loop", True)),
                "strips": strips_payload,
                "keyframes": [keyframe_payload],
                "metadata": metadata,
            }

            existing_payload = self.load_payload(pattern_id)
            needs_update = False
            if existing_payload is None:
                needs_update = True
            else:
                existing_strips = existing_payload.get("strips") or []
                if len(existing_strips) != len(strips_payload):
                    needs_update = True
                else:
                    for expected, existing in zip(strips_payload, existing_strips):
                        if (
                            expected.get("pin") != existing.get("pin")
                            or expected.get("led_count") != existing.get("led_count")
                        ):
                            needs_update = True
                            break
                existing_keyframes = existing_payload.get("keyframes") or []
                if not needs_update:
                    if len(existing_keyframes) != 1:
                        needs_update = True
                    else:
                        expected_keys = set(overrides.keys())
                        existing_overrides = existing_keyframes[0].get("overrides") or {}
                        if set(existing_overrides.keys()) != expected_keys:
                            needs_update = True
                        else:
                            for key in expected_keys:
                                existing_entry = existing_overrides.get(key) or {}
                                expected_entry = overrides[key]
                                existing_color = _normalize_hex_color(
                                    existing_entry.get("color"), expected_entry["color"]
                                )
                                existing_on = bool(existing_entry.get("on", True))
                                existing_brightness = _normalize_brightness(
                                    existing_entry.get("brightness"), expected_entry["brightness"]
                                )
                                if (
                                    existing_color != expected_entry["color"]
                                    or existing_on != expected_entry["on"]
                                    or existing_brightness != expected_entry["brightness"]
                                ):
                                    needs_update = True
                                    break
                if not needs_update:
                    continue

            self.write_pattern_file(pattern_id, payload)


__all__ = ["PatternStore"]



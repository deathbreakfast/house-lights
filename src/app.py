"""Entry point for the House Lights web application."""

from __future__ import annotations

import contextlib
import json
import logging
import logging.handlers
import os
import selectors
import shutil
import socket
import threading
import sqlite3
import subprocess
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from uuid import uuid4
from urllib.parse import urljoin, urlsplit
import hashlib

from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    stream_with_context,
    url_for,
)
import requests
from flask_sock import Sock

from .database import get_db, init_app as init_db
from .hardware import LightStripConfig, build_controller

SIMULATOR_PIN_POOL: tuple[int, ...] = (18, 13)
MAX_SIMULATED_STRIPS = len(SIMULATOR_PIN_POOL)
MAX_LED_COUNT_PER_STRIP = 250

STUDIO_BACKGROUND_SCENE_ID = "__studio_background__"

DEFAULT_PATTERN_DEFINITIONS: list[dict[str, object]] = [
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

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConfigEntry:
    """Represents a parsed configuration item."""

    label: str
    detail: str | None = None


def _parse_config_list(raw_value: str | None) -> list[ConfigEntry]:
    """Parse a comma-separated list of configuration entries."""
    if not raw_value:
        return []

    entries: list[ConfigEntry] = []
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


def _parse_led_counts(raw_value: str | None) -> dict[int, int]:
    """Parse pin-to-LED count mappings from an environment variable."""
    if not raw_value:
        return {}

    counts: dict[int, int] = {}
    for chunk in raw_value.split(","):
        if "=" not in chunk:
            continue
        pin_str, count_str = chunk.split("=", 1)
        try:
            pin = int(pin_str.strip())
            count = int(count_str.strip())
        except ValueError:
            LOGGER.warning("Invalid LED count entry '%s'; expected format pin=count.", chunk)
            continue
        if count <= 0:
            LOGGER.warning("Ignoring non-positive LED count %s for pin %s.", count, pin)
            continue
        counts[pin] = count
    return counts


def _env_flag(name: str, default: bool = False) -> bool:
    """Return True if env var is truthy."""
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


def _build_strip_configs(
    gpio_entries: list[ConfigEntry], led_counts: dict[int, int]
) -> list[LightStripConfig]:
    """Create strip configuration objects usable by the hardware controller."""
    strip_configs: list[LightStripConfig] = []
    for entry in gpio_entries:
        try:
            pin = int(entry.label)
        except ValueError:
            LOGGER.warning("Skipping GPIO entry with non-numeric pin '%s'.", entry.label)
            continue

        count = led_counts.get(pin)
        if count is None:
            LOGGER.debug(
                "No LED count configured for pin %s; skipping hardware setup for this pin.", pin
            )
            continue

        strip_configs.append(
            LightStripConfig(pin=pin, led_count=count, name=entry.detail)
        )

    return strip_configs


def create_app() -> Flask:
    """Create and configure the Flask application instance."""
    logging.basicConfig(level=os.getenv("HOUSE_LIGHTS_LOG_LEVEL", "INFO").upper())

    app = Flask(__name__, template_folder="templates")
    app.config["APP_START_TIME"] = time.time()
    sock = Sock(app)
    app.config["SOCK_SERVER"] = sock

    is_controller = _env_flag("IS_CONTROLLER", True)
    app.config["IS_CONTROLLER"] = is_controller
    app.config["HANDSHAKE_TIMEOUT_SECONDS"] = float(
        os.getenv("HOUSE_LIGHTS_HANDSHAKE_TIMEOUT", "5")
    )
    app.config["DEVICE_HEALTH_MAX_AGE_SECONDS"] = float(
        os.getenv("HOUSE_LIGHTS_DEVICE_HEALTH_MAX_AGE", "45")
    )
    app.config["HEALTH_POLL_INTERVAL_SECONDS"] = float(
        os.getenv("HOUSE_LIGHTS_HEALTH_POLL_INTERVAL", "60")
    )
    app.config["WS_CLIENTS"]: dict[str, dict[str, object]] = {}
    app.config["WS_CLIENT_LOCK"] = threading.Lock()
    controller_only_prefixes = (
        "/api/v2",
        "/patterns",
        "/lights",
        "/api/patterns",
        "/api/logs",
    )
    controller_only_exact = {"/patterns/configure"}

    @app.before_request
    def _restrict_controller_routes() -> None:
        if app.config.get("IS_CONTROLLER", True):
            return
        path = request.path or "/"
        normalized = path.rstrip("/") or "/"
        for prefix in controller_only_prefixes:
            if normalized == prefix or normalized.startswith(f"{prefix}/"):
                abort(
                    403,
                    description="Controller-only endpoint is disabled on this device.",
                )
        if normalized in controller_only_exact:
            abort(
                403,
                description="Controller-only endpoint is disabled on this device.",
            )

    pattern_dir_env = os.getenv("HOUSE_LIGHTS_PATTERN_DIR")
    pattern_dir = (
        Path(pattern_dir_env).expanduser()
        if pattern_dir_env
        else Path.home() / ".houselights" / "patterns"
    )
    pattern_dir.mkdir(parents=True, exist_ok=True)
    app.config["PATTERN_STORAGE_DIR"] = pattern_dir

    env_log_file = os.getenv("HOUSE_LIGHTS_LOG_FILE")
    candidate_paths: list[Path] = []
    if env_log_file:
        candidate_paths.append(Path(env_log_file).expanduser())
    else:
        candidate_paths.append(Path("/var/log/houselights/app.log"))
    candidate_paths.append(Path.home() / ".houselights" / "logs" / "app.log")

    app.config["LOG_FILE_CANDIDATES"] = candidate_paths.copy()

    log_path_obj: Path | None = None
    for candidate in candidate_paths:
        try:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            rotating_handler = logging.handlers.RotatingFileHandler(
                candidate,
                maxBytes=int(os.getenv("HOUSE_LIGHTS_LOG_MAX_BYTES", 5 * 1_024 * 1_024)),
                backupCount=int(os.getenv("HOUSE_LIGHTS_LOG_BACKUP_COUNT", 5)),
                encoding="utf-8",
            )
            rotating_handler.setFormatter(
                logging.Formatter(
                    fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
                    datefmt="%Y-%m-%dT%H:%M:%S",
                )
            )
            rotating_handler.setLevel(logging.INFO)
            logging.getLogger().addHandler(rotating_handler)
            LOGGER.info("File logging enabled at %s", candidate)
            log_path_obj = candidate
            break
        except PermissionError:
            LOGGER.warning(
                "Insufficient permissions for log file path %s; attempting fallback.", candidate
            )
        except Exception:  # pragma: no cover - defensive logging
            LOGGER.exception("Failed to initialize file logging handler at %s.", candidate)

    if log_path_obj is None:
        LOGGER.error("File logging disabled; no writable log file path available.")

    app.config["LOG_FILE_PATH"] = log_path_obj

    systemd_service_name = os.getenv("HOUSE_LIGHTS_SYSTEMD_SERVICE", "houselights")

    gpio_entries = _parse_config_list(os.getenv("HOUSE_LIGHTS_GPIO_PINS"))
    led_counts = _parse_led_counts(os.getenv("HOUSE_LIGHTS_PIN_LED_COUNTS"))
    strip_configs = _build_strip_configs(gpio_entries, led_counts)
    controller = build_controller(strip_configs)

    app.config["LIGHT_CONTROLLER"] = controller
    app.config["STRIP_CONFIGS"] = strip_configs
    app.config["STRIP_CONFIGS_BY_PIN"] = {config.pin: config for config in strip_configs}
    app.config["SIMULATED_STRIPS"]: list[LightStripConfig] = []
    app.config["SIMULATED_STRIPS_BY_PIN"]: dict[int, LightStripConfig] = {}
    app.config["SYSTEMD_SERVICE_NAME"] = systemd_service_name
    app.config["LOCAL_DEVICE_ID_PREFIX"] = (
        os.getenv("HOUSE_LIGHTS_CONTROLLER_DEVICE_ID") or "controller-local"
    )
    
    # Initialize database (controller only)
    if is_controller:
        init_db(app)
    else:
        LOGGER.info("IS_CONTROLLER flag is false; skipping controller database initialization.")
    
    # Set up storage directories
    if is_controller:
        storage_dir = Path.home() / ".houselights" / "v2"
        storage_dir.mkdir(parents=True, exist_ok=True)
        app.config["V2_STORAGE_DIR"] = storage_dir
        app.config["V2_IMAGES_DIR"] = storage_dir / "images"
        app.config["V2_IMAGES_DIR"].mkdir(parents=True, exist_ok=True)
        app.config["V2_AUDIO_DIR"] = storage_dir / "audio"
        app.config["V2_AUDIO_DIR"].mkdir(parents=True, exist_ok=True)
    else:
        app.config["V2_STORAGE_DIR"] = None
        app.config["V2_IMAGES_DIR"] = None
        app.config["V2_AUDIO_DIR"] = None

    def _now_iso() -> str:
        return datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    def _pattern_dir() -> Path:
        return app.config["PATTERN_STORAGE_DIR"]

    def _is_valid_pattern_id(candidate: str) -> bool:
        if not candidate:
            return False
        return all(ch.isalnum() or ch in {"-", "_"} for ch in candidate)

    def _pattern_path(pattern_id: str) -> Path:
        if not _is_valid_pattern_id(pattern_id):
            abort(404, description="Invalid pattern identifier.")
        return _pattern_dir() / f"{pattern_id}.json"

    def _load_pattern_payload(pattern_id: str) -> dict | None:
        path = _pattern_path(pattern_id)
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

    def _load_pattern_file(pattern_id: str) -> dict:
        payload = _load_pattern_payload(pattern_id)
        if payload is None:
            abort(404, description=f"Pattern '{pattern_id}' not found.")
        return payload
        return payload

    def _generate_pattern_id(name: str | None) -> str:
        if name:
            slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in name).strip("-")
            slug = "-".join(filter(None, slug.split("-")))
            if slug and _is_valid_pattern_id(slug):
                candidate = slug
                counter = 1
                while _pattern_path(candidate).exists():
                    candidate = f"{slug}-{counter}"
                    counter += 1
                return candidate
        return uuid4().hex

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

    def _validate_pattern_payload(payload: dict, *, require_name: bool = True) -> dict:
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
        keyframes = _normalize_keyframes(keyframes_raw)

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

    def _write_pattern_file(pattern_id: str, payload: dict) -> dict:
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
        path = _pattern_dir() / f"{pattern_id}.json"
        with path.open("w", encoding="utf-8") as handle:
            json.dump(pattern_payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        return pattern_payload

    def _update_pattern_file(pattern_id: str, existing: dict, payload: dict) -> dict:
        updated = existing.copy()
        updated.update(payload)
        updated["id"] = pattern_id
        if isinstance(updated.get("keyframes"), list):
            updated["keyframes"] = sorted(
                updated["keyframes"], key=lambda item: item.get("time", 0)
            )
        updated["updated_at"] = _now_iso()
        path = _pattern_dir() / f"{pattern_id}.json"
        with path.open("w", encoding="utf-8") as handle:
            json.dump(updated, handle, indent=2, sort_keys=True)
            handle.write("\n")
        return updated

    def _load_pattern_summaries() -> list[dict]:
        summaries: list[dict] = []
        for file_path in sorted(_pattern_dir().glob("*.json")):
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

    def _refresh_pattern_cache() -> None:
        summaries = _load_pattern_summaries()
        app.config["PATTERN_SUMMARIES"] = summaries
        app.config["PATTERNS"] = [(item["id"], item["name"]) for item in summaries]
        light_state = app.config.get("LIGHT_STATE")
        if isinstance(light_state, dict):
            current = light_state.get("selected_pattern")
            available_ids = {item["id"] for item in summaries}
            if current not in available_ids:
                light_state["selected_pattern"] = summaries[0]["id"] if summaries else None

    def _default_pattern_id() -> str | None:
        patterns = app.config.get("PATTERNS") or []
        return patterns[0][0] if patterns else None

    def _pattern_exists(pattern_id: str | None) -> bool:
        if not pattern_id or not _is_valid_pattern_id(pattern_id):
            return False
        return (_pattern_dir() / f"{pattern_id}.json").exists()

    def _remove_legacy_patterns() -> None:
        for legacy_id in LEGACY_PATTERN_IDS_TO_REMOVE:
            path = _pattern_dir() / f"{legacy_id}.json"
            if path.exists():
                try:
                    path.unlink()
                    LOGGER.info("Removed legacy pattern file %s", path)
                except OSError:
                    LOGGER.warning("Unable to remove legacy pattern file %s", path)

    def _ensure_default_patterns() -> None:
        physical_strips: list[LightStripConfig] = app.config.get("STRIP_CONFIGS", [])
        if physical_strips:
            strip_templates = physical_strips
            simulated_flag = False
        else:
            strip_templates = [
                LightStripConfig(
                    pin=pin,
                    led_count=MAX_LED_COUNT_PER_STRIP,
                    name=f"Simulated Strip {index + 1}",
                )
                for index, pin in enumerate(SIMULATOR_PIN_POOL)
            ]
            simulated_flag = True

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

        for definition in DEFAULT_PATTERN_DEFINITIONS:
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

            existing_payload = _load_pattern_payload(pattern_id)
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

            _write_pattern_file(pattern_id, payload)
    _remove_legacy_patterns()
    _ensure_default_patterns()
    _refresh_pattern_cache()

    default_pattern = app.config["PATTERNS"][0][0] if app.config["PATTERNS"] else None
    app.config["LIGHT_STATE"] = {
        "is_on": False,
        "selected_pattern": default_pattern,
    }
    app.config["LIVE_MODE_ENABLED"] = False
    app.config["PLAYBACK_STATE"] = {}
    
    def _safe_scene_data(raw_data: str | None) -> dict[str, object]:
        if not raw_data:
            return {}
        try:
            parsed = json.loads(raw_data)
        except json.JSONDecodeError:
            LOGGER.warning("Failed to parse scene metadata payload.")
            return {}
        if not isinstance(parsed, dict):
            return {}
        return parsed

    def _safe_json_dict(raw_data: str | None) -> dict[str, object]:
        if not raw_data:
            return {}
        try:
            parsed = json.loads(raw_data)
        except json.JSONDecodeError:
            LOGGER.warning("Failed to parse JSON payload; returning empty dict.")
            return {}
        if not isinstance(parsed, dict):
            return {}
        return parsed

    def _safe_json_list(raw_data: str | None) -> list[object]:
        if not raw_data:
            return []
        try:
            parsed = json.loads(raw_data)
        except json.JSONDecodeError:
            LOGGER.warning("Failed to parse JSON list payload; returning []")
            return []
        if isinstance(parsed, list):
            return parsed
        return []

    def _load_auto_strip_snapshot(
        db: sqlite3.Connection, device_id: str
    ) -> list[dict[str, object]] | None:
        health_row = db.execute(
            "SELECT metadata FROM device_health WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        if health_row:
            metadata = _safe_json_dict(health_row["metadata"])
            last_meta = metadata.get("lastMeta")
            if isinstance(last_meta, dict):
                strips_payload = last_meta.get("strips")
                if isinstance(strips_payload, list) and strips_payload:
                    return strips_payload

        handshake_row = db.execute(
            """
            SELECT strip_summary
            FROM device_handshakes
            WHERE device_id = ? AND status = 'success'
            ORDER BY responded_at DESC
            LIMIT 1
            """,
            (device_id,),
        ).fetchone()
        if handshake_row:
            strips_payload = _safe_json_list(handshake_row["strip_summary"])
            if strips_payload:
                return strips_payload  # type: ignore[return-value]

        return None

    def _local_device_id_for_scene(scene_id: str) -> str:
        prefix = app.config.get("LOCAL_DEVICE_ID_PREFIX", "controller-local")
        safe_scene = scene_id or "default"
        return f"{prefix}-{safe_scene}"

    def _seed_local_device_for_scene(db: sqlite3.Connection, scene_id: str) -> None:
        if not app.config.get("IS_CONTROLLER", True):
            return
        env_configs: list[LightStripConfig] = app.config.get("STRIP_CONFIGS", [])
        if not env_configs:
            return

        device_id = _local_device_id_for_scene(scene_id)
        existing = db.execute(
            "SELECT id FROM devices WHERE id = ?", (device_id,)
        ).fetchone()
        if existing:
            return

        ip_address = os.getenv("HOUSE_LIGHTS_DEVICE_IP") or "127.0.0.1"
        strips_payload = [
            {
                "id": f"{device_id}-pin-{config.pin}",
                "gpioPin": config.pin,
                "ledCount": config.led_count,
            }
            for config in env_configs
        ]
        _persist_device_graph(
            db,
            device_id=device_id,
            scene_id=scene_id,
            ip_address=ip_address,
            position={"x": 400, "y": 300},
            device_type="local",
            strip_mode="auto",
            strips=strips_payload,
        )
        db.commit()

    def _device_identity_payload() -> dict[str, object]:
        device_id = os.getenv("HOUSE_LIGHTS_DEVICE_ID") or socket.gethostname()
        hardware_id = os.getenv("HOUSE_LIGHTS_HARDWARE_ID") or device_id
        device_name = os.getenv("HOUSE_LIGHTS_DEVICE_NAME") or device_id
        device_type = os.getenv("HOUSE_LIGHTS_DEVICE_TYPE") or (
            "controller" if app.config.get("IS_CONTROLLER") else "follower"
        )
        strip_mode = os.getenv("HOUSE_LIGHTS_DEVICE_STRIP_MODE", "auto")
        firmware_version = os.getenv("HOUSE_LIGHTS_FIRMWARE_VERSION") or os.getenv(
            "HOUSE_LIGHTS_VERSION"
        )
        capabilities = _safe_json_dict(os.getenv("HOUSE_LIGHTS_DEVICE_CAPABILITIES"))
        return {
            "deviceId": device_id,
            "deviceName": device_name,
            "hardwareId": hardware_id,
            "deviceType": device_type,
            "stripMode": strip_mode,
            "firmwareVersion": firmware_version,
            "capabilities": capabilities,
            "isController": app.config.get("IS_CONTROLLER"),
        }

    def _resolve_device_ip() -> str | None:
        explicit = os.getenv("HOUSE_LIGHTS_DEVICE_IP")
        if explicit:
            return explicit
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return None

    def _build_device_base_url(
        target: str, *, protocol: str | None = None, port: int | None = None
    ) -> str:
        """Normalize a device base URL from an IP/hostname."""
        candidate = target.strip()
        if not candidate:
            raise ValueError("Device address cannot be blank.")
        if candidate.startswith(("http://", "https://")):
            base = candidate
        else:
            scheme = protocol or "http"
            base = f"{scheme}://{candidate}"

        parsed = urlsplit(base)
        netloc = parsed.netloc
        if port and ":" not in netloc:
            netloc = f"{netloc}:{port}"
            base = parsed._replace(netloc=netloc).geturl()

        return base.rstrip("/")

    def _fetch_remote_json(url: str, *, timeout: float) -> tuple[dict[str, object], float]:
        """Fetch JSON from a remote device and measure latency."""
        start = time.perf_counter()
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
        elapsed_ms = (time.perf_counter() - start) * 1000
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError(f"Expected JSON object from {url}")
        return payload, elapsed_ms

    def _controller_clock_payload() -> dict[str, object]:
        return {"iso": _now_iso(), "unixTimeMs": int(time.time() * 1000)}

    def _register_ws_client(device_id: str, ws_conn, handshake_payload: dict[str, object]) -> None:
        with app.config["WS_CLIENT_LOCK"]:
            app.config["WS_CLIENTS"][device_id] = {
                "socket": ws_conn,
                "handshake": handshake_payload,
                "connected_at": _now_iso(),
            }
        metadata_patch = {
            "handshake": handshake_payload,
            "wsConnectedAt": _now_iso(),
        }
        _update_device_health_metadata(device_id, metadata_patch, ws_connected=True)

    def _unregister_ws_client(device_id: str, *, close_socket: bool = False) -> None:
        with app.config["WS_CLIENT_LOCK"]:
            entry = app.config["WS_CLIENTS"].pop(device_id, None)
        ws_conn = entry.get("socket") if entry else None
        _update_device_health_metadata(
            device_id, {"wsDisconnectedAt": _now_iso()}, ws_connected=False
        )
        if close_socket and ws_conn is not None:
            with contextlib.suppress(Exception):
                ws_conn.close()

    def _send_ws_command(
        *,
        command: str,
        payload: dict[str, object],
        device_ids: list[str] | None = None,
    ) -> dict[str, bool]:
        with app.config["WS_CLIENT_LOCK"]:
            if device_ids is None:
                targets = app.config["WS_CLIENTS"].copy()
            else:
                targets = {
                    device_id: app.config["WS_CLIENTS"].get(device_id)
                    for device_id in device_ids
                    if app.config["WS_CLIENTS"].get(device_id)
                }

        message = json.dumps(
            {
                "type": "command",
                "command": command,
                "payload": payload,
                "controllerClock": _controller_clock_payload(),
            }
        )

        results: dict[str, bool] = {}
        for device_id, entry in targets.items():
            if not entry:
                results[device_id] = False
                continue
            socket_obj = entry.get("socket")
            try:
                socket_obj.send(message)
                results[device_id] = True
            except Exception:
                LOGGER.warning("Failed to send WS command to %s; dropping connection.", device_id)
                results[device_id] = False
                _unregister_ws_client(device_id, close_socket=True)
        return results

    def _compute_playlist_hash(payload: dict[str, object]) -> str:
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8"))
        return digest.hexdigest()

    def _notify_playlist_ready(
        device_id: str,
        *,
        playlist_id: str,
        playlist_hash: str,
        entry_count: int,
    ) -> str:
        try:
            download_url = url_for("download_device_playlist", device_id=device_id, _external=True)
        except RuntimeError:
            download_url = f"/api/v2/devices/{device_id}/playlist/download"
        command_payload = {
            "playlistId": playlist_id,
            "playlistHash": playlist_hash,
            "entryCount": entry_count,
            "downloadUrl": download_url,
        }
        _send_ws_command(
            command="playlist_ready",
            payload=command_payload,
            device_ids=[device_id],
        )
        return download_url

    def _maybe_dispatch_playlists(target_device_ids: list[str] | None = None) -> None:
        """Send playlist-ready commands when in scheduled mode."""
        if app.config.get("LIVE_MODE_ENABLED"):
            LOGGER.debug("Live mode enabled; skipping playlist dispatch.")
            return
        light_state = app.config.get("LIGHT_STATE", {})
        if not light_state.get("is_on"):
            LOGGER.debug("Lights are off; skipping playlist dispatch.")
            return

        db = get_db(app)
        if target_device_ids is None:
            device_rows = db.execute("SELECT id FROM devices").fetchall()
            device_ids = [row["id"] for row in device_rows]
        else:
            device_ids = target_device_ids

        for device_id in device_ids:
            row = db.execute(
                """
                SELECT id, playlist_hash, payload
                FROM device_playlists
                WHERE device_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (device_id,),
            ).fetchone()
            if not row:
                continue
            playlist_payload = _safe_scene_data(row["payload"])
            entries = playlist_payload.get("entries")
            if not isinstance(entries, list):
                entries = []
            _notify_playlist_ready(
                device_id,
                playlist_id=row["id"],
                playlist_hash=row["playlist_hash"],
                entry_count=len(entries),
            )

    def _poll_device_health(device_id: str, ip_address: str) -> None:
        """Poll device health and update SQLite."""
        timeout = app.config.get("HANDSHAKE_TIMEOUT_SECONDS", 5.0)
        try:
            base_url = _build_device_base_url(ip_address)
        except ValueError:
            LOGGER.warning("Skipping health poll for %s due to invalid IP %s", device_id, ip_address)
            return

        try:
            health_payload, latency_ms = _fetch_remote_json(
                urljoin(f"{base_url}/", "api/device/health"),
                timeout=timeout,
            )
        except Exception as exc:
            LOGGER.debug("Health poll failed for %s: %s", device_id, exc)
            _update_device_health_metadata(
                device_id,
                {"lastHealthError": {"at": _now_iso(), "error": str(exc)}},
                ws_connected=None,
            )
            return

        try:
            meta_payload, _ = _fetch_remote_json(
                urljoin(f"{base_url}/", "api/device/meta"),
                timeout=timeout,
            )
        except Exception:
            meta_payload = None

        metadata_patch = {
            "lastHealth": {
                "payload": health_payload,
                "latencyMs": latency_ms,
                "polledAt": _now_iso(),
            },
        }
        if meta_payload is not None:
            metadata_patch["lastMeta"] = meta_payload

        _update_device_health_metadata(
            device_id,
            metadata_patch,
            ws_connected=None,
        )

        if meta_payload and isinstance(meta_payload, dict):
            db = get_db(app)
            device_row = db.execute(
                """
                SELECT scene_id, position_x, position_y, device_type, strip_mode, ip_address
                FROM devices
                WHERE id = ?
                """,
                (device_id,),
            ).fetchone()
            if device_row:
                position_payload = {
                    "x": device_row["position_x"],
                    "y": device_row["position_y"],
                }
                try:
                    _persist_device_graph(
                        db,
                        device_id=device_id,
                        scene_id=device_row["scene_id"],
                        ip_address=device_row["ip_address"] or ip_address,
                        position=position_payload,
                        device_type=device_row["device_type"],
                        strip_mode=meta_payload.get("stripMode") or device_row["strip_mode"],
                        strips=meta_payload.get("strips"),
                    )
                except Exception:  # pragma: no cover - defensive
                    LOGGER.exception("Failed to reconcile strips for device %s during health poll.", device_id)

        clock_skew_ms = None
        remote_unix = health_payload.get("unixTimeMs") if isinstance(health_payload, dict) else None
        if isinstance(remote_unix, (int, float)):
            clock_skew_ms = int(remote_unix) - int(time.time() * 1000)

        db = get_db(app)
        db.execute(
            """
            UPDATE device_health
            SET last_latency_ms = ?, clock_skew_ms = COALESCE(?, clock_skew_ms)
            WHERE device_id = ?
            """,
            (
                int(latency_ms) if latency_ms is not None else None,
                int(clock_skew_ms) if clock_skew_ms is not None else None,
                device_id,
            ),
        )
        db.commit()

    def _poll_all_devices_health() -> None:
        """Iterate over devices and poll their health endpoints."""
        db = get_db(app)
        devices = db.execute(
            "SELECT id, ip_address FROM devices ORDER BY updated_at DESC"
        ).fetchall()
        for device_row in devices:
            device_id = device_row["id"]
            ip_address = device_row["ip_address"]
            if not ip_address:
                continue
            try:
                _poll_device_health(device_id, ip_address)
            except Exception as exc:  # pragma: no cover - defensive
                LOGGER.warning("Health polling error for %s: %s", device_id, exc)

    def _start_health_poller() -> None:
        """Start background thread to poll device health periodically."""
        if not app.config.get("IS_CONTROLLER", True):
            return
        interval = app.config.get("HEALTH_POLL_INTERVAL_SECONDS", 60.0)
        if interval <= 0:
            LOGGER.info("Health poller disabled (interval %s).", interval)
            return

        def _poller() -> None:
            with app.app_context():
                while True:
                    try:
                        _poll_all_devices_health()
                    except Exception:  # pragma: no cover - defensive
                        LOGGER.exception("Health poller iteration failed.")
                    time.sleep(interval)

        thread = threading.Thread(target=_poller, name="health-poller", daemon=True)
        thread.start()
        app.config["HEALTH_POLL_THREAD"] = thread

    def _generate_led_layout(
        *,
        led_count: int,
        strip_index: int,
        base_x: float,
        base_y: float,
        id_prefix: str | None = None,
    ) -> list[dict[str, object]]:
        spacing = 18
        start_x = base_x - max(0, (led_count - 1) * spacing / 2)
        offset_y = base_y + 60 + strip_index * 30
        layout: list[dict[str, object]] = []
        for index in range(led_count):
            led_id = f"{id_prefix}-led-{index}" if id_prefix else f"led-{uuid4().hex[:8]}"
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

    def _persist_device_graph(
        db: sqlite3.Connection,
        *,
        device_id: str,
        scene_id: str,
        ip_address: str,
        position: dict[str, float] | None = None,
        device_type: str = "wifi",
        strip_mode: str | None = None,
        strips: list[dict[str, object]] | None = None,
    ) -> None:
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

        persisted_ip = ip_address or (existing_row["ip_address"] if existing_row else ip_address)
        persisted_type = device_type or (existing_row["device_type"] if existing_row else device_type)

        db.execute(
            """
            INSERT INTO devices (id, scene_id, position_x, position_y, ip_address, device_type, strip_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                scene_id = excluded.scene_id,
                position_x = excluded.position_x,
                position_y = excluded.position_y,
                ip_address = excluded.ip_address,
                device_type = excluded.device_type,
                strip_mode = excluded.strip_mode,
                updated_at = CURRENT_TIMESTAMP
            """,
            (device_id, scene_id, pos_x, pos_y, persisted_ip, persisted_type, normalized_strip_mode),
        )

        if normalized_strip_mode == "manual":
            return

        incoming_strips = strips or []
        if not incoming_strips:
            return

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
            gpio_pin = int(strip.get("gpioPin") or strip.get("pin") or strip.get("gpio_pin") or 18)
            led_count = int(
                strip.get("ledCount")
                or strip.get("led_count")
                or (len(strip.get("leds", [])) if isinstance(strip.get("leds"), list) else 10)
            )

            target_row: sqlite3.Row | None = None
            strip_id = strip.get("id")
            if isinstance(strip_id, str) and strip_id in existing_by_id:
                target_row = existing_by_id[strip_id]
            elif gpio_pin in existing_by_pin:
                target_row = existing_by_pin[gpio_pin]
                strip_id = target_row["id"]

            if target_row is None:
                strip_id = strip_id or f"{device_id}-strip-{uuid4().hex[:8]}"
                db.execute(
                    """
                    INSERT INTO led_strips (id, device_id, gpio_pin, led_count)
                    VALUES (?, ?, ?, ?)
                    """,
                    (strip_id, device_id, gpio_pin, led_count),
                )
                target_row = {"id": strip_id, "gpio_pin": gpio_pin, "led_count": led_count}

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
            if isinstance(leds_payload, list) and leds_payload:
                should_refresh_leds = True
            elif metadata_changed:
                should_refresh_leds = True
                leds_payload = _generate_led_layout(
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

        return device_id

    def _ensure_local_device_strips(
        db: sqlite3.Connection,
        *,
        scene_id: str,
        device_row: sqlite3.Row,
    ) -> list[dict[str, object]]:
        env_configs: list[LightStripConfig] = app.config.get("STRIP_CONFIGS", [])
        if not env_configs:
            return []

        device_id = device_row["id"]
        base_x = device_row["position_x"]
        base_y = device_row["position_y"]

        existing_strip_rows = db.execute(
            """
            SELECT id, gpio_pin, led_count FROM led_strips
            WHERE device_id = ?
            """,
            (device_id,),
        ).fetchall()
        existing_by_pin = {row["gpio_pin"]: row for row in existing_strip_rows}

        strips_payload: list[dict[str, object]] = []
        tracked_ids: set[str] = set()

        for index, config in enumerate(env_configs):
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
            leds_layout = _generate_led_layout(
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

        existing_ids = {row["id"] for row in existing_strip_rows}
        for strip_id in existing_ids - tracked_ids:
            db.execute("DELETE FROM leds WHERE strip_id = ?", (strip_id,))
            db.execute("DELETE FROM led_strips WHERE id = ?", (strip_id,))

        db.commit()
        return strips_payload

    def _update_device_health_metadata(
        device_id: str,
        metadata_patch: dict[str, object] | None = None,
        *,
        ws_connected: bool | None = None,
    ) -> None:
        try:
            db = get_db(app)
        except RuntimeError:
            return

        row = db.execute(
            "SELECT metadata FROM device_health WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        merged = _safe_json_dict(row["metadata"]) if row else {}
        if metadata_patch:
            merged.update(metadata_patch)

        ws_value = None
        if ws_connected is True:
            ws_value = 1
        elif ws_connected is False:
            ws_value = 0

        if row:
            db.execute(
                """
                UPDATE device_health
                SET last_seen_at = CURRENT_TIMESTAMP,
                    last_heartbeat_at = CURRENT_TIMESTAMP,
                    ws_connected = COALESCE(?, ws_connected),
                    metadata = ?
                WHERE device_id = ?
                """,
                (ws_value, json.dumps(merged), device_id),
            )
        else:
            db.execute(
                """
                INSERT INTO device_health (
                    device_id,
                    last_seen_at,
                    last_heartbeat_at,
                    last_latency_ms,
                    clock_skew_ms,
                    ws_connected,
                    playlist_hash,
                    metadata
                ) VALUES (
                    ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, ?, NULL, ?
                )
                """,
                (device_id, ws_value if ws_value is not None else 1, json.dumps(merged)),
            )
        db.commit()
    
    def _ensure_scene_exists(
        db: sqlite3.Connection, scene_id: str, *, name: str | None = None
    ) -> None:
        existing = db.execute(
            "SELECT id FROM scenes WHERE id = ?",
            (scene_id,),
        ).fetchone()
        if existing:
            return
        db.execute(
            """
            INSERT INTO scenes (id, name, power_on, data)
            VALUES (?, ?, 0, ?)
            """,
            (scene_id, name or f"Scene {scene_id}", "{}"),
        )
        db.commit()
    
    def _parse_db_timestamp(raw_value: str | None) -> datetime | None:
        if not raw_value:
            return None
        try:
            parsed = datetime.fromisoformat(raw_value)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    def _serialize_scene_row(row: sqlite3.Row) -> dict[str, object]:
        data = _safe_scene_data(row["data"])
        audio_meta = data.get("audio") if isinstance(data, dict) else None
        audio_payload: dict[str, object] | None = None
        if isinstance(audio_meta, dict) and audio_meta.get("id"):
            audio_path = audio_meta.get("file_path")
            if audio_path and Path(audio_path).exists():
                audio_payload = {
                    "id": audio_meta.get("id"),
                    "filename": audio_meta.get("filename"),
                    "contentType": audio_meta.get("content_type"),
                    "url": url_for("get_scene_audio", scene_id=row["id"]),
                }
        return {
            "id": row["id"],
            "name": row["name"],
            "audio": audio_payload,
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }
    
    def _delete_audio_asset(audio_meta: dict | None) -> None:
        if not isinstance(audio_meta, dict):
            return
        file_path = audio_meta.get("file_path")
        if not file_path:
            return
        with contextlib.suppress(OSError):
            Path(file_path).unlink()
    
    def _serialize_playlist_entry(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "sceneId": row["scene_id"],
            "position": row["position"],
            "playDurationSeconds": row["play_duration_seconds"],
            "fadeDurationSeconds": row["fade_duration_seconds"],
        }

    @app.get("/health")
    def health() -> tuple[dict[str, str], int]:
        """Simple health-check endpoint."""
        return jsonify({"status": "ok"}), 200

    @app.get("/")
    def index() -> str:
        """Render the control dashboard."""
        if not app.config.get("IS_CONTROLLER", True):
            identity = _device_identity_payload()
            return jsonify(
                {
                    "status": "follower",
                    "message": "Controller UI disabled on this device.",
                    "device": identity,
                }
            )
        light_state = app.config["LIGHT_STATE"]
        current_gpio_entries = _parse_config_list(os.getenv("HOUSE_LIGHTS_GPIO_PINS"))
        light_range_config = _parse_config_list(os.getenv("HOUSE_LIGHTS_LIGHT_RANGES"))
        return render_template(
            "index.html",
            gpio_entries=current_gpio_entries,
            light_range_entries=light_range_config,
            patterns=app.config["PATTERNS"],
            pattern_summaries=app.config.get("PATTERN_SUMMARIES", []),
            selected_pattern=light_state["selected_pattern"],
            is_on=light_state["is_on"],
        )

    @app.get("/v2")
    def studio_v2() -> str:
        """Render the experimental v2 studio workspace."""
        if not app.config.get("IS_CONTROLLER", True):
            abort(404)
        return render_template("v2.html")
    
    def _upload_background_image(scene_id: str):
        if "file" not in request.files:
            abort(400, description="No file provided")
        
        file = request.files["file"]
        if file.filename == "":
            abort(400, description="No file selected")
        
        if not file.content_type or not file.content_type.startswith("image/"):
            abort(400, description="File must be an image")
        
        file_ext = Path(file.filename).suffix
        image_id = str(uuid4())
        filename = f"{image_id}{file_ext}"
        file_path = app.config["V2_IMAGES_DIR"] / filename
        file.save(str(file_path))
        
        db = get_db(app)
        _ensure_scene_exists(
            db,
            scene_id,
            name="Studio Background" if scene_id == STUDIO_BACKGROUND_SCENE_ID else None,
        )
        db.execute(
            """
            INSERT INTO background_images (id, scene_id, filename, content_type, file_path, scale)
            VALUES (?, ?, ?, ?, ?, 100)
            ON CONFLICT(id) DO UPDATE SET
                filename = excluded.filename,
                content_type = excluded.content_type,
                file_path = excluded.file_path
            """,
            (image_id, scene_id, file.filename, file.content_type, str(file_path)),
        )
        db.commit()
        return jsonify(
            {
                "id": image_id,
                "url": f"/api/v2/images/{image_id}",
                "filename": file.filename,
                "scale": 100,
            }
        )
    
    def _get_background_response(scene_id: str):
        db = get_db(app)
        row = db.execute(
            """
            SELECT id, filename, content_type, scale
            FROM background_images
            WHERE scene_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (scene_id,),
        ).fetchone()
        if not row:
            return jsonify(None), 200
        return jsonify(
            {
                "id": row["id"],
                "url": f"/api/v2/images/{row['id']}",
                "filename": row["filename"],
                "scale": row["scale"] if row["scale"] is not None else 100,
            }
        )
    
    def _update_background_scale(scene_id: str):
        data = request.get_json()
        if not data or "scale" not in data:
            abort(400, description="Scale value required")
        
        scale = int(data["scale"])
        if scale < 10 or scale > 1000:
            abort(400, description="Scale must be between 10 and 1000")
        
        db = get_db(app)
        result = db.execute(
            """
            UPDATE background_images
            SET scale = ?
            WHERE scene_id = ?
            """,
            (scale, scene_id),
        )
        db.commit()
        
        if result.rowcount == 0:
            abort(404, description="Background image not found for this scene")
        
        return jsonify({"scale": scale})
    
    @app.post("/api/v2/scenes/<scene_id>/background")
    def upload_background_image(scene_id: str):
        """Upload a background image for a scene."""
        return _upload_background_image(scene_id)
    
    @app.post("/api/v2/background")
    def upload_global_background_image():
        """Upload the global studio background image."""
        return _upload_background_image(STUDIO_BACKGROUND_SCENE_ID)
    
    @app.get("/api/v2/images/<image_id>")
    def get_background_image(image_id: str) -> Response:
        """Retrieve a background image by ID."""
        db = get_db(app)
        row = db.execute(
            "SELECT file_path, content_type FROM background_images WHERE id = ?",
            (image_id,),
        ).fetchone()
        
        if not row:
            abort(404, description="Image not found")
        
        file_path = Path(row["file_path"])
        if not file_path.exists():
            abort(404, description="Image file not found")
        
        return Response(
            file_path.read_bytes(),
            mimetype=row["content_type"],
            headers={"Cache-Control": "public, max-age=31536000"},
        )
    
    @app.get("/api/v2/scenes/<scene_id>/background")
    def get_scene_background(scene_id: str):
        """Get the background image for a scene."""
        return _get_background_response(scene_id)
    
    @app.get("/api/v2/background")
    def get_global_background():
        """Get the global studio background."""
        return _get_background_response(STUDIO_BACKGROUND_SCENE_ID)
    
    @app.patch("/api/v2/scenes/<scene_id>/background/scale")
    def update_background_scale(scene_id: str):
        """Update the scale of a scene's background image."""
        return _update_background_scale(scene_id)
    
    @app.patch("/api/v2/background/scale")
    def update_global_background_scale():
        """Update the scale of the global background image."""
        return _update_background_scale(STUDIO_BACKGROUND_SCENE_ID)
    
    @app.get("/api/v2/scenes")
    def list_scenes():
        """Return all user-defined scenes."""
        db = get_db(app)
        rows = db.execute(
            """
            SELECT id, name, data, created_at, updated_at
            FROM scenes
            WHERE id != ?
            ORDER BY created_at ASC
            """,
            (STUDIO_BACKGROUND_SCENE_ID,),
        ).fetchall()
        return jsonify([_serialize_scene_row(row) for row in rows])
    
    @app.post("/api/v2/scenes")
    def create_scene():
        """Create a new scene."""
        payload = request.get_json(silent=True) or {}
        name = payload.get("name") or "New Scene"
        if not isinstance(name, str):
            abort(400, description="Scene name must be a string.")
        name = name.strip() or "New Scene"
        scene_id = payload.get("id")
        if not isinstance(scene_id, str) or not scene_id.strip():
            scene_id = f"scene-{uuid4().hex}"
        else:
            scene_id = scene_id.strip()
        db = get_db(app)
        try:
            db.execute(
                """
                INSERT INTO scenes (id, name, power_on, data)
                VALUES (?, ?, 0, ?)
                """,
                (scene_id, name, "{}"),
            )
            db.commit()
        except sqlite3.IntegrityError:
            abort(409, description="Scene with this id already exists.")
        row = db.execute(
            """
            SELECT id, name, data, created_at, updated_at
            FROM scenes
            WHERE id = ?
            """,
            (scene_id,),
        ).fetchone()
        return jsonify(_serialize_scene_row(row)), 201
    
    @app.get("/api/v2/scenes/<scene_id>")
    def get_scene(scene_id: str):
        """Return a single scene's metadata."""
        if scene_id == STUDIO_BACKGROUND_SCENE_ID:
            abort(404, description="Scene not found.")
        db = get_db(app)
        row = db.execute(
            """
            SELECT id, name, data, created_at, updated_at
            FROM scenes
            WHERE id = ?
            """,
            (scene_id,),
        ).fetchone()
        if not row:
            abort(404, description="Scene not found.")
        return jsonify(_serialize_scene_row(row))
    
    @app.patch("/api/v2/scenes/<scene_id>")
    def update_scene_metadata(scene_id: str):
        """Update scene metadata such as the name."""
        if scene_id == STUDIO_BACKGROUND_SCENE_ID:
            abort(400, description="Global scene cannot be modified via this endpoint.")
        payload = request.get_json(silent=True) or {}
        updates = []
        params: list[object] = []
        if "name" in payload:
            name = payload["name"]
            if not isinstance(name, str):
                abort(400, description="Scene name must be a string.")
            name = name.strip()
            if not name:
                abort(400, description="Scene name cannot be empty.")
            updates.append("name = ?")
            params.append(name)
        if not updates:
            abort(400, description="No updates supplied.")
        updates.append("updated_at = CURRENT_TIMESTAMP")
        params.append(scene_id)
        db = get_db(app)
        result = db.execute(
            f"""
            UPDATE scenes
            SET {', '.join(updates)}
            WHERE id = ?
            """,
            params,
        )
        db.commit()
        if result.rowcount == 0:
            abort(404, description="Scene not found.")
        row = db.execute(
            """
            SELECT id, name, data, created_at, updated_at
            FROM scenes
            WHERE id = ?
            """,
            (scene_id,),
        ).fetchone()
        return jsonify(_serialize_scene_row(row))
    
    @app.delete("/api/v2/scenes/<scene_id>")
    def delete_scene(scene_id: str):
        """Delete a scene and all of its associated data."""
        if scene_id == STUDIO_BACKGROUND_SCENE_ID:
            abort(400, description="Cannot delete the global studio scene.")
        db = get_db(app)
        row = db.execute(
            """
            SELECT data FROM scenes WHERE id = ?
            """,
            (scene_id,),
        ).fetchone()
        if not row:
            abort(404, description="Scene not found.")
        data = _safe_scene_data(row["data"])
        _delete_audio_asset(data.get("audio") if isinstance(data, dict) else None)
        result = db.execute("DELETE FROM scenes WHERE id = ?", (scene_id,))
        db.commit()
        if result.rowcount == 0:
            abort(404, description="Scene not found.")
        return jsonify({"status": "deleted"})
    
    @app.post("/api/v2/scenes/<scene_id>/audio")
    def upload_scene_audio(scene_id: str):
        """Upload an audio track for a scene."""
        if scene_id == STUDIO_BACKGROUND_SCENE_ID:
            abort(400, description="Global scene cannot store audio.")
        if "file" not in request.files:
            abort(400, description="No audio file provided.")
        file = request.files["file"]
        if not file or file.filename == "":
            abort(400, description="No audio file selected.")
        if not file.content_type or not file.content_type.startswith("audio/"):
            abort(400, description="File must be an audio type.")
        db = get_db(app)
        row = db.execute(
            "SELECT data FROM scenes WHERE id = ?",
            (scene_id,),
        ).fetchone()
        if not row:
            abort(404, description="Scene not found.")
        audio_id = str(uuid4())
        file_ext = Path(file.filename).suffix or ".bin"
        filename = f"{audio_id}{file_ext}"
        file_path = app.config["V2_AUDIO_DIR"] / filename
        file.save(str(file_path))
        data = _safe_scene_data(row["data"])
        if isinstance(data, dict):
            _delete_audio_asset(data.get("audio"))
            data["audio"] = {
                "id": audio_id,
                "filename": file.filename,
                "content_type": file.content_type or "application/octet-stream",
                "file_path": str(file_path),
            }
        else:
            data = {
                "audio": {
                    "id": audio_id,
                    "filename": file.filename,
                    "content_type": file.content_type or "application/octet-stream",
                    "file_path": str(file_path),
                }
            }
        db.execute(
            """
            UPDATE scenes
            SET data = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (json.dumps(data), scene_id),
        )
        db.commit()
        return jsonify(
            {
                "url": url_for("get_scene_audio", scene_id=scene_id),
                "filename": file.filename,
            }
        )
    
    @app.get("/api/v2/scenes/<scene_id>/audio")
    def get_scene_audio(scene_id: str):
        """Stream a scene's audio asset."""
        db = get_db(app)
        row = db.execute(
            "SELECT data FROM scenes WHERE id = ?",
            (scene_id,),
        ).fetchone()
        if not row:
            abort(404, description="Scene not found.")
        data = _safe_scene_data(row["data"])
        audio_meta = data.get("audio") if isinstance(data, dict) else None
        if not isinstance(audio_meta, dict):
            abort(404, description="No audio attached to this scene.")
        file_path = Path(audio_meta.get("file_path", ""))
        if not file_path.exists():
            abort(404, description="Audio file missing.")
        return Response(
            file_path.read_bytes(),
            mimetype=audio_meta.get("content_type") or "application/octet-stream",
            headers={"Cache-Control": "no-store"},
        )
    
    @app.delete("/api/v2/scenes/<scene_id>/audio")
    def delete_scene_audio(scene_id: str):
        """Remove the audio asset associated with a scene."""
        db = get_db(app)
        row = db.execute(
            "SELECT data FROM scenes WHERE id = ?",
            (scene_id,),
        ).fetchone()
        if not row:
            abort(404, description="Scene not found.")
        data = _safe_scene_data(row["data"])
        if isinstance(data, dict) and "audio" in data:
            _delete_audio_asset(data.get("audio"))
            data.pop("audio", None)
            db.execute(
                """
                UPDATE scenes
                SET data = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (json.dumps(data), scene_id),
            )
            db.commit()
        return jsonify({"status": "cleared"})
    
    @app.get("/api/v2/scene-playlist")
    def get_scene_playlist():
        """Return the ordered scene playlist."""
        db = get_db(app)
        rows = db.execute(
            """
            SELECT id, scene_id, position, play_duration_seconds, fade_duration_seconds
            FROM scene_playlist_entries
            ORDER BY position ASC
            """
        ).fetchall()
        return jsonify([_serialize_playlist_entry(row) for row in rows])
    
    @app.put("/api/v2/scene-playlist")
    def save_scene_playlist():
        """Persist the ordered scene playlist."""
        payload = request.get_json(silent=True) or {}
        entries = payload.get("entries")
        if entries is None or not isinstance(entries, list):
            abort(400, description="entries array is required.")
        db = get_db(app)
        normalized: list[tuple[str, str, int, int, int]] = []
        for position, entry in enumerate(entries):
            if not isinstance(entry, dict):
                abort(400, description="Each entry must be an object.")
            scene_id = entry.get("sceneId")
            if not isinstance(scene_id, str) or not scene_id.strip():
                abort(400, description="sceneId is required for each entry.")
            scene_id = scene_id.strip()
            scene_exists = db.execute(
                "SELECT id FROM scenes WHERE id = ?",
                (scene_id,),
            ).fetchone()
            if not scene_exists:
                abort(400, description=f"Scene '{scene_id}' does not exist.")
            entry_id = entry.get("id")
            if not isinstance(entry_id, str) or not entry_id.strip():
                entry_id = f"playlist-{uuid4().hex}"
            else:
                entry_id = entry_id.strip()
            try:
                play_duration = int(entry.get("playDurationSeconds", 60))
                fade_duration = int(entry.get("fadeDurationSeconds", 5))
            except (TypeError, ValueError):
                abort(400, description="Durations must be numeric.")
            if play_duration <= 0:
                abort(400, description="playDurationSeconds must be greater than zero.")
            if fade_duration < 0:
                abort(400, description="fadeDurationSeconds must be zero or greater.")
            normalized.append(
                (entry_id, scene_id, position, play_duration, fade_duration)
            )
        db.execute("DELETE FROM scene_playlist_entries")
        for entry_id, scene_id, position, play_duration, fade_duration in normalized:
            db.execute(
                """
                INSERT INTO scene_playlist_entries (
                    id,
                    scene_id,
                    position,
                    play_duration_seconds,
                    fade_duration_seconds
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (entry_id, scene_id, position, play_duration, fade_duration),
            )
        db.commit()
        rows = db.execute(
            """
            SELECT id, scene_id, position, play_duration_seconds, fade_duration_seconds
            FROM scene_playlist_entries
            ORDER BY position ASC
            """
        ).fetchall()
        return jsonify([_serialize_playlist_entry(row) for row in rows])
    
    @app.get("/api/v2/scenes/<scene_id>/devices")
    def get_scene_devices(scene_id: str):
        """Get all devices for a scene."""
        db = get_db(app)
        _seed_local_device_for_scene(db, scene_id)
        devices = db.execute(
            """
            SELECT id, position_x, position_y, ip_address, device_type, strip_mode
            FROM devices
            WHERE scene_id = ?
            ORDER BY created_at ASC
            """,
            (scene_id,),
        ).fetchall()
        device_ids = [device_row["id"] for device_row in devices]
        health_map: dict[str, sqlite3.Row] = {}
        if device_ids:
            placeholders = ",".join("?" for _ in device_ids)
            health_rows = db.execute(
                f"""
                SELECT device_id, last_seen_at, last_latency_ms, clock_skew_ms,
                       ws_connected, playlist_hash, metadata
                FROM device_health
                WHERE device_id IN ({placeholders})
                """,
                device_ids,
            ).fetchall()
            health_map = {row["device_id"]: row for row in health_rows}

        result = []
        for device_row in devices:
            device_id = device_row["id"]
            # Get strips for this device
            strips = db.execute(
                """
                SELECT id, gpio_pin, led_count
                FROM led_strips
                WHERE device_id = ?
                ORDER BY created_at ASC
                """,
                (device_id,),
            ).fetchall()
            
            strips_with_leds = []
            for strip in strips:
                strip_id = strip["id"]
                # Get LEDs for this strip
                leds = db.execute(
                    """
                    SELECT id, position_x, position_y, color, opacity
                    FROM leds
                    WHERE strip_id = ?
                    ORDER BY created_at ASC
                    """,
                    (strip_id,),
                ).fetchall()
                
                strips_with_leds.append({
                    "id": strip_id,
                    "gpioPin": strip["gpio_pin"],
                    "ledCount": strip["led_count"],
                    "leds": [
                        {
                            "id": led["id"],
                            "position": {
                                "x": led["position_x"],
                                "y": led["position_y"],
                            },
                            "color": led["color"],
                            "opacity": led["opacity"],
                        }
                        for led in leds
                    ],
                })
        
        if (
            not strips_with_leds
            and device_row["device_type"] == "local"
            and app.config.get("IS_CONTROLLER", True)
            and (device_row["strip_mode"] or "auto").lower() == "auto"
        ):
            strips_with_leds = _ensure_local_device_strips(
                db,
                scene_id=scene_id,
                device_row=device_row,
            )
            
            health_row = health_map.get(device_id)
            health_payload = None
            if health_row:
                metadata = _safe_json_dict(health_row["metadata"])
                last_seen_at = health_row["last_seen_at"]
                parsed_seen = _parse_db_timestamp(last_seen_at)
                is_online = False
                if parsed_seen:
                    age = (datetime.now(timezone.utc) - parsed_seen).total_seconds()
                    is_online = age <= app.config.get("DEVICE_HEALTH_MAX_AGE_SECONDS", 45)
                health_payload = {
                    "online": is_online,
                    "lastSeenAt": last_seen_at,
                    "latencyMs": health_row["last_latency_ms"],
                    "clockSkewMs": health_row["clock_skew_ms"],
                    "wsConnected": bool(health_row["ws_connected"]),
                    "playlistHash": health_row["playlist_hash"],
                    "metadata": metadata,
                }

            result.append({
                "id": device_id,
                "position": {
                    "x": device_row["position_x"],
                    "y": device_row["position_y"],
                },
                "ipAddress": device_row["ip_address"],
                "type": device_row["device_type"],
                "stripMode": device_row["strip_mode"],
                "strips": strips_with_leds,
                "health": health_payload,
            })
        
        return jsonify(result)

    @app.get("/api/device/meta")
    def get_device_meta_info():
        """Expose local device metadata for controller handshakes."""
        identity = _device_identity_payload()
        strips = _active_strip_configs()
        from_simulator = _simulator_enabled()
        strip_payloads = [
            {
                "id": f"{identity['deviceId']}-{config.pin}",
                "gpioPin": config.pin,
                "pin": config.pin,
                "ledCount": config.led_count,
                "name": config.name,
                "simulated": from_simulator,
            }
            for config in strips
        ]
        ip_address = _resolve_device_ip()
        payload = {
            **identity,
            "ipAddress": ip_address,
            "controllerHost": os.getenv("HOUSE_LIGHTS_CONTROLLER_HOST"),
            "timestamp": _now_iso(),
            "unixTimeMs": int(time.time() * 1000),
            "strips": strip_payloads,
            "limits": {
                "max_strips": MAX_SIMULATED_STRIPS,
                "max_leds_per_strip": MAX_LED_COUNT_PER_STRIP,
            },
        }
        return jsonify(payload)

    @app.get("/api/device/health")
    def get_device_health():
        """Expose lightweight health data for polling."""
        identity = _device_identity_payload()
        uptime_seconds = int(max(0, time.time() - app.config.get("APP_START_TIME", time.time())))
        light_state = app.config.get("LIGHT_STATE", {})
        payload = {
            "deviceId": identity["deviceId"],
            "status": "ok",
            "powerOn": bool(light_state.get("is_on")),
            "liveMode": bool(app.config.get("LIVE_MODE_ENABLED", False)),
            "uptimeSeconds": uptime_seconds,
            "timestamp": _now_iso(),
            "unixTimeMs": int(time.time() * 1000),
        }
        return jsonify(payload)
    
    @app.post("/api/v2/scenes/<scene_id>/devices")
    def create_device(scene_id: str):
        """Create a new device for a scene."""
        data = request.get_json()
        if not data:
            abort(400, description="Device data required")
        
        device_id = data.get("id") or str(uuid4())
        position = data.get("position", {"x": 400, "y": 300})
        ip_address = data.get("ipAddress", "192.168.1.100")
        device_type = data.get("type", "wifi")
        strip_mode = data.get("stripMode", "auto")
        strips = data.get("strips", [])
        
        db = get_db(app)
        
        persisted_id = _persist_device_graph(
            db,
            device_id=device_id,
            scene_id=scene_id,
            ip_address=ip_address,
            position=position,
            device_type=device_type,
            strip_mode=strip_mode,
            strips=strips,
        )
        db.commit()
        
        return jsonify({"id": persisted_id}), 201

    @app.post("/api/v2/devices/handshake")
    def initiate_device_handshake():
        """Connect to a remote device and persist its metadata."""
        data = request.get_json(silent=True) or {}
        scene_id = data.get("sceneId")
        if not isinstance(scene_id, str) or not scene_id.strip():
            abort(400, description="sceneId is required.")
        scene_id = scene_id.strip()

        ip_address = data.get("ipAddress") or data.get("address")
        if not isinstance(ip_address, str) or not ip_address.strip():
            abort(400, description="ipAddress is required.")
        ip_address = ip_address.strip()

        base_url = data.get("baseUrl")
        protocol = data.get("protocol")
        port = data.get("port")
        port_value: int | None = None
        if port is not None:
            try:
                port_value = int(port)
            except (TypeError, ValueError):
                abort(400, description="port must be numeric when provided.")

        if base_url:
            base_url = base_url.rstrip("/")
        else:
            try:
                base_url = _build_device_base_url(ip_address, protocol=protocol, port=port_value)
            except ValueError as exc:
                abort(400, description=str(exc))

        timeout = app.config.get("HANDSHAKE_TIMEOUT_SECONDS", 5.0)
        handshake_id = f"hs-{uuid4().hex}"
        controller_unix_ms = int(time.time() * 1000)
        controller_iso = _now_iso()

        metadata_payload: dict[str, object] | None = None
        health_payload: dict[str, object] | None = None
        latency_ms: float | None = None
        clock_skew_ms: int | None = None
        error_message: str | None = None

        meta_url = urljoin(f"{base_url}/", "api/device/meta")
        health_url = urljoin(f"{base_url}/", "api/device/health")

        try:
            metadata_payload, latency_ms = _fetch_remote_json(meta_url, timeout=timeout)
            remote_unix = metadata_payload.get("unixTimeMs")
            if isinstance(remote_unix, (int, float)):
                clock_skew_ms = int(remote_unix) - controller_unix_ms
            try:
                health_payload, _ = _fetch_remote_json(health_url, timeout=timeout)
            except Exception as health_exc:  # pragma: no cover - defensive
                LOGGER.debug("Device health fetch failed for %s: %s", base_url, health_exc)
        except (requests.RequestException, ValueError) as exc:
            LOGGER.warning("Handshake failed for %s: %s", base_url, exc)
            error_message = str(exc)

        db = get_db(app)
        _ensure_scene_exists(db, scene_id)

        persisted_id: str | None = None
        device_payload = metadata_payload or {}
        strips_payload = device_payload.get("strips")
        if not isinstance(strips_payload, list):
            strips_payload = []

        if error_message is None:
            device_id = (
                device_payload.get("deviceId")
                if isinstance(device_payload.get("deviceId"), str)
                else data.get("deviceId")
            )
            if not isinstance(device_id, str) or not device_id.strip():
                device_id = f"device-{uuid4().hex}"

            persisted_id = _persist_device_graph(
                db,
                device_id=device_id,
                scene_id=scene_id,
                ip_address=ip_address,
                position=data.get("position"),
                device_type=device_payload.get("deviceType", "follower"),
                strip_mode=device_payload.get("stripMode", "auto"),
                strips=strips_payload,
            )

        capabilities_blob = (
            device_payload.get("capabilities") if isinstance(device_payload, dict) else {}
        )
        if not isinstance(capabilities_blob, dict):
            capabilities_blob = {}
        playlist_hash = None
        if isinstance(device_payload, dict):
            playlist_hash = device_payload.get("playlistHash")
        if not playlist_hash and isinstance(health_payload, dict):
            playlist_hash = health_payload.get("playlistHash")

        metadata_blob = {
            "meta": metadata_payload,
            "health": health_payload,
        }

        db.execute(
            """
            INSERT INTO device_handshakes (
                id,
                device_id,
                ip_address,
                hardware_id,
                firmware_version,
                capabilities,
                strip_summary,
                status,
                clock_skew_ms,
                responded_at,
                error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
            """,
            (
                handshake_id,
                persisted_id,
                ip_address,
                device_payload.get("hardwareId") if isinstance(device_payload, dict) else None,
                device_payload.get("firmwareVersion") if isinstance(device_payload, dict) else None,
                json.dumps(capabilities_blob or {}),
                json.dumps(strips_payload or []),
                "success" if error_message is None else "failed",
                clock_skew_ms,
                error_message,
            ),
        )

        if error_message is None and persisted_id:
            db.execute(
                """
                INSERT INTO device_health (
                    device_id,
                    last_seen_at,
                    last_heartbeat_at,
                    last_latency_ms,
                    clock_skew_ms,
                    ws_connected,
                    playlist_hash,
                    metadata
                ) VALUES (
                    ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 0, ?, ?
                )
                ON CONFLICT(device_id) DO UPDATE SET
                    last_seen_at = CURRENT_TIMESTAMP,
                    last_heartbeat_at = CURRENT_TIMESTAMP,
                    last_latency_ms = excluded.last_latency_ms,
                    clock_skew_ms = excluded.clock_skew_ms,
                    playlist_hash = excluded.playlist_hash,
                    metadata = excluded.metadata
                """,
                (
                    persisted_id,
                    int(latency_ms) if latency_ms is not None else None,
                    int(clock_skew_ms) if clock_skew_ms is not None else None,
                    playlist_hash,
                    json.dumps(metadata_blob),
                ),
            )

        db.commit()

        if error_message is not None:
            return (
                jsonify(
                    {
                        "status": "error",
                        "handshakeId": handshake_id,
                        "message": error_message,
                        "sceneId": scene_id,
                        "ipAddress": ip_address,
                    }
                ),
                502,
            )

        response_payload = {
            "status": "ok",
            "handshakeId": handshake_id,
            "deviceId": persisted_id,
            "sceneId": scene_id,
            "ipAddress": ip_address,
            "baseUrl": base_url,
            "controllerClock": {
                "iso": controller_iso,
                "unixTimeMs": controller_unix_ms,
            },
            "clockSkewMs": clock_skew_ms,
            "latencyMs": latency_ms,
            "playlistHash": playlist_hash,
            "device": metadata_payload,
            "health": health_payload,
            "strips": strips_payload,
        }
        return jsonify(response_payload), 201

    @app.get("/api/v2/devices/<device_id>/status")
    def get_device_status(device_id: str):
        """Return last known status for a device."""
        db = get_db(app)
        health_row = db.execute(
            """
            SELECT device_id, last_seen_at, last_heartbeat_at, last_latency_ms, clock_skew_ms,
                   ws_connected, playlist_hash, metadata
            FROM device_health
            WHERE device_id = ?
            """,
            (device_id,),
        ).fetchone()
        handshake_row = db.execute(
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
        device_row = db.execute(
            """
            SELECT id, scene_id, ip_address, device_type, strip_mode
            FROM devices
            WHERE id = ?
            """,
            (device_id,),
        ).fetchone()

        metadata_blob = _safe_json_dict(health_row["metadata"]) if health_row else {}
        last_seen_at = health_row["last_seen_at"] if health_row else None
        parsed_seen = _parse_db_timestamp(last_seen_at)
        online = False
        if parsed_seen:
            age = (
                datetime.now(timezone.utc) - parsed_seen
            ).total_seconds()
            online = age <= app.config.get("DEVICE_HEALTH_MAX_AGE_SECONDS", 45)

        handshake_payload = None
        if handshake_row:
            handshake_payload = {
                "id": handshake_row["id"],
                "status": handshake_row["status"],
                "clockSkewMs": handshake_row["clock_skew_ms"],
                "respondedAt": handshake_row["responded_at"],
                "hardwareId": handshake_row["hardware_id"],
                "firmwareVersion": handshake_row["firmware_version"],
                "capabilities": _safe_json_dict(handshake_row["capabilities"]),
                "strips": _safe_json_list(handshake_row["strip_summary"]),
                "error": handshake_row["error"],
            }

        payload = {
            "deviceId": device_id,
            "sceneId": device_row["scene_id"] if device_row else None,
            "ipAddress": device_row["ip_address"] if device_row else None,
            "deviceType": device_row["device_type"] if device_row else None,
            "stripMode": device_row["strip_mode"] if device_row else None,
            "online": online,
            "lastSeenAt": last_seen_at,
            "lastLatencyMs": health_row["last_latency_ms"] if health_row else None,
            "clockSkewMs": health_row["clock_skew_ms"] if health_row else None,
            "wsConnected": bool(health_row["ws_connected"]) if health_row else False,
            "playlistHash": health_row["playlist_hash"] if health_row else None,
            "metadata": metadata_blob,
            "handshake": handshake_payload,
        }
        return jsonify(payload)

    @app.post("/api/v2/devices/<device_id>/commands")
    def send_device_command(device_id: str):
        """Send a realtime command to a device via WebSocket."""
        request_payload = request.get_json(silent=True) or {}
        command = request_payload.get("command")
        if not isinstance(command, str) or not command.strip():
            abort(400, description="command is required.")
        command_payload = request_payload.get("payload")
        if command_payload is None:
            command_payload = {}
        if not isinstance(command_payload, dict):
            abort(400, description="payload must be an object.")

        results = _send_ws_command(
            command=command.strip(),
            payload=command_payload,
            device_ids=[device_id],
        )
        success = results.get(device_id, False)
        status_code = 202 if success else 503
        return (
            jsonify(
                {
                    "deviceId": device_id,
                    "command": command,
                    "via": "websocket",
                    "sent": success,
                }
            ),
            status_code,
        )

    @app.post("/api/v2/devices/<device_id>/playlist")
    def upload_device_playlist(device_id: str):
        """Store a device-specific playlist and notify the device."""
        payload = request.get_json(silent=True) or {}
        entries = payload.get("entries")
        if not isinstance(entries, list) or not entries:
            abort(400, description="entries array is required.")
        metadata = payload.get("metadata")
        if metadata is not None and not isinstance(metadata, dict):
            abort(400, description="metadata must be an object if provided.")
        schedule = payload.get("schedule")
        if schedule is not None and not isinstance(schedule, dict):
            abort(400, description="schedule must be an object if provided.")

        playlist_id = payload.get("id")
        if not isinstance(playlist_id, str) or not playlist_id.strip():
            playlist_id = f"playlist-{uuid4().hex}"
        playlist_payload = {
            "entries": entries,
            "metadata": metadata or {},
            "schedule": schedule or {},
        }
        playlist_hash = payload.get("playlistHash")
        if not isinstance(playlist_hash, str) or not playlist_hash:
            playlist_hash = _compute_playlist_hash(playlist_payload)
        expires_at = payload.get("expiresAt")

        db = get_db(app)
        db.execute("DELETE FROM device_playlists WHERE device_id = ?", (device_id,))
        db.execute(
            """
            INSERT INTO device_playlists (id, device_id, playlist_hash, payload, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (playlist_id, device_id, playlist_hash, json.dumps(playlist_payload), expires_at),
        )
        result = db.execute(
            "UPDATE device_health SET playlist_hash = ? WHERE device_id = ?",
            (playlist_hash, device_id),
        )
        if result.rowcount == 0:
            db.execute(
                """
                INSERT INTO device_health (
                    device_id,
                    last_seen_at,
                    last_heartbeat_at,
                    last_latency_ms,
                    clock_skew_ms,
                    ws_connected,
                    playlist_hash,
                    metadata
                ) VALUES (
                    ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 0, ?, ?
                )
                """,
                (device_id, playlist_hash, json.dumps({"playlistHash": playlist_hash})),
            )
        db.commit()

        _update_device_health_metadata(
            device_id,
            {"lastPlaylistUpload": _now_iso(), "playlistHash": playlist_hash},
            ws_connected=None,
        )

        _maybe_dispatch_playlists([device_id])
        download_url = url_for("download_device_playlist", device_id=device_id, _external=True)

        return jsonify(
            {
                "id": playlist_id,
                "playlistHash": playlist_hash,
                "entries": len(entries),
                "downloadUrl": download_url,
            }
        ), 201

    @app.get("/api/v2/devices/<device_id>/playlist")
    def get_device_playlist(device_id: str):
        """Return the latest stored playlist for UI inspection."""
        db = get_db(app)
        row = db.execute(
            """
            SELECT id, playlist_hash, payload, created_at, downloaded_at
            FROM device_playlists
            WHERE device_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (device_id,),
        ).fetchone()
        if not row:
            abort(404, description="No playlist stored for this device.")
        playlist_payload = _safe_scene_data(row["payload"])
        playlist_payload.update(
            {
                "id": row["id"],
                "playlistHash": row["playlist_hash"],
                "createdAt": row["created_at"],
                "downloadedAt": row["downloaded_at"],
            }
        )
        return jsonify(playlist_payload)

    @app.get("/api/v2/devices/<device_id>/playlist/download")
    def download_device_playlist(device_id: str):
        """Allow devices to fetch and clear their pending playlist."""
        db = get_db(app)
        row = db.execute(
            """
            SELECT id, playlist_hash, payload
            FROM device_playlists
            WHERE device_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (device_id,),
        ).fetchone()
        if not row:
            abort(404, description="No playlist available for download.")
        playlist_payload = _safe_scene_data(row["payload"])
        playlist_payload.update(
            {
                "id": row["id"],
                "playlistHash": row["playlist_hash"],
            }
        )
        db.execute(
            """
            UPDATE device_playlists
            SET downloaded_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (row["id"],),
        )
        db.execute("DELETE FROM device_playlists WHERE id = ?", (row["id"],))
        db.commit()
        _update_device_health_metadata(
            device_id, {"lastPlaylistDownload": _now_iso()}, ws_connected=None
        )
        return jsonify(playlist_payload)

    if is_controller:

        @sock.route("/ws/controller")
        def controller_socket(ws):
            """WebSocket endpoint for follower devices."""
            device_id: str | None = None
            try:
                while True:
                    raw_message = ws.receive()
                    if raw_message is None:
                        break
                    try:
                        message = json.loads(raw_message)
                    except json.JSONDecodeError:
                        ws.send(
                            json.dumps(
                                {"type": "error", "message": "Invalid JSON payload received."}
                            )
                        )
                        continue

                    message_type = message.get("type")
                    if message_type == "hello":
                        candidate = message.get("deviceId")
                        if not isinstance(candidate, str) or not candidate.strip():
                            ws.send(
                                json.dumps(
                                    {
                                        "type": "error",
                                        "message": "deviceId is required for hello handshake.",
                                    }
                                )
                            )
                            continue
                        device_id = candidate.strip()
                        _register_ws_client(device_id, ws, message)
                        ws.send(
                            json.dumps(
                                {
                                    "type": "ack",
                                    "command": "hello",
                                    "deviceId": device_id,
                                    "controllerClock": _controller_clock_payload(),
                                }
                            )
                        )
                    elif message_type == "heartbeat":
                        if not device_id:
                            ws.send(
                                json.dumps(
                                    {"type": "error", "message": "Send hello before heartbeats."}
                                )
                            )
                            continue
                        payload = message.get("payload")
                        heartbeat_payload = payload if isinstance(payload, dict) else {}
                        _update_device_health_metadata(
                            device_id,
                            {"lastHeartbeat": heartbeat_payload},
                            ws_connected=True,
                        )
                    elif message_type == "state":
                        if not device_id:
                            ws.send(
                                json.dumps(
                                    {"type": "error", "message": "Send hello before state updates."}
                                )
                            )
                            continue
                        state_payload = message.get("payload")
                        state_payload = state_payload if isinstance(state_payload, dict) else {}
                        _update_device_health_metadata(
                            device_id,
                            {"lastState": state_payload},
                            ws_connected=True,
                        )
                    elif message_type == "log":
                        LOGGER.info(
                            "Device %s log: %s",
                            device_id or "<unknown>",
                            message.get("message"),
                        )
                    else:
                        LOGGER.debug(
                            "Unhandled WS message from %s: %s", device_id or "<unknown>", message
                        )
            except Exception as exc:  # pragma: no cover - defensive
                LOGGER.warning("WebSocket error for device %s: %s", device_id, exc)
            finally:
                if device_id:
                    _unregister_ws_client(device_id)
    
    @app.patch("/api/v2/devices/<device_id>")
    def update_device(device_id: str):
        """Update a device's properties."""
        data = request.get_json()
        if not data:
            abort(400, description="Device data required")
        
        db = get_db(app)

        device_snapshot_before = db.execute(
            """
            SELECT scene_id, position_x, position_y, ip_address, device_type, strip_mode
            FROM devices
            WHERE id = ?
            """,
            (device_id,),
        ).fetchone()
        if device_snapshot_before is None:
            abort(404, description="Device not found")
        
        updates = []
        params: list[object] = []
        
        if "position" in data:
            updates.append("position_x = ?")
            updates.append("position_y = ?")
            params.extend([data["position"]["x"], data["position"]["y"]])
        
        if "ipAddress" in data:
            updates.append("ip_address = ?")
            params.append(data["ipAddress"])
        
        if "type" in data:
            updates.append("device_type = ?")
            params.append(data["type"])
        
        desired_strip_mode: str | None = None
        if "stripMode" in data:
            desired_strip_mode = str(data["stripMode"]).lower()
            updates.append("strip_mode = ?")
            params.append(desired_strip_mode)
        
        # Update device properties if any
        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.append(device_id)
            
            result = db.execute(
                f"""
                UPDATE devices
                SET {', '.join(updates)}
                WHERE id = ?
                """,
                params,
            )
            db.commit()
            
            if result.rowcount == 0:
                abort(404, description="Device not found")
        
        # Update strips if provided (this can happen independently of device property updates)
        if "strips" in data:
            # Verify device exists
            device_check = db.execute(
                "SELECT id FROM devices WHERE id = ?",
                (device_id,),
            ).fetchone()
            if not device_check:
                abort(404, description="Device not found")
            
            db.execute("DELETE FROM led_strips WHERE device_id = ?", (device_id,))
            for strip in data["strips"]:
                strip_id = strip.get("id") or str(uuid4())
                db.execute(
                    """
                    INSERT INTO led_strips (id, device_id, gpio_pin, led_count)
                    VALUES (?, ?, ?, ?)
                    """,
                    (strip_id, device_id, strip.get("gpioPin", 18), strip.get("ledCount", 10)),
                )
                
                # Insert/update LEDs for this strip
                strip_leds = strip.get("leds", [])
                for led in strip_leds:
                    led_id = led.get("id") or str(uuid4())
                    led_position = led.get("position", {"x": 0, "y": 0})
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
                            led_position.get("x", 0),
                            led_position.get("y", 0),
                            led.get("color", "#ffffff"),
                            led.get("opacity", 1.0),
                        ),
                    )
            db.commit()
        
        device_snapshot_after = db.execute(
            """
            SELECT scene_id, position_x, position_y, ip_address, device_type, strip_mode
            FROM devices
            WHERE id = ?
            """,
            (device_id,),
        ).fetchone()

        if desired_strip_mode and device_snapshot_after:
            if desired_strip_mode == "auto":
                auto_seeded = False
                if (
                    device_snapshot_after["device_type"] == "local"
                    and app.config.get("IS_CONTROLLER", True)
                ):
                    strips_payload = _ensure_local_device_strips(
                        db,
                        scene_id=device_snapshot_after["scene_id"],
                        device_row=device_snapshot_after,
                    )
                    auto_seeded = bool(strips_payload)
                else:
                    auto_snapshot = _load_auto_strip_snapshot(db, device_id)
                    if auto_snapshot:
                        _persist_device_graph(
                            db,
                            device_id=device_id,
                            scene_id=device_snapshot_after["scene_id"],
                            ip_address=device_snapshot_after["ip_address"],
                            position={
                                "x": device_snapshot_after["position_x"],
                                "y": device_snapshot_after["position_y"],
                            },
                            device_type=device_snapshot_after["device_type"],
                            strip_mode="auto",
                            strips=auto_snapshot,
                        )
                        db.commit()
                        auto_seeded = True
                if not auto_seeded:
                    LOGGER.warning(
                        "Unable to refresh auto strips for device %s; no metadata available.",
                        device_id,
                    )

            _send_ws_command(
                command="strip_mode",
                payload={"deviceId": device_id, "mode": desired_strip_mode},
                device_ids=[device_id],
            )

        return jsonify({"id": device_id})
    
    def _serialize_keyframe_row(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "sceneId": row["scene_id"],
            "timestamp": row["timestamp_ms"],
            "effects": {
                "fadeIn": row["effects_fade_in"],
                "fadeOut": row["effects_fade_out"],
            },
            "ledStates": json.loads(row["led_states"]),
        }

    @app.get("/api/v2/scenes/<scene_id>/keyframes")
    def list_scene_keyframes(scene_id: str):
        """Return all keyframes for a scene."""
        db = get_db(app)
        rows = db.execute(
            """
            SELECT id, scene_id, timestamp_ms, effects_fade_in, effects_fade_out, led_states
            FROM scene_keyframes
            WHERE scene_id = ?
            ORDER BY timestamp_ms ASC
            """,
            (scene_id,),
        ).fetchall()
        payload = [_serialize_keyframe_row(row) for row in rows]
        return jsonify(payload)

    @app.post("/api/v2/scenes/<scene_id>/keyframes")
    def create_scene_keyframe(scene_id: str):
        """Persist a keyframe for a scene."""
        data = request.get_json() or {}
        timestamp = int(data.get("timestamp", 0))
        led_states = data.get("ledStates")
        if not isinstance(led_states, dict):
            abort(400, description="ledStates is required and must be an object.")
        effects = data.get("effects") or {}
        fade_in = int(effects.get("fadeIn", 0) or 0)
        fade_out = int(effects.get("fadeOut", 0) or 0)
        keyframe_id = data.get("id") or f"kf-{uuid4().hex}"

        db = get_db(app)
        db.execute(
            """
            DELETE FROM scene_keyframes
            WHERE scene_id = ? AND timestamp_ms = ? AND id != ?
            """,
            (scene_id, timestamp, keyframe_id),
        )
        insert_sql = """
            INSERT INTO scene_keyframes (id, scene_id, timestamp_ms, effects_fade_in, effects_fade_out, led_states)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                scene_id = excluded.scene_id,
                timestamp_ms = excluded.timestamp_ms,
                effects_fade_in = excluded.effects_fade_in,
                effects_fade_out = excluded.effects_fade_out,
                led_states = excluded.led_states,
                updated_at = CURRENT_TIMESTAMP
        """
        insert_params = (
            keyframe_id,
            scene_id,
            timestamp,
            fade_in,
            fade_out,
            json.dumps(led_states),
        )
        try:
            db.execute(
                insert_sql,
                insert_params,
            )
        except sqlite3.IntegrityError:
            db.execute(
                """
                DELETE FROM scene_keyframes
                WHERE scene_id = ? AND timestamp_ms = ? AND id != ?
                """,
                (scene_id, timestamp, keyframe_id),
            )
            db.execute(
                insert_sql,
                insert_params,
            )
        db.commit()
        row = db.execute(
            """
            SELECT id, scene_id, timestamp_ms, effects_fade_in, effects_fade_out, led_states
            FROM scene_keyframes
            WHERE id = ?
            """,
            (keyframe_id,),
        ).fetchone()
        return jsonify(_serialize_keyframe_row(row)), 201
        db.commit()
        row = db.execute(
            """
            SELECT id, scene_id, timestamp_ms, effects_fade_in, effects_fade_out, led_states
            FROM scene_keyframes
            WHERE id = ?
            """,
            (keyframe_id,),
        ).fetchone()
        return jsonify(_serialize_keyframe_row(row)), 201

    @app.patch("/api/v2/scenes/<scene_id>/keyframes/<keyframe_id>")
    def update_scene_keyframe(scene_id: str, keyframe_id: str):
        """Update an existing keyframe."""
        data = request.get_json() or {}
        updates = []
        params: list[object] = []

        new_timestamp: int | None = None
        if "timestamp" in data:
            new_timestamp = int(data["timestamp"])
            updates.append("timestamp_ms = ?")
            params.append(new_timestamp)
        effects = data.get("effects")
        if isinstance(effects, dict):
            if "fadeIn" in effects:
                updates.append("effects_fade_in = ?")
                params.append(int(effects["fadeIn"] or 0))
            if "fadeOut" in effects:
                updates.append("effects_fade_out = ?")
                params.append(int(effects["fadeOut"] or 0))
        if "ledStates" in data:
            if not isinstance(data["ledStates"], dict):
                abort(400, description="ledStates must be an object.")
            updates.append("led_states = ?")
            params.append(json.dumps(data["ledStates"]))

        if not updates:
            abort(400, description="No fields provided to update.")

        updates.append("updated_at = CURRENT_TIMESTAMP")
        db = get_db(app)
        if new_timestamp is not None:
            db.execute(
                """
                DELETE FROM scene_keyframes
                WHERE scene_id = ? AND timestamp_ms = ? AND id != ?
                """,
                (scene_id, new_timestamp, keyframe_id),
            )
        params.extend([scene_id, keyframe_id])
        result = db.execute(
            f"""
            UPDATE scene_keyframes
            SET {', '.join(updates)}
            WHERE scene_id = ? AND id = ?
            """,
            params,
        )
        db.commit()
        if result.rowcount == 0:
            abort(404, description="Keyframe not found.")

        row = db.execute(
            """
            SELECT id, scene_id, timestamp_ms, effects_fade_in, effects_fade_out, led_states
            FROM scene_keyframes
            WHERE id = ?
            """,
            (keyframe_id,),
        ).fetchone()
        return jsonify(_serialize_keyframe_row(row))

    @app.delete("/api/v2/scenes/<scene_id>/keyframes/<keyframe_id>")
    def delete_scene_keyframe(scene_id: str, keyframe_id: str):
        """Delete a keyframe from a scene."""
        db = get_db(app)
        result = db.execute(
            """
            DELETE FROM scene_keyframes
            WHERE scene_id = ? AND id = ?
            """,
            (scene_id, keyframe_id),
        )
        db.commit()
        if result.rowcount == 0:
            abort(404, description="Keyframe not found.")
        return jsonify({"status": "deleted"})

    @app.post("/api/v2/scenes/<scene_id>/keyframes/<int:timestamp_ms>/apply")
    def apply_scene_frame(scene_id: str, timestamp_ms: int):
        """Record a frame application request (stub for hardware playback)."""
        payload = request.get_json(silent=True) or {}
        playback_state = app.config.setdefault("PLAYBACK_STATE", {})
        scene_state = playback_state.setdefault(scene_id, {})
        led_states = payload.get("ledStates", {})
        scene_state["last_frame"] = {
            "timestamp": timestamp_ms,
            "ledStates": led_states,
            "receivedAt": _now_iso(),
        }
        LOGGER.debug("Queued frame apply for scene %s at %sms", scene_id, timestamp_ms)
        if led_states:
            _send_ws_command(
                command="live_frame",
                payload={
                    "sceneId": scene_id,
                    "timestamp": timestamp_ms,
                    "ledStates": led_states,
                },
            )
        return jsonify({"status": "queued"})

    @app.patch("/api/v2/devices/<device_id>/leds")
    def bulk_update_device_leds(device_id: str):
        """Bulk update LED colors/opacities for a device."""
        data = request.get_json() or {}
        leds = data.get("leds")
        if not isinstance(leds, list) or not leds:
            abort(400, description="leds array is required.")
        db = get_db(app)
        updates = 0
        for led_update in leds:
            led_id = led_update.get("id")
            if not isinstance(led_id, str):
                continue
            row = db.execute(
                """
                SELECT leds.id, leds.color, leds.opacity
                FROM leds
                JOIN led_strips ON leds.strip_id = led_strips.id
                WHERE leds.id = ? AND led_strips.device_id = ?
                """,
                (led_id, device_id),
            ).fetchone()
            if not row:
                continue
            new_color = led_update.get("color", row["color"])
            new_opacity = led_update.get("opacity", row["opacity"])
            db.execute(
                """
                UPDATE leds
                SET color = ?, opacity = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (new_color, new_opacity, led_id),
            )
            updates += 1
        db.commit()
        return jsonify({"updated": updates})

    @app.delete("/api/v2/devices/<device_id>")
    def delete_device(device_id: str):
        """Delete a device."""
        db = get_db(app)
        result = db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        db.commit()
        
        if result.rowcount == 0:
            abort(404, description="Device not found")
        
        return jsonify({"id": device_id}), 200
    
    @app.get("/api/v2/scenes/<scene_id>/power")
    def get_scene_power(scene_id: str):
        """Get the power state for a scene."""
        db = get_db(app)
        row = db.execute(
            "SELECT power_on FROM scenes WHERE id = ?",
            (scene_id,),
        ).fetchone()
        
        stored_power = bool(row["power_on"]) if row else False
        hardware_power = bool(app.config["LIGHT_STATE"]["is_on"])
        power_value = hardware_power if app.config.get("IS_CONTROLLER", True) else stored_power
        return jsonify(
            {
                "powerOn": power_value,
                "storedPowerOn": stored_power,
                "hardwarePowerOn": hardware_power,
            }
        ), 200
    
    @app.patch("/api/v2/scenes/<scene_id>/power")
    def update_scene_power(scene_id: str):
        """Update the power state for a scene."""
        data = request.get_json()
        if not data or "powerOn" not in data:
            abort(400, description="powerOn value required")
        
        target_state = bool(data["powerOn"])
        power_on = 1 if target_state else 0
        
        db = get_db(app)
        
        # Check if scene exists, if not create it
        existing = db.execute(
            "SELECT id FROM scenes WHERE id = ?",
            (scene_id,),
        ).fetchone()
        
        if not existing:
            # Create scene with default values
            db.execute(
                """
                INSERT INTO scenes (id, name, power_on, data)
                VALUES (?, ?, ?, ?)
                """,
                (scene_id, f"Scene {scene_id}", power_on, "{}"),
            )
        else:
            # Update existing scene
            db.execute(
                """
                UPDATE scenes
                SET power_on = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (power_on, scene_id),
            )
        
        db.commit()
        if app.config.get("IS_CONTROLLER", True):
            _set_light_power(target_state)
            _send_ws_command(command="power", payload={"powerOn": target_state})
            if target_state and not app.config.get("LIVE_MODE_ENABLED"):
                _maybe_dispatch_playlists()
        return jsonify(
            {
                "powerOn": bool(app.config["LIGHT_STATE"]["is_on"]),
                "storedPowerOn": bool(power_on),
            }
        )

    @app.get("/api/v2/live-mode")
    def get_live_mode():
        """Return whether live mode is active."""
        return jsonify(
            {
                "enabled": bool(app.config.get("LIVE_MODE_ENABLED", False)),
                "powerOn": bool(app.config["LIGHT_STATE"]["is_on"]),
            }
        )

    @app.patch("/api/v2/live-mode")
    def update_live_mode():
        """Toggle live mode and notify devices."""
        data = request.get_json(silent=True) or {}
        if "enabled" not in data:
            abort(400, description="enabled flag is required.")
        enabled = bool(data["enabled"])
        app.config["LIVE_MODE_ENABLED"] = enabled
        _send_ws_command(command="live_mode", payload={"enabled": enabled})
        if not enabled and app.config["LIGHT_STATE"]["is_on"]:
            _maybe_dispatch_playlists()
        return jsonify(
            {
                "enabled": enabled,
                "powerOn": bool(app.config["LIGHT_STATE"]["is_on"]),
            }
        )

    @app.post("/api/v2/playback/<scene_id>/start")
    def start_scene_playback(scene_id: str):
        """Mark a scene as playing."""
        playback_state = app.config.setdefault("PLAYBACK_STATE", {})
        playback_state[scene_id] = {
            "status": "playing",
            "startedAt": _now_iso(),
        }
        LOGGER.info("Playback started for scene %s", scene_id)
        if not app.config.get("LIVE_MODE_ENABLED"):
            _maybe_dispatch_playlists()
        _send_ws_command(command="playlist_play", payload={"sceneId": scene_id})
        return jsonify(playback_state[scene_id])

    @app.post("/api/v2/playback/<scene_id>/stop")
    def stop_scene_playback(scene_id: str):
        """Mark a scene as stopped."""
        playback_state = app.config.setdefault("PLAYBACK_STATE", {})
        playback_state[scene_id] = {
            "status": "stopped",
            "stoppedAt": _now_iso(),
        }
        LOGGER.info("Playback stopped for scene %s", scene_id)
        _send_ws_command(command="playlist_pause", payload={"sceneId": scene_id})
        return jsonify(playback_state[scene_id])

    @app.post("/api/v2/devices/playback")
    def control_device_playback():
        """Play or pause playlists across devices."""
        payload = request.get_json(silent=True) or {}
        action = payload.get("action")
        if action not in {"play", "pause"}:
            abort(400, description="action must be 'play' or 'pause'.")
        if app.config.get("LIVE_MODE_ENABLED"):
            abort(409, description="Disable live mode before controlling playlists.")
        if not app.config["LIGHT_STATE"]["is_on"]:
            abort(409, description="Turn on power before controlling playlists.")

        target_device_ids = payload.get("deviceIds")
        if target_device_ids is not None:
            if not isinstance(target_device_ids, list):
                abort(400, description="deviceIds must be a list when provided.")
            target_device_ids = [
                device_id for device_id in target_device_ids if isinstance(device_id, str) and device_id.strip()
            ]

        playback_state = app.config.setdefault("PLAYBACK_STATE", {})
        if action == "play":
            _maybe_dispatch_playlists(target_device_ids)
            _send_ws_command(
                command="playlist_play",
                payload={"deviceIds": target_device_ids},
            )
            playback_state["global"] = {
                "status": "playing",
                "startedAt": _now_iso(),
            }
        else:
            _send_ws_command(
                command="playlist_pause",
                payload={"deviceIds": target_device_ids},
            )
            playback_state["global"] = {
                "status": "paused",
                "pausedAt": _now_iso(),
            }

        return jsonify(playback_state["global"]), 202

    @app.get("/patterns/configure")
    def configure_patterns() -> str:
        """Render the pattern configurator view."""
        return render_template(
            "configure.html",
            patterns=app.config["PATTERNS"],
        )

    def _apply_current_pattern() -> None:
        controller = app.config["LIGHT_CONTROLLER"]
        light_state = app.config["LIGHT_STATE"]
        pattern_id = light_state.get("selected_pattern")
        if not light_state.get("is_on"):
            LOGGER.debug("Skipping pattern apply because lights are off.")
            return
        if not pattern_id:
            LOGGER.warning("No pattern selected; unable to apply lighting pattern.")
            return
        LOGGER.info("Applying pattern: %s", pattern_id)
        pattern_payload = _load_pattern_payload(pattern_id)
        if pattern_payload is not None:
            strips = _active_strip_configs()
            controller.render_pattern(pattern_payload, strips)
        else:
            LOGGER.warning(
                "Pattern payload for '%s' not found; falling back to legacy controller apply.",
                pattern_id,
            )
            controller.apply_pattern(pattern_id)

    def _set_light_power(is_on: bool) -> None:
        """Update in-memory light power state and notify the controller."""
        light_state = app.config["LIGHT_STATE"]
        light_state["is_on"] = is_on
        LOGGER.info("Lights %s", "ON" if is_on else "OFF")
        controller = app.config["LIGHT_CONTROLLER"]
        controller.set_power(is_on)
        if is_on:
            selected = light_state.get("selected_pattern")
            if not selected or not _pattern_exists(selected):
                fallback = _default_pattern_id()
                if fallback:
                    LOGGER.debug("Defaulting pattern to %s while powering on.", fallback)
                    light_state["selected_pattern"] = fallback
                    selected = fallback
                else:
                    LOGGER.warning("No patterns available to apply after powering on.")
                    selected = None
            if selected:
                _apply_current_pattern()
            if not app.config.get("LIVE_MODE_ENABLED"):
                _maybe_dispatch_playlists()
        else:
            LOGGER.debug("Lights powered off; skipping pattern application.")

    def _set_pattern(pattern_id: str) -> None:
        """Update the in-memory selected pattern and notify the controller."""
        if not _pattern_exists(pattern_id):
            LOGGER.warning("Attempted to select unknown pattern '%s'.", pattern_id)
            return
        light_state = app.config["LIGHT_STATE"]
        light_state["selected_pattern"] = pattern_id
        LOGGER.info("Pattern selected: %s", pattern_id)
        if light_state["is_on"]:
            _apply_current_pattern()

    def _build_journalctl_command(
        *extra_args: str, follow: bool = False, since: str | None = None, tail: int | None = None
    ) -> list[str]:
        command = ["journalctl", "--unit", app.config["SYSTEMD_SERVICE_NAME"], "--no-pager"]
        if since:
            command.extend(["--since", since])
        if tail is not None:
            command.extend(["--lines", str(tail)])
        if follow:
            command.append("--follow")
        command.extend(extra_args)
        return command

    def _journalctl_available() -> bool:
        return shutil.which("journalctl") is not None

    def _read_recent_file_logs(max_lines: int = 200) -> str | None:
        log_file: Path | None = app.config.get("LOG_FILE_PATH")
        if not log_file or not log_file.exists():
            LOGGER.debug("Log file not available for fallback: %s", log_file)
            return None

        try:
            with log_file.open("r", encoding="utf-8", errors="replace") as handle:
                tail_lines = deque(handle, maxlen=max_lines)
        except Exception:  # pragma: no cover - defensive logging
            LOGGER.exception("Failed to read log file fallback at %s", log_file)
            return None

        payload = "".join(tail_lines).strip()
        if payload:
            LOGGER.info("File log fallback returning %s characters.", len(payload))
            LOGGER.debug("File log fallback payload:\n%s", payload)
            return payload

        LOGGER.warning("File log fallback produced no output.")
        return ""

    def _build_log_response(payload: str, source: str) -> Response:
        response = Response(payload, mimetype="text/plain")
        response.headers["X-Log-Source"] = source
        return response

    def _active_strip_configs() -> list[LightStripConfig]:
        physical: list[LightStripConfig] = app.config.get("STRIP_CONFIGS", [])
        if physical:
            return physical
        return app.config.get("SIMULATED_STRIPS", [])

    def _simulator_enabled() -> bool:
        physical: list[LightStripConfig] = app.config.get("STRIP_CONFIGS", [])
        return len(physical) == 0

    def _register_simulated_strip(config: LightStripConfig) -> None:
        simulated: list[LightStripConfig] = app.config["SIMULATED_STRIPS"]
        simulated.append(config)
        app.config["SIMULATED_STRIPS_BY_PIN"][config.pin] = config

    def _remove_simulated_strip(pin: int) -> bool:
        simulated: list[LightStripConfig] = app.config["SIMULATED_STRIPS"]
        sim_map: dict[int, LightStripConfig] = app.config["SIMULATED_STRIPS_BY_PIN"]
        config = sim_map.pop(pin, None)
        if config is None:
            return False
        try:
            simulated.remove(config)
        except ValueError:
            pass
        return True

    def _hex_to_rgb(value: str) -> tuple[int, int, int]:
        """Convert a hex color string (#RRGGBB or RRGGBB) to an RGB tuple."""
        value = value.strip().lower()
        if value.startswith("#"):
            value = value[1:]
        if len(value) != 6:
            raise ValueError("Expected a 6-character hex color.")
        r = int(value[0:2], 16)
        g = int(value[2:4], 16)
        b = int(value[4:6], 16)
        return r, g, b

    def _lookup_strip_config(pin: int) -> LightStripConfig:
        config_map: dict[int, LightStripConfig] = app.config.get("STRIP_CONFIGS_BY_PIN", {})
        config = config_map.get(pin)
        if config is not None:
            return config
        sim_map: dict[int, LightStripConfig] = app.config.get("SIMULATED_STRIPS_BY_PIN", {})
        config = sim_map.get(pin)
        if config is None:
            abort(404, description=f"No strip configured for pin {pin}.")
        return config

    @app.get("/api/strips")
    def list_strips() -> Response:
        """Return metadata for all configured strips or active simulator strips."""
        strips: list[LightStripConfig] = _active_strip_configs()
        from_simulator = _simulator_enabled()
        payload = [
            {
                "pin": config.pin,
                "led_count": config.led_count,
                "name": config.name,
                "label": config.name or f"Strip on pin {config.pin}",
                "simulated": from_simulator,
            }
            for config in strips
        ]
        response_payload = {
            "mode": "simulator" if from_simulator else "hardware",
            "strips": payload,
            "limits": {
                "max_strips": MAX_SIMULATED_STRIPS,
                "max_leds_per_strip": MAX_LED_COUNT_PER_STRIP,
            },
        }
        return jsonify(response_payload)

    @app.post("/api/strips/simulator")
    def create_simulated_strip() -> Response:
        """Add a simulated strip for local testing (limited to hardware PWM capabilities)."""
        if not _simulator_enabled():
            abort(409, description="Simulator disabled while hardware strips are configured.")

        simulated: list[LightStripConfig] = app.config["SIMULATED_STRIPS"]
        if len(simulated) >= MAX_SIMULATED_STRIPS:
            abort(400, description="Simulator already has the maximum number of strips.")

        payload = request.get_json(silent=True) or {}
        try:
            led_count = int(payload.get("led_count", 0))
        except (TypeError, ValueError):
            led_count = 0
        if led_count <= 0 or led_count > MAX_LED_COUNT_PER_STRIP:
            abort(
                400,
                description=(
                    f"LED count must be between 1 and {MAX_LED_COUNT_PER_STRIP} for the simulator."
                ),
            )

        requested_name = payload.get("name")
        name = requested_name.strip() if isinstance(requested_name, str) else ""
        if not name:
            name = f"Simulated Strip {len(simulated) + 1}"

        used_pins = {config.pin for config in simulated}
        next_pin = next((pin for pin in SIMULATOR_PIN_POOL if pin not in used_pins), None)
        if next_pin is None:
            abort(400, description="No available PWM channels remain for simulation.")

        config = LightStripConfig(pin=next_pin, led_count=led_count, name=name)
        _register_simulated_strip(config)

        return (
            jsonify(
                {
                    "pin": config.pin,
                    "led_count": config.led_count,
                    "name": config.name,
                    "label": config.name or f"Strip on pin {config.pin}",
                    "simulated": True,
                }
            ),
            201,
        )

    @app.delete("/api/strips/simulator/<int:pin>")
    def delete_simulated_strip(pin: int) -> Response:
        """Remove a simulated strip."""
        if not _simulator_enabled():
            abort(409, description="Simulator disabled while hardware strips are configured.")

        removed = _remove_simulated_strip(pin)
        if not removed:
            abort(404, description=f"No simulated strip found for pin {pin}.")
        return jsonify({"status": "ok", "pin": pin})

    @app.post("/api/strips/<int:pin>/led/<int:pixel_index>")
    def test_strip_pixel(pin: int, pixel_index: int) -> Response:
        """Toggle or set an individual LED for testing."""
        strip_config = _lookup_strip_config(pin)
        if pixel_index < 0 or pixel_index >= strip_config.led_count:
            abort(
                400,
                description=(
                    f"LED index {pixel_index} out of range for strip on pin {pin}; "
                    f"valid range is 0-{strip_config.led_count - 1}."
                ),
            )

        payload = request.get_json(silent=True) or {}
        is_on = payload.get("on", True)
        color_value = payload.get("color")

        color_tuple: tuple[int, int, int] | None
        if is_on:
            if not color_value:
                abort(400, description="Color value is required when turning an LED on.")
            try:
                color_tuple = _hex_to_rgb(color_value)
            except ValueError as exc:
                abort(400, description=str(exc))
        else:
            color_tuple = None

        controller = app.config["LIGHT_CONTROLLER"]
        controller.set_pixel_test(pin, pixel_index, color_tuple)

        return jsonify(
            {
                "status": "ok",
                "pin": pin,
                "pixel_index": pixel_index,
                "on": bool(is_on),
                "color": color_value if color_tuple else None,
            }
        )

    @app.get("/api/patterns")
    def list_patterns_api() -> Response:
        """Return summaries for all stored patterns."""
        _refresh_pattern_cache()
        return jsonify({"patterns": app.config.get("PATTERN_SUMMARIES", [])})

    @app.post("/api/patterns")
    def create_pattern() -> Response:
        """Create a new lighting pattern."""
        payload = request.get_json(silent=True) or {}
        sanitized = _validate_pattern_payload(payload, require_name=True)

        requested_id = payload.get("id")
        if requested_id is not None:
            if not isinstance(requested_id, str):
                abort(400, description="Pattern 'id' must be a string when provided.")
            requested_id = requested_id.strip()
            if not _is_valid_pattern_id(requested_id):
                abort(
                    400,
                    description=(
                        "Pattern 'id' may only contain letters, numbers, hyphens, or underscores."
                    ),
                )
            if (_pattern_dir() / f"{requested_id}.json").exists():
                abort(409, description=f"Pattern '{requested_id}' already exists.")
            pattern_id = requested_id
        else:
            pattern_id = _generate_pattern_id(payload.get("name"))

        created = _write_pattern_file(pattern_id, sanitized)
        _refresh_pattern_cache()
        return jsonify(created), 201

    @app.get("/api/patterns/<string:pattern_id>")
    def fetch_pattern(pattern_id: str) -> Response:
        """Return the full JSON payload for a stored pattern."""
        pattern = _load_pattern_file(pattern_id)
        return jsonify(pattern)

    @app.put("/api/patterns/<string:pattern_id>")
    def update_pattern(pattern_id: str) -> Response:
        """Replace an existing pattern with a new definition."""
        existing = _load_pattern_file(pattern_id)
        payload = request.get_json(silent=True) or {}
        incoming_id = payload.get("id")
        if incoming_id is not None and incoming_id != pattern_id:
            abort(400, description="Pattern 'id' in payload must match the URL segment.")

        sanitized = _validate_pattern_payload(payload, require_name=True)
        updated = _update_pattern_file(pattern_id, existing, sanitized)
        _refresh_pattern_cache()
        return jsonify(updated)

    @app.delete("/api/patterns/<string:pattern_id>")
    def delete_pattern(pattern_id: str) -> Response:
        """Delete a stored pattern definition."""
        path = _pattern_path(pattern_id)
        if not path.exists():
            abort(404, description=f"Pattern '{pattern_id}' not found.")
        path.unlink()
        _refresh_pattern_cache()
        light_state = app.config.get("LIGHT_STATE")
        if isinstance(light_state, dict) and light_state.get("selected_pattern") == pattern_id:
            light_state["selected_pattern"] = _default_pattern_id()
        return jsonify({"status": "ok", "id": pattern_id})

    @app.get("/api/logs/recent")
    def recent_logs() -> Response:
        """Return the most recent journalctl output for the service."""
        if not _journalctl_available():
            LOGGER.warning("journalctl not available on host; unable to fetch logs.")
            return Response(
                "journalctl not available on host system.",
                status=503,
                mimetype="text/plain",
            )

        command = _build_journalctl_command("--output", "short-iso", tail=200)
        LOGGER.info("Fetching recent logs with command: %s", command)
        try:
            completed = subprocess.run(
                command,
                check=True,
                capture_output=True,
                text=True,
            )
            LOGGER.debug(
                "recent_logs subprocess completed: returncode=%s, stdout_bytes=%s, stderr_bytes=%s",
                completed.returncode,
                len(completed.stdout),
                len(completed.stderr),
            )
            payload = completed.stdout.strip()
            if payload and payload != "-- No entries --":
                LOGGER.info("recent_logs returning %s characters.", len(payload))
                LOGGER.debug("recent_logs payload:\n%s", payload)
                return _build_log_response(payload, source="journalctl")
            LOGGER.warning(
                "recent_logs received empty journal output%s; attempting file fallback.",
                " (-- No entries --)" if payload == "-- No entries --" else "",
            )
        except subprocess.CalledProcessError as exc:
            LOGGER.exception("Failed to read recent logs: command=%s", command)
            message = exc.stderr or exc.stdout or "Failed to retrieve logs."
            LOGGER.warning("recent_logs falling back to file due to journalctl error: %s", message)
        except Exception:  # pragma: no cover - defensive logging
            LOGGER.exception("Unexpected error calling journalctl; using file fallback.")

        fallback_payload = _read_recent_file_logs()
        if fallback_payload is None:
            candidate_hint = ", ".join(str(path) for path in app.config.get("LOG_FILE_CANDIDATES", []))
            return Response(
                (
                    "Log data unavailable: journalctl failed and no readable log file was found. "
                    f"Tried paths: {candidate_hint or 'n/a'}. "
                    "Ensure appropriate systemd journal permissions or set HOUSE_LIGHTS_LOG_FILE."
                ),
                status=503,
                mimetype="text/plain",
            )
        return _build_log_response(fallback_payload, source="file")

    @app.get("/api/logs/live")
    def live_logs() -> Response:
        """Stream journald output as server-sent events for live log viewing."""

        command = _build_journalctl_command(
            "--output",
            "short-iso",
            follow=True,
            since="5 minutes ago",
        )

        def journal_event_stream() -> Iterable[str]:
            heartbeat_interval = 15.0
            LOGGER.debug("Opening journalctl live stream: command=%s", command)
            try:
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
            except OSError as exc:  # pragma: no cover - defensive logging
                LOGGER.exception("Failed to spawn journalctl for live logs.")
                yield f"event: error\ndata: {exc}\n\n"
                return

            assert process.stdout is not None  # for typing
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)

            try:
                yield "event: source\ndata: journalctl\n\n"
                next_heartbeat = time.monotonic() + heartbeat_interval
                while True:
                    timeout = max(0.0, next_heartbeat - time.monotonic())
                    events = selector.select(timeout)
                    if events:
                        line = process.stdout.readline()
                        if not line:
                            LOGGER.debug("journalctl stream ended.")
                            yield "event: stream-end\ndata: journalctl process exited\n\n"
                            break
                        clean_line = line.rstrip()
                        LOGGER.debug("live_logs emitting line: %s", clean_line)
                        yield f"data: {clean_line}\n\n"
                        next_heartbeat = time.monotonic() + heartbeat_interval
                    else:
                        LOGGER.debug("live_logs emitting keep-alive event.")
                        yield ": keep-alive\n\n"
                        next_heartbeat = time.monotonic() + heartbeat_interval
            except Exception as exc:  # pragma: no cover - defensive logging
                LOGGER.exception("Error streaming logs: %s", exc)
                yield f"event: error\ndata: {exc}\n\n"
            finally:
                with contextlib.suppress(Exception):
                    selector.unregister(process.stdout)
                selector.close()
                with contextlib.suppress(Exception):
                    process.stdout.close()
                with contextlib.suppress(Exception):
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    with contextlib.suppress(Exception):
                        process.kill()
                    with contextlib.suppress(Exception):
                        process.wait(timeout=1)

        def file_event_stream() -> Iterable[str]:
            log_file: Path | None = app.config.get("LOG_FILE_PATH")
            if not log_file or not log_file.exists():
                LOGGER.error("File event stream requested but log file unavailable: %s", log_file)
                yield "event: error\ndata: Log file unavailable for streaming.\n\n"
                return

            heartbeat_interval = 15.0
            LOGGER.debug("Starting file-based log stream from %s", log_file)
            try:
                with log_file.open("r", encoding="utf-8", errors="replace") as handle:
                    handle.seek(0, os.SEEK_END)
                    next_heartbeat = time.monotonic() + heartbeat_interval
                    yield "event: source\ndata: file\n\n"
                    while True:
                        line = handle.readline()
                        if line:
                            clean_line = line.rstrip()
                            LOGGER.debug("file live_logs emitting line: %s", clean_line)
                            yield f"data: {clean_line}\n\n"
                            next_heartbeat = time.monotonic() + heartbeat_interval
                        else:
                            now = time.monotonic()
                            if now >= next_heartbeat:
                                LOGGER.debug("file live_logs emitting keep-alive event.")
                                yield ": keep-alive\n\n"
                                next_heartbeat = now + heartbeat_interval
                            time.sleep(1.0)
            except Exception as exc:  # pragma: no cover - defensive logging
                LOGGER.exception("Error streaming file logs: %s", exc)
                yield f"event: error\ndata: {exc}\n\n"

        if _journalctl_available():
            event_stream = journal_event_stream
            source = "journalctl"
        else:
            LOGGER.warning("journalctl not available; using file log stream.")
            event_stream = file_event_stream
            source = "file"

        response = Response(stream_with_context(event_stream()), mimetype="text/event-stream")
        response.headers["Cache-Control"] = "no-cache"
        response.headers["X-Accel-Buffering"] = "no"
        response.headers["X-Log-Source"] = source
        return response

    @app.post("/lights/on")
    def turn_lights_on() -> str:
        """Handle a request to turn the lights on."""
        LOGGER.info("Received request to turn lights on.")
        _set_light_power(True)
        _send_ws_command(command="power", payload={"powerOn": True})
        return redirect(url_for("index"))

    @app.post("/lights/off")
    def turn_lights_off() -> str:
        """Handle a request to turn the lights off."""
        LOGGER.info("Received request to turn lights off.")
        _set_light_power(False)
        _send_ws_command(command="power", payload={"powerOn": False})
        return redirect(url_for("index"))

    @app.post("/patterns/select")
    def select_pattern() -> str:
        """Handle selection of a lighting pattern."""
        pattern_id = request.form.get("pattern")
        valid_pattern_ids = {pattern for pattern, _ in app.config["PATTERNS"]}
        if not pattern_id or pattern_id not in valid_pattern_ids:
            LOGGER.warning("Received invalid pattern selection: %s", pattern_id)
            return redirect(url_for("index"))

        LOGGER.info("Received request to apply pattern: %s", pattern_id)
        _set_pattern(pattern_id)
        return redirect(url_for("index"))

    if is_controller:
        _start_health_poller()

    return app


app = create_app()

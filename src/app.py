"""Entry point for the House Lights web application."""

from __future__ import annotations

import contextlib
import json
import logging
import logging.handlers
import os
import selectors
import shutil
import sqlite3
import subprocess
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from uuid import uuid4

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
    
    # Initialize database
    init_db(app)
    
    # Set up storage directories
    storage_dir = Path.home() / ".houselights" / "v2"
    storage_dir.mkdir(parents=True, exist_ok=True)
    app.config["V2_STORAGE_DIR"] = storage_dir
    app.config["V2_IMAGES_DIR"] = storage_dir / "images"
    app.config["V2_IMAGES_DIR"].mkdir(parents=True, exist_ok=True)
    app.config["V2_AUDIO_DIR"] = storage_dir / "audio"
    app.config["V2_AUDIO_DIR"].mkdir(parents=True, exist_ok=True)

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
        devices = db.execute(
            """
            SELECT id, position_x, position_y, ip_address, device_type, strip_mode
            FROM devices
            WHERE scene_id = ?
            ORDER BY created_at ASC
            """,
            (scene_id,),
        ).fetchall()
        
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
            })
        
        return jsonify(result)
    
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
        
        # Insert device
        db.execute(
            """
            INSERT INTO devices (id, scene_id, position_x, position_y, ip_address, device_type, strip_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                position_x = excluded.position_x,
                position_y = excluded.position_y,
                ip_address = excluded.ip_address,
                device_type = excluded.device_type,
                strip_mode = excluded.strip_mode,
                updated_at = CURRENT_TIMESTAMP
            """,
            (device_id, scene_id, position["x"], position["y"], ip_address, device_type, strip_mode),
        )
        
        # Delete existing strips and LEDs (cascade will handle LEDs)
        db.execute("DELETE FROM led_strips WHERE device_id = ?", (device_id,))
        
        # Insert strips and their LEDs
        for strip in strips:
            strip_id = strip.get("id") or str(uuid4())
            db.execute(
                """
                INSERT INTO led_strips (id, device_id, gpio_pin, led_count)
                VALUES (?, ?, ?, ?)
                """,
                (strip_id, device_id, strip.get("gpioPin", 18), strip.get("ledCount", 10)),
            )
            
            # Insert LEDs for this strip
            strip_leds = strip.get("leds", [])
            for led in strip_leds:
                led_id = led.get("id") or str(uuid4())
                led_position = led.get("position", {"x": 0, "y": 0})
                db.execute(
                    """
                    INSERT INTO leds (id, strip_id, position_x, position_y, color, opacity)
                    VALUES (?, ?, ?, ?, ?, ?)
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
        
        return jsonify({"id": device_id}), 201
    
    @app.patch("/api/v2/devices/<device_id>")
    def update_device(device_id: str):
        """Update a device's properties."""
        data = request.get_json()
        if not data:
            abort(400, description="Device data required")
        
        db = get_db(app)
        
        updates = []
        params = []
        
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
        
        if "stripMode" in data:
            updates.append("strip_mode = ?")
            params.append(data["stripMode"])
        
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
        scene_state["last_frame"] = {
            "timestamp": timestamp_ms,
            "ledStates": payload.get("ledStates", {}),
            "receivedAt": _now_iso(),
        }
        LOGGER.debug("Queued frame apply for scene %s at %sms", scene_id, timestamp_ms)
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
        
        if not row:
            # Scene doesn't exist in database, return default
            return jsonify({"powerOn": False}), 200
        
        return jsonify({"powerOn": bool(row["power_on"])}), 200
    
    @app.patch("/api/v2/scenes/<scene_id>/power")
    def update_scene_power(scene_id: str):
        """Update the power state for a scene."""
        data = request.get_json()
        if not data or "powerOn" not in data:
            abort(400, description="powerOn value required")
        
        power_on = 1 if data["powerOn"] else 0
        
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
        
        return jsonify({"powerOn": bool(power_on)})

    @app.post("/api/v2/playback/<scene_id>/start")
    def start_scene_playback(scene_id: str):
        """Mark a scene as playing."""
        playback_state = app.config.setdefault("PLAYBACK_STATE", {})
        playback_state[scene_id] = {
            "status": "playing",
            "startedAt": _now_iso(),
        }
        LOGGER.info("Playback started for scene %s", scene_id)
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
        return jsonify(playback_state[scene_id])

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
        return redirect(url_for("index"))

    @app.post("/lights/off")
    def turn_lights_off() -> str:
        """Handle a request to turn the lights off."""
        LOGGER.info("Received request to turn lights off.")
        _set_light_power(False)
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

    return app


app = create_app()

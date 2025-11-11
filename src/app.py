"""Entry point for the House Lights web application."""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Iterable, Iterator

from flask import (
    Flask,
    Response,
    jsonify,
    redirect,
    render_template,
    request,
    stream_with_context,
    url_for,
)

from .hardware import LightStripConfig, build_controller

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

    patterns: list[tuple[str, str]] = [
        ("all_on_white", "All On (White)"),
        ("warm_glow", "Warm Glow"),
        ("rainbow_wave", "Rainbow Wave"),
        ("twinkle", "Twinkle"),
    ]

    systemd_service_name = os.getenv("HOUSE_LIGHTS_SYSTEMD_SERVICE", "houselights")

    gpio_entries = _parse_config_list(os.getenv("HOUSE_LIGHTS_GPIO_PINS"))
    led_counts = _parse_led_counts(os.getenv("HOUSE_LIGHTS_PIN_LED_COUNTS"))
    strip_configs = _build_strip_configs(gpio_entries, led_counts)
    controller = build_controller(strip_configs)

    app.config["LIGHT_CONTROLLER"] = controller
    app.config["PATTERNS"] = patterns
    app.config["LIGHT_STATE"] = {
        "is_on": False,
        "selected_pattern": patterns[0][0],
    }
    app.config["SYSTEMD_SERVICE_NAME"] = systemd_service_name

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
            selected_pattern=light_state["selected_pattern"],
            is_on=light_state["is_on"],
        )

    def _apply_current_pattern() -> None:
        controller = app.config["LIGHT_CONTROLLER"]
        light_state = app.config["LIGHT_STATE"]
        if light_state["is_on"]:
            controller.apply_pattern(light_state["selected_pattern"])

    def _set_light_power(is_on: bool) -> None:
        """Update in-memory light power state and notify the controller."""
        light_state = app.config["LIGHT_STATE"]
        light_state["is_on"] = is_on
        controller = app.config["LIGHT_CONTROLLER"]
        controller.set_power(is_on)
        if is_on:
            # Default to the all white pattern when powering on.
            if light_state["selected_pattern"] != "all_on_white":
                light_state["selected_pattern"] = "all_on_white"
            _apply_current_pattern()

    def _set_pattern(pattern_id: str) -> None:
        """Update the in-memory selected pattern and notify the controller."""
        light_state = app.config["LIGHT_STATE"]
        light_state["selected_pattern"] = pattern_id
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

    def _stream_journal_output(command: list[str]) -> Iterator[str]:
        LOGGER.debug("Starting journalctl stream: command=%s", command)
        with subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        ) as process:
            assert process.stdout is not None  # for typing
            try:
                for line in process.stdout:
                    yield line.rstrip("\n")
            finally:
                with contextlib.suppress(Exception):
                    process.terminate()
                with contextlib.suppress(Exception):
                    process.kill()

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
        try:
            completed = subprocess.run(
                command,
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            LOGGER.exception("Failed to read recent logs: command=%s", command)
            message = exc.stderr or exc.stdout or "Failed to retrieve logs."
            return Response(message, status=500, mimetype="text/plain")

        payload = completed.stdout.strip() or "(no log entries)"
        return Response(payload, mimetype="text/plain")

    @app.get("/api/logs/live")
    def live_logs() -> Response:
        """Stream journald output as server-sent events for live log viewing."""

        if not _journalctl_available():
            LOGGER.warning("journalctl not available on host; unable to stream logs.")
            return Response(
                "journalctl not available on host system.",
                status=503,
                mimetype="text/plain",
            )

        command = _build_journalctl_command(
            "--output",
            "short-iso",
            follow=True,
            since="5 minutes ago",
        )

        def event_stream() -> Iterable[str]:
            heartbeat_interval = 15.0
            next_heartbeat = time.monotonic() + heartbeat_interval
            try:
                for line in _stream_journal_output(command):
                    yield f"data: {line}\n\n"
                    current_time = time.monotonic()
                    if current_time >= next_heartbeat:
                        next_heartbeat = current_time + heartbeat_interval
                        yield ": keep-alive\n\n"
                yield "event: stream-end\ndata: journalctl process exited\n\n"
            except Exception as exc:  # pragma: no cover - defensive logging
                LOGGER.exception("Error streaming logs: %s", exc)
                yield f"event: error\ndata: {exc}\n\n"

        response = Response(stream_with_context(event_stream()), mimetype="text/event-stream")
        response.headers["Cache-Control"] = "no-cache"
        response.headers["X-Accel-Buffering"] = "no"
        return response

    @app.post("/lights/on")
    def turn_lights_on() -> str:
        """Handle a request to turn the lights on."""
        _set_light_power(True)
        return redirect(url_for("index"))

    @app.post("/lights/off")
    def turn_lights_off() -> str:
        """Handle a request to turn the lights off."""
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

        _set_pattern(pattern_id)
        return redirect(url_for("index"))

    return app


app = create_app()

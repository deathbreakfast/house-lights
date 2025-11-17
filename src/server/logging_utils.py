"""Logging helpers shared across the House Lights server stack."""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
from pathlib import Path
from typing import Iterable

from flask import Flask

LOGGER = logging.getLogger(__name__)


def configure_file_logging(app: Flask) -> None:
    """Attach a rotating file handler based on configured candidate paths."""
    env_log_file = os.getenv("HOUSE_LIGHTS_LOG_FILE")
    candidate_paths: list[Path] = []
    if env_log_file:
        candidate_paths.append(Path(env_log_file).expanduser())
    else:
        candidate_paths.append(Path("/var/log/houselights/app.log"))
    candidate_paths.append(Path.home() / ".houselights" / "logs" / "app.log")

    app.config["LOG_FILE_CANDIDATES"] = candidate_paths.copy()

    log_path_obj: Path | None = None
    handler: logging.Handler | None = None
    for candidate in candidate_paths:
        try:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            handler = logging.handlers.RotatingFileHandler(
                candidate,
                maxBytes=int(os.getenv("HOUSE_LIGHTS_LOG_MAX_BYTES", 5 * 1_024 * 1_024)),
                backupCount=int(os.getenv("HOUSE_LIGHTS_LOG_BACKUP_COUNT", 5)),
                encoding="utf-8",
            )
            handler.setFormatter(
                logging.Formatter(
                    fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
                    datefmt="%Y-%m-%dT%H:%M:%S",
                )
            )
            handler.setLevel(logging.INFO)
            logging.getLogger().addHandler(handler)
            LOGGER.info("File logging enabled at %s", candidate)
            log_path_obj = candidate
            break
        except PermissionError:
            LOGGER.warning(
                "Insufficient permissions for log file path %s; attempting fallback.",
                candidate,
            )
        except Exception:  # pragma: no cover - defensive logging
            LOGGER.exception("Failed to initialize file logging handler at %s.", candidate)

    if log_path_obj is None:
        LOGGER.error("File logging disabled; no writable log file path available.")

    app.config["FILE_LOG_HANDLER"] = handler
    app.config["LOG_FILE_PATH"] = log_path_obj


def apply_verbose_logging_preferences(app: Flask, verbose_device_logs: bool) -> None:
    """Update app/global logging levels based on the verbose flag."""
    app.config["VERBOSE_DEVICE_LOGS"] = verbose_device_logs
    root_logger = logging.getLogger()
    if verbose_device_logs and root_logger.level > logging.DEBUG:
        root_logger.setLevel(logging.DEBUG)
    file_handler = app.config.get("FILE_LOG_HANDLER")
    if file_handler:
        file_handler.setLevel(root_logger.level)


def log_device_debug(app: Flask, message: str, **details: object) -> None:
    """Emit verbose device traces when the flag is enabled."""
    if not app.config.get("VERBOSE_DEVICE_LOGS"):
        return
    if details:
        try:
            serialized = json.dumps(details, default=str)
        except TypeError:
            serialized = str(details)
        LOGGER.debug("%s | %s", message, serialized)
    else:
        LOGGER.debug(message)


__all__ = [
    "configure_file_logging",
    "apply_verbose_logging_preferences",
    "log_device_debug",
]



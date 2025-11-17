"""JSON parsing utilities for the House Lights server."""

from __future__ import annotations

import json
import logging

LOGGER = logging.getLogger(__name__)


def safe_json_dict(raw_data: str | None) -> dict[str, object]:
    """Safely parse a JSON string into a dict, returning empty dict on failure."""
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


def safe_json_list(raw_data: str | None) -> list[object]:
    """Safely parse a JSON string into a list, returning empty list on failure."""
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


def safe_scene_data(raw_data: str | None) -> dict[str, object]:
    """Safely parse scene metadata JSON, returning empty dict on failure."""
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


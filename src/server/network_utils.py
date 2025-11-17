"""Network utilities for the House Lights server."""

from __future__ import annotations

import os
import socket


def resolve_device_ip() -> str | None:
    """Resolve device IP from environment or hostname."""
    explicit = os.getenv("HOUSE_LIGHTS_DEVICE_IP")
    if explicit:
        return explicit
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return None


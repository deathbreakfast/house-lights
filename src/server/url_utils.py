"""URL building utilities for the House Lights server."""

from __future__ import annotations

from urllib.parse import urlsplit


def build_device_base_url(
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


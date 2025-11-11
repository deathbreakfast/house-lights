"""Entry point for the House Lights web application."""

from __future__ import annotations

import os
from flask import Flask, jsonify


def create_app() -> Flask:
    """Create and configure the Flask application instance."""
    app = Flask(__name__)

    @app.get("/health")
    def health() -> tuple[dict[str, str], int]:
        """Simple health-check endpoint."""
        return jsonify({"status": "ok"}), 200

    @app.get("/")
    def index() -> tuple[dict[str, str], int]:
        """Temporary placeholder for the root route."""
        gpio_pins = os.getenv("HOUSE_LIGHTS_GPIO_PINS", "not-configured")
        light_ranges = os.getenv("HOUSE_LIGHTS_LIGHT_RANGES", "not-configured")
        return jsonify(
            {
                "message": "House Lights control server is running.",
                "gpio_pins": gpio_pins,
                "light_ranges": light_ranges,
            }
        ), 200

    return app


app = create_app()


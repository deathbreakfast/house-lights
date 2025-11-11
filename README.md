# House Lights

House Lights is a small Python application for orchestrating individually addressable RGB LED strands around the home, with first-class support planned for WS2811 strips and compatible controllers. The project will grow into a self-hosted controller with a browser-based interface for configuring GPIO pins, defining light ranges, and designing animated patterns through a keyframe timeline editor.

## Planned Features

- Configurable GPIO pin assignments provided through environment variables.
- Adjustable LED counts per pin configured via environment variables.
- Web UI to power lights on or off and select from preconfigured patterns.
- Pattern editor with timeline, per-light controls, color selection, easing tools, and the ability to save and load custom sequences.

## Development Roadmap

1. Establish project scaffolding with a simple Flask server and basic configuration loader.
2. Implement REST endpoints and the web UI for managing lights and patterns.
3. Integrate hardware control for WS2811 LED strings and compatible drivers.
4. Expand pattern editing capabilities with advanced easing and playback options.

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/deathbreakfast/house-lights.git
   ```
2. Create and activate a virtual environment:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Run the development server:
   ```bash
   flask --app src/app.py run --reload
   ```

## License

This project is released under the MIT License. See `LICENSE` for details.


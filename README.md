# House Lights

House Lights is a self-hosted Python application for orchestrating individually addressable RGB LED strands around the home, with first-class support for WS2811 strips and compatible controllers. It provides a browser-based interface for configuring GPIO pins, defining light ranges, and designing animated patterns through a keyframe timeline editor.

**Note:** This project is currently on hiatus due to hardware issues. See the [Current Status](#current-status) section for details.

## Features

<div align="center">
  <img src="screenshots/Houselights%20Example%20Screenshot%2004.png" width="48%" />
  <img src="screenshots/Houselights%20Example%20Screenshot%2001.png" width="48%" />
</div>

- Configurable GPIO pin assignments provided through environment variables or UI
- Adjustable LED counts per pin (configured via environment variables).
- Web UI to power lights on or off and select from preconfigured patterns / scenes.
- Scene editor with timeline, per-light controls, color selection, easing tools, and the ability to save and load custom sequences.
- Upload images and move around virtual LEDs to align on screenshot and preview scenes.
- Support for multiple devices and synchronization between them.
- Audio track upload for in browser playback to help time LEDs to audio timing.
  - Radio transmission support of audio (Coming Soon)
- Scene playlist to fade between scenes.
- Live mode to sync live browser changes to hardware.
- Tools to help quickly design scenes.
  - Paint Brush
  - Paint Bucket w/ multiple modes
  - Eye dropper

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/deathbreakfast/house-lights.git
   cd house-lights
   ```
2. Build the v2 frontend (React/Tailwind bundle):
   ```bash
   scripts/build_v2.sh
   ```
3. Create and activate a virtual environment:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
4. Install backend dependencies (Flask, requests, flask-sock, etc.):
   ```bash
   pip install --upgrade pip
   pip install -r requirements.txt
   ```

## System Requirements

- **Python**: Python 3.7+
- **Controller**: Any device capable of running Python (Windows, macOS, Linux)
- **Hardware Devices**: Raspberry Pi (recommended for GPIO control of WS2811 LED strips)
- **Network**: Controller and follower devices must be on the same network for communication

## Current Status

NOTE: I wired my Raspberry Pi and/or WS2811 and I saw the dreaded green smoke after full scale test. Currently on Hiatus until I have time to finish.

- Multiple devices and light synchronization not tested.
- Playlist playback, currently incomplete and not working
- E2E tests not implemented

## Architecture

House Lights uses a controller-follower architecture:

- **Controller**: The main orchestration node that hosts the web UI, manages device connections, stores playlists, and coordinates all follower devices. Only one controller should be running.
- **Follower Devices**: Hardware nodes (typically Raspberry Pi) that connect to the controller, expose device APIs, and execute commands sent via WebSocket. Multiple followers can be connected to a single controller.

## Environment Variables

### Controller Settings

| Variable | Description | Example |
| --- | --- | --- |
| `IS_CONTROLLER` | Set `true` on the orchestration node ("controller"). Followers should set `false` so they skip UI/db and just expose device APIs. Defaults to `true`. | `IS_CONTROLLER=true` |
| `HOUSE_LIGHTS_GPIO_PINS` | Comma-separated list of GPIO pins and labels. | `18:Living Room,13:Porch` |
| `HOUSE_LIGHTS_PIN_LED_COUNTS` | Pin-to-LED-count mapping (must match `HOUSE_LIGHTS_GPIO_PINS`). | `18=120,13=60` |
| `HOUSE_LIGHTS_PATTERN_DIR` | Override pattern storage directory. | `/opt/houselights/patterns` |
| `HOUSE_LIGHTS_HEALTH_POLL_INTERVAL` | Controller polling interval (seconds) for refreshing device health. | `60` |
| `HOUSE_LIGHTS_DEVICE_HEALTH_MAX_AGE` | Seconds before a device is considered offline in the UI. | `45` |
| `HOUSE_LIGHTS_HANDSHAKE_TIMEOUT` | Seconds to wait when the controller performs a handshake fetch. | `5` |

### Follower Device Settings

| Variable | Description | Example |
| --- | --- | --- |
| `HOUSE_LIGHTS_CONTROLLER_HOST` | Hostname/IP of the controller. Followers use this when initiating handshakes. | `http://192.168.1.10:5001` |
| `HOUSE_LIGHTS_DEVICE_ID`, `HOUSE_LIGHTS_DEVICE_NAME`, `HOUSE_LIGHTS_DEVICE_TYPE`, `HOUSE_LIGHTS_DEVICE_STRIP_MODE` | Metadata that follower devices expose during `/api/device/meta`. Defaults fall back to hostname. | `HOUSE_LIGHTS_DEVICE_ID=porch-esp32` |
| `HOUSE_LIGHTS_DEVICE_CAPABILITIES` | JSON blob describing hardware features (exposed in metadata). | `{"supportsPlaylists":true}` |
| `HOUSE_LIGHTS_DEVICE_IP` | Override autodetection if it doesn't work. | — |
| `HOUSE_LIGHTS_FIRMWARE_VERSION` | Surface firmware metadata during handshakes. | — |

### Optional Settings

| Variable | Description | Example |
| --- | --- | --- |
| `HOUSE_LIGHTS_LOG_FILE`, `HOUSE_LIGHTS_LOG_MAX_BYTES`, `HOUSE_LIGHTS_LOG_BACKUP_COUNT` | Optional tuning knobs for logging. | — |

## Running the Application

### Running the Controller

1. Ensure the frontend bundle is built (`scripts/build_v2.sh`) and Python deps are installed.
2. Export the controller environment (at minimum `IS_CONTROLLER=true`, GPIO pin definitions, and LED counts).
3. Start the Flask server:
   ```bash
   source .venv/bin/activate
   export IS_CONTROLLER=true
   export HOUSE_LIGHTS_GPIO_PINS="18:Living Room"
   export HOUSE_LIGHTS_PIN_LED_COUNTS="18=120"
   flask --app src/app.py run --reload --port 5001
   ```
4. Visit `http://<controller>:5001/v2` to access the UI and add devices.

The controller will initialize SQLite under `~/.houselights/houselights_v2.db`, host the UI, manage handshakes, store playlists, and maintain WebSocket connections to every follower.

### Running a Follower Device

1. Clone the repo onto the device (or copy just the `src` directory plus requirements).
2. Set `IS_CONTROLLER=false` and point `HOUSE_LIGHTS_CONTROLLER_HOST` at the controller.
3. Provide the hardware-specific env vars (`HOUSE_LIGHTS_GPIO_PINS`, `HOUSE_LIGHTS_PIN_LED_COUNTS`, `HOUSE_LIGHTS_DEVICE_ID`, etc.).
4. Install deps and start Flask:
   ```bash
   source .venv/bin/activate
   export IS_CONTROLLER=false
   export HOUSE_LIGHTS_CONTROLLER_HOST="http://192.168.1.10:5001"
   export HOUSE_LIGHTS_DEVICE_ID="porch-strip"
   export HOUSE_LIGHTS_GPIO_PINS="18:Porch"
   export HOUSE_LIGHTS_PIN_LED_COUNTS="18=120"
   flask --app src/app.py run --host 0.0.0.0 --port 5002
   ```

Follower nodes skip the UI, expose `/api/device/meta` & `/api/device/health` for controller handshakes, accept WebSocket commands, and execute playlists or live frames pushed from the controller.

## License

This project is released under the MIT License. See `LICENSE` for details.
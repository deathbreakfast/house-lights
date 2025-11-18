"""WebSocket client for follower devices to connect to controller."""

from __future__ import annotations

import json
import logging
import threading
import time
import os
from typing import TYPE_CHECKING
from urllib.parse import urljoin, urlsplit

try:
    import websocket
except ImportError:
    websocket = None  # type: ignore

if TYPE_CHECKING:
    from flask import Flask

from ..datetime_utils import now_iso

LOGGER = logging.getLogger(__name__)


class FollowerWebSocketClient:
    """WebSocket client that connects follower devices to the controller."""

    def __init__(self, app: Flask) -> None:
        """Initialize the follower WebSocket client."""
        self.app = app
        self.ws: websocket.WebSocket | None = None
        self.device_id: str | None = None
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._connected = False
        self._reconnect_delay = 5.0  # seconds
        self._local_playlist: dict[str, object] | None = None
        self._playback_engine = None

    def _get_device_id(self) -> str:
        """Get the device ID from environment or fallback."""
        device_id = os.getenv("HOUSE_LIGHTS_DEVICE_ID")
        if device_id:
            return device_id.strip()
        
        import socket
        return socket.gethostname()

    def _get_controller_ws_url(self) -> str | None:
        """Get the WebSocket URL for the controller."""
        controller_host = os.getenv("HOUSE_LIGHTS_CONTROLLER_HOST")
        if not controller_host:
            return None
        
        # Parse the controller host URL
        parsed = urlsplit(controller_host)
        scheme = "ws" if parsed.scheme == "http" else "wss" if parsed.scheme == "https" else "ws"
        host = parsed.netloc or parsed.path
        port = parsed.port
        
        # Build WebSocket URL
        if port:
            return f"{scheme}://{host}/ws/controller"
        else:
            # Default port based on scheme
            default_port = 5001 if scheme == "ws" else 443
            if ":" in host:
                return f"{scheme}://{host}/ws/controller"
            return f"{scheme}://{host}:{default_port}/ws/controller"

    def _on_message(self, ws: websocket.WebSocket, message: str) -> None:
        """Handle incoming WebSocket messages from controller."""
        try:
            data = json.loads(message)
            msg_type = data.get("type")
            
            if msg_type == "ack":
                # Handle hello acknowledgment
                ack_cmd = data.get("command")
                if ack_cmd == "hello":
                    self._connected = True
                    LOGGER.info("WebSocket connection established with controller - device_id=%s", self.device_id)
            elif msg_type == "command":
                # Handle commands from controller
                command = data.get("command")
                payload = data.get("payload", {})
                self._handle_command(command, payload)
            elif msg_type == "error":
                error_msg = data.get("message", "Unknown error")
                LOGGER.warning("WebSocket error from controller: %s", error_msg)
        except json.JSONDecodeError:
            LOGGER.warning("Invalid JSON received from controller: %s", message[:100])
        except Exception as exc:
            LOGGER.error("Error handling WebSocket message: %s", exc, exc_info=True)

    def _handle_command(self, command: str, payload: dict[str, object]) -> None:
        """Handle commands from the controller."""
        LOGGER.debug("Received command from controller - command=%s, payload_keys=%s", command, list(payload.keys()))
        
        if command == "live_frame":
            self._handle_live_frame(payload)
        elif command == "live_play":
            self._handle_live_play(payload)
        elif command == "live_pause":
            self._handle_live_pause(payload)
        elif command == "playlist_ready":
            self._handle_playlist_ready(payload)
        elif command == "playlist_play":
            self._handle_playlist_play(payload)
        elif command == "playlist_pause":
            self._handle_playlist_pause(payload)
        elif command == "power":
            self._handle_power(payload)
        elif command == "strip_mode":
            self._handle_strip_mode(payload)
        else:
            LOGGER.warning("Unhandled command from controller: %s", command)

    def _handle_live_frame(self, payload: dict[str, object]) -> None:
        """Handle live_frame command - apply LED states directly to hardware."""
        led_states = payload.get("ledStates")
        if not isinstance(led_states, dict):
            LOGGER.warning("live_frame command missing or invalid ledStates")
            return
        
        LOGGER.debug("Applying live_frame - led_count=%s", len(led_states))
        self._apply_led_states_to_hardware(led_states)

    def _handle_live_play(self, payload: dict[str, object]) -> None:
        """Handle live_play command - start live playback."""
        LOGGER.info("Received live_play command - payload=%s", payload)
        # TODO: Implement live playback if needed

    def _handle_live_pause(self, payload: dict[str, object]) -> None:
        """Handle live_pause command - pause live playback."""
        LOGGER.info("Received live_pause command - payload=%s", payload)
        # TODO: Implement live pause if needed

    def _handle_playlist_ready(self, payload: dict[str, object]) -> None:
        """Handle playlist_ready command - playlist is ready for download."""
        LOGGER.info("Received playlist_ready command - payload=%s", payload)
        download_url = payload.get("downloadUrl")
        if not isinstance(download_url, str):
            LOGGER.warning("playlist_ready missing downloadUrl")
            return
        
        # Download playlist from controller
        try:
            import requests
            response = requests.get(download_url, timeout=10.0)
            if response.status_code == 200:
                self._local_playlist = response.json()
                LOGGER.info(
                    "Downloaded playlist - entries=%d",
                    len(self._local_playlist.get("entries", [])) if isinstance(self._local_playlist, dict) else 0,
                )
            else:
                LOGGER.warning("Failed to download playlist - status=%d", response.status_code)
        except Exception as exc:
            LOGGER.error("Error downloading playlist: %s", exc, exc_info=True)

    def _handle_playlist_play(self, payload: dict[str, object]) -> None:
        """Handle playlist_play command - start playlist playback."""
        LOGGER.info("Received playlist_play command - payload=%s", payload)
        
        if not self._local_playlist:
            LOGGER.warning("No playlist available, cannot start playback")
            return
        
        # Initialize local playback engine if needed
        if self._playback_engine is None:
            from ..playlists.playback_engine import PlaylistPlaybackEngine
            self._playback_engine = PlaylistPlaybackEngine(self.app)
        
        # Get synchronized start time from payload if provided, otherwise use current time
        synchronized_start_time_ms = payload.get("startTimeMs")
        if not isinstance(synchronized_start_time_ms, int):
            synchronized_start_time_ms = int(time.time() * 1000) + 100
        
        # Store playlist in a way the engine can access it
        # For follower devices, we need to store it in a format the engine expects
        # The engine reads from device_playlists table, but followers don't have that
        # So we'll need to modify the engine or store it differently
        # For now, let's store it in app config temporarily
        device_id = self._get_device_id()
        self.app.config.setdefault("FOLLOWER_PLAYLISTS", {})[device_id] = self._local_playlist
        
        # Start playback
        self._playback_engine.start_playback(device_id, synchronized_start_time_ms)
        LOGGER.info("Started local playlist playback - device_id=%s, start_time_ms=%s", device_id, synchronized_start_time_ms)

    def _handle_playlist_pause(self, payload: dict[str, object]) -> None:
        """Handle playlist_pause command - pause playlist playback."""
        LOGGER.info("Received playlist_pause command - payload=%s", payload)
        
        if self._playback_engine is None:
            LOGGER.debug("No playback engine initialized, nothing to pause")
            return
        
        device_id = self._get_device_id()
        self._playback_engine.stop_playback(device_id)
        LOGGER.info("Paused local playlist playback - device_id=%s", device_id)

    def _handle_power(self, payload: dict[str, object]) -> None:
        """Handle power command - turn lights on/off."""
        power_on = payload.get("powerOn", False)
        controller = self.app.config.get("LIGHT_CONTROLLER")
        if controller:
            controller.set_power(bool(power_on))
            LOGGER.info("Power command executed - power_on=%s", power_on)

    def _handle_strip_mode(self, payload: dict[str, object]) -> None:
        """Handle strip_mode command - update strip mode."""
        LOGGER.info("Received strip_mode command - payload=%s", payload)
        # TODO: Implement strip mode update if needed

    def _apply_led_states_to_hardware(self, led_states: dict[str, object]) -> None:
        """Apply LED states directly to hardware, filtering to only LEDs belonging to this device."""
        controller = self.app.config.get("LIGHT_CONTROLLER")
        if not controller:
            LOGGER.warning("LIGHT_CONTROLLER not available, cannot apply live frame")
            return
        
        try:
            # Ensure led_states is in correct format: dict[str, dict[str, object]]
            if not isinstance(led_states, dict):
                LOGGER.warning("led_states must be a dictionary")
                return
            
            # Filter LED states to only those belonging to this device
            my_device_id = self._get_device_id()
            filtered_states: dict[str, dict[str, object]] = {}
            
            for led_id, state in led_states.items():
                if not isinstance(state, dict):
                    LOGGER.warning("LED state for %s is not a dictionary, skipping", led_id)
                    continue
                
                # Check if this LED belongs to this device
                # LED IDs are typically: "{device_id}-{strip_id}-led-{index}" where strip_id is "{device_id}-{pin}"
                # So LED IDs look like: "{device_id}-{device_id}-{pin}-led-{index}" (e.g., "houselights-houselights-18-led-0")
                # Legacy format: "{device_id}-pin-{pin}-led-{index}" (still supported)
                if led_id.startswith(f"{my_device_id}-"):
                    filtered_states[str(led_id)] = state
                else:
                    LOGGER.debug("LED %s does not belong to device %s, skipping", led_id, my_device_id)
            
            if not filtered_states:
                LOGGER.debug("No LED states for this device (device_id=%s)", my_device_id)
                return
            
            # If controller has a method to apply LED states directly, use it
            if hasattr(controller, "apply_led_states"):
                controller.apply_led_states(filtered_states)  # type: ignore
                LOGGER.debug("Applied %d LED states to hardware (filtered from %d total)", len(filtered_states), len(led_states))
            else:
                LOGGER.warning("Controller does not support apply_led_states method")
            
        except Exception as exc:
            LOGGER.error("Error applying LED states to hardware: %s", exc, exc_info=True)

    def _send_heartbeat(self) -> None:
        """Send heartbeat message to controller."""
        if not self.ws or not self._connected or not self.device_id:
            return
        
        try:
            heartbeat = {
                "type": "heartbeat",
                "deviceId": self.device_id,
                "payload": {
                    "timestamp": now_iso(),
                    "unixTimeMs": int(time.time() * 1000),
                },
            }
            self.ws.send(json.dumps(heartbeat))
        except Exception as exc:
            LOGGER.warning("Error sending heartbeat: %s", exc)

    def _connect(self) -> bool:
        """Establish WebSocket connection to controller."""
        if websocket is None:
            LOGGER.error("websocket-client library not installed. Install with: pip install websocket-client")
            return False
        
        ws_url = self._get_controller_ws_url()
        if not ws_url:
            LOGGER.warning("HOUSE_LIGHTS_CONTROLLER_HOST not set, cannot connect to controller")
            return False
        
        self.device_id = self._get_device_id()
        
        try:
            LOGGER.info("Connecting to controller WebSocket: %s", ws_url)
            self.ws = websocket.WebSocketApp(
                ws_url,
                on_message=self._on_message,
                on_error=self._on_error,
                on_close=self._on_close,
                on_open=self._on_open,
            )
            
            # Run WebSocket in blocking mode
            self.ws.run_forever()
            return True
        except Exception as exc:
            LOGGER.error("Error connecting to controller: %s", exc, exc_info=True)
            return False

    def _on_open(self, ws: websocket.WebSocket) -> None:
        """Handle WebSocket connection opened."""
        LOGGER.info("WebSocket connection opened to controller")
        
        # Send hello message
        try:
            identity = self._get_device_identity()
            hello = {
                "type": "hello",
                "deviceId": self.device_id,
                "payload": identity,
            }
            ws.send(json.dumps(hello))
            LOGGER.debug("Sent hello message to controller")
        except Exception as exc:
            LOGGER.error("Error sending hello message: %s", exc, exc_info=True)

    def _on_error(self, ws: websocket.WebSocket, error: Exception) -> None:
        """Handle WebSocket error."""
        LOGGER.warning("WebSocket error: %s", error)
        self._connected = False

    def _on_close(self, ws: websocket.WebSocket, close_status_code: int | None, close_msg: str | None) -> None:
        """Handle WebSocket connection closed."""
        LOGGER.info("WebSocket connection closed - status=%s, msg=%s", close_status_code, close_msg)
        self._connected = False
        self.ws = None

    def _get_device_identity(self) -> dict[str, object]:
        """Get device identity payload for hello message."""
        identity: dict[str, object] = {
            "timestamp": now_iso(),
            "unixTimeMs": int(time.time() * 1000),
        }
        
        # Add strip information if available
        strip_configs = self.app.config.get("STRIP_CONFIGS", [])
        if strip_configs:
            identity["strips"] = [
                {
                    "pin": config.pin,
                    "ledCount": config.led_count,
                    "name": config.name,
                }
                for config in strip_configs
            ]
        
        return identity

    def _run(self) -> None:
        """Main connection loop with automatic reconnection."""
        while not self._stop_event.is_set():
            if not self._connected:
                LOGGER.info("Attempting to connect to controller...")
                self._connect()
            
            # If connected, send periodic heartbeats
            if self._connected and not self._stop_event.is_set():
                # Send heartbeat every 30 seconds
                for _ in range(6):  # 6 * 5 seconds = 30 seconds
                    if self._stop_event.wait(5.0):
                        return
                    if not self._connected:
                        break
                
                if self._connected:
                    self._send_heartbeat()
            
            # Wait before reconnecting
            if not self._connected and not self._stop_event.is_set():
                LOGGER.info("Waiting %s seconds before reconnecting...", self._reconnect_delay)
                if self._stop_event.wait(self._reconnect_delay):
                    return

    def start(self) -> None:
        """Start the WebSocket client in a background thread."""
        if self._thread and self._thread.is_alive():
            LOGGER.warning("Follower WebSocket client already running")
            return
        
        if websocket is None:
            LOGGER.warning("websocket-client library not installed. Follower WebSocket client will not start.")
            LOGGER.warning("Install with: pip install websocket-client")
            return
        
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="FollowerWSClient")
        self._thread.start()
        LOGGER.info("Follower WebSocket client started")

    def stop(self) -> None:
        """Stop the WebSocket client."""
        self._stop_event.set()
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=2.0)
        LOGGER.info("Follower WebSocket client stopped")


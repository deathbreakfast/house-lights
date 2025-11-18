# Debugging Live Mode - Log Viewing Guide

## How to View Logs

Based on your command:
```bash
echo 'yes' | python3 scripts/dump_and_reset_db.py --reset --no-backup && scripts/build_v2.sh && export HOUSE_LIGHTS_VERBOSE_DEVICE_LOGS=true && export HOUSE_LIGHTS_GPIO_PINS=18 && export HOUSE_LIGHTS_PIN_LED_COUNTS=18=50 && flask --app src/app.py run --reload --port 5001
```

### Option 1: View stdout/stderr (Terminal Output)
Since Flask runs in the foreground, all logs appear in your terminal. Look for:
- `INFO` level messages about playback start/stop
- `DEBUG` level messages about WebSocket commands (when `HOUSE_LIGHTS_VERBOSE_DEVICE_LOGS=true`)
- Messages prefixed with scene_id, timestamp, and led_count

### Option 2: View Log File
Logs are also written to a file. Check these locations in order:
1. `~/.houselights/logs/app.log` (most likely)
2. `/var/log/houselights/app.log` (if you have permissions)

To view the log file in real-time:
```bash
tail -f ~/.houselights/logs/app.log
```

Or view the last 100 lines:
```bash
tail -n 100 ~/.houselights/logs/app.log
```

### Option 3: Use the Live Logs API
The application provides a live log streaming endpoint:
```bash
# In another terminal
curl http://localhost:5001/api/logs/live
```

Or open in browser: `http://localhost:5001/api/logs/live`

## What to Look For

When testing live mode, you should see these log messages:

### 1. Live Mode Toggle
```
INFO: Live mode toggle - enabled=True
INFO: live_mode WebSocket command sent - enabled=True, results={...}
```

### 2. Playback Start (in live mode)
```
INFO: Playback start request - scene_id=<id>, live_mode=True
INFO: Live mode playback start - scene_id=<id>, timestamp=<ms>, led_count=<n>
DEBUG: Applying keyframe for live mode play - scene_id=<id>, timestamp=<ms>
INFO: Applying keyframe - scene_id=<id>, timestamp=<ms>, led_count=<n>
DEBUG: Sending live_frame WebSocket command - scene_id=<id>, timestamp=<ms>, led_count=<n>
INFO: live_frame command sent - results={...}
DEBUG: Sending live_play WebSocket command - scene_id=<id>, timestamp=<ms>
INFO: live_play command sent - results={...}
```

### 3. Playback Stop (in live mode)
```
INFO: Playback stop request - scene_id=<id>, live_mode=True
INFO: Live mode playback stop - scene_id=<id>, timestamp=<ms>, led_count=<n>
DEBUG: Applying keyframe for live mode pause - scene_id=<id>, timestamp=<ms>
INFO: Applying keyframe - scene_id=<id>, timestamp=<ms>, led_count=<n>
DEBUG: Sending live_frame WebSocket command - scene_id=<id>, timestamp=<ms>, led_count=<n>
INFO: live_frame command sent - results={...}
DEBUG: Sending live_pause WebSocket command - scene_id=<id>, timestamp=<ms>
INFO: live_pause command sent - results={...}
```

### 4. LED Color Update (when paused in live mode)
When you change an LED color while paused in live mode, you should see:
```
INFO: Applying keyframe - scene_id=<id>, timestamp=<ms>, led_count=<n>
DEBUG: Sending live_frame WebSocket command - scene_id=<id>, timestamp=<ms>, led_count=<n>
INFO: live_frame command sent - results={...}
```

## Troubleshooting

### If you don't see WebSocket command logs:
- Check that `HOUSE_LIGHTS_VERBOSE_DEVICE_LOGS=true` is set
- Check that devices are connected (WebSocket clients registered)
- Look for `DEVICE_SERVICE not available` warnings

### If WebSocket results show `False`:
- Device may not be connected
- Check device connection status in the UI
- Verify WebSocket handshake completed successfully

### If timestamp or ledStates are missing:
- Check browser console for errors
- Verify the frontend is sending the correct payload
- Look for warnings like "Live mode play missing timestamp or ledStates"

## Setting Log Level

To get even more detailed logs, set:
```bash
export HOUSE_LIGHTS_LOG_LEVEL=DEBUG
```

This will show all DEBUG level messages including WebSocket communication details.


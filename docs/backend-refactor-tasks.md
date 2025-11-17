# Backend Refactoring Tasks

This document outlines the remaining backend refactoring tasks to modularize the Flask monolith (`src/app.py`, currently ~3268 lines) into a more maintainable, testable architecture.

## Overview

**Current State:**
- `src/app.py` contains 60+ route handlers and numerous helper functions
- Device-related logic partially extracted to `DeviceService`
- Utility functions split into granular modules (`json_utils`, `url_utils`, `network_utils`, `datetime_utils`)
- Pattern management extracted to `PatternStore`

**Goal:**
- Organize routes into Flask Blueprints by domain
- Extract business logic into service classes
- Create repository/data access layer for database operations
- Improve testability and maintainability

---

## 1. Flask Blueprints (Route Organization)

Extract route handlers from `app.py` into domain-specific blueprints.

### 1.1 Scene Blueprint (`src/server/blueprints/scenes.py`)
**Routes to extract:**
- `GET /api/v2/scenes` - List all scenes
- `POST /api/v2/scenes` - Create scene
- `GET /api/v2/scenes/<scene_id>` - Get scene
- `PATCH /api/v2/scenes/<scene_id>` - Update scene
- `DELETE /api/v2/scenes/<scene_id>` - Delete scene
- `GET /api/v2/scenes/<scene_id>/devices` - Get scene devices
- `POST /api/v2/scenes/<scene_id>/devices` - Add device to scene
- `GET /api/v2/scenes/<scene_id>/power` - Get scene power state
- `PATCH /api/v2/scenes/<scene_id>/power` - Update scene power state

**Helper functions to move:**
- `_ensure_scene_exists()`
- `_delete_audio_asset()`
- Scene serialization logic

### 1.2 Background/Image Blueprint (`src/server/blueprints/backgrounds.py`)
**Routes to extract:**
- `POST /api/v2/scenes/<scene_id>/background` - Upload scene background
- `POST /api/v2/background` - Upload global background
- `GET /api/v2/images/<image_id>` - Get image by ID
- `GET /api/v2/scenes/<scene_id>/background` - Get scene background
- `GET /api/v2/background` - Get global background
- `PATCH /api/v2/scenes/<scene_id>/background/scale` - Update scene background scale
- `PATCH /api/v2/background/scale` - Update global background scale

**Helper functions to move:**
- `_upload_background_image()`
- `_get_background_response()`
- `_update_background_scale()`

### 1.3 Audio Blueprint (`src/server/blueprints/audio.py`)
**Routes to extract:**
- `POST /api/v2/scenes/<scene_id>/audio` - Upload audio file
- `GET /api/v2/scenes/<scene_id>/audio` - Get scene audio
- `DELETE /api/v2/scenes/<scene_id>/audio` - Delete scene audio

### 1.4 Keyframe Blueprint (`src/server/blueprints/keyframes.py`)
**Routes to extract:**
- `GET /api/v2/scenes/<scene_id>/keyframes` - List keyframes
- `POST /api/v2/scenes/<scene_id>/keyframes` - Create keyframe
- `PATCH /api/v2/scenes/<scene_id>/keyframes/<keyframe_id>` - Update keyframe
- `DELETE /api/v2/scenes/<scene_id>/keyframes/<keyframe_id>` - Delete keyframe
- `POST /api/v2/scenes/<scene_id>/keyframes/<int:timestamp_ms>/apply` - Apply keyframe

### 1.5 Device Blueprint (`src/server/blueprints/devices.py`)
**Routes to extract:**
- `GET /api/device/meta` - Get device metadata
- `GET /api/device/health` - Get device health
- `POST /api/v2/devices/handshake` - Device handshake
- `GET /api/v2/devices/<device_id>/status` - Get device status
- `POST /api/v2/devices/<device_id>/commands` - Send device command
- `POST /api/v2/devices/<device_id>/playlist` - Upload device playlist
- `GET /api/v2/devices/<device_id>/playlist` - Get device playlist
- `GET /api/v2/devices/<device_id>/playlist/download` - Download device playlist
- `PATCH /api/v2/devices/<device_id>` - Update device
- `PATCH /api/v2/devices/<device_id>/leds` - Update device LEDs
- `DELETE /api/v2/devices/<device_id>` - Delete device
- `POST /api/v2/devices/playback` - Device playback control

**Note:** Some device logic already in `DeviceService`; routes should delegate to service methods.

### 1.6 Playlist Blueprint (`src/server/blueprints/playlists.py`)
**Routes to extract:**
- `GET /api/v2/scene-playlist` - Get scene playlist
- `PUT /api/v2/scene-playlist` - Update scene playlist

**Helper functions to move:**
- `_serialize_playlist_entry()`
- `_compute_playlist_hash()` (already delegated to DeviceService)

### 1.7 Pattern Blueprint (`src/server/blueprints/patterns.py`)
**Routes to extract:**
- `GET /patterns/configure` - Pattern configuration UI
- `GET /api/patterns` - List patterns
- `POST /api/patterns` - Create pattern
- `GET /api/patterns/<pattern_id>` - Get pattern
- `PUT /api/patterns/<pattern_id>` - Update pattern
- `DELETE /api/patterns/<pattern_id>` - Delete pattern
- `POST /patterns/select` - Select pattern (legacy)

**Note:** Pattern logic already in `PatternStore`; routes should delegate to store methods.

### 1.8 Strip/Simulator Blueprint (`src/server/blueprints/strips.py`)
**Routes to extract:**
- `GET /api/strips` - List strips
- `POST /api/strips/simulator` - Register simulated strip
- `DELETE /api/strips/simulator/<int:pin>` - Remove simulated strip
- `POST /api/strips/<int:pin>/led/<int:pixel_index>` - Set LED color

**Helper functions to move:**
- `_register_simulated_strip()`
- `_remove_simulated_strip()`

### 1.9 Playback Blueprint (`src/server/blueprints/playback.py`)
**Routes to extract:**
- `GET /api/v2/live-mode` - Get live mode state
- `PATCH /api/v2/live-mode` - Update live mode state
- `POST /api/v2/playback/<scene_id>/start` - Start playback
- `POST /api/v2/playback/<scene_id>/stop` - Stop playback

### 1.10 Logs Blueprint (`src/server/blueprints/logs.py`)
**Routes to extract:**
- `GET /api/logs/recent` - Get recent logs
- `GET /api/logs/live` - Stream live logs

**Helper functions to move:**
- `_build_journalctl_command()`
- `_build_log_response()`

### 1.11 Legacy Blueprint (`src/server/blueprints/legacy.py`)
**Routes to extract:**
- `POST /lights/on` - Turn lights on (legacy)
- `POST /lights/off` - Turn lights off (legacy)

**Helper functions to move:**
- `_set_light_power()`
- `_set_pattern()`
- `_apply_current_pattern()`

### 1.12 Core Blueprint (`src/server/blueprints/core.py`)
**Routes to keep in core:**
- `GET /health` - Health check
- `GET /` - Index page (dashboard)
- `GET /v2` - V2 studio page

---

## 2. Service Layer Extraction

Extract business logic from route handlers into service classes.

### 2.1 SceneService (`src/server/scenes/service.py`)
**Responsibilities:**
- Scene CRUD operations
- Scene validation
- Scene-to-device relationships
- Scene power state management

**Methods to implement:**
- `create_scene(scene_id: str, name: str, data: dict) -> dict`
- `get_scene(scene_id: str) -> dict | None`
- `update_scene(scene_id: str, updates: dict) -> dict`
- `delete_scene(scene_id: str) -> None`
- `ensure_scene_exists(scene_id: str, name: str | None = None) -> None`
- `get_scene_power_state(scene_id: str) -> dict`
- `update_scene_power_state(scene_id: str, is_on: bool) -> None`

**Dependencies:**
- Database connection (via repository pattern)
- `DeviceService` (for device relationships)

### 2.2 BackgroundService (`src/server/backgrounds/service.py`)
**Responsibilities:**
- Background image upload/storage
- Image metadata management
- Background scale management

**Methods to implement:**
- `upload_background(scene_id: str, file, filename: str, content_type: str) -> dict`
- `get_background(scene_id: str) -> dict | None`
- `update_background_scale(scene_id: str, scale: int) -> dict`
- `get_image_by_id(image_id: str) -> tuple[Path, str] | None`  # Returns (file_path, content_type)

**Dependencies:**
- Database connection
- File storage path (`V2_IMAGES_DIR`)

### 2.3 AudioService (`src/server/audio/service.py`)
**Responsibilities:**
- Audio file upload/storage
- Audio metadata management
- Audio file cleanup

**Methods to implement:**
- `upload_audio(scene_id: str, file, filename: str, content_type: str) -> dict`
- `get_audio(scene_id: str) -> dict | None`
- `delete_audio(scene_id: str) -> None`
- `delete_audio_asset(audio_meta: dict | None) -> None`

**Dependencies:**
- Database connection
- File storage path

### 2.4 KeyframeService (`src/server/keyframes/service.py`)
**Responsibilities:**
- Keyframe CRUD operations
- Keyframe validation
- Keyframe application to devices

**Methods to implement:**
- `list_keyframes(scene_id: str) -> list[dict]`
- `create_keyframe(scene_id: str, timestamp_ms: int, data: dict) -> dict`
- `update_keyframe(scene_id: str, keyframe_id: str, updates: dict) -> dict`
- `delete_keyframe(scene_id: str, keyframe_id: str) -> None`
- `apply_keyframe(scene_id: str, timestamp_ms: int) -> dict`

**Dependencies:**
- Database connection
- `DeviceService` (for applying keyframes to devices)

### 2.5 DevicePersistenceService (`src/server/devices/persistence.py`)
**Responsibilities:**
- Device persistence operations
- Device graph management
- LED layout generation
- Local device seeding

**Methods to implement:**
- `persist_device_graph(device_id: str, scene_id: str, ip_address: str, position: dict | None, device_type: str, strip_mode: str | None, strips: list[dict] | None) -> None`
- `ensure_local_device_strips(db: sqlite3.Connection, device_id: str, scene_id: str, strip_configs: list[LightStripConfig]) -> None`
- `seed_local_device_for_scene(scene_id: str) -> None`
- `generate_led_layout(led_count: int, strip_index: int, base_x: float, base_y: float, id_prefix: str | None = None) -> list[dict]`

**Note:** Currently `_persist_device_graph` and `_ensure_local_device_strips` are passed as lambdas to `DeviceService`. These should be extracted into a dedicated service.

### 2.6 PlaylistService (`src/server/playlists/service.py`)
**Responsibilities:**
- Playlist CRUD operations
- Playlist serialization
- Playlist hash computation

**Methods to implement:**
- `get_playlist() -> list[dict]`
- `update_playlist(entries: list[dict]) -> None`
- `serialize_playlist_entry(row: sqlite3.Row) -> dict`
- `compute_playlist_hash(payload: dict) -> str`

**Dependencies:**
- Database connection
- `DeviceService` (for playlist dispatch)

### 2.7 PlaybackService (`src/server/playback/service.py`)
**Responsibilities:**
- Playback state management
- Live mode management
- Playback control

**Methods to implement:**
- `get_live_mode() -> dict`
- `update_live_mode(enabled: bool) -> dict`
- `start_playback(scene_id: str) -> dict`
- `stop_playback(scene_id: str) -> dict`
- `control_device_playback(device_ids: list[str] | None, command: str) -> dict`

**Dependencies:**
- `DeviceService` (for device commands)

### 2.8 StripService (`src/server/strips/service.py`)
**Responsibilities:**
- Strip configuration management
- Simulated strip management
- LED color updates

**Methods to implement:**
- `list_strips() -> list[dict]`
- `register_simulated_strip(config: LightStripConfig) -> None`
- `remove_simulated_strip(pin: int) -> bool`
- `set_led_color(pin: int, pixel_index: int, color: dict) -> dict`

**Dependencies:**
- Hardware controller
- Database connection (for simulated strips)

---

## 3. Repository/Data Access Layer

Create repository classes to abstract database operations.

### 3.1 SceneRepository (`src/server/scenes/repository.py`)
**Methods:**
- `create(scene_id: str, name: str, data: dict) -> None`
- `get_by_id(scene_id: str) -> sqlite3.Row | None`
- `list_all() -> list[sqlite3.Row]`
- `update(scene_id: str, updates: dict) -> None`
- `delete(scene_id: str) -> None`
- `exists(scene_id: str) -> bool`

### 3.2 DeviceRepository (`src/server/devices/repository.py`)
**Methods:**
- `get_by_id(device_id: str) -> sqlite3.Row | None`
- `get_by_scene_id(scene_id: str) -> list[sqlite3.Row]`
- `create(device_id: str, scene_id: str, ...) -> None`
- `update(device_id: str, updates: dict) -> None`
- `delete(device_id: str) -> None`
- `update_health_metadata(device_id: str, metadata: dict) -> None`

### 3.3 KeyframeRepository (`src/server/keyframes/repository.py`)
**Methods:**
- `list_by_scene(scene_id: str) -> list[sqlite3.Row]`
- `get_by_id(keyframe_id: str) -> sqlite3.Row | None`
- `create(scene_id: str, keyframe_id: str, timestamp_ms: int, data: dict) -> None`
- `update(keyframe_id: str, updates: dict) -> None`
- `delete(keyframe_id: str) -> None`

### 3.4 BackgroundRepository (`src/server/backgrounds/repository.py`)
**Methods:**
- `create(image_id: str, scene_id: str, filename: str, content_type: str, file_path: str, scale: int) -> None`
- `get_by_scene_id(scene_id: str) -> sqlite3.Row | None`
- `get_by_id(image_id: str) -> sqlite3.Row | None`
- `update_scale(scene_id: str, scale: int) -> None`

### 3.5 AudioRepository (`src/server/audio/repository.py`)
**Methods:**
- `create(audio_id: str, scene_id: str, filename: str, content_type: str, file_path: str) -> None`
- `get_by_scene_id(scene_id: str) -> sqlite3.Row | None`
- `delete_by_scene_id(scene_id: str) -> None`

### 3.6 PlaylistRepository (`src/server/playlists/repository.py`)
**Methods:**
- `get_all() -> list[sqlite3.Row]`
- `replace_all(entries: list[dict]) -> None`
- `delete_all() -> None`

---

## 4. WebSocket Handling

### 4.1 WebSocket Blueprint (`src/server/blueprints/websocket.py`)
**Routes to extract:**
- WebSocket endpoint registration (currently in `app.py` via `@sock.route`)

**Note:** WebSocket client management already partially in `DeviceService`. Consider:
- Moving WebSocket route handlers to a blueprint
- Keeping WebSocket client registry in `DeviceService` or a dedicated `WebSocketService`

---

## 5. Configuration & Initialization

### 5.1 AppConfigService (`src/server/config/service.py`)
**Responsibilities:**
- Centralize app configuration loading
- Environment variable parsing
- Configuration validation

**Methods to implement:**
- `load_config() -> dict`
- `validate_config(config: dict) -> None`
- `get_strip_configs() -> list[LightStripConfig]`

**Note:** Some config logic already in `src/server/config.py`; consolidate here.

### 5.2 AppInitialization (`src/server/init.py`)
**Responsibilities:**
- Pattern store initialization
- Default pattern seeding
- Device service initialization
- Database initialization

**Functions to extract:**
- Pattern store setup logic from `create_app()`
- Default pattern seeding
- Controller initialization

---

## 6. Testing Infrastructure

### 6.1 Test Utilities
- Create test fixtures for Flask app
- Mock database connections
- Mock device services
- Test helpers for blueprints

### 6.2 Integration Tests
- Test each blueprint independently
- Test service layer with mocked repositories
- Test repository layer with test database

### 6.3 Unit Tests
- Test service methods in isolation
- Test repository methods
- Test utility functions

---

## 7. Dependency Injection

### 7.1 Service Container
Consider using a simple dependency injection pattern:
- Create service instances in `create_app()`
- Store in `app.config` or use Flask's application context
- Inject services into blueprints via factory functions

**Example structure:**
```python
def create_scene_blueprint(scene_service: SceneService, ...) -> Blueprint:
    bp = Blueprint('scenes', __name__, url_prefix='/api/v2/scenes')
    # Register routes that use scene_service
    return bp
```

---

## 8. Error Handling & Validation

### 8.1 Error Handlers
- Create custom exception classes
- Register error handlers in blueprints or app
- Standardize error response format

### 8.2 Request Validation
- Extract validation logic from route handlers
- Create validation decorators or middleware
- Use schema validation (e.g., `marshmallow` or `pydantic`)

---

## 9. Migration Strategy

### Phase 1: Extract Services (Low Risk)
1. Create service classes for business logic
2. Move helper functions to services
3. Update route handlers to call services
4. Keep routes in `app.py` initially

### Phase 2: Extract Repositories (Medium Risk)
1. Create repository classes
2. Update services to use repositories
3. Test thoroughly

### Phase 3: Extract Blueprints (Medium Risk)
1. Create blueprints one domain at a time
2. Register blueprints in `create_app()`
3. Remove routes from `app.py`
4. Test each blueprint independently

### Phase 4: Cleanup (Low Risk)
1. Remove unused helper functions
2. Consolidate configuration
3. Add comprehensive tests
4. Update documentation

---

## 10. Priority Recommendations

### High Priority
1. **SceneService** - Core functionality, heavily used
2. **DevicePersistenceService** - Currently passed as lambda, should be proper service
3. **Scene Blueprint** - Largest route group, good starting point
4. **Device Blueprint** - Complex logic, already partially extracted

### Medium Priority
5. **KeyframeService & Blueprint** - Well-defined domain
6. **BackgroundService & Blueprint** - Self-contained functionality
7. **PlaylistService & Blueprint** - Simple CRUD operations
8. **Repository layer** - Improves testability

### Low Priority
9. **Legacy Blueprint** - Deprecated routes, low impact
10. **Logs Blueprint** - Simple streaming, low complexity
11. **Testing infrastructure** - Can be done incrementally

---

## Notes

- **Backward Compatibility**: Ensure all existing API endpoints continue to work
- **Database Migrations**: No schema changes expected, but verify repository layer doesn't break existing queries
- **Performance**: Monitor for any performance regressions during refactoring
- **Documentation**: Update API documentation as routes are moved to blueprints


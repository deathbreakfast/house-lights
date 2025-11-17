## LED Scene Editor Refactor Plan

### Goals
- Extract monolithic `LEDSceneEditor.tsx` logic (3538 → 878 LOC, 75% reduction) into focused hooks/components.
- Improve separation of concerns for:
  - Device and strip management
  - API interactions (scenes, devices, playlists)
  - Canvas viewport, file uploads, media handling
  - Playlist editing and persistence
  - Event handlers and user interactions
- Maintain functional parity while enabling easier testing and future refactors.

### Current Progress
- Extracted backend utilities: `json_utils`, `network_utils`, `datetime_utils`, `url_utils`.
- Added frontend hooks/utilities:
  - **Core Hooks:**
    - `useCanvasViewport` for pan/zoom/touch state.
    - `useDevices` for polling/connection updates.
    - `useSceneAPI` for scene/keyframe/power persistence.
    - `useFileUpload` for background/audio uploads.
    - `usePlaylist` for playlist CRUD + debounced saves.
    - `useDeviceManagement` for add/reset/strip CRUD + strip-mode updates.
  - **Interaction Hooks:**
    - `useCanvasInteractions` for canvas mouse/touch handlers and painting.
    - `useTimelineInteractions` for timeline click/drag/slider handlers.
    - `usePropertiesPanel` for properties panel state and selection management.
  - **Handler Hooks:**
    - `useKeyframeHandlers` for keyframe CRUD operations.
    - `useSceneHandlers` for scene create/delete/rename/audio management.
    - `useDeviceHandlers` for device type/IP/connection management.
    - `useColorHandlers` for color and opacity updates.
    - `usePlaybackHandlers` for playback control and power state.
  - **Utility Hooks:**
    - `useAutoExtendTimeline` for automatic timeline extension.
    - `useKeyboardShortcuts` for keyboard shortcuts.
    - `useBackgroundImageLoader` for background image loading.
    - `useDeviceLoader` for device loading.
    - `useSceneBootstrap` for initial scene loading.
    - `useSceneDataLoader` for scene data loading.
    - `useDevicePoller` for device polling.
    - `useLiveModeKeyframe` for live mode keyframe application.
    - `useSceneNameSync` for scene name synchronization.
    - `useCurrentFrameKeyframeRef` for current frame keyframe reference.
  - **Utilities:**
    - `utils/devices.ts` for device helpers (`createClientId`, etc.).
- `LEDSceneEditor.tsx` reduced from 3538 to 878 LOC (75% reduction); all major handlers and logic extracted.

### Outstanding Work
1. **Component Extraction** (Optional)
   - Break down JSX sections (e.g., properties drawer content, modals, playlist editor).
   - Create `DeviceInspector` and `StripList` components fed by hooks.
   - Extract background image scale handler into a dedicated hook if needed.
2. **Typing & Error Handling**
   - Tighten API response types; add `Result` helpers for fetch calls.
   - Surface toast/toast-equivalent feedback on network failures (partially done with `useNotifications`).
3. **Testing/Validation**
   - Add unit tests for new hooks (mock fetch + timers).
   - Snapshot/component tests once JSX is modularized.

### Completed
✅ All major handler functions extracted into dedicated hooks
✅ Canvas interactions extracted into `useCanvasInteractions`
✅ Timeline interactions extracted into `useTimelineInteractions`
✅ Properties panel management extracted into `usePropertiesPanel`
✅ Keyframe handlers extracted into `useKeyframeHandlers`
✅ Scene handlers extracted into `useSceneHandlers`
✅ Device handlers extracted into `useDeviceHandlers`
✅ Color handlers extracted into `useColorHandlers`
✅ Playback handlers extracted into `usePlaybackHandlers`
✅ Notification system implemented (`useNotifications`)
✅ All utility hooks created and integrated

### Next Steps (Optional Enhancements)
1. Extract `handleBackgroundImageScaleChange` into a dedicated hook if it grows in complexity.
2. Add comprehensive unit tests for all hooks.
3. Consider extracting JSX into smaller components for better maintainability.
4. Add error boundary components for better error handling.


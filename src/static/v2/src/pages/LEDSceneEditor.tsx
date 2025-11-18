import React, {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  MouseEvent as ReactMouseEvent,
  ChangeEvent,
} from "react";
import { EditorLayout } from "../components/layout/EditorLayout";
import { SceneViewer } from "../components/scene/SceneViewer";
import { PropertiesDrawerOverlay } from "../components/properties/PropertiesDrawerOverlay";
import { DrawerDataProvider } from "../context/DrawerContext";
import { PowerButton } from "../components/buttons/PowerButton";
import { TopRightButtons } from "../components/buttons/TopRightButtons";
import { ToolPalette } from "../components/buttons/ToolPalette";
import { TimelineContainer } from "../components/timeline/TimelineContainer";
import { SceneModal } from "../components/modals/SceneModal";
import { SceneSettingsModal } from "../components/modals/SceneSettingsModal";
import { ColorPickerModal } from "../components/modals/ColorPickerModal";
import type {
  Scene,
  Device,
  LEDStrip,
  LED,
  Keyframe,
  Tool,
  EditorMode,
  Point,
  ScenePlaylistEntry,
  DeviceConnectionState,
  DeviceHealth,
} from "../types/editor";
import { DEFAULT_SCENE, DEFAULT_TOTAL_DURATION } from "../constants/editor";
import { useSceneStore } from "../state/sceneStore";
import { useGlobalStore } from "../state/globalStore";
import { useTimelinePlayer } from "../hooks/useTimelinePlayer";
import { usePaintTool } from "../hooks/usePaintTool";
import {
  buildSceneLedState,
  cloneLedStateMap,
  dedupeKeyframesByTimestamp,
  findKeyframeAtPosition,
  getFrameLedState,
  sortKeyframes,
} from "../utils/timeline";
import {
  collectContiguousLedIds,
  distanceToSegment,
} from "../utils/paint";
import { createClientId } from "../utils/devices";
import { useCanvasViewport } from "../hooks/useCanvasViewport";
import { useDevices } from "../hooks/useDevices";
import { useSceneAPI } from "../hooks/useSceneAPI";
import { useFileUpload } from "../hooks/useFileUpload";
import { usePlaylist } from "../hooks/usePlaylist";
import { useDeviceManagement } from "../hooks/useDeviceManagement";
import { useCanvasInteractions } from "../hooks/useCanvasInteractions";
import { useKeyframeDrag } from "../hooks/useKeyframeDrag";
import { useTimelineInteractions } from "../hooks/useTimelineInteractions";
import { useAutoExtendTimeline } from "../hooks/useAutoExtendTimeline";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useBackgroundImageLoader } from "../hooks/useBackgroundImageLoader";
import { useDeviceLoader } from "../hooks/useDeviceLoader";
import { useSceneBootstrap } from "../hooks/useSceneBootstrap";
import { useSceneDataLoader } from "../hooks/useSceneDataLoader";
import { useDevicePoller } from "../hooks/useDevicePoller";
import { useLiveModeKeyframe } from "../hooks/useLiveModeKeyframe";
import { useSceneNameSync } from "../hooks/useSceneNameSync";
import { useCurrentFrameKeyframeRef } from "../hooks/useCurrentFrameKeyframeRef";
import { useKeyframeHandlers } from "../hooks/useKeyframeHandlers";
import { useDrawer } from "../context/DrawerContext";
import { useSceneHandlers } from "../hooks/useSceneHandlers";
import { useDeviceHandlers } from "../hooks/useDeviceHandlers";
import { useColorHandlers } from "../hooks/useColorHandlers";
import { usePlaybackHandlers } from "../hooks/usePlaybackHandlers";
import { useNotifications } from "../utils/notifications";
import { NotificationContainer } from "../components/ui/NotificationToast";

export const LEDSceneEditor: React.FC = () => {
  const {
    scenes,
    setScenes,
    currentScene,
    currentSceneId,
    setCurrentSceneId,
    selectedDeviceId,
    setSelectedDeviceId,
    selectedLEDId,
    setSelectedLEDId,
    selectedKeyframeId,
    setSelectedKeyframeId,
    selectedBackgroundImage,
    setSelectedBackgroundImage,
    updateCurrentScene,
    updateKeyframe,
    deleteKeyframe,
    undo,
    createHistoryCheckpoint,
    runWithHistoryBatch,
    beginHistoryTransaction,
    endHistoryTransaction,
    updateDevice,
  } = useSceneStore();

  // Local state (must be declared before useSceneAPI which needs setSceneSettingsName)
  const [mode, setMode] = useState<EditorMode>("view");
  const [tool, setTool] = useState<Tool>("select");
  const [powerOn, setPowerOn] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [showSceneModal, setShowSceneModal] = useState(false);
  const [isSceneSettingsOpen, setIsSceneSettingsOpen] = useState(false);
  const [sceneSettingsName, setSceneSettingsName] = useState("");
  const [isSavingSceneName, setIsSavingSceneName] = useState(false);

  // Scene API (must be called before useSceneBootstrap which needs loadScenes)
  const {
    loadScenes,
    loadKeyframes,
    loadPowerState,
    savePowerState,
    saveKeyframe,
    applyKeyframe,
  } = useSceneAPI({
    currentSceneId,
    setScenes,
    setCurrentSceneId,
    updateCurrentScene,
    setSceneSettingsName,
  });
  
  // Bootstrap scenes on initial load
  const scenesBootstrapped = useSceneBootstrap({
    loadScenes,
  });
  
  // Global state for devices and background (loaded once at startup)
  const {
    devices,
    setDevices,
    backgroundImage,
    setBackgroundImage,
    backgroundImageScale,
    setBackgroundImageScale,
  } = useGlobalStore({ scenesBootstrapped });

  // Notifications
  const { notifications, dismiss } = useNotifications();

  // Canvas viewport state
  const {
    canvasZoom,
    setCanvasZoom,
    canvasPan,
    setCanvasPan,
    isPanning,
    setIsPanning,
    lastPanPosition,
    setLastPanPosition,
    isDraggingElement,
    setIsDraggingElement,
    dragStartOffset,
    setDragStartOffset,
    touchState,
    setTouchState,
  } = useCanvasViewport();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const [timelineDuration, setTimelineDuration] = useState(DEFAULT_TOTAL_DURATION);

  // File upload handling
  const { fileInputRef, audioInputRef } = useFileUpload({
    currentSceneId,
    canvasRef,
    canvasZoom,
    setBackgroundImage,
    setBackgroundImageScale,
    setCanvasPan,
    setCanvasZoom,
    setScenes,
  });

  // Playlist management
  const {
    playlistEntries,
    handlePlaylistReorder,
    handleAddSceneToPlaylist,
    handleUpdatePlaylistEntry,
    handleRemovePlaylistEntry,
    handleRemovePlaylistEntriesBySceneId,
  } = usePlaylist();

  const playbackWindow = useMemo(() => {
    if (!currentScene.keyframes.length) {
      return undefined;
    }
    const sortedFrames = sortKeyframes(currentScene.keyframes);
    if (!sortedFrames.length) {
      return undefined;
    }
    const start = sortedFrames[0].timestamp;
    const end = sortedFrames[sortedFrames.length - 1].timestamp;
    return { start, end };
  }, [currentScene.keyframes]);

  const {
    timelinePosition,
    setTimelinePosition,
    isPlaying,
    togglePlayback: toggleTimelinePlayback,
    framerate,
    setFramerate,
    timelineWindowStart,
    setTimelineWindowStart,
    timelineWindowWidth,
    setTimelineWindowWidth,
    isDraggingTimeline,
    setIsDraggingTimeline,
    sliderHandlers,
    isDraggingSlider,
    snapToFrame,
    setTimelineFromPointer,
  } = useTimelinePlayer({
    audioRef,
    timelineRef,
    playbackWindow,
    duration: timelineDuration,
    initialFramerate: currentScene.framerate ?? 24,
  });

  // Save framerate to scene when it changes (both local state and backend)
  const setFramerateWithSave = useCallback(
    (newFramerate: number) => {
      setFramerate(newFramerate);
      updateCurrentScene((scene) => ({
        ...scene,
        framerate: newFramerate,
      }));
      
      // Persist to backend (fire and forget)
      fetch(`/api/v2/scenes/${currentSceneId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ framerate: newFramerate }),
      })
        .then((response) => {
          if (!response.ok) {
            console.error("Error saving framerate:", response.status, response.statusText);
          }
        })
        .catch((error) => {
          console.error("Error saving framerate:", error);
        });
    },
    [setFramerate, updateCurrentScene, currentSceneId]
  );

  const {
    selectedColor,
    setSelectedColor,
    selectedOpacity,
    setSelectedOpacity,
    isPainting,
    beginPainting,
    endPainting,
  } = usePaintTool();

  const baseLedState = useMemo(
    () => {
      const state = buildSceneLedState(devices);
      return state;
    },
    [currentScene.id, currentScene.name, devices]
  );

  const frameLedState = useMemo(
    () => {
      const state = getFrameLedState({
        keyframes: currentScene.keyframes,
        timelinePosition,
        baseState: baseLedState,
      });
      return state;
    },
    [baseLedState, currentScene.keyframes, timelinePosition]
  );

  // Create updateDevice function for global devices
  const updateGlobalDevice = useCallback(
    (deviceId: string, updater: (device: Device) => Device) => {
      setDevices((currentDevices) =>
        currentDevices.map((device: Device) => (device.id === deviceId ? updater(device) : device))
      );
    },
    [setDevices]
  );

  // Device management
  const { fetchDevices, setDeviceConnectionState } = useDevices({
    setDevices,
    updateDevice: updateGlobalDevice,
  });
  
  // Create a wrapper that passes existing devices to preserve state
  const fetchDevicesWithState = useCallback(() => {
    return fetchDevices(devices);
  }, [fetchDevices, devices]);

  // Device/strip management (must come after useDevices for fetchSceneDevices)
  const {
    handleAddDevice,
    handleAddStrip,
    handleRemoveStrip,
    handleUpdateStrip,
    handleResetDevices,
    handleDeviceStripModeChange,
  } = useDeviceManagement({
    currentSceneId,
    devices,
    canvasRef,
    backgroundImage,
    backgroundImageScale,
    canvasZoom,
    canvasPan,
    setDevices,
    setSelectedDeviceId,
    setSelectedLEDId,
    fetchDevices,
  });
  const ledMetadata = useMemo(() => {
    const map = new Map<
      string,
      {
        device: Device;
        strip: LEDStrip;
        led: LED;
        deviceId: string;
        stripId: string;
        ledIndex: number;
      }
    >();
    devices.forEach((device) => {
      device.strips.forEach((strip) => {
        strip.leds.forEach((led, ledIndex) => {
          map.set(led.id, {
            device,
            strip,
            led,
            deviceId: device.id,
            stripId: strip.id,
            ledIndex,
          });
        });
      });
    });
    return map;
  }, [devices]);

  const updateSceneDuration = useCallback(
    (rawDurationMs: number) => {
      const sanitizedDuration = Math.max(
        DEFAULT_TOTAL_DURATION,
        Math.round(rawDurationMs)
      );
      setTimelineDuration((prev) =>
        prev === sanitizedDuration ? prev : sanitizedDuration
      );
      setScenes(
        (prev) => {
          let changed = false;
          const nextScenes = prev.map((scene) => {
            if (scene.id !== currentSceneId) {
              return scene;
            }
            const existing = scene.durationMs ?? DEFAULT_TOTAL_DURATION;
            if (existing === sanitizedDuration) {
              return scene;
            }
            changed = true;
            return { ...scene, durationMs: sanitizedDuration };
          });
          return changed ? nextScenes : prev;
        },
        { recordHistory: false }
      );
    },
    [currentSceneId, setScenes]
  );

  // Auto-extend timeline based on keyframes and audio
  useAutoExtendTimeline({
    currentScene,
    timelineDuration,
    setTimelineDuration,
    updateSceneDuration,
    audioRef,
  });

  // Current frame keyframe reference management
  const currentFrameKeyframeRef = useCurrentFrameKeyframeRef(timelinePosition);
  const skipNextClickRef = useRef(false);
  const draggedDuringInteractionRef = useRef(false);

  // Drawer context
  const { openDrawer, closeDrawer, isOpen } = useDrawer();

  // Keyframe selection handler
  const handleKeyframeSelect = useCallback(
    (keyframe: Keyframe) => {
      if (isOpen && selectedKeyframeId === keyframe.id) {
        closeDrawer();
        return;
      }
      setSelectedKeyframeId(keyframe.id);
      setSelectedBackgroundImage(false);
      // Pass the keyframe object directly so drawer can use it even if state hasn't updated
      openDrawer({ type: "keyframe", keyframeId: keyframe.id }, keyframe);
    },
    [isOpen, selectedKeyframeId, closeDrawer, openDrawer, setSelectedKeyframeId, setSelectedBackgroundImage]
  );

  // Sync scene name to local state
  useSceneNameSync({
    sceneName: currentScene.name,
    setSceneSettingsName,
  });

  // Load scene data (keyframes and power state) when scene changes
  useSceneDataLoader({
    scenesBootstrapped,
    currentSceneId: currentScene.id,
    loadKeyframes,
    loadPowerState,
    setPowerOn,
  });

  // Set initial zoom/pan to fit background image when it loads
  useBackgroundImageLoader({
    scenesBootstrapped,
    canvasRef,
    backgroundImage,
    backgroundImageScale,
    canvasZoom,
    setCanvasPan,
    setCanvasZoom,
  });

  // Load devices from backend when scene changes
  useDeviceLoader({
    scenesBootstrapped,
    setDevices,
  });

  // Poll devices from backend
  useDevicePoller({
    scenesBootstrapped,
    fetchDevices,
  });

  // Apply keyframes in live mode
  useLiveModeKeyframe({
    powerOn,
    liveMode,
    currentSceneId,
    timelinePosition,
    frameLedState,
    isPlaying,
    applyKeyframe,
  });

  const ensureKeyframeAtCurrentFrame = useCallback((options?: { openDrawer?: boolean }) => {
    const shouldOpenDrawer = options?.openDrawer ?? false;
    const snappedPosition = snapToFrame(timelinePosition);
    const cached = currentFrameKeyframeRef.current;
    if (cached && Math.abs(cached.timestamp - snappedPosition) < 0.5) {
      const existing =
        currentScene.keyframes.find(
          (keyframe) => keyframe.id === cached.keyframeId
        ) ?? null;
      return {
        keyframeId: cached.keyframeId,
        timestamp: cached.timestamp,
        effects: existing?.effects ?? {},
      };
    }

    const existing =
      currentScene.keyframes.find(
        (keyframe) => Math.abs(keyframe.timestamp - snappedPosition) < 0.5
      ) ?? null;
    if (existing) {
      currentFrameKeyframeRef.current = {
        timestamp: snappedPosition,
        keyframeId: existing.id,
      };
      return {
        keyframeId: existing.id,
        timestamp: snappedPosition,
        effects: existing.effects ?? {},
      };
    }

    const ledStatesSnapshot = cloneLedStateMap(frameLedState);
    const newKeyframe: Keyframe = {
      id: `keyframe-${Date.now()}`,
      timestamp: snappedPosition,
      effects: {
        fadeIn: 0,
        fadeOut: 0,
      },
      ledStates: ledStatesSnapshot,
    };

    updateCurrentScene((scene) => ({
      ...scene,
      keyframes: sortKeyframes([...scene.keyframes, newKeyframe]),
    }));

    currentFrameKeyframeRef.current = {
      timestamp: snappedPosition,
      keyframeId: newKeyframe.id,
    };

    setSelectedKeyframeId(newKeyframe.id);
    // Only open drawer if explicitly requested (e.g., from "Add Keyframe" button)
    if (shouldOpenDrawer) {
      // Pass the new keyframe object directly so drawer can use it even if state hasn't updated
      openDrawer({ type: "keyframe", keyframeId: newKeyframe.id }, newKeyframe);
    }
    void saveKeyframe(currentSceneId, newKeyframe);
    return {
      keyframeId: newKeyframe.id,
      timestamp: snappedPosition,
      effects: newKeyframe.effects ?? {},
    };
  }, [
    currentScene.keyframes,
    frameLedState,
    setSelectedKeyframeId,
    openDrawer,
    snapToFrame,
    timelinePosition,
    updateCurrentScene,
    currentSceneId,
    saveKeyframe,
  ]);

  // Canvas interactions hook
  const {
    handleCanvasMouseDown,
    handleCanvasMouseMove,
    handleCanvasMouseUp,
    handleCanvasClick,
    handleCanvasTouchStart,
    handleCanvasTouchMove,
    handleCanvasTouchEnd,
    commitLedUpdates,
  } = useCanvasInteractions({
    canvasRef,
    currentScene,
    currentSceneId,
    frameLedState,
    ledMetadata,
    tool,
    mode,
    selectedColor,
    selectedOpacity,
    isPainting,
    beginPainting,
    endPainting,
    setSelectedColor,
    setSelectedOpacity,
    canvasZoom,
    canvasPan,
    setCanvasZoom,
    setCanvasPan,
    isPanning,
    setIsPanning,
    lastPanPosition,
    setLastPanPosition,
    isDraggingElement,
    setIsDraggingElement,
    dragStartOffset,
    setDragStartOffset,
    touchState,
    setTouchState,
    setTool,
    updateCurrentScene,
    updateKeyframe,
    runWithHistoryBatch,
    beginHistoryTransaction,
    endHistoryTransaction,
    createHistoryCheckpoint,
    ensureKeyframeAtCurrentFrame,
    devices,
    setDevices,
    selectedDeviceId,
    selectedLEDId,
    setSelectedDeviceId,
    setSelectedLEDId,
    setSelectedKeyframeId,
    setSelectedBackgroundImage,
    backgroundImage,
    selectedBackgroundImage,
    skipNextClickRef,
    draggedDuringInteractionRef,
    liveMode,
    isPlaying,
    timelinePosition,
    applyKeyframe,
  });

  // Timeline interactions hook
  const {
    handleTimelineClick,
    handleTimelineDrag,
    handlePlayheadMouseDown,
    handleSliderMouseDown,
    handleTimelinePointer,
    handleTimelineTouchStart,
    handlePlayheadTouchStart,
    handleSliderTouchStart,
  } = useTimelineInteractions({
    timelineRef,
    sliderRef,
    currentScene,
    timelineDuration,
    timelineWindowStart,
    timelineWindowWidth,
    isDraggingTimeline,
    setIsDraggingTimeline,
    isDraggingSlider,
    setTimelineFromPointer,
    sliderHandlers,
    handleKeyframeSelect,
    setSelectedKeyframeId,
    setSelectedBackgroundImage,
    closeDrawer,
  });

  const selectedDevice = devices.find(
    (device) => device.id === selectedDeviceId
  ) || null;

  const selectedLED = (() => {
    if (!selectedLEDId) {
      return undefined;
    }
    for (const device of devices) {
      for (const strip of device.strips) {
        for (const led of strip.leds) {
          if (led.id === selectedLEDId) {
            return led;
          }
        }
      }
    }
    return undefined;
  })();

  const selectedKeyframe = useMemo(
    () =>
      currentScene.keyframes.find((keyframe) => keyframe.id === selectedKeyframeId) ??
      null,
    [currentScene.keyframes, selectedKeyframeId]
  );

  // Keyframe handlers
  const {
    handleDeleteKeyframe,
    handleAddKeyframe,
    handleKeyframeEffectsChange,
  } = useKeyframeHandlers({
    currentSceneId,
    selectedKeyframeId,
    deleteKeyframe,
    updateKeyframe,
    closeDrawer,
    openDrawer,
    ensureKeyframeAtCurrentFrame,
    setSelectedKeyframeId,
    currentFrameKeyframeRef,
  });

  // Keyframe drag handlers
  const {
    isDraggingKeyframe,
    handleKeyframeDragStart,
    handleKeyframeDrag,
    handleKeyframeDragEnd,
  } = useKeyframeDrag({
    keyframes: currentScene.keyframes,
    selectedKeyframeId,
    framerate,
    totalDuration: timelineDuration,
    timelineWindowStart,
    timelineWindowWidth,
    timelineRef,
    updateKeyframe,
    updateCurrentScene,
    createHistoryCheckpoint,
  });






  // Playback handlers
  const {
    handlePowerToggle,
    handlePlayPause,
    handleExtendTimeline,
  } = usePlaybackHandlers({
    currentSceneId,
    powerOn,
    setPowerOn,
    savePowerState,
    isPlaying,
    toggleTimelinePlayback,
    timelineDuration,
    updateSceneDuration,
    liveMode,
    timelinePosition,
    frameLedState,
    applyKeyframe,
  });


  // Keyboard shortcuts
  useKeyboardShortcuts({
    mode,
    selectedKeyframeId,
    setTool,
    handleDeleteKeyframe,
    handlePlayPause,
    undo,
  });



  // Color handlers
  const {
    handleColorChange,
    handleOpacityChange,
    handleColorPickerInputChange,
    handleColorPickerOpacityChange,
  } = useColorHandlers({
    selectedLEDId,
    commitLedUpdates,
    setSelectedColor,
    setSelectedOpacity,
  });

  // Device handlers
  const {
    handleDeviceIpChange,
    handleDeviceConnect,
  } = useDeviceHandlers({
    currentSceneId,
    devices,
    setDevices,
    updateDevice: updateGlobalDevice,
    setDeviceConnectionState,
    fetchDevices,
  });

  const handleBackgroundImageScaleChange = useCallback(async (newScale: number) => {
    setBackgroundImageScale(newScale);
    try {
      const response = await fetch(`/api/v2/background/scale`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scale: newScale }),
      });
      if (!response.ok) {
        console.error("Failed to save background image scale");
      }
    } catch (error) {
      console.error("Error saving background image scale:", error);
    }
  }, []);


  // Scene handlers
  const {
    handleCreateScene,
    handleSelectScene,
    handleDeleteScene,
    handleSceneNameSave,
    handleRemoveAudio,
  } = useSceneHandlers({
    currentSceneId,
    currentScene,
    scenes,
    setScenes,
    setCurrentSceneId,
    setSceneSettingsName,
    setIsSceneSettingsOpen,
    setIsSavingSceneName,
    setShowSceneModal,
    canvasRef,
    canvasPan,
    canvasZoom,
    handleRemovePlaylistEntriesBySceneId,
  });

  // Memoize the drawer data value to ensure it updates when devices change
  const drawerDataValue = React.useMemo(
    () => ({
      devices,
      timelinePosition,
      frameLedState,
      onColorChange: handleColorChange,
      onOpacityChange: handleOpacityChange,
      onKeyframeEffectsChange: handleKeyframeEffectsChange,
      onBackgroundImageScaleChange: handleBackgroundImageScaleChange,
      onDeviceIpChange: handleDeviceIpChange,
      onDeviceConnect: handleDeviceConnect,
      onDeviceStripModeChange: handleDeviceStripModeChange,
      onAddStrip: handleAddStrip,
      onRemoveStrip: handleRemoveStrip,
      onUpdateStrip: handleUpdateStrip,
      onResetDevices: handleResetDevices,
      onDeleteKeyframe: handleDeleteKeyframe,
    }),
    [
      devices,
      timelinePosition,
      frameLedState,
      handleColorChange,
      handleOpacityChange,
      handleKeyframeEffectsChange,
      handleBackgroundImageScaleChange,
      handleDeviceIpChange,
      handleDeviceConnect,
      handleDeviceStripModeChange,
      handleAddStrip,
      handleRemoveStrip,
      handleUpdateStrip,
      handleResetDevices,
      handleDeleteKeyframe,
    ]
  );

  return (
    <DrawerDataProvider value={drawerDataValue}>
    <EditorLayout fileInputRef={fileInputRef} audioInputRef={audioInputRef}>
      <div className="flex-1 relative">
        <SceneViewer
          canvasRef={canvasRef}
          scene={currentScene}
          devices={devices}
          frameLedState={frameLedState}
          backgroundImage={backgroundImage}
          backgroundImageScale={backgroundImageScale}
          canvasZoom={canvasZoom}
          canvasPan={canvasPan}
          selectedDeviceId={selectedDeviceId}
          selectedLEDId={selectedLEDId}
          powerOn={powerOn}
          tool={tool}
          mode={mode}
          onCanvasClick={handleCanvasClick}
          onCanvasMouseDown={handleCanvasMouseDown}
          onCanvasMouseMove={handleCanvasMouseMove}
          onCanvasMouseUp={handleCanvasMouseUp}
          onCanvasTouchStart={handleCanvasTouchStart}
          onCanvasTouchMove={handleCanvasTouchMove}
          onCanvasTouchEnd={handleCanvasTouchEnd}
        />

        <PowerButton
          powerOn={powerOn}
          liveMode={liveMode}
          onPowerToggle={handlePowerToggle}
          onLiveModeToggle={() => setLiveMode((prev) => !prev)}
        />

        <TopRightButtons
          fileInputRef={fileInputRef}
          mode={mode}
          onModeChange={setMode}
          onSceneManagerClick={() => setShowSceneModal(true)}
          onSceneSettingsClick={() => setIsSceneSettingsOpen(true)}
        />

        <ToolPalette
          tool={tool}
          mode={mode}
          onToolChange={setTool}
          onAddDevice={handleAddDevice}
        />

        {tool === "color-picker" ? (
          <ColorPickerModal
            selectedColor={selectedColor}
            selectedOpacity={selectedOpacity}
            onColorChange={handleColorPickerInputChange}
            onOpacityChange={handleColorPickerOpacityChange}
            onToolChange={setTool}
          />
        ) : null}
            </div>

      <TimelineContainer
        audioInputRef={audioInputRef}
        timelineRef={timelineRef}
        sliderRef={sliderRef}
        isPlaying={isPlaying}
        framerate={framerate}
        totalDuration={timelineDuration}
        timelinePosition={timelinePosition}
        timelineWindowStart={timelineWindowStart}
        timelineWindowWidth={timelineWindowWidth}
        isDraggingTimeline={isDraggingTimeline}
        keyframes={currentScene.keyframes}
        selectedKeyframeId={selectedKeyframeId}
        hasAudio={Boolean(currentScene.audioUrl)}
        onPlayPause={handlePlayPause}
        onAddKeyframe={handleAddKeyframe}
        onExtendDuration={handleExtendTimeline}
        onFramerateChange={setFramerateWithSave}
        onTimelineClick={(event) => {
          // Don't handle timeline click if we're dragging a keyframe
          if (isDraggingKeyframe) {
            return;
          }
          
          // Only check for keyframes if clicking in the keyframe area (not ruler or waveform)
          const target = event.target as HTMLElement;
          const isKeyframeElement = target.closest('[data-keyframe]') !== null;
          const isInKeyframeArea = timelineRef.current?.contains(target) ?? false;
          
          if (isKeyframeElement || isInKeyframeArea) {
            // Check for keyframe at click position
            const keyframe = findKeyframeAtPosition(
              event.clientX,
              timelineRef,
              currentScene.keyframes,
              timelineWindowStart,
              timelineWindowWidth,
              timelineDuration
            );
            
            if (keyframe) {
              // Keyframe found - select it and don't move playhead
              handleKeyframeSelect(keyframe);
              return;
            }
          }
          
          // No keyframe found or clicking outside keyframe area - proceed with normal timeline click
          handleTimelineClick(event);
        }}
        onTimelineMouseDown={(event) => {
          // Don't start timeline drag if we're already dragging a keyframe
          if (isDraggingKeyframe) {
            return;
          }
          
          // Check if the click target is a keyframe drag handle first (highest priority)
          const target = event.target as HTMLElement;
          const isDragHandle = target.closest('[data-keyframe-drag-handle]') !== null;
          if (isDragHandle) {
            // Let the keyframe drag handle handle the event
            return;
          }
          
          // Only check for keyframes if clicking in the keyframe area (not ruler or waveform)
          const isKeyframeElement = target.closest('[data-keyframe]') !== null;
          const isInKeyframeArea = timelineRef.current?.contains(target) ?? false;
          
          if (isKeyframeElement || isInKeyframeArea) {
            // Check for ANY keyframe at click position using utility function
            const keyframe = findKeyframeAtPosition(
              event.clientX,
              timelineRef,
              currentScene.keyframes,
              timelineWindowStart,
              timelineWindowWidth,
              timelineDuration
            );
            
            if (keyframe) {
              // Keyframe found - let it handle the event (it will select itself)
              return;
            }
          }
          
          // No keyframe found or clicking outside keyframe area - start timeline drag
          setIsDraggingTimeline(true);
          handleTimelinePointer(event.clientX, { focusKeyframe: true });
        }}
        onTimelineMouseUp={() => {
          setIsDraggingTimeline(false);
          handleKeyframeDragEnd();
        }}
        onTimelineDrag={(event) => {
          if (isDraggingKeyframe) {
            event.preventDefault();
            handleKeyframeDrag(event);
          } else if (!isDraggingTimeline) {
            // Only handle timeline drag if we're actually dragging the timeline
            return;
          } else {
            handleTimelineDrag(event);
          }
        }}
        onPlayheadMouseDown={handlePlayheadMouseDown}
        onSliderMouseDown={handleSliderMouseDown}
        onTimelineTouchStart={handleTimelineTouchStart}
        onPlayheadTouchStart={handlePlayheadTouchStart}
        onSliderTouchStart={handleSliderTouchStart}
        onKeyframeSelect={handleKeyframeSelect}
        onKeyframeDragStart={handleKeyframeDragStart}
        onKeyframeDrag={handleKeyframeDrag}
        onKeyframeDragEnd={handleKeyframeDragEnd}
        isDraggingKeyframe={isDraggingKeyframe}
      />

      <SceneModal
        isOpen={showSceneModal}
        scenes={scenes}
        currentSceneId={currentSceneId}
        onClose={() => setShowSceneModal(false)}
        onSelectScene={handleSelectScene}
        onCreateScene={handleCreateScene}
        playlist={playlistEntries}
        onAddSceneToPlaylist={handleAddSceneToPlaylist}
        onReorderPlaylist={handlePlaylistReorder}
        onUpdatePlaylistEntry={handleUpdatePlaylistEntry}
        onRemovePlaylistEntry={handleRemovePlaylistEntry}
      />

      <SceneSettingsModal
        isOpen={isSceneSettingsOpen}
        sceneName={sceneSettingsName}
        audioFileName={currentScene.audioFileName}
        disableDelete={scenes.length <= 1}
        isSaving={isSavingSceneName}
        onClose={() => setIsSceneSettingsOpen(false)}
        onSaveName={handleSceneNameSave}
        onRequestAudioUpload={() => audioInputRef.current?.click()}
        onRemoveAudio={handleRemoveAudio}
        onDeleteScene={handleDeleteScene}
      />

      {currentScene.audioUrl ? (
        <audio ref={audioRef} src={currentScene.audioUrl} />
      ) : null}

      <NotificationContainer notifications={notifications} onDismiss={dismiss} />
      <PropertiesDrawerOverlay />
    </EditorLayout>
    </DrawerDataProvider>
  );
};

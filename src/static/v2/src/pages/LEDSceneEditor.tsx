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
import { PropertiesDrawer } from "../components/properties/PropertiesDrawer";
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
import { usePropertiesPanel } from "../hooks/usePropertiesPanel";
import { useKeyframeHandlers } from "../hooks/useKeyframeHandlers";
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
    showPropertiesPanel,
    setShowPropertiesPanel,
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
      console.log("setFramerateWithSave called with:", newFramerate);
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
          } else {
            console.log("Framerate saved successfully");
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
      const totalLeds = devices.reduce(
        (sum, device) =>
          sum +
          device.strips.reduce(
            (stripSum, strip) => stripSum + strip.leds.length,
            0
          ),
        0
      );
      console.log("[LEDSceneEditor] baseLedState recalculating", {
        sceneId: currentScene.id,
        sceneName: currentScene.name,
        deviceCount: devices.length,
        baseLedStateKeys: Object.keys(state).length,
        totalLedsInScene: totalLeds,
        hasDevicesButNoLeds: devices.length > 0 && totalLeds === 0,
      });
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
      console.log("[LEDSceneEditor] frameLedState recalculating", {
        sceneId: currentScene.id,
        frameLedStateKeys: Object.keys(state).length,
        baseLedStateKeys: Object.keys(baseLedState).length,
      });
      return state;
    },
    [baseLedState, currentScene.keyframes, timelinePosition]
  );

  // Device management
  const { fetchDevices, setDeviceConnectionState } = useDevices({
    setDevices,
    updateDevice,
  });

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

  // Properties panel management
  const {
    handlePropertiesClose,
    handleKeyframeSelect,
    pendingExternalCloseRef,
    suppressNextOutsideCloseRef,
  } = usePropertiesPanel({
    showPropertiesPanel,
    setShowPropertiesPanel,
    selectedKeyframeId,
    setSelectedKeyframeId,
    setSelectedDeviceId,
    setSelectedLEDId,
    setSelectedBackgroundImage,
  });


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
    applyKeyframe,
  });

  const ensureKeyframeAtCurrentFrame = useCallback(() => {
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
    suppressNextOutsideCloseRef.current = true;
    setShowPropertiesPanel(true);
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
    setShowPropertiesPanel,
    snapToFrame,
    timelinePosition,
    updateCurrentScene,
    currentSceneId,
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
    showPropertiesPanel,
    setShowPropertiesPanel,
    handlePropertiesClose,
    backgroundImage,
    selectedBackgroundImage,
    skipNextClickRef,
    draggedDuringInteractionRef,
    suppressNextOutsideCloseRef,
    pendingExternalCloseRef,
  });

  // Timeline interactions hook
  const {
    handleTimelineClick,
    handleTimelineDrag,
    handlePlayheadMouseDown,
    handleSliderMouseDown,
    handleTimelinePointer,
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
    setShowPropertiesPanel,
    pendingExternalCloseRef,
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
    setShowPropertiesPanel,
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
    handleDeviceTypeChange,
    handleDeviceIpChange,
    handleDeviceConnect,
  } = useDeviceHandlers({
    currentSceneId,
    devices,
    setDevices,
    updateDevice,
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

  return (
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

        <PropertiesDrawer
          isOpen={showPropertiesPanel}
          selectedDeviceId={selectedDeviceId}
          selectedLEDId={selectedLEDId}
          selectedKeyframeId={selectedKeyframeId}
          selectedKeyframe={selectedKeyframe}
          selectedBackgroundImage={selectedBackgroundImage}
          selectedColor={
            selectedLEDId
              ? frameLedState[selectedLEDId]?.color ??
                selectedLED?.color ??
                "#ffffff"
              : "#ffffff"
          }
          selectedOpacity={
            selectedLEDId
              ? frameLedState[selectedLEDId]?.opacity ??
                selectedLED?.opacity ??
                1
              : 1
          }
          backgroundImageScale={backgroundImageScale}
          selectedDevice={selectedDevice}
          onClose={handlePropertiesClose}
          protectedRefs={[canvasRef, timelineRef, sliderRef]}
          suppressNextOutsideCloseRef={suppressNextOutsideCloseRef}
          onAddStrip={handleAddStrip}
          onColorChange={handleColorChange}
          onOpacityChange={handleOpacityChange}
          onKeyframeEffectsChange={handleKeyframeEffectsChange}
          onBackgroundImageScaleChange={handleBackgroundImageScaleChange}
          onDeviceTypeChange={handleDeviceTypeChange}
          onDeviceIpChange={handleDeviceIpChange}
          onDeviceConnect={handleDeviceConnect}
          onDeviceStripModeChange={handleDeviceStripModeChange}
          onRemoveStrip={handleRemoveStrip}
          onUpdateStrip={handleUpdateStrip}
          onResetDevices={handleResetDevices}
          onDeleteKeyframe={handleDeleteKeyframe}
        />
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
        showPropertiesPanel={showPropertiesPanel}
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
    </EditorLayout>
  );
};

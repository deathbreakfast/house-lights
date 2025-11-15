import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
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
import { useTimelinePlayer } from "../hooks/useTimelinePlayer";
import { usePaintTool } from "../hooks/usePaintTool";
import {
  buildSceneLedState,
  cloneLedStateMap,
  dedupeKeyframesByTimestamp,
  getFrameLedState,
  sortKeyframes,
} from "../utils/timeline";
import {
  collectContiguousLedIds,
  distanceToSegment,
} from "../utils/paint";

const createClientId = (prefix: string): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

type SceneDeviceResponse = {
  id: string;
  position: Point;
  ipAddress: string;
  type: Device["type"];
  stripMode: Device["stripMode"];
  strips: LEDStrip[];
  health?: DeviceHealth | null;
};

const deriveConnectionState = (
  response: SceneDeviceResponse,
  existing?: Device
): { state: DeviceConnectionState; error: string | null } => {
  const isWifi = (existing?.type ?? response.type) === "wifi";
  const online = response.health?.online;

  if (isWifi) {
    if (existing?.connectionState === "connecting" && online !== true) {
      return {
        state: "connecting",
        error: existing.connectionError ?? null,
      };
    }
    if (online === true) {
      return { state: "online", error: null };
    }
    if (online === false) {
      return {
        state: "error",
        error: existing?.connectionError ?? "Device is offline",
      };
    }
    return {
      state: existing?.connectionState ?? "idle",
      error: existing?.connectionError ?? null,
    };
  }

  if (online === true) {
    return { state: "online", error: null };
  }
  return {
    state: existing?.connectionState ?? "idle",
    error: existing?.connectionError ?? null,
  };
};

const mergeDeviceFromResponse = (
  response: SceneDeviceResponse,
  existing?: Device
): Device => {
  const { state, error } = deriveConnectionState(response, existing);
  return {
    id: response.id,
    position: response.position ?? existing?.position ?? { x: 400, y: 300 },
    ipAddress: response.ipAddress ?? existing?.ipAddress ?? "",
    strips: response.strips ?? existing?.strips ?? [],
    type: response.type ?? existing?.type ?? "wifi",
    stripMode: response.stripMode ?? existing?.stripMode ?? "auto",
    connectionState: state,
    connectionError: error,
    health: response.health ?? existing?.health ?? null,
  };
};

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
  const [mode, setMode] = useState<EditorMode>("view");
  const [tool, setTool] = useState<Tool>("select");
  const [powerOn, setPowerOn] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  const [backgroundImageScale, setBackgroundImageScale] = useState<number>(100);
  const [showSceneModal, setShowSceneModal] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [canvasPan, setCanvasPan] = useState<Point>({
    x: 0,
    y: 0,
  });
  const [scenesBootstrapped, setScenesBootstrapped] = useState(false);
  const [isSceneSettingsOpen, setIsSceneSettingsOpen] = useState(false);
  const [sceneSettingsName, setSceneSettingsName] = useState("");
  const [isSavingSceneName, setIsSavingSceneName] = useState(false);
  const [playlistEntries, setPlaylistEntries] = useState<ScenePlaylistEntry[]>([]);
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPosition, setLastPanPosition] = useState<Point>({ x: 0, y: 0 });
  const [isDraggingElement, setIsDraggingElement] = useState(false);
  const [dragStartOffset, setDragStartOffset] = useState<Point>({ x: 0, y: 0 });
  
  // Touch gesture state
  const [touchState, setTouchState] = useState<{
    initialDistance: number;
    initialZoom: number;
    initialPan: Point;
    centerPoint: Point;
    isPinching: boolean;
    isPanning: boolean;
    lastTouch1: Point | null;
    lastTouch2: Point | null;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const playlistSaveTimeoutRef = useRef<number | null>(null);
  const [timelineDuration, setTimelineDuration] = useState(DEFAULT_TOTAL_DURATION);

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
  });

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
    () => buildSceneLedState(currentScene),
    [currentScene]
  );

  const frameLedState = useMemo(
    () =>
      getFrameLedState({
        keyframes: currentScene.keyframes,
        timelinePosition,
        baseState: baseLedState,
      }),
    [baseLedState, currentScene.keyframes, timelinePosition]
  );

  const fetchSceneDevices = useCallback(
    async (sceneIdOverride?: string) => {
      const targetSceneId = sceneIdOverride ?? currentSceneId;
      if (!targetSceneId) {
        return;
      }
      try {
        const response = await fetch(`/api/v2/scenes/${targetSceneId}/devices`);
        if (!response.ok) {
          return;
        }
        const data: SceneDeviceResponse[] = await response.json();
        setScenes(
          (prev) =>
            prev.map((scene) => {
              if (scene.id !== targetSceneId) {
                return scene;
              }
              const existingMap = new Map(
                scene.devices.map((device) => [device.id, device])
              );
              const mergedDevices = data.map((device) =>
                mergeDeviceFromResponse(device, existingMap.get(device.id))
              );
              existingMap.forEach((device, deviceId) => {
                if (!data.some((item) => item.id === deviceId)) {
                  mergedDevices.push(device);
                }
              });
              return {
                ...scene,
                devices: mergedDevices,
              };
            }),
          { recordHistory: false }
        );
      } catch (error) {
        console.error("Error loading devices:", error);
      }
    },
    [currentSceneId, setScenes]
  );

  const setDeviceConnectionState = useCallback(
    (deviceId: string, state: DeviceConnectionState, error: string | null = null) => {
      updateDevice(deviceId, (device) => ({
        ...device,
        connectionState: state,
        connectionError: error,
        health:
          state === "online"
            ? { ...(device.health ?? {}), online: true }
            : device.health,
      }));
    },
    [updateDevice]
  );
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
    currentScene.devices.forEach((device) => {
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
  }, [currentScene.devices]);

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

  useEffect(() => {
    const desired = currentScene.durationMs ?? DEFAULT_TOTAL_DURATION;
    setTimelineDuration((prev) => (prev === desired ? prev : desired));
  }, [currentScene.durationMs, currentScene.id]);

  useEffect(() => {
    if (!currentScene.keyframes.length) {
      return;
    }
    const sorted = sortKeyframes(currentScene.keyframes);
    const lastTimestamp = sorted[sorted.length - 1]?.timestamp ?? 0;
    const baseline = currentScene.durationMs ?? DEFAULT_TOTAL_DURATION;
    if (lastTimestamp + 1000 > baseline) {
      updateSceneDuration(lastTimestamp + 1000);
    }
  }, [currentScene.keyframes, currentScene.durationMs, updateSceneDuration]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentScene.audioUrl) {
      return;
    }
    const handleMetadata = () => {
      if (!isFinite(audio.duration) || audio.duration <= 0) {
        return;
      }
      const audioDurationMs = Math.ceil(audio.duration * 1000);
      const baseline = currentScene.durationMs ?? DEFAULT_TOTAL_DURATION;
      if (audioDurationMs > baseline) {
        updateSceneDuration(audioDurationMs);
      }
    };
    audio.addEventListener("loadedmetadata", handleMetadata);
    if (audio.readyState >= 1) {
      handleMetadata();
    }
    return () => {
      audio.removeEventListener("loadedmetadata", handleMetadata);
    };
  }, [currentScene.audioUrl, currentScene.durationMs, updateSceneDuration]);

  const currentFrameKeyframeRef = useRef<{
    timestamp: number;
    keyframeId: string;
  } | null>(null);
  const skipNextClickRef = useRef(false);
  const draggedDuringInteractionRef = useRef(false);
  const pendingExternalCloseRef = useRef(false);
  const suppressNextOutsideCloseRef = useRef(false);

  const handlePropertiesClose = useCallback(
    (reason?: "outside" | "explicit") => {
      pendingExternalCloseRef.current = reason === "outside";
      suppressNextOutsideCloseRef.current = false;
      setShowPropertiesPanel(false);
      setSelectedDeviceId(null);
      setSelectedLEDId(null);
      setSelectedKeyframeId(null);
      setSelectedBackgroundImage(false);
    },
    [
      setSelectedBackgroundImage,
      setSelectedDeviceId,
      setSelectedKeyframeId,
      setSelectedLEDId,
      setShowPropertiesPanel,
    ]
  );

  const handleKeyframeSelect = useCallback(
    (keyframe: Keyframe) => {
      const suppressToggle = pendingExternalCloseRef.current;
    if (!suppressToggle && showPropertiesPanel && selectedKeyframeId === keyframe.id) {
      pendingExternalCloseRef.current = false;
      handlePropertiesClose();
      return;
    }
    pendingExternalCloseRef.current = false;
    suppressNextOutsideCloseRef.current = true;
      setSelectedKeyframeId(keyframe.id);
      setSelectedBackgroundImage(false);
      setShowPropertiesPanel(true);
      setTimelinePosition(keyframe.timestamp);
    },
    [
      handlePropertiesClose,
      selectedKeyframeId,
      setSelectedBackgroundImage,
      setSelectedKeyframeId,
      setShowPropertiesPanel,
      setTimelinePosition,
      showPropertiesPanel,
    ]
  );

  useEffect(() => {
    if (scenesBootstrapped) {
      return;
    }
    let isMounted = true;
    const loadScenes = async () => {
      try {
        const response = await fetch("/api/v2/scenes");
        let payload: Array<{
          id: string;
          name: string;
          audio?: { url?: string; filename?: string };
        }> = [];
        if (response.ok) {
          const data = await response.json();
          payload = Array.isArray(data) ? data : [];
        }
        if (!payload.length) {
          const createResponse = await fetch("/api/v2/scenes", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: "Scene 1" }),
          });
          if (createResponse.ok) {
            const created = await createResponse.json();
            payload = [created];
          }
        }
        if (!isMounted) {
          return;
        }
        const normalizedScenes: Scene[] =
          payload.map((sceneMeta) => ({
            id: sceneMeta.id,
            name: sceneMeta.name,
            devices: [],
            keyframes: [],
            audioUrl: sceneMeta.audio?.url,
            audioFileName: sceneMeta.audio?.filename,
            durationMs: DEFAULT_TOTAL_DURATION,
          })) || [];
        const fallbackScenes =
          normalizedScenes.length > 0 ? normalizedScenes : [DEFAULT_SCENE];
        setScenes(fallbackScenes, { recordHistory: false });
        const preferredScene =
          fallbackScenes.find((scene) => scene.id === currentSceneId) ??
          fallbackScenes[0];
        setCurrentSceneId(preferredScene.id);
        setSceneSettingsName(preferredScene.name);
        setScenesBootstrapped(true);
      } catch (error) {
        console.error("Error loading scenes:", error);
        if (!isMounted) {
          return;
        }
        setScenes([DEFAULT_SCENE], { recordHistory: false });
        setCurrentSceneId(DEFAULT_SCENE.id);
        setSceneSettingsName(DEFAULT_SCENE.name);
        setScenesBootstrapped(true);
      }
    };
    loadScenes();
    return () => {
      isMounted = false;
    };
  }, [
    currentSceneId,
    scenesBootstrapped,
    setCurrentSceneId,
    setScenes,
    setSceneSettingsName,
  ]);

  useEffect(() => {
    setSceneSettingsName(currentScene.name ?? "");
  }, [currentScene.name]);

  useEffect(() => {
    currentFrameKeyframeRef.current = null;
  }, [timelinePosition]);

  useEffect(() => {
    return () => {
      if (playlistSaveTimeoutRef.current !== null) {
        window.clearTimeout(playlistSaveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }
    const loadKeyframes = async () => {
      const sceneId = currentScene.id;
      try {
        const response = await fetch(`/api/v2/scenes/${sceneId}/keyframes`);
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as Array<{
          id: string;
          timestamp: number;
          effects?: { fadeIn?: number; fadeOut?: number };
          ledStates: Keyframe["ledStates"];
        }>;
        const normalizedKeyframes = dedupeKeyframesByTimestamp(
          data.map((item) => ({
            id: item.id,
            timestamp: item.timestamp,
            effects: item.effects ?? {},
            ledStates: item.ledStates ?? {},
          }))
        );
        updateCurrentScene((scene) => ({
          ...scene,
          keyframes: normalizedKeyframes,
        }));
      } catch (error) {
        console.error("Error loading keyframes:", error);
      }
    };

    loadKeyframes();
  }, [currentScene.id, scenesBootstrapped, updateCurrentScene]);

  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }
    let intervalId: number | null = null;

    const loadDevices = async () => {
      await fetchSceneDevices(currentScene.id);
    };

    void loadDevices();
    intervalId = window.setInterval(loadDevices, 15000);

    return () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [currentScene.id, scenesBootstrapped, fetchSceneDevices]);

  useEffect(() => {
    if (!powerOn || !liveMode) {
      return;
    }
    const controller = new AbortController();
    const timestamp = Math.round(timelinePosition);
    fetch(
      `/api/v2/scenes/${currentSceneId}/keyframes/${timestamp}/apply`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ledStates: frameLedState }),
        signal: controller.signal,
      }
    ).catch((error) =>
      console.error("Error applying frame to playback engine:", error)
    );
    return () => controller.abort();
  }, [
    currentSceneId,
    frameLedState,
    liveMode,
    powerOn,
    timelinePosition,
  ]);

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
    void fetch(`/api/v2/scenes/${currentSceneId}/keyframes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: newKeyframe.id,
        timestamp: snappedPosition,
        ledStates: ledStatesSnapshot,
        effects: newKeyframe.effects,
      }),
    }).catch((error) =>
      console.error("Error saving keyframe:", error)
    );
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

  const applyLedUpdates = useCallback(
    (updates: Array<{ id: string; color?: string; opacity?: number }>) => {
      if (!updates.length) {
        return;
      }
      const updateMap = new Map(updates.map((update) => [update.id, update]));
      updateCurrentScene((scene) => ({
        ...scene,
        devices: scene.devices.map((device) => ({
          ...device,
          strips: device.strips.map((strip) => ({
            ...strip,
            leds: strip.leds.map((led) => {
              const update = updateMap.get(led.id);
              if (!update) {
                return led;
              }
              return {
                ...led,
                color: update.color ?? led.color,
                opacity: update.opacity ?? led.opacity,
              };
            }),
          })),
        })),
      }));
    },
    [updateCurrentScene]
  );

  const paintedLedsRef = useRef<Set<string>>(new Set());
  const paintingTransactionRef = useRef(false);

  const getCanvasPoint = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return null;
      }
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left - canvasPan.x) / canvasZoom,
        y: (clientY - rect.top - canvasPan.y) / canvasZoom,
      };
    },
    [canvasPan, canvasZoom]
  );

  const findDeviceHit = useCallback(
    (point: Point): Device | null => {
      for (const device of currentScene.devices) {
        const dist = Math.hypot(
          point.x - device.position.x,
          point.y - device.position.y
        );
        if (dist < 20) {
          return device;
        }
      }
      return null;
    },
    [currentScene.devices]
  );

  const findLedHit = useCallback(
    (point: Point): { device: Device; strip: LEDStrip; led: LED; index: number } | null => {
      for (const device of currentScene.devices) {
        for (const strip of device.strips) {
          for (let index = 0; index < strip.leds.length; index++) {
            const led = strip.leds[index];
            const dist = Math.hypot(point.x - led.position.x, point.y - led.position.y);
            if (dist < 10) {
              return { device, strip, led, index };
            }
          }
        }
      }
      return null;
    },
    [currentScene.devices]
  );

  const findStripLineHit = useCallback(
    (
      point: Point
    ): { device: Device; strip: LEDStrip; ledIndex: number } | null => {
      const threshold = 6;
      let closest:
        | { device: Device; strip: LEDStrip; ledIndex: number; distance: number }
        | null = null;
      for (const device of currentScene.devices) {
        for (const strip of device.strips) {
          if (strip.leds.length === 0) continue;
          const firstLed = strip.leds[0].position;
          const deviceLineDistance = distanceToSegment(
            point,
            device.position,
            firstLed
          );
          if (
            deviceLineDistance <= threshold &&
            (closest === null || deviceLineDistance < closest.distance)
          ) {
            closest = { device, strip, ledIndex: 0, distance: deviceLineDistance };
          }
          for (let index = 1; index < strip.leds.length; index++) {
            const start = strip.leds[index - 1].position;
            const end = strip.leds[index].position;
            const segmentDistance = distanceToSegment(point, start, end);
            if (
              segmentDistance <= threshold &&
              (closest === null || segmentDistance < closest.distance)
            ) {
              const startDist = Math.hypot(point.x - start.x, point.y - start.y);
              const endDist = Math.hypot(point.x - end.x, point.y - end.y);
              const ledIndex = startDist <= endDist ? index - 1 : index;
              closest = { device, strip, ledIndex, distance: segmentDistance };
            }
          }
        }
      }
      return closest
        ? {
            device: closest.device,
            strip: closest.strip,
            ledIndex: Math.max(
              0,
              Math.min(closest.strip.leds.length - 1, closest.ledIndex)
            ),
          }
        : null;
    },
    [currentScene.devices]
  );

  const persistLedUpdates = useCallback(
    async (updates: Array<{ id: string; color?: string; opacity?: number }>) => {
      if (!updates.length) {
        return;
      }
      const grouped: Record<
        string,
        Array<{ id: string; color?: string; opacity?: number }>
      > = {};
      updates.forEach((update) => {
        const metadata = ledMetadata.get(update.id);
        if (!metadata) {
          return;
        }
        if (!grouped[metadata.deviceId]) {
          grouped[metadata.deviceId] = [];
        }
        grouped[metadata.deviceId].push(update);
      });

      await Promise.all(
        Object.entries(grouped).map(([deviceId, payload]) =>
          fetch(`/api/v2/devices/${deviceId}/leds`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ leds: payload }),
          }).catch((error) =>
            console.error("Error saving LED updates:", error)
          )
        )
      );
    },
    [ledMetadata]
  );

  const commitLedUpdates = useCallback(
    async (
      updates: Array<{ id: string; color?: string; opacity?: number }>
    ) => {
      if (!updates.length) {
        return;
      }
      const aggregate = new Map<
        string,
        { id: string; color?: string; opacity?: number }
      >();
      updates.forEach((update) => {
        const current = aggregate.get(update.id) || { id: update.id };
        aggregate.set(update.id, { ...current, ...update });
      });
      const normalized = Array.from(aggregate.values());
      const payloadLedStates = { ...frameLedState };
      normalized.forEach((update) => {
        const previousState =
          payloadLedStates[update.id] ?? {
            color: update.color ?? "#ffffff",
            opacity: update.opacity ?? 1,
          };
        payloadLedStates[update.id] = {
          color: update.color ?? previousState.color,
          opacity: update.opacity ?? previousState.opacity,
        };
      });

      let keyframeMeta: {
        keyframeId: string;
        timestamp: number;
        effects: Keyframe["effects"];
      } | null = null;

      runWithHistoryBatch(() => {
        applyLedUpdates(normalized);
        keyframeMeta = ensureKeyframeAtCurrentFrame();
        if (!keyframeMeta) {
          return;
        }
        updateKeyframe(keyframeMeta.keyframeId, (keyframe) => ({
          ...keyframe,
          ledStates: payloadLedStates,
        }));
      });

      if (!keyframeMeta) {
        return;
      }

      const { keyframeId, timestamp, effects } = keyframeMeta;

      const payload = {
        id: keyframeId,
        timestamp,
        ledStates: payloadLedStates,
        effects,
      };
      await fetch(`/api/v2/scenes/${currentSceneId}/keyframes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }).catch((error) =>
        console.error("Error persisting keyframe:", error)
      );
      await persistLedUpdates(normalized);
    },
    [
      applyLedUpdates,
      ensureKeyframeAtCurrentFrame,
      frameLedState,
      persistLedUpdates,
      runWithHistoryBatch,
      updateKeyframe,
      currentSceneId,
    ]
  );

  const getLedAppearance = useCallback(
    (ledId: string) => {
      const state = frameLedState[ledId];
      if (state) {
        return {
          color: state.color,
          opacity: state.opacity,
        };
      }
      const metadata = ledMetadata.get(ledId);
      return {
        color: metadata?.led.color ?? "#000000",
        opacity: metadata?.led.opacity ?? 1,
      };
    },
    [frameLedState, ledMetadata]
  );

  const getLedColor = useCallback(
    (ledId: string) =>
      getLedAppearance(ledId).color.toLowerCase(),
    [getLedAppearance]
  );

  const getLedOpacity = useCallback(
    (ledId: string) => getLedAppearance(ledId).opacity,
    [getLedAppearance]
  );

  const applyBrushAtPoint = useCallback(
    (point: Point) => {
      const hit = findLedHit(point);
      if (!hit) {
        return;
      }
      if (paintedLedsRef.current.has(hit.led.id)) {
        return;
      }
      paintedLedsRef.current.add(hit.led.id);
      commitLedUpdates([
        {
          id: hit.led.id,
          color: selectedColor,
          opacity: selectedOpacity,
        },
      ]);
    },
    [
      commitLedUpdates,
      findLedHit,
      selectedColor,
      selectedOpacity,
    ]
  );

  const paintStrip = useCallback(
    (strip: LEDStrip) => {
      if (!strip.leds.length) {
        return;
      }
      commitLedUpdates(
        strip.leds.map((led) => ({
          id: led.id,
          color: selectedColor,
          opacity: selectedOpacity,
        }))
      );
    },
    [commitLedUpdates, selectedColor, selectedOpacity]
  );

  const paintDevice = useCallback(
    (device: Device) => {
      const ids = device.strips.reduce<string[]>((acc, strip) => {
        strip.leds.forEach((led) => acc.push(led.id));
        return acc;
      }, []);
      if (!ids.length) {
        return;
      }
      commitLedUpdates(
        ids.map((id) => ({
          id,
          color: selectedColor,
          opacity: selectedOpacity,
        }))
      );
    },
    [commitLedUpdates, selectedColor, selectedOpacity]
  );

  const applyBucketAtPoint = useCallback(
    (point: Point, options?: { fillEntireStrip?: boolean }) => {
      const fillEntireStrip = options?.fillEntireStrip ?? false;
      const ledHit = findLedHit(point);
      if (ledHit) {
        if (fillEntireStrip) {
          paintStrip(ledHit.strip);
          return;
        }
        const originColor =
          getLedColor(ledHit.strip.leds[ledHit.index].id);
        const ids = collectContiguousLedIds(
          ledHit.strip,
          ledHit.index,
          (ledId) => getLedColor(ledId) === originColor
        );
        if (!ids.length) {
          return;
        }
        commitLedUpdates(
          ids.map((id) => ({
            id,
            color: selectedColor,
            opacity: selectedOpacity,
          }))
        );
        return;
      }

      const stripHit = findStripLineHit(point);
      if (stripHit) {
        if (fillEntireStrip) {
          paintStrip(stripHit.strip);
          return;
        }
        const originColor =
          getLedColor(stripHit.strip.leds[stripHit.ledIndex].id);
        const ids = collectContiguousLedIds(
          stripHit.strip,
          stripHit.ledIndex,
          (ledId) => getLedColor(ledId) === originColor
        );
        if (!ids.length) {
          return;
        }
        commitLedUpdates(
          ids.map((id) => ({
            id,
            color: selectedColor,
            opacity: selectedOpacity,
          }))
        );
        return;
      }

      const deviceHit = findDeviceHit(point);
      if (deviceHit) {
        paintDevice(deviceHit);
      }
    },
    [
      commitLedUpdates,
      collectContiguousLedIds,
      findDeviceHit,
      findLedHit,
      findStripLineHit,
      getLedColor,
      paintDevice,
      paintStrip,
      selectedColor,
      selectedOpacity,
    ]
  );

  // Load power state from backend when scene changes
  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }
    const loadPowerState = async () => {
      const sceneId = currentScene.id;
      try {
        const response = await fetch(`/api/v2/scenes/${sceneId}/power`);
        if (response.ok) {
          const data = await response.json();
          setPowerOn(data.powerOn ?? false);
        }
      } catch (error) {
        console.error("Error loading power state:", error);
      }
    };
    loadPowerState();
  }, [currentScene.id, scenesBootstrapped]);
  
  // Save power state to backend when it changes
  const handlePowerToggle = useCallback(async () => {
    const newPowerState = !powerOn;
    setPowerOn(newPowerState);
    
    try {
      await fetch(`/api/v2/scenes/${currentSceneId}/power`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ powerOn: newPowerState }),
      });
    } catch (error) {
      console.error("Error saving power state:", error);
    }
  }, [powerOn, currentSceneId]);

  const selectedDevice = currentScene.devices.find(
    (device) => device.id === selectedDeviceId
  ) || null;

  const selectedLED = (() => {
    if (!selectedLEDId) {
      return undefined;
    }
    for (const device of currentScene.devices) {
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

  const handleDeleteKeyframe = useCallback(() => {
    if (!selectedKeyframeId) {
      return;
    }
    const keyframeId = selectedKeyframeId;
    deleteKeyframe(keyframeId);
    currentFrameKeyframeRef.current = null;
    setShowPropertiesPanel(false);
    void fetch(`/api/v2/scenes/${currentSceneId}/keyframes/${keyframeId}`, {
      method: "DELETE",
    }).catch((error) => console.error("Error deleting keyframe:", error));
  }, [
    currentSceneId,
    deleteKeyframe,
    selectedKeyframeId,
    setShowPropertiesPanel,
  ]);

  // Ctrl + scroll wheel zoom
  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!canvasRef.current) return;
      
      // Only handle if Ctrl is pressed
      if (!event.ctrlKey && !event.metaKey) return;
      
      // Don't zoom if typing in inputs
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      event.preventDefault();
      
      const rect = canvasRef.current.getBoundingClientRect();
      const zoomFactor = event.deltaY > 0 ? 1 / 1.1 : 1.1;
      const newZoom = Math.max(0.05, Math.min(10, canvasZoom * zoomFactor));
      
      // Calculate the point in canvas coordinates
      const canvasX = (event.clientX - rect.left - canvasPan.x) / canvasZoom;
      const canvasY = (event.clientY - rect.top - canvasPan.y) / canvasZoom;
      
      // Adjust pan to keep the mouse position in the same screen position
      const newPanX = event.clientX - rect.left - canvasX * newZoom;
      const newPanY = event.clientY - rect.top - canvasY * newZoom;
      
      setCanvasZoom(newZoom);
      setCanvasPan({ x: newPanX, y: newPanY });
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, [canvasZoom, canvasPan]);

  // Sync background image and scale from global background settings
  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }
    const loadBackgroundImage = async () => {
      try {
        const response = await fetch("/api/v2/background");
        if (response.ok) {
          const data = await response.json();
          if (data?.url) {
            const scale = data.scale ?? 100;
            setBackgroundImage(data.url);
            setBackgroundImageScale(scale);
            const img = new Image();
            img.onload = () => {
              if (canvasRef.current) {
                const displayWidth = img.naturalWidth * (scale / 100);
                const displayHeight = img.naturalHeight * (scale / 100);
                const canvas = canvasRef.current;
                setCanvasPan({
                  x: canvas.offsetWidth / 2 - (displayWidth / 2) * canvasZoom,
                  y: canvas.offsetHeight / 2 - (displayHeight / 2) * canvasZoom,
                });
              }
            };
            img.src = data.url;
            return;
          }
        }
        setBackgroundImage(null);
        setBackgroundImageScale(100);
      } catch (error) {
        console.error("Error loading background image:", error);
        setBackgroundImage(null);
        setBackgroundImageScale(100);
      }
    };
    void loadBackgroundImage();
  }, [canvasZoom, scenesBootstrapped]);
  
  // Load devices from backend when scene changes
  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }
    const loadDevices = async () => {
      const sceneId = currentScene.id;
      
      try {
        const response = await fetch(`/api/v2/scenes/${sceneId}/devices`);
        if (response.ok) {
          const devices = await response.json();
          if (devices && devices.length > 0) {
            // Debug: log the devices to see if LEDs are included
            console.log("Loaded devices from backend:", devices);
            
            // Convert backend format to frontend format
            const formattedDevices: Device[] = devices.map((d: any) => ({
              id: d.id,
              position: d.position,
              ipAddress: d.ipAddress,
              type: d.type,
              stripMode: d.stripMode,
              strips: d.strips.map((s: any) => {
                // If LEDs are provided from backend, use them; otherwise create default LEDs
                let leds: LED[];
                if (s.leds && Array.isArray(s.leds) && s.leds.length > 0) {
                  // Use LEDs from backend with their saved positions
                  // Ensure we have the correct number of LEDs (match ledCount)
                  const savedLeds = s.leds.map((led: any) => ({
                    id: led.id,
                    position: led.position || { x: d.position.x, y: d.position.y + 50 },
                    color: led.color || "#ffffff",
                    opacity: led.opacity ?? 1,
                  }));
                  
                  // If we have fewer LEDs than ledCount, add default ones
                  if (savedLeds.length < s.ledCount) {
                    const additionalLeds = Array.from(
                      { length: s.ledCount - savedLeds.length },
                      (_, index) => ({
                        id: `led-${d.id}-${s.id}-${savedLeds.length + index}`,
                        position: {
                          x: d.position.x + (savedLeds.length + index) * 20,
                          y: d.position.y + 50,
                        },
                        color: "#ffffff",
                        opacity: 1,
                      })
                    );
                    leds = [...savedLeds, ...additionalLeds];
                  } else if (savedLeds.length > s.ledCount) {
                    // If we have more LEDs than ledCount, trim to ledCount
                    leds = savedLeds.slice(0, s.ledCount);
                  } else {
                    leds = savedLeds;
                  }
                } else {
                  // Create default LEDs if none exist in backend
                  leds = Array.from({ length: s.ledCount }, (_, index) => ({
                    id: `led-${d.id}-${s.id}-${index}`,
                    position: {
                      x: d.position.x + index * 20,
                      y: d.position.y + 50,
                    },
                    color: "#ffffff",
                    opacity: 1,
                  }));
                }
                
                return {
                  id: s.id,
                  gpioPin: s.gpioPin,
                  ledCount: s.ledCount,
                  leds,
                };
              }),
            }));
            
            setScenes(
              (prev) =>
                prev.map((scene) =>
                  scene.id === sceneId
                    ? { ...scene, devices: formattedDevices }
                    : scene
                ),
              { recordHistory: false }
            );
          } else {
            // No devices in backend - create default device centered on background image or viewport
            let centerX = 400;
            let centerY = 300;
            
            if (backgroundImage) {
              // Calculate center based on background image dimensions
              const img = new Image();
              img.onload = () => {
                const displayWidth = img.naturalWidth * (backgroundImageScale / 100);
                const displayHeight = img.naturalHeight * (backgroundImageScale / 100);
                const imageCenterX = displayWidth / 2;
                const imageCenterY = displayHeight / 2;
                
                const defaultDevice: Device = {
                  id: "device-local-default",
                  position: { x: imageCenterX, y: imageCenterY },
                  ipAddress: "127.0.0.1",
                  strips: [],
                  type: "local",
                  stripMode: "auto",
                };
                
                // Update frontend state
                setScenes(
                  (prev) =>
                    prev.map((scene) =>
                      scene.id === sceneId
                        ? { ...scene, devices: [defaultDevice] }
                        : scene
                    ),
                  { recordHistory: false }
                );
                
                // Save to backend
                fetch(`/api/v2/scenes/${sceneId}/devices`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(defaultDevice),
                }).catch((error) => console.error("Error saving default device:", error));
              };
              img.src = backgroundImage;
              // Will be set when image loads
            } else if (canvasRef.current) {
              // No background image - use viewport center
              const rect = canvasRef.current.getBoundingClientRect();
              centerX = (rect.width / 2 - canvasPan.x) / canvasZoom;
              centerY = (rect.height / 2 - canvasPan.y) / canvasZoom;
              
              const defaultDevice: Device = {
                id: "device-local-default",
                position: { x: centerX, y: centerY },
                ipAddress: "127.0.0.1",
                strips: [],
                type: "local",
                stripMode: "auto",
              };
              
              // Update frontend state
              setScenes(
                (prev) =>
                  prev.map((scene) =>
                    scene.id === sceneId
                      ? { ...scene, devices: [defaultDevice] }
                      : scene
                  ),
                { recordHistory: false }
              );
              
              // Save to backend
              try {
                await fetch(`/api/v2/scenes/${sceneId}/devices`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(defaultDevice),
                });
              } catch (error) {
                console.error("Error saving default device:", error);
              }
            } else {
              // Fallback if canvas not available yet - use DEFAULT_SCENE device
              const scene = currentScene;
              if (scene.devices.length > 0) {
                const defaultDevice = scene.devices[0];
                try {
                  await fetch(`/api/v2/scenes/${sceneId}/devices`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(defaultDevice),
                  });
                } catch (error) {
                  console.error("Error saving default device:", error);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error("Error loading devices:", error);
        // If error, create default device centered on background image or viewport
        const createDefaultDevice = async () => {
          let position: Point;
          
          if (backgroundImage) {
            position = await new Promise<Point>((resolve) => {
              const img = new Image();
              img.onload = () => {
                const displayWidth = img.naturalWidth * (backgroundImageScale / 100);
                const displayHeight = img.naturalHeight * (backgroundImageScale / 100);
                resolve({ x: displayWidth / 2, y: displayHeight / 2 });
              };
              img.onerror = () => {
                if (canvasRef.current) {
                  const rect = canvasRef.current.getBoundingClientRect();
                  resolve({
                    x: (rect.width / 2 - canvasPan.x) / canvasZoom,
                    y: (rect.height / 2 - canvasPan.y) / canvasZoom,
                  });
                } else {
                  resolve({ x: 400, y: 300 });
                }
              };
              img.src = backgroundImage;
            });
          } else if (canvasRef.current) {
            const rect = canvasRef.current.getBoundingClientRect();
            position = {
              x: (rect.width / 2 - canvasPan.x) / canvasZoom,
              y: (rect.height / 2 - canvasPan.y) / canvasZoom,
            };
          } else {
            position = { x: 400, y: 300 };
          }
          
          const defaultDevice: Device = {
            id: "device-local-default",
            position,
            ipAddress: "127.0.0.1",
            strips: [],
            type: "local",
            stripMode: "auto",
          };
          
          setScenes(
            (prev) =>
              prev.map((scene) =>
                scene.id === sceneId
                  ? { ...scene, devices: [defaultDevice] }
                  : scene
              ),
            { recordHistory: false }
          );
          
          try {
            await fetch(`/api/v2/scenes/${sceneId}/devices`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(defaultDevice),
            });
          } catch (saveError) {
            console.error("Error saving default device:", saveError);
          }
        };
        
        createDefaultDevice();
      }
    };
    
    loadDevices();
  }, [
    backgroundImage,
    backgroundImageScale,
    canvasPan,
    canvasZoom,
    currentScene.id,
    scenesBootstrapped,
  ]);

  useEffect(() => {
    const fileInput = fileInputRef.current;
    if (!fileInput) {
      return;
    }
    const handler = async (event: Event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) {
        return;
      }
      try {
        const formData = new FormData();
        formData.append("file", file);
        const response = await fetch("/api/v2/background", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          throw new Error("Failed to upload image");
        }
        const data = await response.json();
        const imageUrl = data.url;
        const scale = data.scale ?? 100;
        setBackgroundImage(imageUrl);
        setBackgroundImageScale(scale);
        const img = new Image();
        img.onload = () => {
          if (!canvasRef.current) {
            return;
          }
          const displayWidth = img.naturalWidth * (scale / 100);
          const displayHeight = img.naturalHeight * (scale / 100);
          setCanvasPan({
            x: canvasRef.current.offsetWidth / 2 - (displayWidth / 2) * canvasZoom,
            y: canvasRef.current.offsetHeight / 2 - (displayHeight / 2) * canvasZoom,
          });
        };
        img.src = imageUrl;
      } catch (error) {
        console.error("Error uploading background image:", error);
        const url = URL.createObjectURL(file);
        setBackgroundImage(url);
      }
      target.value = "";
    };
    fileInput.addEventListener("change", handler);
    return () => fileInput.removeEventListener("change", handler);
  }, [canvasZoom]);

  useEffect(() => {
    const audioInput = audioInputRef.current;
    if (!audioInput) {
      return;
    }
    const handler = async (event: Event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) {
        return;
      }
      try {
        const formData = new FormData();
        formData.append("file", file);
        const response = await fetch(`/api/v2/scenes/${currentSceneId}/audio`, {
          method: "POST",
          body: formData,
        });
        const audioData = response.ok ? await response.json() : null;
        const audioUrl = audioData?.url ?? URL.createObjectURL(file);
        const uploadedFileName = audioData?.filename ?? file.name;
        setScenes((prev) =>
          prev.map((scene) =>
            scene.id === currentSceneId
              ? {
                  ...scene,
                  audioUrl,
                  audioFileName: uploadedFileName,
                }
              : scene
          )
        );
      } catch (error) {
        console.error("Error uploading audio file:", error);
      }
      target.value = "";
    };
    audioInput.addEventListener("change", handler);
    return () => audioInput.removeEventListener("change", handler);
  }, [currentSceneId, setScenes]);

  const handleAddDevice = useCallback(async () => {
    const newDevice: Device = {
      id: `device-${Date.now()}`,
      position: { x: 400, y: 300 },
      ipAddress: "192.168.1.100",
      strips: [],
      type: "wifi",
      stripMode: "auto", // WiFi devices default to auto
      connectionState: "idle",
      connectionError: null,
      health: null,
    };

    setScenes((prev) =>
      prev.map((scene) =>
        scene.id === currentSceneId
          ? {
              ...scene,
              devices: [...scene.devices, newDevice],
            }
          : scene
      )
    );
    
    // Save to backend
    try {
      await fetch(`/api/v2/scenes/${currentSceneId}/devices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(newDevice),
      });
      await fetchSceneDevices(currentSceneId);
    } catch (error) {
      console.error("Error saving new device:", error);
    }
  }, [currentSceneId, fetchSceneDevices, setScenes]);

  // Helper function to calculate center position (image center or viewport center)
  const calculateDefaultDevicePosition = useCallback((): Promise<Point> => {
    return new Promise((resolve) => {
      if (backgroundImage) {
        // If background image exists, center device at the center of the image
        const img = new Image();
        img.onload = () => {
          const displayWidth = img.naturalWidth * (backgroundImageScale / 100);
          const displayHeight = img.naturalHeight * (backgroundImageScale / 100);
          resolve({ x: displayWidth / 2, y: displayHeight / 2 });
        };
        img.onerror = () => {
          // Fallback to viewport center if image fails to load
          if (canvasRef.current) {
            const rect = canvasRef.current.getBoundingClientRect();
            resolve({
              x: (rect.width / 2 - canvasPan.x) / canvasZoom,
              y: (rect.height / 2 - canvasPan.y) / canvasZoom,
            });
          } else {
            resolve({ x: 400, y: 300 });
          }
        };
        img.src = backgroundImage;
      } else if (canvasRef.current) {
        // No background image - use viewport center
        const rect = canvasRef.current.getBoundingClientRect();
        resolve({
          x: (rect.width / 2 - canvasPan.x) / canvasZoom,
          y: (rect.height / 2 - canvasPan.y) / canvasZoom,
        });
      } else {
        resolve({ x: 400, y: 300 });
      }
    });
  }, [backgroundImage, backgroundImageScale, canvasZoom, canvasPan]);

  const handleResetDevices = useCallback(async () => {
    if (!window.confirm("Are you sure you want to reset all devices to default? This will delete all existing devices and create a default local device.")) {
      return;
    }

    const currentScene = scenes.find((s) => s.id === currentSceneId);
    if (!currentScene) return;

    // Delete all existing devices from backend
    for (const device of currentScene.devices) {
      try {
        await fetch(`/api/v2/devices/${device.id}`, {
          method: "DELETE",
        });
      } catch (error) {
        console.error(`Error deleting device ${device.id}:`, error);
      }
    }

    // Calculate center position (image center if background exists, otherwise viewport center)
    const position = await calculateDefaultDevicePosition();

    // Create the default device
    const defaultDevice: Device = {
      id: "device-local-default",
      position,
      ipAddress: "127.0.0.1",
      strips: [],
      type: "local",
      stripMode: "auto",
      connectionState: "online",
      connectionError: null,
      health: {
        online: true,
        lastSeenAt: null,
        latencyMs: null,
        clockSkewMs: null,
        wsConnected: false,
      },
    };

    // Update frontend state
    setScenes((prev) =>
      prev.map((scene) =>
        scene.id === currentSceneId
          ? {
              ...scene,
              devices: [defaultDevice],
            }
          : scene
      )
    );

    // Save default device to backend
    try {
      await fetch(`/api/v2/scenes/${currentSceneId}/devices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(defaultDevice),
      });
      await fetchSceneDevices(currentSceneId);
    } catch (error) {
      console.error("Error saving default device:", error);
    }

    // Clear selections
    setSelectedDeviceId(null);
    setSelectedLEDId(null);
  }, [currentSceneId, scenes]);

  const handleAddStrip = useCallback(
    async (deviceId: string, gpioPin: number, ledCount: number) => {
      const device = currentScene.devices.find((d) => d.id === deviceId);
      if (!device) return;
      
      const leds: LED[] = Array.from({ length: ledCount }, (_, index) => ({
        id: `led-${deviceId}-${device.strips.length}-${index}`,
        position: {
          x: device.position.x + index * 20,
          y: device.position.y + 50,
        },
        color: "#ffffff",
        opacity: 1,
      }));
      const newStrip: LEDStrip = {
        id: `strip-${Date.now()}`,
        gpioPin,
        ledCount,
        leds,
      };
      
      // Create the updated device with the new strip for saving
      const updatedDevice: Device = {
        ...device,
        strips: [...device.strips, newStrip],
      };
      
      setScenes((prev) =>
        prev.map((scene) => {
          if (scene.id !== currentSceneId) {
            return scene;
          }
          return {
            ...scene,
            devices: scene.devices.map((device) => {
              if (device.id !== deviceId) {
                return device;
              }
              return updatedDevice;
            }),
          };
        })
      );
      
      // Save to backend using the updated device we just created
      try {
        const stripsPayload = updatedDevice.strips.map((s: LEDStrip) => ({
          id: s.id,
          gpioPin: s.gpioPin,
          ledCount: s.ledCount,
          leds: s.leds.map((led: LED) => ({
            id: led.id,
            position: led.position,
            color: led.color,
            opacity: led.opacity,
          })),
        }));
        
        const response = await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            strips: stripsPayload,
          }),
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error("Error saving strip - response not OK:", response.status, errorText);
        }
      } catch (error) {
        console.error("Error saving strip:", error);
      }
    },
    [currentSceneId, currentScene.devices]
  );

  const handleRemoveStrip = useCallback(
    async (deviceId: string, stripId: string) => {
      let updatedStrips: LEDStrip[] = [];
      
      setScenes((prev) =>
        prev.map((scene) => {
          if (scene.id !== currentSceneId) {
            return scene;
          }
          return {
            ...scene,
            devices: scene.devices.map((device) => {
              if (device.id !== deviceId) {
                return device;
              }
              const updatedDevice = {
                ...device,
                strips: device.strips.filter((strip) => strip.id !== stripId),
              };
              updatedStrips = updatedDevice.strips;
              return updatedDevice;
            }),
          };
        })
      );
      
      // Save to backend
      try {
        await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            strips: updatedStrips.map((s) => ({
              id: s.id,
              gpioPin: s.gpioPin,
              ledCount: s.ledCount,
              leds: s.leds.map((led) => ({
                id: led.id,
                position: led.position,
                color: led.color,
                opacity: led.opacity,
              })),
            })),
          }),
        });
      } catch (error) {
        console.error("Error saving strip removal:", error);
      }
    },
    [currentSceneId]
  );

  const handleUpdateStrip = useCallback(
    async (deviceId: string, stripId: string, gpioPin: number, ledCount: number) => {
      const device = currentScene.devices.find((d) => d.id === deviceId);
      if (!device) return;
      
      let updatedStrips: LEDStrip[] = [];
      
      setScenes((prev) =>
        prev.map((scene) => {
          if (scene.id !== currentSceneId) {
            return scene;
          }
          return {
            ...scene,
            devices: scene.devices.map((device) => {
              if (device.id !== deviceId) {
                return device;
              }
              const updatedDevice = {
                ...device,
                strips: device.strips.map((strip) => {
                  if (strip.id !== stripId) {
                    return strip;
                  }
                  // Update LED count - add or remove LEDs as needed
                  const currentLedCount = strip.leds.length;
                  let newLeds = [...strip.leds];
                  
                  if (ledCount > currentLedCount) {
                    // Add new LEDs
                    const additionalLeds: LED[] = Array.from(
                      { length: ledCount - currentLedCount },
                      (_, index) => ({
                        id: `led-${deviceId}-${stripId}-${currentLedCount + index}`,
                position: {
                          x: device.position.x + (currentLedCount + index) * 20,
                  y: device.position.y + 50,
                },
                color: "#ffffff",
                opacity: 1,
                      })
                    );
                    newLeds = [...newLeds, ...additionalLeds];
                  } else if (ledCount < currentLedCount) {
                    // Remove excess LEDs
                    newLeds = newLeds.slice(0, ledCount);
                  }
                  
                  const updatedStrip = {
                    ...strip,
                    gpioPin,
                ledCount,
                    leds: newLeds,
                  };
                  
                  return updatedStrip;
                }),
              };
              updatedStrips = updatedDevice.strips;
              return updatedDevice;
            }),
          };
        })
      );
      
      // Save to backend using the updated strips we just created
      try {
        await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            strips: updatedStrips.map((s) => ({
              id: s.id,
              gpioPin: s.gpioPin,
              ledCount: s.ledCount,
              leds: s.leds.map((led) => ({
                id: led.id,
                position: led.position,
                color: led.color,
                opacity: led.opacity,
              })),
            })),
          }),
        });
      } catch (error) {
        console.error("Error saving strip update:", error);
      }
    },
    [currentSceneId, currentScene.devices]
  );

  const handleDeviceStripModeChange = useCallback(
    async (deviceId: string, mode: "auto" | "manual") => {
      setScenes((prev) =>
        prev.map((scene) => {
          if (scene.id !== currentSceneId) {
            return scene;
          }
          return {
            ...scene,
            devices: scene.devices.map((device) => {
              if (device.id !== deviceId) {
                return device;
              }
              return {
                ...device,
                stripMode: mode,
              };
            }),
          };
        })
      );
      
      // Save to backend
      try {
        await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            stripMode: mode,
          }),
        });
      } catch (error) {
        console.error("Error saving device strip mode:", error);
      }
    },
    [currentSceneId]
  );

  const handleAddKeyframe = useCallback(() => {
    const { keyframeId } = ensureKeyframeAtCurrentFrame();
    setSelectedKeyframeId(keyframeId);
    setShowPropertiesPanel(true);
  }, [
    ensureKeyframeAtCurrentFrame,
    setSelectedKeyframeId,
    setShowPropertiesPanel,
  ]);

  const handleExtendTimeline = useCallback(() => {
    updateSceneDuration(timelineDuration + 10000);
  }, [timelineDuration, updateSceneDuration]);

  const handlePlayPause = useCallback(() => {
    const willPlay = !isPlaying;
    toggleTimelinePlayback();
    const endpoint = willPlay ? "start" : "stop";
    void fetch(`/api/v2/playback/${currentSceneId}/${endpoint}`, {
      method: "POST",
    }).catch((error) =>
      console.error("Error updating playback state:", error)
    );
  }, [currentSceneId, isPlaying, toggleTimelinePlayback]);

  const handleTimelinePointer = useCallback(
    (clientX: number, options?: { focusKeyframe?: boolean }) => {
      const snappedPosition = setTimelineFromPointer(clientX);
      if (snappedPosition == null) return;
      const shouldFocus = options?.focusKeyframe ?? false;
      if (shouldFocus) {
        const clickThreshold = 10;
        const timeline = timelineRef.current;
        if (!timeline) return;
        const rect = timeline.getBoundingClientRect();
        const visibleStart = (timelineWindowStart / 100) * timelineDuration;
        const visibleEnd =
          visibleStart + (timelineWindowWidth / 100) * timelineDuration;
        const visibleDuration = visibleEnd - visibleStart;

        const keyframe = currentScene.keyframes.find((kf) => {
          const kfX =
            ((kf.timestamp - visibleStart) / visibleDuration) * rect.width;
          const playheadX =
            ((snappedPosition - visibleStart) / visibleDuration) * rect.width;
          return Math.abs(kfX - playheadX) < clickThreshold;
        });

        if (keyframe) {
          handleKeyframeSelect(keyframe);
        } else {
          setSelectedKeyframeId(null);
          setSelectedBackgroundImage(false);
          setShowPropertiesPanel(false);
          pendingExternalCloseRef.current = false;
        }
      }
    },
    [
      currentScene.keyframes,
      handleKeyframeSelect,
      setSelectedKeyframeId,
      setShowPropertiesPanel,
      setSelectedBackgroundImage,
      setTimelineFromPointer,
      timelineRef,
      timelineWindowStart,
      timelineWindowWidth,
      timelineDuration,
    ]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const isUndoShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z";
      if (isUndoShortcut) {
        event.preventDefault();
        undo();
        return;
      }

      // Don't trigger if modifier keys are pressed (except for undo handled above)
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      switch (event.key.toLowerCase()) {
        case "p":
          event.preventDefault();
          setTool("pan");
          break;
        case "m":
          event.preventDefault();
          if (mode === "edit") {
            setTool("move");
          }
          break;
        case "s":
          event.preventDefault();
          setTool("select");
          break;
        case "b":
          if (mode === "paint") {
            event.preventDefault();
            setTool("paint");
          }
          break;
        case "f":
          if (mode === "paint") {
            event.preventDefault();
            setTool("bucket");
          }
          break;
        case "c":
          if (mode === "paint") {
            event.preventDefault();
            setTool("color-picker");
          }
          break;
        case "i":
          if (mode === "paint") {
            event.preventDefault();
            setTool("eyedropper");
          }
          break;
        case " ":
          event.preventDefault();
          handlePlayPause();
          break;
        case "delete":
          if (selectedKeyframeId) {
            event.preventDefault();
            handleDeleteKeyframe();
          }
          break;
        case "+":
        case "=":
          event.preventDefault();
          setTool("zoom-in");
          break;
        case "-":
        case "_":
          event.preventDefault();
          setTool("zoom-out");
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, selectedKeyframeId, handleDeleteKeyframe, handlePlayPause, undo]);

  const handleTimelineClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      handleTimelinePointer(event.clientX, { focusKeyframe: true });
    },
    [handleTimelinePointer]
  );

  const handleTimelineDrag = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isDraggingTimeline) {
        handleTimelinePointer(event.clientX, { focusKeyframe: false });
      }
    },
    [handleTimelinePointer, isDraggingTimeline]
  );

  const handleSliderMouseDown = useCallback(
    (
      event: ReactMouseEvent<HTMLDivElement>,
      type: "left" | "right" | "middle"
    ) => {
      event.stopPropagation();
      sliderHandlers.beginDrag(type);
    },
    [sliderHandlers]
  );

  useEffect(() => {
    if (isDraggingSlider) {
      const handleMouseMove = (event: MouseEvent) => {
        const rect = sliderRef.current?.getBoundingClientRect();
        if (!rect) return;
        sliderHandlers.onMouseMove(event.clientX, rect);
      };
      const handleMouseUp = () => sliderHandlers.endDrag();
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isDraggingSlider, sliderHandlers]);

  useEffect(() => {
    if (!isDraggingTimeline) return;

    const handleMouseMove = (event: MouseEvent) => {
      handleTimelinePointer(event.clientX, { focusKeyframe: false });
    };

    const handleMouseUp = () => setIsDraggingTimeline(false);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleTimelinePointer, isDraggingTimeline, setIsDraggingTimeline]);

  const handlePlayheadMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDraggingTimeline(true);
      handleTimelinePointer(event.clientX, { focusKeyframe: false });
    },
    [handleTimelinePointer, setIsDraggingTimeline]
  );

  const handleCanvasMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      skipNextClickRef.current = false;
      draggedDuringInteractionRef.current = false;
      const point = getCanvasPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      const isPaintTool =
        tool === "paint" ||
        tool === "bucket" ||
        tool === "eyedropper" ||
        tool === "color-picker";

      if (event.button === 1) {
        event.preventDefault();
        event.stopPropagation();
        if (isPaintTool) {
          setTool("pan");
        }
        setIsPanning(true);
        setLastPanPosition({ x: event.clientX, y: event.clientY });
        return;
      }

      if (tool === "paint") {
        event.preventDefault();
        paintedLedsRef.current.clear();
        if (!paintingTransactionRef.current) {
          beginHistoryTransaction();
          paintingTransactionRef.current = true;
        }
        beginPainting();
        applyBrushAtPoint(point);
        return;
      }

      if (tool === "bucket") {
        event.preventDefault();
        applyBucketAtPoint(point, { fillEntireStrip: event.shiftKey });
        return;
      }

      if (tool === "color-picker") {
        return;
      }

      if (tool === "eyedropper") {
        event.preventDefault();
        const hit = findLedHit(point);
        if (hit) {
          const appearance = getLedAppearance(hit.led.id);
          setSelectedColor(appearance.color);
          setSelectedOpacity(appearance.opacity);
        }
        return;
      }

      // Zoom tools - zoom centered on click
      if (tool === "zoom-in" || tool === "zoom-out") {
        if (!canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const zoomFactor = tool === "zoom-in" ? 1.2 : 1 / 1.2;
        const newZoom = Math.max(0.05, Math.min(10, canvasZoom * zoomFactor));
        
        // Calculate the point in canvas coordinates
        const canvasX = (event.clientX - rect.left - canvasPan.x) / canvasZoom;
        const canvasY = (event.clientY - rect.top - canvasPan.y) / canvasZoom;
        
        // Adjust pan to keep the clicked point in the same screen position
        const newPanX = event.clientX - rect.left - canvasX * newZoom;
        const newPanY = event.clientY - rect.top - canvasY * newZoom;
        
        setCanvasZoom(newZoom);
        setCanvasPan({ x: newPanX, y: newPanY });
        return;
      }

      if (tool === "pan") {
        setIsPanning(true);
        setLastPanPosition({ x: event.clientX, y: event.clientY });
      } else if (mode === "edit" && (tool === "select" || tool === "move")) {
        for (const device of currentScene.devices) {
          const dist = Math.hypot(point.x - device.position.x, point.y - device.position.y);
          if (dist < 15) {
            if (showPropertiesPanel && selectedDeviceId === device.id) {
              handlePropertiesClose();
              return;
            }
            createHistoryCheckpoint();
            setSelectedDeviceId(device.id);
            setSelectedLEDId(null);
            suppressNextOutsideCloseRef.current = true;
            setShowPropertiesPanel(true);
            setIsDraggingElement(true);
            setDragStartOffset({
              x: point.x - device.position.x,
              y: point.y - device.position.y,
            });
            return;
          }
        }
        for (const device of currentScene.devices) {
          for (const strip of device.strips) {
            for (const led of strip.leds) {
              const ledDist = Math.hypot(point.x - led.position.x, point.y - led.position.y);
              if (ledDist < 8) {
                if (showPropertiesPanel && selectedLEDId === led.id) {
                  handlePropertiesClose();
                  return;
                }
                createHistoryCheckpoint();
                setSelectedLEDId(led.id);
                setSelectedDeviceId(null);
                suppressNextOutsideCloseRef.current = true;
                setShowPropertiesPanel(true);
                setIsDraggingElement(true);
                setDragStartOffset({
                  x: point.x - led.position.x,
                  y: point.y - led.position.y,
                });
                return;
              }
            }
          }
        }
      }
    },
    [
      tool,
      mode,
      currentScene,
      canvasZoom,
      canvasPan,
      getCanvasPoint,
      beginPainting,
      applyBrushAtPoint,
      applyBucketAtPoint,
      findLedHit,
      getLedAppearance,
      setSelectedColor,
      setSelectedOpacity,
      createHistoryCheckpoint,
      beginHistoryTransaction,
      handlePropertiesClose,
      showPropertiesPanel,
      selectedDeviceId,
      selectedLEDId,
    ]
  );

  const handleCanvasMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const point = getCanvasPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }
      const { x, y } = point;

      if (tool === "paint" && isPainting) {
        applyBrushAtPoint(point);
        return;
      }

      // Panning (either from pan tool or middle mouse button)
      if (isPanning) {
        const dx = event.clientX - lastPanPosition.x;
        const dy = event.clientY - lastPanPosition.y;
        setCanvasPan((prev) => ({
          x: prev.x + dx,
          y: prev.y + dy,
        }));
        setLastPanPosition({ x: event.clientX, y: event.clientY });
      } else if (isDraggingElement && mode === "edit") {
        draggedDuringInteractionRef.current = true;
        const newX = x - dragStartOffset.x;
        const newY = y - dragStartOffset.y;
        setScenes(
          (prev) =>
            prev.map((scene) => {
              if (scene.id !== currentSceneId) return scene;
              return {
                ...scene,
                devices: scene.devices.map((device) => {
                  if (device.id === selectedDeviceId) {
                    return {
                      ...device,
                      position: { x: newX, y: newY },
                    };
                  }
                  return {
                    ...device,
                    strips: device.strips.map((strip) => ({
                      ...strip,
                      leds: strip.leds.map((led) =>
                        led.id === selectedLEDId
                          ? {
                              ...led,
                              position: { x: newX, y: newY },
                            }
                          : led
                      ),
                    })),
                  };
                }),
              };
            }),
          { recordHistory: false }
        );
      }
    },
    [
      isPanning,
      tool,
      lastPanPosition,
      isDraggingElement,
      mode,
      dragStartOffset,
      currentSceneId,
      selectedDeviceId,
      selectedLEDId,
      getCanvasPoint,
      applyBrushAtPoint,
      isPainting,
    ]
  );

  const handleCanvasMouseUp = useCallback(async () => {
    if (isPainting) {
      endPainting();
      paintedLedsRef.current.clear();
      if (paintingTransactionRef.current) {
        endHistoryTransaction();
        paintingTransactionRef.current = false;
      }
    }
    setIsPanning(false);
    skipNextClickRef.current = draggedDuringInteractionRef.current;
    draggedDuringInteractionRef.current = false;
    
    // Save device or LED position if we were dragging
    if (isDraggingElement) {
      if (selectedDeviceId) {
        const device = currentScene.devices.find((d) => d.id === selectedDeviceId);
        if (device) {
          try {
            await fetch(`/api/v2/devices/${selectedDeviceId}`, {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                position: device.position,
              }),
            });
          } catch (error) {
            console.error("Error saving device position:", error);
          }
        }
      } else if (selectedLEDId) {
        // Find the LED and its device/strip, then save all strips with updated LED positions
        for (const device of currentScene.devices) {
          for (const strip of device.strips) {
            const led = strip.leds.find((l) => l.id === selectedLEDId);
            if (led) {
              try {
                // Save the entire device with updated LED positions
                await fetch(`/api/v2/devices/${device.id}`, {
                  method: "PATCH",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    strips: device.strips.map((s: LEDStrip) => ({
                      id: s.id,
                      gpioPin: s.gpioPin,
                      ledCount: s.ledCount,
                      leds: s.leds.map((l: LED) => ({
                        id: l.id,
                        position: l.position,
                        color: l.color,
                        opacity: l.opacity,
                      })),
                    })),
                  }),
                });
              } catch (error) {
                console.error("Error saving LED position:", error);
              }
              break;
            }
          }
        }
      }
    }
    
    setIsDraggingElement(false);
  }, [
    isDraggingElement,
    selectedDeviceId,
    selectedLEDId,
    currentScene.devices,
    endPainting,
    isPainting,
    endHistoryTransaction,
  ]);

  // Touch gesture handlers for mobile
  const getTouchDistance = (touch1: React.Touch, touch2: React.Touch): number => {
    return Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
  };

  const getTouchCenter = (touch1: React.Touch, touch2: React.Touch, rect: DOMRect): Point => {
    return {
      x: ((touch1.clientX + touch2.clientX) / 2 - rect.left - canvasPan.x) / canvasZoom,
      y: ((touch1.clientY + touch2.clientY) / 2 - rect.top - canvasPan.y) / canvasZoom,
    };
  };

  const handleCanvasTouchStart = useCallback(
    (event: React.TouchEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();

      if (event.touches.length === 2) {
        // Two finger pinch/pan
        const touch1 = event.touches[0];
        const touch2 = event.touches[1];
        const distance = getTouchDistance(touch1, touch2);
        const centerPoint = getTouchCenter(touch1, touch2, rect);

        setTouchState({
          initialDistance: distance,
          initialZoom: canvasZoom,
          initialPan: canvasPan,
          centerPoint,
          isPinching: true,
          isPanning: false,
          lastTouch1: { x: touch1.clientX, y: touch1.clientY },
          lastTouch2: { x: touch2.clientX, y: touch2.clientY },
        });
      } else if (event.touches.length === 1 && (tool === "select" || tool === "move" || tool === "pan")) {
        // Single finger pan
        const touch = event.touches[0];
        setTouchState({
          initialDistance: 0,
          initialZoom: canvasZoom,
          initialPan: canvasPan,
          centerPoint: { x: 0, y: 0 },
          isPinching: false,
          isPanning: true,
          lastTouch1: { x: touch.clientX, y: touch.clientY },
          lastTouch2: null,
        });
      }
    },
    [canvasZoom, canvasPan, tool]
  );

  const handleCanvasTouchMove = useCallback(
    (event: React.TouchEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current || !touchState) return;
      const rect = canvasRef.current.getBoundingClientRect();

      if (event.touches.length === 2 && touchState.isPinching) {
        // Pinch to zoom
        const touch1 = event.touches[0];
        const touch2 = event.touches[1];
        const currentDistance = getTouchDistance(touch1, touch2);
        const scale = currentDistance / touchState.initialDistance;
        const newZoom = Math.max(0.05, Math.min(10, touchState.initialZoom * scale));

        // Calculate center point in canvas coordinates
        const canvasX = touchState.centerPoint.x;
        const canvasY = touchState.centerPoint.y;

        // Adjust pan to keep the center point in the same screen position
        const centerScreenX = (touch1.clientX + touch2.clientX) / 2;
        const centerScreenY = (touch1.clientY + touch2.clientY) / 2;
        const newPanX = centerScreenX - rect.left - canvasX * newZoom;
        const newPanY = centerScreenY - rect.top - canvasY * newZoom;

        setCanvasZoom(newZoom);
        setCanvasPan({ x: newPanX, y: newPanY });
      } else if (event.touches.length === 2 && touchState.lastTouch1 && touchState.lastTouch2) {
        // Two finger pan
        const touch1 = event.touches[0];
        const touch2 = event.touches[1];
        const dx = ((touch1.clientX + touch2.clientX) / 2) - ((touchState.lastTouch1.x + touchState.lastTouch2.x) / 2);
        const dy = ((touch1.clientY + touch2.clientY) / 2) - ((touchState.lastTouch1.y + touchState.lastTouch2.y) / 2);

        setCanvasPan({
          x: touchState.initialPan.x + dx,
          y: touchState.initialPan.y + dy,
        });

        setTouchState({
          ...touchState,
          lastTouch1: { x: touch1.clientX, y: touch1.clientY },
          lastTouch2: { x: touch2.clientX, y: touch2.clientY },
        });
      } else if (event.touches.length === 1 && touchState.isPanning && touchState.lastTouch1) {
        // Single finger pan
        const touch = event.touches[0];
        const dx = touch.clientX - touchState.lastTouch1.x;
        const dy = touch.clientY - touchState.lastTouch1.y;

        setCanvasPan({
          x: touchState.initialPan.x + dx,
          y: touchState.initialPan.y + dy,
        });

        setTouchState({
          ...touchState,
          lastTouch1: { x: touch.clientX, y: touch.clientY },
        });
      }
    },
    [touchState]
  );

  const handleCanvasTouchEnd = useCallback(() => {
    setTouchState(null);
  }, []);

  const handleCanvasClick = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = (event.clientX - rect.left - canvasPan.x) / canvasZoom;
      const y = (event.clientY - rect.top - canvasPan.y) / canvasZoom;

      if (skipNextClickRef.current) {
        skipNextClickRef.current = false;
        return;
      }

      if (tool === "select") {
        const suppressToggle = pendingExternalCloseRef.current;
        let clicked = false;
        currentScene.devices.forEach((device) => {
          const dist = Math.hypot(x - device.position.x, y - device.position.y);
          if (dist < 15) {
            if (
              !suppressToggle &&
              showPropertiesPanel &&
              selectedDeviceId === device.id
            ) {
              handlePropertiesClose();
            } else {
              setSelectedDeviceId(device.id);
              setSelectedLEDId(null);
              setSelectedKeyframeId(null);
              setSelectedBackgroundImage(false);
              suppressNextOutsideCloseRef.current = true;
              setShowPropertiesPanel(true);
            }
            clicked = true;
          }
          device.strips.forEach((strip) => {
            strip.leds.forEach((led) => {
              const ledDist = Math.hypot(x - led.position.x, y - led.position.y);
              if (ledDist < 8) {
                if (
                  !suppressToggle &&
                  showPropertiesPanel &&
                  selectedLEDId === led.id
                ) {
                  handlePropertiesClose();
                } else {
                  setSelectedLEDId(led.id);
                  setSelectedDeviceId(null);
                  setSelectedKeyframeId(null);
                  setSelectedBackgroundImage(false);
                  suppressNextOutsideCloseRef.current = true;
                  setShowPropertiesPanel(true);
                }
                clicked = true;
              }
            });
          });
        });
        
        // Check if clicking on background image area (if background exists)
        if (!clicked && backgroundImage) {
          // Select background image if clicking in empty space
          if (
            selectedBackgroundImage &&
            showPropertiesPanel &&
            !suppressToggle
          ) {
            handlePropertiesClose();
          } else {
            setSelectedBackgroundImage(true);
            setSelectedDeviceId(null);
            setSelectedLEDId(null);
            setSelectedKeyframeId(null);
            suppressNextOutsideCloseRef.current = true;
            setShowPropertiesPanel(true);
          }
          clicked = true;
        }
        
        if (!clicked) {
          handlePropertiesClose();
        }
        pendingExternalCloseRef.current = false;
      }
    },
    [
      tool,
      currentScene,
      canvasZoom,
      canvasPan,
      backgroundImage,
      selectedDeviceId,
      selectedLEDId,
      selectedBackgroundImage,
      showPropertiesPanel,
      handlePropertiesClose,
      setSelectedDeviceId,
      setSelectedLEDId,
      setSelectedKeyframeId,
      setSelectedBackgroundImage,
    ]
  );

  const handleColorChange = useCallback(
    (newColor: string) => {
      if (!selectedLEDId) {
        return;
      }
      commitLedUpdates([{ id: selectedLEDId, color: newColor }]);
    },
    [commitLedUpdates, selectedLEDId]
  );

  const handleOpacityChange = useCallback(
    (newOpacity: number) => {
      if (!selectedLEDId) {
        return;
      }
      commitLedUpdates([{ id: selectedLEDId, opacity: newOpacity }]);
    },
    [commitLedUpdates, selectedLEDId]
  );

  const handleColorPickerInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSelectedColor(event.target.value);
    },
    [setSelectedColor]
  );

  const handleColorPickerOpacityChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSelectedOpacity(parseFloat(event.target.value));
    },
    [setSelectedOpacity]
  );

  const handleKeyframeEffectsChange = useCallback(
    (keyframeId: string, updates: { fadeIn?: number; fadeOut?: number }) => {
      updateKeyframe(keyframeId, (keyframe) => ({
        ...keyframe,
        effects: {
          ...keyframe.effects,
          ...updates,
        },
      }));
      void fetch(`/api/v2/scenes/${currentSceneId}/keyframes/${keyframeId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          effects: updates,
        }),
      }).catch((error) =>
        console.error("Error updating keyframe effects:", error)
      );
    },
    [currentSceneId, updateKeyframe]
  );

  const handleDeviceTypeChange = useCallback(
    async (deviceId: string, type: "local" | "wifi" | "virtual") => {
      setScenes((prev) =>
        prev.map((scene) => {
          if (scene.id !== currentSceneId) return scene;
          // Prevent changing the first device's type (it must be local)
          const firstDevice = scene.devices[0];
          if (firstDevice && firstDevice.id === deviceId && firstDevice.type === "local") {
            return scene; // Don't allow changing the first device's type
          }
          return {
            ...scene,
            devices: scene.devices.map((device) => {
              if (device.id !== deviceId) {
                return device;
              }
              // Set stripMode based on device type
              // Local and WiFi default to auto, Virtual defaults to manual
              const stripMode = type === "virtual" ? "manual" : "auto";
              return { ...device, type, stripMode };
            }),
          };
        })
      );
      
      // Save to backend
      try {
        await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type,
            stripMode: type === "virtual" ? "manual" : "auto",
          }),
        });
      } catch (error) {
        console.error("Error saving device type:", error);
      }
    },
    [currentSceneId]
  );

  const handleDeviceIpChange = useCallback(
    (deviceId: string, ipAddress: string) => {
      updateDevice(deviceId, (device) => ({
        ...device,
        ipAddress,
        connectionState:
          device.connectionState === "connecting" ? "connecting" : "idle",
        connectionError: null,
      }));
    },
    [updateDevice]
  );

  const handleDeviceConnect = useCallback(
    async (deviceId: string) => {
      const device = currentScene.devices.find((d) => d.id === deviceId);
      if (!device || device.type !== "wifi") {
        return;
      }
      const ipAddress = device.ipAddress.trim();
      if (!ipAddress) {
        setDeviceConnectionState(
          deviceId,
          "error",
          "IP address is required before connecting."
        );
        return;
      }

      setDeviceConnectionState(deviceId, "connecting", null);

      try {
        await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ipAddress }),
        });
      } catch (error) {
        console.error("Error saving device IP:", error);
        setDeviceConnectionState(
          deviceId,
          "error",
          "Failed to save IP address."
        );
        return;
      }

      try {
        const response = await fetch(`/api/v2/devices/handshake`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sceneId: currentSceneId,
            deviceId,
            ipAddress,
          }),
        });
        let payload: { status?: string; message?: string } | null = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (!response.ok || payload?.status === "error") {
          throw new Error(payload?.message ?? "Device did not respond.");
        }
        await fetchSceneDevices(currentSceneId);
        setDeviceConnectionState(deviceId, "online", null);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to establish handshake.";
        console.error("Handshake error:", error);
        setDeviceConnectionState(deviceId, "error", message);
      }
    },
    [currentScene.devices, currentSceneId, fetchSceneDevices, setDeviceConnectionState]
  );

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

  useEffect(() => {
    const loadPlaylist = async () => {
      try {
        const response = await fetch("/api/v2/scene-playlist");
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        if (Array.isArray(data)) {
          setPlaylistEntries(
            data.map((entry: ScenePlaylistEntry, index: number) => ({
              ...entry,
              position: index,
            }))
          );
        }
      } catch (error) {
        console.error("Error loading scene playlist:", error);
      }
    };
    loadPlaylist();
  }, []);

  const queuePlaylistSave = useCallback(
    (entries: ScenePlaylistEntry[]) => {
      if (playlistSaveTimeoutRef.current !== null) {
        window.clearTimeout(playlistSaveTimeoutRef.current);
      }
      playlistSaveTimeoutRef.current = window.setTimeout(() => {
        fetch("/api/v2/scene-playlist", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ entries }),
        }).catch((error) =>
          console.error("Error saving scene playlist:", error)
        );
      }, 400);
    },
    []
  );

  const handlePlaylistReorder = useCallback(
    (entries: ScenePlaylistEntry[]) => {
      const normalized = entries.map((entry, index) => ({
        ...entry,
        position: index,
      }));
      setPlaylistEntries(normalized);
      queuePlaylistSave(normalized);
    },
    [queuePlaylistSave]
  );

  const handleAddSceneToPlaylist = useCallback(
    (sceneId: string) => {
      setPlaylistEntries((prev) => {
        const newEntry: ScenePlaylistEntry = {
          id: createClientId("playlist"),
          sceneId,
          position: prev.length,
          playDurationSeconds: 60,
          fadeDurationSeconds: 5,
        };
        const next = [...prev, newEntry].map((entry, index) => ({
          ...entry,
          position: index,
        }));
        queuePlaylistSave(next);
        return next;
      });
    },
    [queuePlaylistSave]
  );

  const handleUpdatePlaylistEntry = useCallback(
    (
      entryId: string,
      updates: Partial<
        Pick<ScenePlaylistEntry, "playDurationSeconds" | "fadeDurationSeconds">
      >
    ) => {
      setPlaylistEntries((prev) => {
        const next = prev.map((entry) =>
          entry.id === entryId ? { ...entry, ...updates } : entry
        );
        queuePlaylistSave(next);
        return next;
      });
    },
    [queuePlaylistSave]
  );

  const handleRemovePlaylistEntry = useCallback(
    (entryId: string) => {
      setPlaylistEntries((prev) => {
        const filtered = prev
          .filter((entry) => entry.id !== entryId)
          .map((entry, index) => ({ ...entry, position: index }));
        queuePlaylistSave(filtered);
        return filtered;
      });
    },
    [queuePlaylistSave]
  );

  const handleSceneNameSave = useCallback(
    async (nextName: string) => {
      const trimmedName = nextName.trim();
    if (!trimmedName || trimmedName === currentScene.name) {
      setIsSceneSettingsOpen(false);
      return;
    }
    setIsSavingSceneName(true);
    try {
      const response = await fetch(`/api/v2/scenes/${currentSceneId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: trimmedName }),
      });
      if (!response.ok) {
        throw new Error("Failed to rename scene");
      }
      setScenes((prev) =>
        prev.map((scene) =>
          scene.id === currentSceneId ? { ...scene, name: trimmedName } : scene
        )
      );
      setIsSceneSettingsOpen(false);
    } catch (error) {
      console.error("Error renaming scene:", error);
    } finally {
      setIsSavingSceneName(false);
    }
    },
    [currentScene.name, currentSceneId, setScenes]
  );

  const handleRemoveAudio = useCallback(async () => {
    try {
      await fetch(`/api/v2/scenes/${currentSceneId}/audio`, {
        method: "DELETE",
      });
    } catch (error) {
      console.error("Error removing scene audio:", error);
    } finally {
      setScenes((prev) =>
        prev.map((scene) =>
          scene.id === currentSceneId
            ? { ...scene, audioUrl: undefined, audioFileName: undefined }
            : scene
        )
      );
    }
  }, [currentSceneId, setScenes]);

  const handleDeleteScene = useCallback(async () => {
    if (scenes.length <= 1) {
      window.alert("You need at least one scene.");
      return;
    }
    const remainingScenes = scenes.filter(
      (scene) => scene.id !== currentSceneId
    );
    const nextScene = remainingScenes[0];
    try {
      const response = await fetch(`/api/v2/scenes/${currentSceneId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Failed to delete scene");
      }
      setScenes(remainingScenes);
      if (nextScene) {
        setCurrentSceneId(nextScene.id);
        setSceneSettingsName(nextScene.name);
      }
      setIsSceneSettingsOpen(false);
      setPlaylistEntries((prev) => {
        const filtered = prev
          .filter((entry) => entry.sceneId !== currentSceneId)
          .map((entry, index) => ({ ...entry, position: index }));
        queuePlaylistSave(filtered);
        return filtered;
      });
    } catch (error) {
      console.error("Error deleting scene:", error);
    }
  }, [
    currentSceneId,
    queuePlaylistSave,
    scenes,
    setCurrentSceneId,
    setSceneSettingsName,
    setScenes,
  ]);

  const handleCreateScene = useCallback(async () => {
    let centerX = 400;
    let centerY = 300;
    if (canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      centerX = (rect.width / 2 - canvasPan.x) / canvasZoom;
      centerY = (rect.height / 2 - canvasPan.y) / canvasZoom;
    }
    const defaultDevice: Device = {
      id: `device-local-${Date.now()}`,
      position: { x: centerX, y: centerY },
      ipAddress: "127.0.0.1",
      strips: [],
      type: "local",
      stripMode: "auto",
    };
    try {
      const response = await fetch("/api/v2/scenes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: `Scene ${scenes.length + 1}` }),
      });
      if (!response.ok) {
        throw new Error("Failed to create scene");
      }
      const metadata = await response.json();
      const populatedScene: Scene = {
        id: metadata.id,
        name: metadata.name,
        devices: [defaultDevice],
        keyframes: [],
        audioUrl: metadata.audio?.url,
        audioFileName: metadata.audio?.filename,
        durationMs: DEFAULT_TOTAL_DURATION,
      };
      setScenes((prev) => [...prev, populatedScene]);
      setCurrentSceneId(metadata.id);
      setSceneSettingsName(metadata.name);
      setShowSceneModal(false);
      await fetch(`/api/v2/scenes/${metadata.id}/devices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(defaultDevice),
      });
    } catch (error) {
      console.error("Error creating scene:", error);
    }
  }, [
    canvasPan.x,
    canvasPan.y,
    canvasZoom,
    scenes.length,
    setCurrentSceneId,
    setSceneSettingsName,
    setScenes,
  ]);

  const handleSelectScene = useCallback(
    (sceneId: string) => {
      setCurrentSceneId(sceneId);
      const selectedScene = scenes.find((scene) => scene.id === sceneId);
      if (selectedScene) {
        setSceneSettingsName(selectedScene.name);
      }
      setShowSceneModal(false);
    },
    [scenes, setSceneSettingsName]
  );

  return (
    <EditorLayout fileInputRef={fileInputRef} audioInputRef={audioInputRef}>
      <div className="flex-1 relative">
        <SceneViewer
          canvasRef={canvasRef}
          scene={currentScene}
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
          <div className="absolute left-28 top-1/2 -translate-y-1/2 w-72 rounded-2xl border border-white/20 bg-[#0f0f0f]/95 backdrop-blur-xl p-5 space-y-4 text-white shadow-2xl z-30">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold tracking-wide">
                Color Picker
              </h4>
              <button
                type="button"
                onClick={() => setTool("paint")}
                className="text-gray-400 hover:text-white transition-colors"
                aria-label="Close color picker"
              >
                ✕
              </button>
            </div>
            <div className="flex items-center gap-4">
              <input
                type="color"
                value={selectedColor}
                onChange={handleColorPickerInputChange}
                className="w-16 h-16 rounded-lg cursor-pointer border border-white/20 bg-transparent"
              />
              <div className="flex flex-col gap-1 text-xs text-gray-300">
                <span className="uppercase tracking-wider text-sm">
                  {selectedColor.toUpperCase()}
                </span>
                <span>Opacity {(selectedOpacity * 100).toFixed(0)}%</span>
              </div>
            </div>
            <div>
              <label className="text-gray-400 text-xs uppercase tracking-widest">
                Opacity
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={selectedOpacity}
                onChange={handleColorPickerOpacityChange}
                className="w-full"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setTool("paint")}
                className="flex-1 px-3 py-2 rounded-lg bg-blue-500/20 text-blue-200 hover:bg-blue-500/30 transition-colors text-sm"
              >
                Use Brush
              </button>
              <button
                type="button"
                onClick={() => setTool("bucket")}
                className="flex-1 px-3 py-2 rounded-lg bg-purple-500/20 text-purple-200 hover:bg-purple-500/30 transition-colors text-sm"
              >
                Use Bucket
              </button>
            </div>
            <p className="text-[11px] text-gray-400">
              The paint brush and bucket tools will use this color.
            </p>
          </div>
        ) : null}

        <PropertiesDrawer
          isOpen={showPropertiesPanel}
          selectedDeviceId={selectedDeviceId}
          selectedLEDId={selectedLEDId}
          selectedKeyframeId={selectedKeyframeId}
          selectedKeyframe={selectedKeyframe}
          selectedBackgroundImage={selectedBackgroundImage}
          selectedColor={selectedLED?.color ?? "#ffffff"}
          selectedOpacity={selectedLED?.opacity ?? 1}
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
        onFramerateChange={setFramerate}
        onTimelineClick={handleTimelineClick}
        onTimelineMouseDown={(event) => {
          setIsDraggingTimeline(true);
          handleTimelinePointer(event.clientX, { focusKeyframe: true });
        }}
        onTimelineMouseUp={() => setIsDraggingTimeline(false)}
        onTimelineDrag={handleTimelineDrag}
        onPlayheadMouseDown={handlePlayheadMouseDown}
        onSliderMouseDown={handleSliderMouseDown}
        onKeyframeSelect={handleKeyframeSelect}
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
    </EditorLayout>
  );
};

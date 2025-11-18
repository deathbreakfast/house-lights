/** Hook for managing canvas interactions: painting, hit detection, mouse/touch handlers. */

import { useRef, useCallback, useEffect } from "react";
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from "react";
import { useDrawer } from "../context/DrawerContext";
import type {
  Device,
  LEDStrip,
  LED,
  Keyframe,
  Tool,
  EditorMode,
  Point,
  Scene,
} from "../types/editor";
import { collectContiguousLedIds, distanceToSegment } from "../utils/paint";
import { cloneLedStateMap } from "../utils/timeline";
import { notificationManager } from "../utils/notifications";
import type { TouchState } from "./useCanvasViewport";

type LedMetadata = Map<
  string,
  {
    device: Device;
    strip: LEDStrip;
    led: LED;
    deviceId: string;
    stripId: string;
    ledIndex: number;
  }
>;

type UseCanvasInteractionsOptions = {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  currentScene: Scene;
  currentSceneId: string;
  devices: Device[];
  frameLedState: Record<string, { color: string; opacity: number }>;
  ledMetadata: LedMetadata;
  tool: Tool;
  mode: EditorMode;
  selectedColor: string;
  selectedOpacity: number;
  isPainting: boolean;
  beginPainting: () => void;
  endPainting: () => void;
  setSelectedColor: (color: string) => void;
  setSelectedOpacity: (opacity: number) => void;
  canvasZoom: number;
  canvasPan: Point;
  setCanvasZoom: (zoom: number) => void;
  setCanvasPan: (pan: Point) => void;
  isPanning: boolean;
  setIsPanning: (panning: boolean) => void;
  lastPanPosition: Point;
  setLastPanPosition: (position: Point) => void;
  isDraggingElement: boolean;
  setIsDraggingElement: (dragging: boolean) => void;
  dragStartOffset: Point;
  setDragStartOffset: (offset: Point) => void;
  touchState: TouchState | null;
  setTouchState: (state: TouchState | null) => void;
  setTool: (tool: Tool) => void;
  updateCurrentScene: (updater: (scene: Scene) => Scene) => void;
  updateKeyframe: (keyframeId: string, updater: (keyframe: Keyframe) => Keyframe) => void;
  runWithHistoryBatch: (fn: () => void) => void;
  beginHistoryTransaction: () => void;
  endHistoryTransaction: () => void;
  createHistoryCheckpoint: () => void;
  ensureKeyframeAtCurrentFrame: (options?: { openDrawer?: boolean }) => {
    keyframeId: string;
    timestamp: number;
    effects: Keyframe["effects"];
  };
  setDevices: (devices: Device[]) => void;
  selectedDeviceId: string | null;
  selectedLEDId: string | null;
  setSelectedDeviceId: (id: string | null) => void;
  setSelectedLEDId: (id: string | null) => void;
  setSelectedKeyframeId: (id: string | null) => void;
  setSelectedBackgroundImage: (selected: boolean) => void;
  backgroundImage: string | null;
  selectedBackgroundImage: boolean;
  skipNextClickRef: React.MutableRefObject<boolean>;
  draggedDuringInteractionRef: React.MutableRefObject<boolean>;
  liveMode?: boolean;
  isPlaying?: boolean;
  timelinePosition?: number;
  applyKeyframe?: (
    sceneId: string,
    timestamp: number,
    ledStates: Record<string, { color: string; opacity: number }>
  ) => Promise<AbortController>;
};

export const useCanvasInteractions = ({
  canvasRef,
  currentScene,
  currentSceneId,
  devices,
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
  liveMode = false,
  isPlaying = false,
  timelinePosition = 0,
  applyKeyframe,
}: UseCanvasInteractionsOptions) => {
  const { openDrawer, closeDrawer, isOpen } = useDrawer();
  const paintedLedsRef = useRef<Set<string>>(new Set());
  const paintingTransactionRef = useRef(false);
  const lastAppliedFrameRef = useRef<string>("");

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
    [canvasPan, canvasZoom, canvasRef]
  );

  const findDeviceHit = useCallback(
    (point: Point): Device | null => {
      for (const device of devices) {
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
    [devices]
  );

  const findLedHit = useCallback(
    (point: Point): { device: Device; strip: LEDStrip; led: LED; index: number } | null => {
      for (const device of devices) {
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
    [devices]
  );

  const findStripLineHit = useCallback(
    (
      point: Point
    ): { device: Device; strip: LEDStrip; ledIndex: number } | null => {
      const threshold = 6;
      let closest:
        | { device: Device; strip: LEDStrip; ledIndex: number; distance: number }
        | null = null;
      for (const device of devices) {
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
    [devices]
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

  const applyLedUpdates = useCallback(
    (updates: Array<{ id: string; color?: string; opacity?: number }>) => {
      if (!updates.length) {
        return;
      }
      const updateMap = new Map(updates.map((update) => [update.id, update]));
      setDevices(devices.map((device) => ({
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
      })));
    },
    [devices, setDevices]
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
          }).catch((error) => {
            notificationManager.apiError("Error saving LED updates", error);
          })
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
      }).catch((error) => {
        notificationManager.apiError("Error persisting keyframe", error);
      });
      await persistLedUpdates(normalized);

      // If in live mode and paused, immediately apply the frame to hardware
      // Use a ref to track the last applied state to avoid duplicate applications
      if (liveMode && !isPlaying && applyKeyframe && keyframeMeta) {
        // Serialize the payload for comparison to avoid duplicate applications
        const sortedKeys = Object.keys(payloadLedStates).sort();
        const serializedState = JSON.stringify(
          sortedKeys.map((key) => [key, payloadLedStates[key]])
        );
        const serializedKey = `${currentSceneId}-${timestamp}-${serializedState}`;
        
        // Only apply if the state has actually changed
        if (serializedKey !== lastAppliedFrameRef.current) {
          lastAppliedFrameRef.current = serializedKey;
          applyKeyframe(currentSceneId, keyframeMeta.timestamp, payloadLedStates).catch(
            (error) => {
              console.error("Error applying frame to hardware in live mode:", error);
            }
          );
        }
      }
    },
    [
      applyLedUpdates,
      ensureKeyframeAtCurrentFrame,
      frameLedState,
      persistLedUpdates,
      runWithHistoryBatch,
      updateKeyframe,
      currentSceneId,
      liveMode,
      isPlaying,
      applyKeyframe,
    ]
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
  }, [canvasZoom, canvasPan, canvasRef, setCanvasZoom, setCanvasPan]);

  const getTouchDistance = (touch1: React.Touch, touch2: React.Touch): number => {
    return Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
  };

  const getTouchCenter = (touch1: React.Touch, touch2: React.Touch, rect: DOMRect): Point => {
    return {
      x: ((touch1.clientX + touch2.clientX) / 2 - rect.left - canvasPan.x) / canvasZoom,
      y: ((touch1.clientY + touch2.clientY) / 2 - rect.top - canvasPan.y) / canvasZoom,
    };
  };

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

      // Middle mouse button - pan
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

      // Paint tool
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

      // Bucket tool
      if (tool === "bucket") {
        event.preventDefault();
        applyBucketAtPoint(point, { fillEntireStrip: event.shiftKey });
        return;
      }

      // Color picker tool - no action on mouse down
      if (tool === "color-picker") {
        return;
      }

      // Eyedropper tool
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

      // Zoom tools
      if (tool === "zoom-in" || tool === "zoom-out") {
        if (!canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const zoomFactor = tool === "zoom-in" ? 1.2 : 1 / 1.2;
        const newZoom = Math.max(0.05, Math.min(10, canvasZoom * zoomFactor));
        
        const canvasX = (event.clientX - rect.left - canvasPan.x) / canvasZoom;
        const canvasY = (event.clientY - rect.top - canvasPan.y) / canvasZoom;
        
        const newPanX = event.clientX - rect.left - canvasX * newZoom;
        const newPanY = event.clientY - rect.top - canvasY * newZoom;
        
        setCanvasZoom(newZoom);
        setCanvasPan({ x: newPanX, y: newPanY });
        return;
      }

      // Pan tool
      if (tool === "pan") {
        setIsPanning(true);
        setLastPanPosition({ x: event.clientX, y: event.clientY });
        return;
      }

      // Select and move tools - device/LED interaction
      if (mode === "edit" && (tool === "select" || tool === "move")) {
        const shouldOpenProps = tool === "select";
        
        // Close properties panel when using move tool
        if (tool === "move" && isOpen) {
          closeDrawer();
        }
        
        // Check for device hit
        for (const device of devices) {
          const dist = Math.hypot(point.x - device.position.x, point.y - device.position.y);
          if (dist < 15) {
            // Toggle properties panel if clicking same device with select tool
            if (tool === "select" && isOpen && selectedDeviceId === device.id) {
              closeDrawer();
              return;
            }
            
            createHistoryCheckpoint();
            setSelectedDeviceId(device.id);
            setSelectedLEDId(null);
            setSelectedBackgroundImage(false);
            if (shouldOpenProps) {
              openDrawer({ type: "device", deviceId: device.id });
            }
            // Only allow dragging with move tool
            if (tool === "move") {
              setIsDraggingElement(true);
              setDragStartOffset({
                x: point.x - device.position.x,
                y: point.y - device.position.y,
              });
            }
            return;
          }
        }
        
        // Check for LED hit
        for (const device of devices) {
          for (const strip of device.strips) {
            for (const led of strip.leds) {
              const ledDist = Math.hypot(point.x - led.position.x, point.y - led.position.y);
              if (ledDist < 8) {
                // Toggle properties panel if clicking same LED with select tool
                if (tool === "select" && isOpen && selectedLEDId === led.id) {
                  closeDrawer();
                  return;
                }
                
                createHistoryCheckpoint();
                setSelectedLEDId(led.id);
                setSelectedDeviceId(null);
                setSelectedBackgroundImage(false);
                if (shouldOpenProps) {
                  openDrawer({ type: "led", ledId: led.id });
                }
                // Only allow dragging with move tool
                if (tool === "move") {
                  setIsDraggingElement(true);
                  setDragStartOffset({
                    x: point.x - led.position.x,
                    y: point.y - led.position.y,
                  });
                }
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
      devices,
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
      openDrawer,
      closeDrawer,
      isOpen,
      selectedDeviceId,
      selectedLEDId,
      canvasRef,
      setCanvasZoom,
      setCanvasPan,
      setIsPanning,
      setLastPanPosition,
      setTool,
      setIsDraggingElement,
      setDragStartOffset,
      setSelectedDeviceId,
      setSelectedLEDId,
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
      } else if (isDraggingElement && mode === "edit" && tool === "move") {
        draggedDuringInteractionRef.current = true;
        const newX = x - dragStartOffset.x;
        const newY = y - dragStartOffset.y;
        setDevices(devices.map((device) => {
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
        }));
      }
    },
    [
      isPanning,
      tool,
      lastPanPosition,
      isDraggingElement,
      mode,
      dragStartOffset,
      selectedDeviceId,
      selectedLEDId,
      devices,
      getCanvasPoint,
      applyBrushAtPoint,
      isPainting,
      setCanvasPan,
      setLastPanPosition,
      setDevices,
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
        const device = devices.find((d) => d.id === selectedDeviceId);
        if (device) {
          try {
            const response = await fetch(`/api/v2/devices/${selectedDeviceId}`, {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                position: device.position,
              }),
            });
            if (!response.ok) {
              const errorText = await response.text();
              console.error("Failed to save device position:", response.status, errorText);
              notificationManager.apiError(
                `Error saving device position: ${response.status}`,
                new Error(errorText)
              );
            }
          } catch (error) {
            console.error("Error saving device position:", error);
            notificationManager.apiError("Error saving device position", error);
          }
        }
      } else if (selectedLEDId) {
        // Find the LED and its device/strip, then save all strips with updated LED positions
        for (const device of devices) {
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
                notificationManager.apiError("Error saving LED position", error);
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
    devices,
    endPainting,
    isPainting,
    endHistoryTransaction,
    setIsPanning,
    setIsDraggingElement,
  ]);

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
    [canvasZoom, canvasPan, tool, canvasRef, setTouchState]
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
    [touchState, canvasRef, setCanvasZoom, setCanvasPan, setTouchState]
  );

  const handleCanvasTouchEnd = useCallback(() => {
    setTouchState(null);
  }, [setTouchState]);

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

      // Only allow properties panel to open from canvas interactions when using select tool
      if (tool !== "select") {
        return;
      }

      if (tool === "select") {
        let clicked = false;
        devices.forEach((device) => {
          const dist = Math.hypot(x - device.position.x, y - device.position.y);
          if (dist < 15) {
            if (isOpen && selectedDeviceId === device.id) {
              closeDrawer();
            } else {
              setSelectedDeviceId(device.id);
              setSelectedLEDId(null);
              setSelectedKeyframeId(null);
              setSelectedBackgroundImage(false);
              openDrawer({ type: "device", deviceId: device.id });
            }
            clicked = true;
          }
          device.strips.forEach((strip) => {
            strip.leds.forEach((led) => {
              const ledDist = Math.hypot(x - led.position.x, y - led.position.y);
              if (ledDist < 8) {
                if (isOpen && selectedLEDId === led.id) {
                  closeDrawer();
                } else {
                  setSelectedLEDId(led.id);
                  setSelectedDeviceId(null);
                  setSelectedKeyframeId(null);
                  setSelectedBackgroundImage(false);
                  openDrawer({ type: "led", ledId: led.id });
                }
                clicked = true;
              }
            });
          });
        });
        
        // Check if clicking on background image area (if background exists)
        if (!clicked && backgroundImage) {
          // Select background image if clicking in empty space
          if (selectedBackgroundImage && isOpen) {
            closeDrawer();
          } else {
            setSelectedBackgroundImage(true);
            setSelectedDeviceId(null);
            setSelectedLEDId(null);
            setSelectedKeyframeId(null);
            openDrawer({ type: "background-image" });
          }
          clicked = true;
        }
        
        if (!clicked) {
          closeDrawer();
        }
      }
    },
    [
      tool,
      devices,
      canvasZoom,
      canvasPan,
      backgroundImage,
      selectedDeviceId,
      selectedLEDId,
      selectedBackgroundImage,
      openDrawer,
      closeDrawer,
      isOpen,
      setSelectedDeviceId,
      setSelectedLEDId,
      setSelectedKeyframeId,
      setSelectedBackgroundImage,
      canvasRef,
    ]
  );

  return {
    handleCanvasMouseDown,
    handleCanvasMouseMove,
    handleCanvasMouseUp,
    handleCanvasClick,
    handleCanvasTouchStart,
    handleCanvasTouchMove,
    handleCanvasTouchEnd,
    commitLedUpdates,
  };
};


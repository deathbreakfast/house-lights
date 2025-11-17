import React, {
  RefObject,
  useLayoutEffect,
  useRef,
  useMemo,
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
} from "react";
import type { Scene, Point, Tool, EditorMode, Device } from "../../types/editor";
import { renderCanvas, type RenderOptions } from "./CanvasRenderer";
import type { LedStateMap } from "../../utils/timeline";
import { buildSceneLedState } from "../../utils/timeline";

interface SceneViewerProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  scene: Scene;
  devices: Device[];
  frameLedState?: LedStateMap;
  backgroundImage: string | null;
  backgroundImageScale: number;
  canvasZoom: number;
  canvasPan: Point;
  selectedDeviceId: string | null;
  selectedLEDId: string | null;
  powerOn: boolean;
  tool: Tool;
  mode: EditorMode;
  onCanvasClick: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  onCanvasMouseDown: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  onCanvasMouseMove: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  onCanvasMouseUp: () => void;
  onCanvasTouchStart?: (event: ReactTouchEvent<HTMLCanvasElement>) => void;
  onCanvasTouchMove?: (event: ReactTouchEvent<HTMLCanvasElement>) => void;
  onCanvasTouchEnd?: (event: ReactTouchEvent<HTMLCanvasElement>) => void;
  onZoomChange?: (zoom: number, pan: Point) => void;
}

export const SceneViewer: React.FC<SceneViewerProps> = ({
  canvasRef,
  scene,
  devices,
  frameLedState,
  backgroundImage,
  backgroundImageScale,
  canvasZoom,
  canvasPan,
  selectedDeviceId,
  selectedLEDId,
  powerOn,
  tool,
  mode,
  onCanvasClick,
  onCanvasMouseDown,
  onCanvasMouseMove,
  onCanvasMouseUp,
  onCanvasTouchStart,
  onCanvasTouchMove,
  onCanvasTouchEnd,
  onZoomChange,
}) => {
  const prevSceneIdRef = useRef<string | null>(null);
  const isFirstRenderRef = useRef(true);

  // Use frameLedState directly (devices are now global, so validation is handled at buildSceneLedState level)
  const effectiveFrameLedState = useMemo(() => {
    // If frameLedState is undefined, compute from global devices
    if (!frameLedState) {
      return buildSceneLedState(devices);
    }
    // Use frameLedState directly - it should already be consistent with global devices
    return frameLedState;
  }, [devices, frameLedState]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const sceneChanged = prevSceneIdRef.current !== scene.id;

    // Track scene changes
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      prevSceneIdRef.current = scene.id;
    } else if (sceneChanged) {
      prevSceneIdRef.current = scene.id;
    }

    // Use effectiveFrameLedState which is guaranteed to match current devices
    const options: RenderOptions = {
      canvas,
      ctx,
      scene,
      devices,
      frameLedState: effectiveFrameLedState,
      backgroundImage,
      backgroundImageScale,
      canvasZoom,
      canvasPan,
      selectedDeviceId,
      selectedLEDId,
      powerOn,
    };

    renderCanvas(options);
  }, [
    canvasRef,
    scene,
    effectiveFrameLedState,
    backgroundImage,
    backgroundImageScale,
    canvasZoom,
    canvasPan,
    selectedDeviceId,
    selectedLEDId,
    powerOn,
  ]);

  // Determine cursor based on tool
  const getCursor = () => {
    switch (tool) {
      case "pan":
        return "cursor-grab active:cursor-grabbing";
      case "zoom-in":
        return "cursor-zoom-in";
      case "zoom-out":
        return "cursor-zoom-out";
      case "select":
        return "cursor-pointer";
      case "move":
        return "cursor-move";
      default:
        return "cursor-default";
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full ${getCursor()}`}
      onClick={onCanvasClick}
      onMouseDown={onCanvasMouseDown}
      onMouseMove={onCanvasMouseMove}
      onMouseUp={onCanvasMouseUp}
      onMouseLeave={onCanvasMouseUp}
      onTouchStart={onCanvasTouchStart}
      onTouchMove={onCanvasTouchMove}
      onTouchEnd={onCanvasTouchEnd}
      style={{ touchAction: "none" }}
    />
  );
};


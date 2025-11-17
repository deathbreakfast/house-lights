/** Hook for managing canvas viewport state (zoom, pan, touch gestures). */

import { useState, useCallback } from "react";
import type { Point } from "../types/editor";

export type TouchState = {
  initialDistance: number;
  initialZoom: number;
  initialPan: Point;
  centerPoint: Point;
  isPinching: boolean;
  isPanning: boolean;
  lastTouch1: Point | null;
  lastTouch2: Point | null;
};

export const useCanvasViewport = () => {
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [canvasPan, setCanvasPan] = useState<Point>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPosition, setLastPanPosition] = useState<Point>({ x: 0, y: 0 });
  const [isDraggingElement, setIsDraggingElement] = useState(false);
  const [dragStartOffset, setDragStartOffset] = useState<Point>({ x: 0, y: 0 });
  const [touchState, setTouchState] = useState<TouchState | null>(null);

  const resetViewport = useCallback(() => {
    setCanvasZoom(1);
    setCanvasPan({ x: 0, y: 0 });
  }, []);

  return {
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
    resetViewport,
  };
};


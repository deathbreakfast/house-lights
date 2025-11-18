/** Hook for managing timeline interactions: click, drag, slider handlers. */

import { useCallback, useEffect } from "react";
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from "react";
import type { Keyframe, Scene } from "../types/editor";

type UseTimelineInteractionsOptions = {
  timelineRef: React.RefObject<HTMLDivElement>;
  sliderRef: React.RefObject<HTMLDivElement>;
  currentScene: Scene;
  timelineDuration: number;
  timelineWindowStart: number;
  timelineWindowWidth: number;
  isDraggingTimeline: boolean;
  setIsDraggingTimeline: (dragging: boolean) => void;
  isDraggingSlider: boolean | string | null;
  setTimelineFromPointer: (clientX: number) => number | null;
  sliderHandlers: {
    beginDrag: (type: "left" | "right" | "middle") => void;
    onMouseMove: (clientX: number, rect: DOMRect) => void;
    endDrag: () => void;
  };
  handleKeyframeSelect: (keyframe: Keyframe) => void;
  setSelectedKeyframeId: (id: string | null) => void;
  setSelectedBackgroundImage: (selected: boolean) => void;
  closeDrawer: () => void;
};

export const useTimelineInteractions = ({
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
}: UseTimelineInteractionsOptions) => {
  const handleTimelinePointer = useCallback(
    (clientX: number, options?: { focusKeyframe?: boolean }) => {
      const snappedPosition = setTimelineFromPointer(clientX);
      if (snappedPosition == null) return;
      const shouldFocus = options?.focusKeyframe ?? false;
      if (shouldFocus) {
        // Keyframes now handle their own selection explicitly through click handlers
        // This function is only called when no keyframe was found, so clear selection
        setSelectedKeyframeId(null);
        setSelectedBackgroundImage(false);
        closeDrawer();
      }
    },
    [
      setSelectedKeyframeId,
      setSelectedBackgroundImage,
      setTimelineFromPointer,
      closeDrawer,
    ]
  );

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

  const handlePlayheadMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDraggingTimeline(true);
      handleTimelinePointer(event.clientX, { focusKeyframe: false });
    },
    [handleTimelinePointer, setIsDraggingTimeline]
  );

  const handleTimelineTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      if (event.touches.length === 1) {
        event.preventDefault();
        const touch = event.touches[0];
        setIsDraggingTimeline(true);
        handleTimelinePointer(touch.clientX, { focusKeyframe: true });
      }
    },
    [handleTimelinePointer, setIsDraggingTimeline]
  );

  const handlePlayheadTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      if (event.touches.length === 1) {
        event.preventDefault();
        event.stopPropagation();
        const touch = event.touches[0];
        setIsDraggingTimeline(true);
        handleTimelinePointer(touch.clientX, { focusKeyframe: false });
      }
    },
    [handleTimelinePointer, setIsDraggingTimeline]
  );

  const handleSliderTouchStart = useCallback(
    (
      event: ReactTouchEvent<HTMLDivElement>,
      type: "left" | "right" | "middle"
    ) => {
      if (event.touches.length === 1) {
        event.preventDefault();
        event.stopPropagation();
        sliderHandlers.beginDrag(type);
      }
    },
    [sliderHandlers]
  );

  // Slider drag effect
  useEffect(() => {
    if (isDraggingSlider) {
      const handleMouseMove = (event: MouseEvent) => {
        const rect = sliderRef.current?.getBoundingClientRect();
        if (!rect) return;
        sliderHandlers.onMouseMove(event.clientX, rect);
      };
      const handleMouseUp = () => sliderHandlers.endDrag();
      const handleTouchMove = (event: TouchEvent) => {
        if (event.touches.length === 1) {
          event.preventDefault();
          const rect = sliderRef.current?.getBoundingClientRect();
          if (!rect) return;
          sliderHandlers.onMouseMove(event.touches[0].clientX, rect);
        }
      };
      const handleTouchEnd = () => sliderHandlers.endDrag();
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      window.addEventListener("touchmove", handleTouchMove, { passive: false });
      window.addEventListener("touchend", handleTouchEnd);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        window.removeEventListener("touchmove", handleTouchMove);
        window.removeEventListener("touchend", handleTouchEnd);
      };
    }
  }, [isDraggingSlider, sliderHandlers, sliderRef]);

  // Timeline drag effect
  useEffect(() => {
    if (!isDraggingTimeline) return;

    const handleMouseMove = (event: MouseEvent) => {
      handleTimelinePointer(event.clientX, { focusKeyframe: false });
    };

    const handleMouseUp = () => setIsDraggingTimeline(false);

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        event.preventDefault();
        handleTimelinePointer(event.touches[0].clientX, { focusKeyframe: false });
      }
    };

    const handleTouchEnd = () => setIsDraggingTimeline(false);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handleTouchEnd);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, [handleTimelinePointer, isDraggingTimeline, setIsDraggingTimeline]);

  return {
    handleTimelineClick,
    handleTimelineDrag,
    handlePlayheadMouseDown,
    handleSliderMouseDown,
    handleTimelinePointer,
    handleTimelineTouchStart,
    handlePlayheadTouchStart,
    handleSliderTouchStart,
  };
};


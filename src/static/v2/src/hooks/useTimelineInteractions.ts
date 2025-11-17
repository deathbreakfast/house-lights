/** Hook for managing timeline interactions: click, drag, slider handlers. */

import { useCallback, useEffect } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
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
  setShowPropertiesPanel: (open: boolean) => void;
  pendingExternalCloseRef: React.MutableRefObject<boolean>;
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
  setShowPropertiesPanel,
  pendingExternalCloseRef,
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
        setShowPropertiesPanel(false);
        pendingExternalCloseRef.current = false;
      }
    },
    [
      setSelectedKeyframeId,
      setShowPropertiesPanel,
      setSelectedBackgroundImage,
      setTimelineFromPointer,
      pendingExternalCloseRef,
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

  // Slider drag effect
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
  }, [isDraggingSlider, sliderHandlers, sliderRef]);

  // Timeline drag effect
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

  return {
    handleTimelineClick,
    handleTimelineDrag,
    handlePlayheadMouseDown,
    handleSliderMouseDown,
    handleTimelinePointer,
  };
};


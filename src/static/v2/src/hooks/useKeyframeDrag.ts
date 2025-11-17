import { useCallback, useRef, useState } from "react";
import type { Keyframe } from "../types/editor";

type UseKeyframeDragOptions = {
  keyframes: Keyframe[];
  selectedKeyframeId: string | null;
  framerate: number;
  totalDuration: number;
  timelineWindowStart: number;
  timelineWindowWidth: number;
  timelineRef: React.RefObject<HTMLDivElement>;
  updateKeyframe: (keyframeId: string, updater: (keyframe: Keyframe) => Keyframe) => void;
  updateCurrentScene: (updater: (scene: any) => any) => void;
  createHistoryCheckpoint: () => void;
};

export const useKeyframeDrag = ({
  keyframes,
  selectedKeyframeId,
  framerate,
  totalDuration,
  timelineWindowStart,
  timelineWindowWidth,
  timelineRef,
  updateKeyframe,
  updateCurrentScene,
  createHistoryCheckpoint,
}: UseKeyframeDragOptions) => {
  const [isDraggingKeyframe, setIsDraggingKeyframe] = useState(false);
  const dragStartRef = useRef<{ keyframeId: string; startTimestamp: number } | null>(null);

  const snapToFrame = useCallback(
    (position: number) => {
      const frameDuration = 1000 / framerate;
      return Math.round(position / frameDuration) * frameDuration;
    },
    [framerate]
  );

  const getTimestampFromClientX = useCallback(
    (clientX: number): number | null => {
      const timeline = timelineRef.current;
      if (!timeline) return null;
      const rect = timeline.getBoundingClientRect();
      if (rect.width === 0) return null;
      const x = clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, x / rect.width));
      const visibleStart = (timelineWindowStart / 100) * totalDuration;
      const visibleEnd = visibleStart + (timelineWindowWidth / 100) * totalDuration;
      const visibleDuration = Math.max(0, visibleEnd - visibleStart);
      const rawTimestamp = visibleStart + percentage * visibleDuration;
      return Math.max(0, Math.min(snapToFrame(rawTimestamp), totalDuration));
    },
    [timelineRef, timelineWindowStart, timelineWindowWidth, totalDuration, snapToFrame]
  );

  const checkCollision = useCallback(
    (targetTimestamp: number, excludeKeyframeId: string): boolean => {
      const frameDuration = 1000 / framerate;
      const collisionThreshold = frameDuration / 2;
      
      // Check if target position would collide with any other keyframe
      return keyframes.some(
        (kf) =>
          kf.id !== excludeKeyframeId &&
          Math.abs(kf.timestamp - targetTimestamp) < collisionThreshold
      );
    },
    [keyframes, framerate]
  );

  const handleKeyframeDragStart = useCallback(
    (keyframeId: string, event: React.MouseEvent) => {
      if (selectedKeyframeId !== keyframeId) return;
      event.preventDefault();
      event.stopPropagation();
      const keyframe = keyframes.find((kf) => kf.id === keyframeId);
      if (!keyframe) return;

      dragStartRef.current = {
        keyframeId,
        startTimestamp: keyframe.timestamp,
      };
      setIsDraggingKeyframe(true);
      createHistoryCheckpoint();
    },
    [selectedKeyframeId, keyframes, createHistoryCheckpoint]
  );

  const handleKeyframeDrag = useCallback(
    (event: React.MouseEvent) => {
      if (!isDraggingKeyframe || !dragStartRef.current) return;

      const newTimestamp = getTimestampFromClientX(event.clientX);
      if (newTimestamp === null) return;

      const { keyframeId } = dragStartRef.current;

      // Check for collisions - if there's a collision, don't update (will snap back on drag end)
      const hasCollision = checkCollision(newTimestamp, keyframeId);
      
      if (!hasCollision) {
        // No collision, update the dragged keyframe position
        updateKeyframe(keyframeId, (keyframe) => ({
          ...keyframe,
          timestamp: newTimestamp,
        }));
      }
      // If there's a collision, we don't update - the keyframe will snap back on drag end
    },
    [
      isDraggingKeyframe,
      getTimestampFromClientX,
      checkCollision,
      updateKeyframe,
    ]
  );

  const handleKeyframeDragEnd = useCallback(() => {
    if (!isDraggingKeyframe || !dragStartRef.current) {
      return;
    }

    const { keyframeId, startTimestamp } = dragStartRef.current;
    const currentKeyframe = keyframes.find((kf) => kf.id === keyframeId);
    
    if (currentKeyframe) {
      // Check if final position is valid (no collision)
      const hasCollision = checkCollision(currentKeyframe.timestamp, keyframeId);
      
      if (hasCollision) {
        // Invalid position - snap back to original
        updateKeyframe(keyframeId, (keyframe) => ({
          ...keyframe,
          timestamp: startTimestamp,
        }));
      }
    }

    setIsDraggingKeyframe(false);
    dragStartRef.current = null;
  }, [isDraggingKeyframe, keyframes, checkCollision, updateKeyframe]);

  return {
    isDraggingKeyframe,
    handleKeyframeDragStart,
    handleKeyframeDrag,
    handleKeyframeDragEnd,
  };
};


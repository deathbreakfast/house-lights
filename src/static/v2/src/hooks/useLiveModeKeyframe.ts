/** Hook for applying keyframes in live mode. */

import { useEffect, useRef } from "react";
import type { Keyframe } from "../types/editor";

type UseLiveModeKeyframeOptions = {
  powerOn: boolean;
  liveMode: boolean;
  currentSceneId: string;
  timelinePosition: number;
  frameLedState: Keyframe["ledStates"];
  isPlaying: boolean;
  applyKeyframe: (
    sceneId: string,
    timestamp: number,
    ledStates: Keyframe["ledStates"]
  ) => Promise<AbortController>;
};

/**
 * Serialize frameLedState for comparison. Only includes keys that have values
 * to avoid false positives from empty objects.
 */
const serializeFrameState = (state: Keyframe["ledStates"]): string => {
  if (!state || Object.keys(state).length === 0) {
    return "";
  }
  // Sort keys for consistent serialization
  const sorted = Object.keys(state).sort();
  return JSON.stringify(
    sorted.map((key) => [key, state[key]]),
    null,
    0
  );
};

export const useLiveModeKeyframe = ({
  powerOn,
  liveMode,
  currentSceneId,
  timelinePosition,
  frameLedState,
  isPlaying,
  applyKeyframe,
}: UseLiveModeKeyframeOptions) => {
  const prevFrameStateRef = useRef<string>("");
  const prevTimestampRef = useRef<number>(-1);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Only apply frames when playing in live mode
    // When paused, frames are applied immediately on change via commitLedUpdates
    if (!powerOn || !liveMode || !isPlaying) {
      // Clean up any pending requests when not playing
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      return;
    }

    const timestamp = Math.round(timelinePosition);
    const serializedState = serializeFrameState(frameLedState);

    // Only apply if frame state or timestamp has actually changed
    if (
      serializedState === prevFrameStateRef.current &&
      timestamp === prevTimestampRef.current
    ) {
      return; // Skip if nothing changed
    }

    // Abort any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Update refs
    prevFrameStateRef.current = serializedState;
    prevTimestampRef.current = timestamp;

    // Apply the keyframe
    applyKeyframe(currentSceneId, timestamp, frameLedState).then((ctrl) => {
      abortControllerRef.current = ctrl;
    });

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [
    currentSceneId,
    frameLedState,
    liveMode,
    powerOn,
    isPlaying,
    timelinePosition,
    applyKeyframe,
  ]);
};


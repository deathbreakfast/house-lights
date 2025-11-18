/** Hook for applying keyframes in live mode. */

import { useEffect } from "react";
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

export const useLiveModeKeyframe = ({
  powerOn,
  liveMode,
  currentSceneId,
  timelinePosition,
  frameLedState,
  isPlaying,
  applyKeyframe,
}: UseLiveModeKeyframeOptions) => {
  useEffect(() => {
    // Only apply frames when playing in live mode
    // When paused, frames are applied immediately on change via commitLedUpdates
    if (!powerOn || !liveMode || !isPlaying) {
      return;
    }
    const timestamp = Math.round(timelinePosition);
    let controller: AbortController | null = null;
    applyKeyframe(currentSceneId, timestamp, frameLedState).then((ctrl) => {
      controller = ctrl;
    });
    return () => {
      if (controller) {
        controller.abort();
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


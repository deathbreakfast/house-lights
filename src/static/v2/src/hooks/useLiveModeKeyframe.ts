/** Hook for applying keyframes in live mode. */

import { useEffect } from "react";
import type { Keyframe } from "../types/editor";

type UseLiveModeKeyframeOptions = {
  powerOn: boolean;
  liveMode: boolean;
  currentSceneId: string;
  timelinePosition: number;
  frameLedState: Keyframe["ledStates"];
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
  applyKeyframe,
}: UseLiveModeKeyframeOptions) => {
  useEffect(() => {
    if (!powerOn || !liveMode) {
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
    timelinePosition,
    applyKeyframe,
  ]);
};


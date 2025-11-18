/** Hook for managing playback and timeline handlers. */

import { useCallback } from "react";

type UsePlaybackHandlersOptions = {
  currentSceneId: string;
  powerOn: boolean;
  setPowerOn: (power: boolean) => void;
  savePowerState: (sceneId: string, isOn: boolean) => Promise<void>;
  isPlaying: boolean;
  toggleTimelinePlayback: () => void;
  timelineDuration: number;
  updateSceneDuration: (duration: number) => void;
  liveMode?: boolean;
  timelinePosition?: number;
  frameLedState?: Record<string, { color: string; opacity: number }>;
  applyKeyframe?: (
    sceneId: string,
    timestamp: number,
    ledStates: Record<string, { color: string; opacity: number }>
  ) => Promise<AbortController>;
};

export const usePlaybackHandlers = ({
  currentSceneId,
  powerOn,
  setPowerOn,
  savePowerState,
  isPlaying,
  toggleTimelinePlayback,
  timelineDuration,
  updateSceneDuration,
  liveMode = false,
  timelinePosition = 0,
  frameLedState = {},
  applyKeyframe,
}: UsePlaybackHandlersOptions) => {
  const handlePowerToggle = useCallback(async () => {
    const newPowerState = !powerOn;
    setPowerOn(newPowerState);
    await savePowerState(currentSceneId, newPowerState);
  }, [powerOn, currentSceneId, savePowerState, setPowerOn]);

  const handlePlayPause = useCallback(() => {
    const willPlay = !isPlaying;
    toggleTimelinePlayback();
    const endpoint = willPlay ? "start" : "stop";
    
    // In live mode, send current frame state with play/pause command
    if (liveMode && powerOn) {
      const timestamp = Math.round(timelinePosition);
      void fetch(`/api/v2/playback/${currentSceneId}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timestamp,
          ledStates: frameLedState,
        }),
      }).catch((error) =>
        console.error("Error updating playback state:", error)
      );
      
      // Also apply current frame immediately when toggling play/pause in live mode
      if (applyKeyframe && Object.keys(frameLedState).length > 0) {
        applyKeyframe(currentSceneId, timestamp, frameLedState).catch((error) => {
          console.error("Error applying frame when toggling play/pause:", error);
        });
      }
    } else {
      void fetch(`/api/v2/playback/${currentSceneId}/${endpoint}`, {
        method: "POST",
      }).catch((error) =>
        console.error("Error updating playback state:", error)
      );
    }
  }, [
    currentSceneId,
    isPlaying,
    toggleTimelinePlayback,
    liveMode,
    powerOn,
    timelinePosition,
    frameLedState,
    applyKeyframe,
  ]);

  const handleExtendTimeline = useCallback(() => {
    updateSceneDuration(timelineDuration + 10000);
  }, [timelineDuration, updateSceneDuration]);

  return {
    handlePowerToggle,
    handlePlayPause,
    handleExtendTimeline,
  };
};


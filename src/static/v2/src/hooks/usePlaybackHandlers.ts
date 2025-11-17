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
    void fetch(`/api/v2/playback/${currentSceneId}/${endpoint}`, {
      method: "POST",
    }).catch((error) =>
      console.error("Error updating playback state:", error)
    );
  }, [currentSceneId, isPlaying, toggleTimelinePlayback]);

  const handleExtendTimeline = useCallback(() => {
    updateSceneDuration(timelineDuration + 10000);
  }, [timelineDuration, updateSceneDuration]);

  return {
    handlePowerToggle,
    handlePlayPause,
    handleExtendTimeline,
  };
};


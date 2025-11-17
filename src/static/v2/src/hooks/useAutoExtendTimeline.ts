/** Hook for automatically extending timeline duration based on keyframes and audio. */

import { useEffect } from "react";
import { DEFAULT_TOTAL_DURATION } from "../constants/editor";
import { sortKeyframes } from "../utils/timeline";
import type { Scene } from "../types/editor";

type UseAutoExtendTimelineOptions = {
  currentScene: Scene;
  timelineDuration: number;
  setTimelineDuration: (duration: number) => void;
  updateSceneDuration: (duration: number) => void;
  audioRef: React.RefObject<HTMLAudioElement>;
};

export const useAutoExtendTimeline = ({
  currentScene,
  timelineDuration,
  setTimelineDuration,
  updateSceneDuration,
  audioRef,
}: UseAutoExtendTimelineOptions) => {
  // Sync timeline duration with scene duration
  useEffect(() => {
    const desired = currentScene.durationMs ?? DEFAULT_TOTAL_DURATION;
    setTimelineDuration((prev) => (prev === desired ? prev : desired));
  }, [currentScene.durationMs, currentScene.id, setTimelineDuration]);

  // Extend timeline if keyframes extend beyond current duration
  useEffect(() => {
    if (!currentScene.keyframes.length) {
      return;
    }
    const sorted = sortKeyframes(currentScene.keyframes);
    const lastTimestamp = sorted[sorted.length - 1]?.timestamp ?? 0;
    const baseline = currentScene.durationMs ?? DEFAULT_TOTAL_DURATION;
    if (lastTimestamp + 1000 > baseline) {
      updateSceneDuration(lastTimestamp + 1000);
    }
  }, [currentScene.keyframes, currentScene.durationMs, updateSceneDuration]);

  // Extend timeline if audio duration exceeds current duration
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentScene.audioUrl) {
      return;
    }
    const handleMetadata = () => {
      if (!isFinite(audio.duration) || audio.duration <= 0) {
        return;
      }
      const audioDurationMs = Math.ceil(audio.duration * 1000);
      const baseline = currentScene.durationMs ?? DEFAULT_TOTAL_DURATION;
      if (audioDurationMs > baseline) {
        updateSceneDuration(audioDurationMs);
      }
    };
    audio.addEventListener("loadedmetadata", handleMetadata);
    if (audio.readyState >= 1) {
      handleMetadata();
    }
    return () => {
      audio.removeEventListener("loadedmetadata", handleMetadata);
    };
  }, [currentScene.audioUrl, currentScene.durationMs, updateSceneDuration, audioRef]);
};


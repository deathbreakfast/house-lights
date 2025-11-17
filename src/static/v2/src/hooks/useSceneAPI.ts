/** Hook for managing scene API calls (loading, saving, power state). */

import { useCallback } from "react";
import type { Keyframe, Scene } from "../types/editor";
import { DEFAULT_SCENE, DEFAULT_TOTAL_DURATION } from "../constants/editor";
import { dedupeKeyframesByTimestamp } from "../utils/timeline";

type UseSceneAPIOptions = {
  currentSceneId: string;
  setScenes: (
    updater: (scenes: Scene[]) => Scene[],
    options?: { recordHistory?: boolean }
  ) => void;
  setCurrentSceneId: (id: string) => void;
  updateCurrentScene: (updater: (scene: Scene) => Scene) => void;
  setSceneSettingsName: (name: string) => void;
};

export const useSceneAPI = ({
  currentSceneId,
  setScenes,
  setCurrentSceneId,
  updateCurrentScene,
  setSceneSettingsName,
}: UseSceneAPIOptions) => {
  const loadScenes = useCallback(async () => {
    try {
      const response = await fetch("/api/v2/scenes");
      let payload: Array<{
        id: string;
        name: string;
        audio?: { url?: string; filename?: string };
        framerate?: number;
      }> = [];
      if (response.ok) {
        const data = await response.json();
        payload = Array.isArray(data) ? data : [];
      }
      if (!payload.length) {
        const createResponse = await fetch("/api/v2/scenes", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Scene 1" }),
        });
        if (createResponse.ok) {
          const created = await createResponse.json();
          payload = [created];
        }
      }
      const normalizedScenes: Scene[] =
        payload.map((sceneMeta) => ({
          id: sceneMeta.id,
          name: sceneMeta.name,
          devices: [],
          keyframes: [],
          audioUrl: sceneMeta.audio?.url,
          audioFileName: sceneMeta.audio?.filename,
          durationMs: DEFAULT_TOTAL_DURATION,
          framerate: sceneMeta.framerate ?? undefined,
        })) || [];
      const fallbackScenes =
        normalizedScenes.length > 0 ? normalizedScenes : [DEFAULT_SCENE];
      setScenes(() => fallbackScenes, { recordHistory: false });
      const preferredScene =
        fallbackScenes.find((scene) => scene.id === currentSceneId) ??
        fallbackScenes[0];
      setCurrentSceneId(preferredScene.id);
      setSceneSettingsName(preferredScene.name);
      return true;
    } catch (error) {
      console.error("Error loading scenes:", error);
      setScenes(() => [DEFAULT_SCENE], { recordHistory: false });
      setCurrentSceneId(DEFAULT_SCENE.id);
      setSceneSettingsName(DEFAULT_SCENE.name);
      return false;
    }
  }, [currentSceneId, setScenes, setCurrentSceneId, setSceneSettingsName]);

  const loadKeyframes = useCallback(
    async (sceneId: string) => {
      try {
        const response = await fetch(`/api/v2/scenes/${sceneId}/keyframes`);
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as Array<{
          id: string;
          timestamp: number;
          effects?: { fadeIn?: number; fadeOut?: number };
          ledStates: Keyframe["ledStates"];
        }>;
        const normalizedKeyframes = dedupeKeyframesByTimestamp(
          data.map((item) => ({
            id: item.id,
            timestamp: item.timestamp,
            effects: item.effects ?? {},
            ledStates: item.ledStates ?? {},
          }))
        );
        updateCurrentScene((scene) => ({
          ...scene,
          keyframes: normalizedKeyframes,
        }));
      } catch (error) {
        console.error("Error loading keyframes:", error);
      }
    },
    [updateCurrentScene]
  );

  const loadPowerState = useCallback(
    async (sceneId: string): Promise<boolean | null> => {
      try {
        const response = await fetch(`/api/v2/scenes/${sceneId}/power`);
        if (response.ok) {
          const data = await response.json();
          return data.powerOn ?? false;
        }
        return null;
      } catch (error) {
        console.error("Error loading power state:", error);
        return null;
      }
    },
    []
  );

  const savePowerState = useCallback(
    async (sceneId: string, powerOn: boolean): Promise<void> => {
      try {
        await fetch(`/api/v2/scenes/${sceneId}/power`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ powerOn }),
        });
      } catch (error) {
        console.error("Error saving power state:", error);
      }
    },
    []
  );

  const saveKeyframe = useCallback(
    async (sceneId: string, keyframe: Keyframe): Promise<void> => {
      try {
        await fetch(`/api/v2/scenes/${sceneId}/keyframes`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: keyframe.id,
            timestamp: keyframe.timestamp,
            ledStates: keyframe.ledStates,
            effects: keyframe.effects,
          }),
        });
      } catch (error) {
        console.error("Error saving keyframe:", error);
      }
    },
    []
  );

  const applyKeyframe = useCallback(
    async (
      sceneId: string,
      timestamp: number,
      ledStates: Keyframe["ledStates"]
    ): Promise<AbortController> => {
      const controller = new AbortController();
      fetch(`/api/v2/scenes/${sceneId}/keyframes/${timestamp}/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ledStates }),
        signal: controller.signal,
      }).catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        console.error("Error applying frame to playback engine:", error);
      });
      return controller;
    },
    []
  );

  return {
    loadScenes,
    loadKeyframes,
    loadPowerState,
    savePowerState,
    saveKeyframe,
    applyKeyframe,
  };
};


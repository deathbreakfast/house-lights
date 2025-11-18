/** Hook for managing scene-related handlers (create, delete, rename, etc.). */

import { useCallback } from "react";
import type { Scene, Device } from "../types/editor";
import { DEFAULT_TOTAL_DURATION } from "../constants/editor";

type UseSceneHandlersOptions = {
  currentSceneId: string;
  currentScene: Scene;
  scenes: Scene[];
  setScenes: (
    updater: (scenes: Scene[]) => Scene[],
    options?: { recordHistory?: boolean }
  ) => void;
  setCurrentSceneId: (id: string) => void;
  setSceneSettingsName: (name: string) => void;
  setIsSceneSettingsOpen: (open: boolean) => void;
  setIsSavingSceneName: (saving: boolean) => void;
  setShowSceneModal: (open: boolean) => void;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  canvasPan: { x: number; y: number };
  canvasZoom: number;
  handleRemovePlaylistEntriesBySceneId: (sceneId: string) => void;
};

export const useSceneHandlers = ({
  currentSceneId,
  currentScene,
  scenes,
  setScenes,
  setCurrentSceneId,
  setSceneSettingsName,
  setIsSceneSettingsOpen,
  setIsSavingSceneName,
  setShowSceneModal,
  canvasRef,
  canvasPan,
  canvasZoom,
  handleRemovePlaylistEntriesBySceneId,
}: UseSceneHandlersOptions) => {
  const handleCreateScene = useCallback(async () => {
    let centerX = 400;
    let centerY = 300;
    if (canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      centerX = (rect.width / 2 - canvasPan.x) / canvasZoom;
      centerY = (rect.height / 2 - canvasPan.y) / canvasZoom;
    }
    const defaultDevice: Device = {
      id: `device-local-${Date.now()}`,
      position: { x: centerX, y: centerY },
      ipAddress: "127.0.0.1",
      strips: [],
      type: "wifi",
      stripMode: "auto",
    };
    try {
      const response = await fetch("/api/v2/scenes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: `Scene ${scenes.length + 1}` }),
      });
      if (!response.ok) {
        throw new Error("Failed to create scene");
      }
      const metadata = await response.json();
      const populatedScene: Scene = {
        id: metadata.id,
        name: metadata.name,
        devices: [defaultDevice],
        keyframes: [],
        audioUrl: metadata.audio?.url,
        audioFileName: metadata.audio?.filename,
        durationMs: DEFAULT_TOTAL_DURATION,
      };
      setScenes((prev) => [...prev, populatedScene]);
      setCurrentSceneId(metadata.id);
      setSceneSettingsName(metadata.name);
      setShowSceneModal(false);
      await fetch(`/api/v2/scenes/${metadata.id}/devices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(defaultDevice),
      });
    } catch (error) {
      console.error("Error creating scene:", error);
    }
  }, [
    canvasPan.x,
    canvasPan.y,
    canvasZoom,
    scenes.length,
    setCurrentSceneId,
    setSceneSettingsName,
    setScenes,
    setShowSceneModal,
    canvasRef,
  ]);

  const handleSelectScene = useCallback(
    (sceneId: string) => {
      setCurrentSceneId(sceneId);
      const selectedScene = scenes.find((scene) => scene.id === sceneId);
      if (selectedScene) {
        setSceneSettingsName(selectedScene.name);
      }
      setShowSceneModal(false);
    },
    [scenes, setCurrentSceneId, setSceneSettingsName, setShowSceneModal]
  );

  const handleDeleteScene = useCallback(async () => {
    if (scenes.length <= 1) {
      window.alert("You need at least one scene.");
      return;
    }
    const remainingScenes = scenes.filter(
      (scene) => scene.id !== currentSceneId
    );
    const nextScene = remainingScenes[0];
    try {
      const response = await fetch(`/api/v2/scenes/${currentSceneId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Failed to delete scene");
      }
      setScenes(remainingScenes);
      if (nextScene) {
        setCurrentSceneId(nextScene.id);
        setSceneSettingsName(nextScene.name);
      }
      setIsSceneSettingsOpen(false);
      handleRemovePlaylistEntriesBySceneId(currentSceneId);
    } catch (error) {
      console.error("Error deleting scene:", error);
    }
  }, [
    currentSceneId,
    handleRemovePlaylistEntriesBySceneId,
    scenes,
    setCurrentSceneId,
    setSceneSettingsName,
    setScenes,
    setIsSceneSettingsOpen,
  ]);

  const handleSceneNameSave = useCallback(
    async (nextName: string) => {
      const trimmedName = nextName.trim();
      if (!trimmedName || trimmedName === currentScene.name) {
        setIsSceneSettingsOpen(false);
        return;
      }
      setIsSavingSceneName(true);
      try {
        const response = await fetch(`/api/v2/scenes/${currentSceneId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: trimmedName }),
        });
        if (!response.ok) {
          throw new Error("Failed to rename scene");
        }
        setScenes((prev) =>
          prev.map((scene) =>
            scene.id === currentSceneId ? { ...scene, name: trimmedName } : scene
          )
        );
        setIsSceneSettingsOpen(false);
      } catch (error) {
        console.error("Error renaming scene:", error);
      } finally {
        setIsSavingSceneName(false);
      }
    },
    [currentScene.name, currentSceneId, setScenes, setIsSceneSettingsOpen, setIsSavingSceneName]
  );

  const handleRemoveAudio = useCallback(async () => {
    try {
      await fetch(`/api/v2/scenes/${currentSceneId}/audio`, {
        method: "DELETE",
      });
    } catch (error) {
      console.error("Error removing scene audio:", error);
    } finally {
      setScenes((prev) =>
        prev.map((scene) =>
          scene.id === currentSceneId
            ? { ...scene, audioUrl: undefined, audioFileName: undefined }
            : scene
        )
      );
    }
  }, [currentSceneId, setScenes]);

  return {
    handleCreateScene,
    handleSelectScene,
    handleDeleteScene,
    handleSceneNameSave,
    handleRemoveAudio,
  };
};


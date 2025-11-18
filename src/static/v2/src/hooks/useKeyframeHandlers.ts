/** Hook for managing keyframe-related handlers. */

import { useCallback } from "react";
import type { Keyframe } from "../types/editor";
import { useDrawer } from "../context/DrawerContext";

type UseKeyframeHandlersOptions = {
  currentSceneId: string;
  selectedKeyframeId: string | null;
  deleteKeyframe: (keyframeId: string) => void;
  updateKeyframe: (keyframeId: string, updater: (keyframe: Keyframe) => Keyframe) => void;
  closeDrawer: () => void;
  openDrawer: (content: { type: "keyframe"; keyframeId: string }) => void;
  ensureKeyframeAtCurrentFrame: (options?: { openDrawer?: boolean }) => {
    keyframeId: string;
    timestamp: number;
    effects: Keyframe["effects"];
  };
  setSelectedKeyframeId: (id: string | null) => void;
  currentFrameKeyframeRef: React.MutableRefObject<{
    timestamp: number;
    keyframeId: string;
  } | null>;
};

export const useKeyframeHandlers = ({
  currentSceneId,
  selectedKeyframeId,
  deleteKeyframe,
  updateKeyframe,
  closeDrawer,
  openDrawer,
  ensureKeyframeAtCurrentFrame,
  setSelectedKeyframeId,
  currentFrameKeyframeRef,
}: UseKeyframeHandlersOptions) => {
  const handleDeleteKeyframe = useCallback(() => {
    if (!selectedKeyframeId) {
      return;
    }
    const keyframeId = selectedKeyframeId;
    deleteKeyframe(keyframeId);
    currentFrameKeyframeRef.current = null;
    closeDrawer();
    void fetch(`/api/v2/scenes/${currentSceneId}/keyframes/${keyframeId}`, {
      method: "DELETE",
    }).catch((error) => console.error("Error deleting keyframe:", error));
  }, [
    currentSceneId,
    deleteKeyframe,
    selectedKeyframeId,
    closeDrawer,
    currentFrameKeyframeRef,
  ]);

  const handleAddKeyframe = useCallback(() => {
    const { keyframeId } = ensureKeyframeAtCurrentFrame({ openDrawer: true });
    setSelectedKeyframeId(keyframeId);
    // Drawer is opened by ensureKeyframeAtCurrentFrame when openDrawer is true
  }, [
    ensureKeyframeAtCurrentFrame,
    setSelectedKeyframeId,
  ]);

  const handleKeyframeEffectsChange = useCallback(
    (keyframeId: string, updates: { fadeIn?: number; fadeOut?: number }) => {
      updateKeyframe(keyframeId, (keyframe) => ({
        ...keyframe,
        effects: {
          ...keyframe.effects,
          ...updates,
        },
      }));
      void fetch(`/api/v2/scenes/${currentSceneId}/keyframes/${keyframeId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          effects: updates,
        }),
      }).catch((error) =>
        console.error("Error updating keyframe effects:", error)
      );
    },
    [currentSceneId, updateKeyframe]
  );

  return {
    handleDeleteKeyframe,
    handleAddKeyframe,
    handleKeyframeEffectsChange,
  };
};


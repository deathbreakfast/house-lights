/** Hook for managing keyframe-related handlers. */

import { useCallback } from "react";
import type { Keyframe } from "../types/editor";

type UseKeyframeHandlersOptions = {
  currentSceneId: string;
  selectedKeyframeId: string | null;
  deleteKeyframe: (keyframeId: string) => void;
  updateKeyframe: (keyframeId: string, updater: (keyframe: Keyframe) => Keyframe) => void;
  setShowPropertiesPanel: (open: boolean) => void;
  ensureKeyframeAtCurrentFrame: () => {
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
  setShowPropertiesPanel,
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
    setShowPropertiesPanel(false);
    void fetch(`/api/v2/scenes/${currentSceneId}/keyframes/${keyframeId}`, {
      method: "DELETE",
    }).catch((error) => console.error("Error deleting keyframe:", error));
  }, [
    currentSceneId,
    deleteKeyframe,
    selectedKeyframeId,
    setShowPropertiesPanel,
    currentFrameKeyframeRef,
  ]);

  const handleAddKeyframe = useCallback(() => {
    const { keyframeId } = ensureKeyframeAtCurrentFrame();
    setSelectedKeyframeId(keyframeId);
    setShowPropertiesPanel(true);
  }, [
    ensureKeyframeAtCurrentFrame,
    setSelectedKeyframeId,
    setShowPropertiesPanel,
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


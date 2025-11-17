/** Hook for managing properties panel state and selection. */

import { useCallback, useRef } from "react";
import type { Keyframe } from "../types/editor";

type UsePropertiesPanelOptions = {
  showPropertiesPanel: boolean;
  setShowPropertiesPanel: (open: boolean) => void;
  selectedKeyframeId: string | null;
  setSelectedKeyframeId: (id: string | null) => void;
  setSelectedDeviceId: (id: string | null) => void;
  setSelectedLEDId: (id: string | null) => void;
  setSelectedBackgroundImage: (selected: boolean) => void;
};

export const usePropertiesPanel = ({
  showPropertiesPanel,
  setShowPropertiesPanel,
  selectedKeyframeId,
  setSelectedKeyframeId,
  setSelectedDeviceId,
  setSelectedLEDId,
  setSelectedBackgroundImage,
}: UsePropertiesPanelOptions) => {
  const pendingExternalCloseRef = useRef(false);
  const suppressNextOutsideCloseRef = useRef(false);

  const handlePropertiesClose = useCallback(
    (reason?: "outside" | "explicit") => {
      pendingExternalCloseRef.current = reason === "outside";
      suppressNextOutsideCloseRef.current = false;
      setShowPropertiesPanel(false);
      setSelectedDeviceId(null);
      setSelectedLEDId(null);
      setSelectedKeyframeId(null);
      setSelectedBackgroundImage(false);
    },
    [
      setSelectedBackgroundImage,
      setSelectedDeviceId,
      setSelectedKeyframeId,
      setSelectedLEDId,
      setShowPropertiesPanel,
    ]
  );

  const handleKeyframeSelect = useCallback(
    (keyframe: Keyframe) => {
      const suppressToggle = pendingExternalCloseRef.current;
      if (!suppressToggle && showPropertiesPanel && selectedKeyframeId === keyframe.id) {
        pendingExternalCloseRef.current = false;
        handlePropertiesClose();
        return;
      }
      pendingExternalCloseRef.current = false;
      suppressNextOutsideCloseRef.current = true;
      setSelectedKeyframeId(keyframe.id);
      setSelectedBackgroundImage(false);
      setShowPropertiesPanel(true);
      // Don't move playhead when selecting a keyframe - keep it at current position
    },
    [
      handlePropertiesClose,
      selectedKeyframeId,
      setSelectedBackgroundImage,
      setSelectedKeyframeId,
      setShowPropertiesPanel,
      showPropertiesPanel,
    ]
  );

  return {
    handlePropertiesClose,
    handleKeyframeSelect,
    pendingExternalCloseRef,
    suppressNextOutsideCloseRef,
  };
};


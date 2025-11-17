/** Hook for managing color and opacity handlers. */

import { useCallback } from "react";
import type { ChangeEvent } from "react";

type UseColorHandlersOptions = {
  selectedLEDId: string | null;
  commitLedUpdates: (updates: Array<{ id: string; color?: string; opacity?: number }>) => void;
  setSelectedColor: (color: string) => void;
  setSelectedOpacity: (opacity: number) => void;
};

export const useColorHandlers = ({
  selectedLEDId,
  commitLedUpdates,
  setSelectedColor,
  setSelectedOpacity,
}: UseColorHandlersOptions) => {
  const handleColorChange = useCallback(
    (newColor: string) => {
      if (!selectedLEDId) {
        return;
      }
      commitLedUpdates([{ id: selectedLEDId, color: newColor }]);
    },
    [commitLedUpdates, selectedLEDId]
  );

  const handleOpacityChange = useCallback(
    (newOpacity: number) => {
      if (!selectedLEDId) {
        return;
      }
      commitLedUpdates([{ id: selectedLEDId, opacity: newOpacity }]);
    },
    [commitLedUpdates, selectedLEDId]
  );

  const handleColorPickerInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSelectedColor(event.target.value);
    },
    [setSelectedColor]
  );

  const handleColorPickerOpacityChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSelectedOpacity(parseFloat(event.target.value));
    },
    [setSelectedOpacity]
  );

  return {
    handleColorChange,
    handleOpacityChange,
    handleColorPickerInputChange,
    handleColorPickerOpacityChange,
  };
};


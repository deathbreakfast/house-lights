import { useCallback, useState } from "react";

type UsePaintToolOptions = {
  initialColor?: string;
  initialOpacity?: number;
};

export const usePaintTool = ({
  initialColor = "#ff0000",
  initialOpacity = 1,
}: UsePaintToolOptions = {}) => {
  const [selectedColor, setSelectedColor] = useState(initialColor);
  const [selectedOpacity, setSelectedOpacity] = useState(initialOpacity);
  const [isPainting, setIsPainting] = useState(false);

  const beginPainting = useCallback(() => setIsPainting(true), []);
  const endPainting = useCallback(() => setIsPainting(false), []);

  return {
    selectedColor,
    setSelectedColor,
    selectedOpacity,
    setSelectedOpacity,
    isPainting,
    beginPainting,
    endPainting,
  };
};



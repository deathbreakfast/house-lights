/** Hook for syncing background image zoom/pan when it loads (background image is loaded by useGlobalStore). */

import { useEffect } from "react";

type UseBackgroundImageLoaderOptions = {
  scenesBootstrapped: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  backgroundImage: string | null;
  backgroundImageScale: number;
  canvasZoom: number;
  setCanvasPan: (pan: { x: number; y: number }) => void;
  setCanvasZoom: (zoom: number) => void;
};

export const useBackgroundImageLoader = ({
  scenesBootstrapped,
  canvasRef,
  backgroundImage,
  backgroundImageScale,
  canvasZoom,
  setCanvasPan,
  setCanvasZoom,
}: UseBackgroundImageLoaderOptions) => {
  useEffect(() => {
    if (!scenesBootstrapped || !backgroundImage) {
      return;
    }

    // Calculate zoom/pan to fit the background image when it loads
    const img = new Image();
    img.onload = () => {
      if (canvasRef.current) {
        const displayWidth = img.naturalWidth * (backgroundImageScale / 100);
        const displayHeight = img.naturalHeight * (backgroundImageScale / 100);
        const canvas = canvasRef.current;
        
        // Only set zoom if it hasn't been set yet (initial load)
        // Check if zoom is still at default value (1) to avoid overriding user's manual zoom
        if (canvasZoom === 1) {
          // Calculate zoom to fit the image in the canvas viewport
          const canvasWidth = canvas.offsetWidth;
          const canvasHeight = canvas.offsetHeight;
          const zoomX = canvasWidth / displayWidth;
          const zoomY = canvasHeight / displayHeight;
          const fitZoom = Math.min(zoomX, zoomY); // Use smaller zoom to ensure entire image fits
          
          setCanvasZoom(fitZoom);
          
          // Center the image after setting zoom
          setCanvasPan({
            x: canvasWidth / 2 - (displayWidth / 2) * fitZoom,
            y: canvasHeight / 2 - (displayHeight / 2) * fitZoom,
          });
        }
      }
    };
    img.src = backgroundImage;
  }, [scenesBootstrapped, backgroundImage, backgroundImageScale, canvasRef, canvasZoom, setCanvasPan, setCanvasZoom]);
};


/** Hook for handling file uploads (images and audio). */

import { useRef, useEffect, useCallback } from "react";
import type { Point } from "../types/editor";

type UseFileUploadOptions = {
  currentSceneId: string;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  canvasZoom: number;
  setBackgroundImage: (url: string | null) => void;
  setBackgroundImageScale: (scale: number) => void;
  setCanvasPan: (pan: Point) => void;
  setCanvasZoom: (zoom: number) => void;
  setScenes: (
    updater: (scenes: any[]) => any[],
    options?: { recordHistory?: boolean }
  ) => void;
};

export const useFileUpload = ({
  currentSceneId,
  canvasRef,
  canvasZoom,
  setBackgroundImage,
  setBackgroundImageScale,
  setCanvasPan,
  setCanvasZoom,
  setScenes,
}: UseFileUploadOptions) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fileInput = fileInputRef.current;
    if (!fileInput) {
      return;
    }
    const handler = async (event: Event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) {
        return;
      }
      try {
        const formData = new FormData();
        formData.append("file", file);
        const response = await fetch("/api/v2/background", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          throw new Error("Failed to upload image");
        }
        const data = await response.json();
        const imageUrl = data.url;
        const scale = data.scale ?? 100;
        setBackgroundImage(imageUrl);
        setBackgroundImageScale(scale);
        const img = new Image();
        img.onload = () => {
          if (!canvasRef.current) {
            return;
          }
          const displayWidth = img.naturalWidth * (scale / 100);
          const displayHeight = img.naturalHeight * (scale / 100);
          const canvas = canvasRef.current;
          
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
        };
        img.src = imageUrl;
      } catch (error) {
        console.error("Error uploading background image:", error);
        const url = URL.createObjectURL(file);
        setBackgroundImage(url);
        setBackgroundImageScale(100);
        const img = new Image();
        img.onload = () => {
          if (!canvasRef.current) {
            return;
          }
          const displayWidth = img.naturalWidth;
          const displayHeight = img.naturalHeight;
          const canvas = canvasRef.current;
          
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
        };
        img.src = url;
      }
      target.value = "";
    };
    fileInput.addEventListener("change", handler);
    return () => fileInput.removeEventListener("change", handler);
  }, [canvasRef, setBackgroundImage, setBackgroundImageScale, setCanvasPan, setCanvasZoom]);

  useEffect(() => {
    const audioInput = audioInputRef.current;
    if (!audioInput) {
      return;
    }
    const handler = async (event: Event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) {
        return;
      }
      try {
        const formData = new FormData();
        formData.append("file", file);
        const response = await fetch(`/api/v2/scenes/${currentSceneId}/audio`, {
          method: "POST",
          body: formData,
        });
        const audioData = response.ok ? await response.json() : null;
        const audioUrl = audioData?.url ?? URL.createObjectURL(file);
        const uploadedFileName = audioData?.filename ?? file.name;
        setScenes((prev) =>
          prev.map((scene) =>
            scene.id === currentSceneId
              ? {
                  ...scene,
                  audioUrl,
                  audioFileName: uploadedFileName,
                }
              : scene
          )
        );
      } catch (error) {
        console.error("Error uploading audio file:", error);
      }
      target.value = "";
    };
    audioInput.addEventListener("change", handler);
    return () => audioInput.removeEventListener("change", handler);
  }, [currentSceneId, setScenes]);

  return {
    fileInputRef,
    audioInputRef,
  };
};


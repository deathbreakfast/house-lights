/** Global state store for devices and background image (shared across all scenes). */

import { useState, useCallback, useEffect } from "react";
import type { Device } from "../types/editor";
import { notificationManager } from "../utils/notifications";

type UseGlobalStoreOptions = {
  scenesBootstrapped: boolean;
};

export const useGlobalStore = (options: UseGlobalStoreOptions = { scenesBootstrapped: false }) => {
  const { scenesBootstrapped } = options;

  const [devices, setDevicesState] = useState<Device[]>([]);
  const [backgroundImage, setBackgroundImageState] = useState<string | null>(null);
  const [backgroundImageScale, setBackgroundImageScaleState] = useState<number>(100);

  const setDevices = useCallback((devices: Device[]) => {
    setDevicesState(devices);
  }, []);

  const setBackgroundImage = useCallback((image: string | null) => {
    setBackgroundImageState(image);
  }, []);

  const setBackgroundImageScale = useCallback((scale: number) => {
    setBackgroundImageScaleState(scale);
  }, []);

  // Load devices once at startup
  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }

    const loadDevices = async () => {
      try {
        const response = await fetch("/api/v2/devices");
        if (!response.ok) {
          const errorText = await response.text();
          console.error("Failed to load devices:", response.status, errorText);
          notificationManager.apiError(
            `Error loading devices: ${response.status}`,
            new Error(errorText)
          );
          return;
        }

        const devices = await response.json();
        if (devices && Array.isArray(devices)) {
          setDevices(devices);
        } else {
          setDevices([]);
        }
      } catch (error) {
        notificationManager.apiError("Error loading devices", error);
        setDevices([]);
      }
    };

    loadDevices();
  }, [scenesBootstrapped, setDevices]);

  // Load background image once at startup
  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }

    const loadBackgroundImage = async () => {
      try {
        const response = await fetch("/api/v2/background");
        if (response.ok) {
          const data = await response.json();
          if (data?.url) {
            const scale = data.scale ?? 100;
            setBackgroundImage(data.url);
            setBackgroundImageScale(scale);
            return;
          }
        }
        setBackgroundImage(null);
        setBackgroundImageScale(100);
      } catch (error) {
        notificationManager.apiError("Error loading background image", error);
        setBackgroundImage(null);
        setBackgroundImageScale(100);
      }
    };

    loadBackgroundImage();
  }, [scenesBootstrapped, setBackgroundImage, setBackgroundImageScale]);

  return {
    devices,
    setDevices,
    backgroundImage,
    setBackgroundImage,
    backgroundImageScale,
    setBackgroundImageScale,
  };
};


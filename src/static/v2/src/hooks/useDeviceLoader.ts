/** Hook for loading devices from backend (loads once at startup, global scope). */

import { useEffect } from "react";
import type { Device } from "../types/editor";
import { notificationManager } from "../utils/notifications";

type UseDeviceLoaderOptions = {
  scenesBootstrapped: boolean;
  setDevices: (devices: Device[]) => void;
};

export const useDeviceLoader = ({
  scenesBootstrapped,
  setDevices,
}: UseDeviceLoaderOptions) => {
  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }
    
    // Abort controller to cancel in-flight requests
    const abortController = new AbortController();
    
    const loadDevices = async () => {
      try {
        const response = await fetch(`/api/v2/devices`, {
          signal: abortController.signal,
        });
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
          // Convert backend format to frontend format
          const formattedDevices: Device[] = devices.map((d: any) => ({
            id: d.id,
            position: d.position,
            ipAddress: d.ipAddress,
            type: d.type,
            stripMode: d.stripMode,
            strips: (d.strips || []).map((s: any) => ({
              id: s.id,
              gpioPin: s.gpioPin,
              ledCount: s.ledCount,
              leds: (s.leds || []).map((led: any) => ({
                id: led.id,
                position: led.position || { x: d.position.x, y: d.position.y + 50 },
                color: led.color || "#ffffff",
                opacity: led.opacity ?? 1,
              })),
            })),
          }));
          
          setDevices(formattedDevices);
        } else {
          setDevices([]);
        }
      } catch (error) {
        // Don't show error if request was aborted
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        notificationManager.apiError("Error loading devices", error);
        setDevices([]);
      }
    };
    
    loadDevices();
    
    // Cleanup: abort in-flight request when effect re-runs or component unmounts
    return () => {
      abortController.abort();
    };
  }, [
    scenesBootstrapped,
    setDevices,
  ]);
};


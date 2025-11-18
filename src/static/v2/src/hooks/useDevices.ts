/** Hook for managing device fetching and connection state. */

import { useCallback } from "react";
import type { Device, DeviceConnectionState } from "../types/editor";
import { mergeDeviceFromResponse, type SceneDeviceResponse } from "../utils/devices";

type UseDevicesOptions = {
  setDevices: (devices: Device[]) => void;
  updateDevice: (deviceId: string, updater: (device: Device) => Device) => void;
};

export const useDevices = ({
  setDevices,
  updateDevice,
}: UseDevicesOptions) => {
  const fetchDevices = useCallback(
    async (existingDevices?: Device[]) => {
      try {
        const response = await fetch(`/api/v2/devices`);
        if (!response.ok) {
          return;
        }
        const data: SceneDeviceResponse[] = await response.json();
        console.log("fetchDevices: API response", {
          deviceCount: data.length,
          devices: data.map(d => ({
            id: d.id,
            stripCount: d.strips?.length ?? 0,
            strips: d.strips?.map(s => ({ id: s.id, gpioPin: s.gpioPin, ledCount: s.ledCount, ledCount_actual: s.leds?.length ?? 0 })) ?? []
          }))
        });
        // Merge with existing devices to preserve state (like connectionState, strips if API is stale)
        const deviceMap = new Map(existingDevices?.map(d => [d.id, d]) ?? []);
        const mergedDevices = data.map((device) => {
          const existing = deviceMap.get(device.id);
          const merged = mergeDeviceFromResponse(device, existing);
          console.log(`fetchDevices: Merged device ${merged.id}`, {
            apiStrips: device.strips?.length ?? 0,
            existingStrips: existing?.strips?.length ?? 0,
            mergedStrips: merged.strips?.length ?? 0,
            mergedStripDetails: merged.strips?.map(s => ({ id: s.id, gpioPin: s.gpioPin, ledCount: s.ledCount, ledCount_actual: s.leds?.length ?? 0 })) ?? []
          });
          return merged;
        });
        console.log("fetchDevices: Setting devices", {
          deviceCount: mergedDevices.length,
          totalStrips: mergedDevices.reduce((sum, d) => sum + (d.strips?.length ?? 0), 0),
          totalLEDs: mergedDevices.reduce((sum, d) => sum + (d.strips?.reduce((s, strip) => s + (strip.leds?.length ?? 0), 0) ?? 0), 0)
        });
        setDevices(mergedDevices);
      } catch (error) {
        console.error("Error loading devices:", error);
      }
    },
    [setDevices]
  );

  const setDeviceConnectionState = useCallback(
    (deviceId: string, state: DeviceConnectionState, error: string | null = null) => {
      updateDevice(deviceId, (device) => ({
        ...device,
        connectionState: state,
        connectionError: error,
        health:
          state === "online"
            ? { ...(device.health ?? {}), online: true }
            : device.health,
      }));
    },
    [updateDevice]
  );

  return {
    fetchDevices,
    setDeviceConnectionState,
  };
};


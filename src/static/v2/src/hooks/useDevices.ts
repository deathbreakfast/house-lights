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
    async () => {
      try {
        const response = await fetch(`/api/v2/devices`);
        if (!response.ok) {
          return;
        }
        const data: SceneDeviceResponse[] = await response.json();
        const mergedDevices = data.map((device) =>
          mergeDeviceFromResponse(device, undefined)
        );
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


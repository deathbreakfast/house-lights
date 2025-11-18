/** Hook for managing device interaction handlers. */

import { useCallback } from "react";
import type { Device } from "../types/editor";

type UseDeviceHandlersOptions = {
  currentSceneId: string;
  devices: Device[];
  setDevices: (devices: Device[]) => void;
  updateDevice: (deviceId: string, updater: (device: Device) => Device) => void;
  setDeviceConnectionState: (
    deviceId: string,
    state: "idle" | "connecting" | "online" | "error",
    error: string | null
  ) => void;
  fetchDevices: (existingDevices?: Device[]) => Promise<void>;
};

export const useDeviceHandlers = ({
  currentSceneId,
  devices,
  setDevices,
  updateDevice,
  setDeviceConnectionState,
  fetchDevices,
}: UseDeviceHandlersOptions) => {
  const handleDeviceIpChange = useCallback(
    (deviceId: string, ipAddress: string) => {
      updateDevice(deviceId, (device) => ({
        ...device,
        ipAddress,
        connectionState:
          device.connectionState === "connecting" ? "connecting" : "idle",
        connectionError: null,
      }));
    },
    [updateDevice]
  );

  const handleDeviceConnect = useCallback(
    async (deviceId: string) => {
      const device = devices.find((d) => d.id === deviceId);
      if (!device) {
        return;
      }
      const ipAddress = device.ipAddress.trim();
      if (!ipAddress) {
        setDeviceConnectionState(
          deviceId,
          "error",
          "IP address is required before connecting."
        );
        return;
      }

      setDeviceConnectionState(deviceId, "connecting", null);

      try {
        await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ipAddress }),
        });
      } catch (error) {
        console.error("Error saving device IP:", error);
        setDeviceConnectionState(
          deviceId,
          "error",
          "Failed to save IP address."
        );
        return;
      }

      try {
        const response = await fetch(`/api/v2/devices/handshake`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            deviceId,
            ipAddress,
          }),
        });
        let payload: { status?: string; message?: string } | null = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (!response.ok || payload?.status === "error") {
          throw new Error(payload?.message ?? "Device did not respond.");
        }
        // Backend verifies persistence, but SQLite may need a moment for the commit to be visible
        // Retry fetching devices a few times to ensure strips are available
        // The merge will preserve existing strips if API response is stale
        await fetchDevices(devices);
        // Give a brief moment for any async database operations to complete
        await new Promise((resolve) => setTimeout(resolve, 150));
        // Fetch again to get the latest data with strips
        await fetchDevices(devices);
        setDeviceConnectionState(deviceId, "online", null);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to establish handshake.";
        console.error("Handshake error:", error);
        setDeviceConnectionState(deviceId, "error", message);
      }
    },
    [
      devices,
      fetchDevices,
      setDeviceConnectionState,
    ]
  );

  return {
    handleDeviceIpChange,
    handleDeviceConnect,
  };
};


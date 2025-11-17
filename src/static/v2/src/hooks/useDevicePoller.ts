/** Hook for polling device data from the backend. */

import { useEffect } from "react";

type UseDevicePollerOptions = {
  scenesBootstrapped: boolean;
  fetchDevices: () => Promise<void>;
  pollInterval?: number;
};

export const useDevicePoller = ({
  scenesBootstrapped,
  fetchDevices,
  pollInterval = 15000,
}: UseDevicePollerOptions) => {
  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }
    let intervalId: number | null = null;

    const loadDevices = async () => {
      await fetchDevices();
    };

    void loadDevices();
    intervalId = window.setInterval(loadDevices, pollInterval);

    return () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [scenesBootstrapped, fetchDevices, pollInterval]);
};


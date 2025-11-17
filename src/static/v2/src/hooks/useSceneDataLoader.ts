/** Hook for loading scene data (keyframes and power state) when scene changes. */

import { useEffect } from "react";

type UseSceneDataLoaderOptions = {
  scenesBootstrapped: boolean;
  currentSceneId: string;
  loadKeyframes: (sceneId: string) => Promise<void>;
  loadPowerState: (sceneId: string) => Promise<boolean | null>;
  setPowerOn: (powerOn: boolean) => void;
};

export const useSceneDataLoader = ({
  scenesBootstrapped,
  currentSceneId,
  loadKeyframes,
  loadPowerState,
  setPowerOn,
}: UseSceneDataLoaderOptions) => {
  // Load keyframes when scene changes
  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }
    void loadKeyframes(currentSceneId);
  }, [currentSceneId, scenesBootstrapped, loadKeyframes]);

  // Load power state when scene changes
  useEffect(() => {
    if (!scenesBootstrapped) {
      return;
    }
    const load = async () => {
      const state = await loadPowerState(currentSceneId);
      if (state !== null) {
        setPowerOn(state);
      }
    };
    void load();
  }, [currentSceneId, scenesBootstrapped, loadPowerState, setPowerOn]);
};


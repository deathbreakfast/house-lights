/** Hook for syncing scene name to local state. */

import { useEffect } from "react";

type UseSceneNameSyncOptions = {
  sceneName: string | undefined;
  setSceneSettingsName: (name: string) => void;
};

export const useSceneNameSync = ({
  sceneName,
  setSceneSettingsName,
}: UseSceneNameSyncOptions) => {
  useEffect(() => {
    setSceneSettingsName(sceneName ?? "");
  }, [sceneName, setSceneSettingsName]);
};


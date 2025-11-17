/** Hook for bootstrapping scenes on initial load. */

import { useEffect, useState } from "react";

type UseSceneBootstrapOptions = {
  loadScenes: () => Promise<boolean>;
};

export const useSceneBootstrap = ({
  loadScenes,
}: UseSceneBootstrapOptions): boolean => {
  const [scenesBootstrapped, setScenesBootstrapped] = useState(false);

  useEffect(() => {
    if (scenesBootstrapped) {
      return;
    }
    let isMounted = true;
    const bootstrap = async () => {
      await loadScenes();
      if (isMounted) {
        setScenesBootstrapped(true);
      }
    };
    void bootstrap();
    return () => {
      isMounted = false;
    };
  }, [scenesBootstrapped, loadScenes]);

  return scenesBootstrapped;
};


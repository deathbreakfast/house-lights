import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Device, Keyframe, LED, LEDStrip, Scene } from "../types/editor";
import { DEFAULT_SCENE } from "../constants/editor";

const MAX_HISTORY_LENGTH = 30;

type SceneHistoryEntry = {
  scenes: Scene[];
  currentSceneId: string;
};

type SceneUpdateOptions = {
  recordHistory?: boolean;
};

const cloneScenesSnapshot = (scenes: Scene[]): Scene[] => {
  const globalClone = (globalThis as typeof globalThis & {
    structuredClone?: <T>(input: T) => T;
  }).structuredClone;
  if (typeof globalClone === "function") {
    return globalClone(scenes);
  }
  return JSON.parse(JSON.stringify(scenes)) as Scene[];
};

type SceneStoreOptions = {
  initialScenes?: Scene[];
  initialSceneId?: string;
};

const findLedInScene = (
  scene: Scene | null,
  ledId: string | null
): LED | undefined => {
  if (!scene || !ledId) {
    return undefined;
  }
  for (const device of scene.devices) {
    for (const strip of device.strips) {
      const match = strip.leds.find((led) => led.id === ledId);
      if (match) {
        return match;
      }
    }
  }
  return undefined;
};

export const useSceneStore = (options: SceneStoreOptions = {}) => {
  const [scenes, setScenesState] = useState<Scene[]>(
    options.initialScenes && options.initialScenes.length > 0
      ? options.initialScenes
      : [DEFAULT_SCENE]
  );

  const [currentSceneId, setCurrentSceneId] = useState(
    options.initialSceneId ??
      options.initialScenes?.[0]?.id ??
      DEFAULT_SCENE.id
  );

  const [history, setHistory] = useState<SceneHistoryEntry[]>([]);
  const historySuppressedRef = useRef(false);
  const transactionDepthRef = useRef(0);
  const transactionSnapshotRef = useRef<SceneHistoryEntry | null>(null);
  const transactionDirtyRef = useRef(false);
  const scenesRef = useRef<Scene[]>(scenes);

  useEffect(() => {
    scenesRef.current = scenes;
  }, [scenes]);

  const appendHistoryEntry = useCallback((entry: SceneHistoryEntry) => {
    setHistory((prev) => {
      const nextHistory = [...prev, entry];
      if (nextHistory.length > MAX_HISTORY_LENGTH) {
        nextHistory.shift();
      }
      return nextHistory;
    });
  }, []);

  const pushHistoryEntry = useCallback(
    (snapshot: Scene[]) => {
      appendHistoryEntry({
        scenes: cloneScenesSnapshot(snapshot),
        currentSceneId,
      });
    },
    [appendHistoryEntry, currentSceneId]
  );

  const beginHistoryTransaction = useCallback(() => {
    transactionDepthRef.current += 1;
    if (transactionDepthRef.current === 1) {
      transactionSnapshotRef.current = {
        scenes: cloneScenesSnapshot(scenesRef.current),
        currentSceneId,
      };
      transactionDirtyRef.current = false;
      historySuppressedRef.current = true;
    }
  }, [currentSceneId]);

  const endHistoryTransaction = useCallback(() => {
    if (transactionDepthRef.current === 0) {
      return;
    }
    transactionDepthRef.current -= 1;
    if (transactionDepthRef.current === 0) {
      historySuppressedRef.current = false;
      if (transactionDirtyRef.current && transactionSnapshotRef.current) {
        appendHistoryEntry(transactionSnapshotRef.current);
      }
      transactionSnapshotRef.current = null;
      transactionDirtyRef.current = false;
    }
  }, [appendHistoryEntry]);

  const setScenes = useCallback(
    (
      action: React.SetStateAction<Scene[]>,
      options: SceneUpdateOptions = {}
    ) => {
      setScenesState((prev) => {
        const next =
          typeof action === "function"
            ? (action as (draft: Scene[]) => Scene[])(prev)
            : action;
        const didChange = !Object.is(prev, next);
        if (didChange) {
          scenesRef.current = next;
        }
        const shouldRecord =
          (options.recordHistory ?? true) &&
          !historySuppressedRef.current &&
          didChange;
        if (shouldRecord) {
          pushHistoryEntry(prev);
        } else if (historySuppressedRef.current && didChange) {
          transactionDirtyRef.current = true;
        }
        return next;
      });
    },
    [pushHistoryEntry]
  );

  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [selectedLEDId, setSelectedLEDId] = useState<string | null>(null);
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(null);
  const [selectedBackgroundImage, setSelectedBackgroundImage] = useState(false);
  const [selectedColor, setSelectedColor] = useState("#ff0000");
  const [selectedOpacity, setSelectedOpacity] = useState(1);

  const currentScene = useMemo(
    () => scenes.find((scene) => scene.id === currentSceneId) ?? DEFAULT_SCENE,
    [scenes, currentSceneId]
  );

  useEffect(() => {
    if (!selectedLEDId) {
      return;
    }
    const led = findLedInScene(currentScene, selectedLEDId);
    if (led) {
      setSelectedColor(led.color);
      setSelectedOpacity(led.opacity);
    }
  }, [currentScene, selectedLEDId]);

  const syncDevicesToBackend = useCallback(async (scene: Scene) => {
    try {
      const response = await fetch(`/api/v2/scenes/${scene.id}/devices`);
      const devicesFromBackend: Array<{ id: string }> = response.ok
        ? await response.json()
        : [];
      const existingIds = new Set(devicesFromBackend.map((device) => device.id));

      await Promise.all(
        scene.devices.map(async (device) => {
          const payload = {
            position: device.position,
            ipAddress: device.ipAddress,
            type: device.type,
            stripMode: device.stripMode,
            strips: device.strips.map((strip) => ({
              id: strip.id,
              gpioPin: strip.gpioPin,
              ledCount: strip.ledCount,
              leds: strip.leds.map((led) => ({
                id: led.id,
                position: led.position,
                color: led.color,
                opacity: led.opacity,
              })),
            })),
          };

          if (!existingIds.has(device.id)) {
            return;
          }
          await fetch(`/api/v2/devices/${device.id}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          }).catch((error) =>
            console.error("Error updating device after undo:", error)
          );
        })
      );

      const toDelete = devicesFromBackend
        .map((device) => device.id)
        .filter(
          (deviceId) => !scene.devices.some((device) => device.id === deviceId)
        );

      await Promise.all(
        toDelete.map((deviceId) =>
          fetch(`/api/v2/devices/${deviceId}`, {
            method: "DELETE",
          }).catch((error) =>
            console.error("Error removing device after undo:", error)
          )
        )
      );
    } catch (error) {
      console.error("Error syncing devices after undo:", error);
    }
  }, []);

  const syncKeyframesToBackend = useCallback(async (scene: Scene) => {
    try {
      const response = await fetch(`/api/v2/scenes/${scene.id}/keyframes`);
      const existingKeyframes: Array<{ id: string }> = response.ok
        ? await response.json()
        : [];
      const desiredIds = new Set(scene.keyframes.map((keyframe) => keyframe.id));

      await Promise.all(
        scene.keyframes.map((keyframe) =>
          fetch(`/api/v2/scenes/${scene.id}/keyframes`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              id: keyframe.id,
              timestamp: keyframe.timestamp,
              ledStates: keyframe.ledStates,
              effects: keyframe.effects,
            }),
          }).catch((error) =>
            console.error("Error syncing keyframe after undo:", error)
          )
        )
      );

      const toDelete = existingKeyframes
        .map((keyframe) => keyframe.id)
        .filter((id) => !desiredIds.has(id));

      await Promise.all(
        toDelete.map((keyframeId) =>
          fetch(`/api/v2/scenes/${scene.id}/keyframes/${keyframeId}`, {
            method: "DELETE",
          }).catch((error) =>
            console.error("Error deleting keyframe after undo:", error)
          )
        )
      );
    } catch (error) {
      console.error("Error syncing keyframes after undo:", error);
    }
  }, []);

  const syncSceneSnapshotToBackend = useCallback(
    async (entry: SceneHistoryEntry) => {
      const scene = entry.scenes.find(
        (sceneItem) => sceneItem.id === entry.currentSceneId
      );
      if (!scene) {
        return;
      }
      try {
        await Promise.all([
          syncDevicesToBackend(scene),
          syncKeyframesToBackend(scene),
        ]);
      } catch (error) {
        console.error("Error syncing scene after undo:", error);
      }
    },
    [syncDevicesToBackend, syncKeyframesToBackend]
  );

  const undo = useCallback(() => {
    let entryToRestore: SceneHistoryEntry | null = null;
    setHistory((prev) => {
      if (!prev.length) {
        return prev;
      }
      const nextHistory = [...prev];
      entryToRestore = nextHistory.pop() ?? null;
      if (entryToRestore) {
        setScenesState(cloneScenesSnapshot(entryToRestore.scenes));
        setCurrentSceneId(entryToRestore.currentSceneId);
      }
      return nextHistory;
    });
    if (entryToRestore) {
      void syncSceneSnapshotToBackend(entryToRestore);
    }
  }, [setCurrentSceneId, setScenesState, syncSceneSnapshotToBackend]);

  const createHistoryCheckpoint = useCallback(() => {
    pushHistoryEntry(scenes);
  }, [pushHistoryEntry, scenes]);

  const runWithHistoryBatch = useCallback(
    (operation: () => void) => {
      beginHistoryTransaction();
      try {
        operation();
      } finally {
        endHistoryTransaction();
      }
    },
    [beginHistoryTransaction, endHistoryTransaction]
  );

  const canUndo = history.length > 0;


  const updateScene = useCallback(
    (sceneId: string, updater: (scene: Scene) => Scene): void => {
      setScenes((prev) =>
        prev.map((scene) => (scene.id === sceneId ? updater(scene) : scene))
      );
    },
    []
  );

  const updateCurrentScene = useCallback(
    (updater: (scene: Scene) => Scene) => {
      updateScene(currentSceneId, updater);
    },
    [currentSceneId, updateScene]
  );

  const setSceneBackground = useCallback(
    (url: string | null) => {
      updateCurrentScene((scene) => ({
        ...scene,
        backgroundImage: url ?? undefined,
      }));
    },
    [updateCurrentScene]
  );

  const setSceneBackgroundScale = useCallback(
    (scale: number) => {
      updateCurrentScene((scene) => ({
        ...scene,
        backgroundImageScale: scale,
      }));
    },
    [updateCurrentScene]
  );

  const updateDevice = useCallback(
    (deviceId: string, updater: (device: Device) => Device) => {
      updateCurrentScene((scene) => ({
        ...scene,
        devices: scene.devices.map((device) =>
          device.id === deviceId ? updater(device) : device
        ),
      }));
    },
    [updateCurrentScene]
  );

  const updateStrip = useCallback(
    (
      deviceId: string,
      stripId: string,
      updater: (strip: LEDStrip) => LEDStrip
    ) => {
      updateDevice(deviceId, (device) => ({
        ...device,
        strips: device.strips.map((strip) =>
          strip.id === stripId ? updater(strip) : strip
        ),
      }));
    },
    [updateDevice]
  );

  const updateLED = useCallback(
    (deviceId: string, ledId: string, updater: (led: LED) => LED) => {
      updateDevice(deviceId, (device) => ({
        ...device,
        strips: device.strips.map((strip) => ({
          ...strip,
          leds: strip.leds.map((led) => (led.id === ledId ? updater(led) : led)),
        })),
      }));
    },
    [updateDevice]
  );

  const updateKeyframe = useCallback(
    (keyframeId: string, updater: (keyframe: Keyframe) => Keyframe) => {
      updateCurrentScene((scene) => ({
        ...scene,
        keyframes: scene.keyframes.map((keyframe) =>
          keyframe.id === keyframeId ? updater(keyframe) : keyframe
        ),
      }));
    },
    [updateCurrentScene]
  );

  const addKeyframe = useCallback(
    (keyframe: Keyframe) => {
      updateCurrentScene((scene) => ({
        ...scene,
        keyframes: [...scene.keyframes, keyframe],
      }));
    },
    [updateCurrentScene]
  );

  const deleteKeyframe = useCallback(
    (keyframeId: string) => {
      setScenes((prev) =>
        prev.map((scene) =>
          scene.id === currentSceneId
            ? {
                ...scene,
                keyframes: scene.keyframes.filter(
                  (keyframe) => keyframe.id !== keyframeId
                ),
              }
            : scene
        )
      );
      setSelectedKeyframeId((prev) => (prev === keyframeId ? null : prev));
    },
    [currentSceneId, setScenes, setSelectedKeyframeId]
  );

  const selectDevice = useCallback(
    (deviceId: string | null, opts?: { openProperties?: boolean }) => {
      setSelectedDeviceId(deviceId);
      if (deviceId) {
        setSelectedLEDId(null);
        setSelectedKeyframeId(null);
      }
    },
    []
  );

  const selectLED = useCallback(
    (ledId: string | null, opts?: { openProperties?: boolean }) => {
      setSelectedLEDId(ledId);
      if (ledId) {
        setSelectedDeviceId(null);
        setSelectedKeyframeId(null);
      }
    },
    []
  );

  const selectKeyframe = useCallback(
    (keyframeId: string | null, opts?: { openProperties?: boolean }) => {
      setSelectedKeyframeId(keyframeId);
      if (keyframeId) {
        setSelectedDeviceId(null);
        setSelectedLEDId(null);
        setSelectedBackgroundImage(false);
      }
    },
    []
  );

  const selectBackgroundImage = useCallback(
    (opts?: { openProperties?: boolean }) => {
      setSelectedBackgroundImage(true);
      setSelectedDeviceId(null);
      setSelectedLEDId(null);
      setSelectedKeyframeId(null);
    },
    []
  );

  const clearSelections = useCallback(() => {
    setSelectedDeviceId(null);
    setSelectedLEDId(null);
    setSelectedKeyframeId(null);
    setSelectedBackgroundImage(false);
    setShowPropertiesPanel(false);
  }, []);

  return {
    scenes,
    setScenes,
    currentSceneId,
    setCurrentSceneId,
    currentScene,
    selectedDeviceId,
    setSelectedDeviceId,
    selectedLEDId,
    setSelectedLEDId,
    selectedKeyframeId,
    setSelectedKeyframeId,
    selectedBackgroundImage,
    setSelectedBackgroundImage,
    selectedColor,
    setSelectedColor,
    selectedOpacity,
    setSelectedOpacity,
    updateScene,
    updateCurrentScene,
    setSceneBackground,
    setSceneBackgroundScale,
    updateDevice,
    updateStrip,
    updateLED,
    updateKeyframe,
    addKeyframe,
    deleteKeyframe,
    selectDevice,
    selectLED,
    selectKeyframe,
    selectBackgroundImage,
    clearSelections,
    undo,
    canUndo,
    createHistoryCheckpoint,
    runWithHistoryBatch,
    beginHistoryTransaction,
    endHistoryTransaction,
  };
};

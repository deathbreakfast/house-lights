import React, { useEffect, useMemo, useState } from "react";
import { Reorder } from "framer-motion";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import type { Scene, ScenePlaylistEntry } from "../../types/editor";

interface ScenePlaylistPanelProps {
  scenes: Scene[];
  playlist: ScenePlaylistEntry[];
  currentSceneId: string;
  onAddScene: (sceneId: string) => void;
  onReorder: (entries: ScenePlaylistEntry[]) => void;
  onUpdateEntry: (
    entryId: string,
    updates: Partial<
      Pick<ScenePlaylistEntry, "playDurationSeconds" | "fadeDurationSeconds">
    >
  ) => void;
  onRemoveEntry: (entryId: string) => void;
  variant?: "sidebar" | "modal";
}

const formatSceneName = (scenes: Scene[], sceneId: string): string => {
  return scenes.find((scene) => scene.id === sceneId)?.name ?? "Unknown Scene";
};

export const ScenePlaylistPanel: React.FC<ScenePlaylistPanelProps> = ({
  scenes,
  playlist,
  currentSceneId,
  onAddScene,
  onReorder,
  onUpdateEntry,
  onRemoveEntry,
  variant = "sidebar",
}) => {
  const [selectedSceneId, setSelectedSceneId] = useState(currentSceneId);

  useEffect(() => {
    if (!scenes.find((scene) => scene.id === selectedSceneId)) {
      setSelectedSceneId(currentSceneId);
    }
  }, [currentSceneId, scenes, selectedSceneId]);

  const sceneOptions = useMemo(
    () =>
      scenes.map((scene) => ({
        id: scene.id,
        name: scene.name,
      })),
    [scenes]
  );

  const handleAdd = () => {
    if (!selectedSceneId) {
      return;
    }
    onAddScene(selectedSceneId);
  };

  const containerClasses =
    variant === "sidebar"
      ? "w-96 border-l border-white/10 bg-[#141414] h-full flex flex-col p-4 gap-4"
      : "rounded-2xl border border-white/10 bg-white/5 p-4 flex flex-col gap-4";

  const listWrapperClasses =
    variant === "sidebar"
      ? "flex-1 overflow-y-auto pr-1 space-y-3"
      : "max-h-[420px] overflow-y-auto pr-1 space-y-3";

  const helperText =
    variant === "sidebar"
      ? "Playlist durations define how long each scene loops before fading into the next. Devices follow this order whenever Live Mode is disabled."
      : "Scenes run through this playlist whenever Live Mode is off.";

  return (
    <div className={containerClasses}>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Scene Playlist</h3>
            <p className="text-xs text-white/60">
              Runs when Live Mode is off to keep lights moving.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={selectedSceneId}
          onChange={(event) => setSelectedSceneId(event.target.value)}
          className="flex-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 transition-colors"
        >
          {sceneOptions.map((scene) => (
            <option key={scene.id} value={scene.id} className="bg-[#141414]">
              {scene.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!selectedSceneId}
          className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
            selectedSceneId
              ? "bg-blue-500 text-white hover:bg-blue-600"
              : "bg-white/10 text-white/40 cursor-not-allowed"
          }`}
        >
          <Plus size={16} />
          Add
        </button>
      </div>

      <div className={listWrapperClasses}>
        {playlist.length === 0 ? (
          <div className="h-full rounded-2xl border border-dashed border-white/10 bg-white/5 p-4 text-center text-sm text-white/60 flex items-center justify-center">
            Add scenes to define the playback order.
          </div>
        ) : (
          <Reorder.Group axis="y" values={playlist} onReorder={onReorder} className="space-y-3">
            {playlist.map((entry) => (
              <Reorder.Item
                key={entry.id}
                value={entry}
                whileDrag={{ scale: 1.01 }}
                className="rounded-2xl border border-white/10 bg-white/5 p-3 space-y-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <GripVertical className="text-white/40" size={16} />
                    <div>
                      <p className="text-sm font-semibold">
                        {formatSceneName(scenes, entry.sceneId)}
                      </p>
                      <p className="text-xs text-white/60">
                        Repeat for {entry.playDurationSeconds}s then fade{" "}
                        {entry.fadeDurationSeconds}s
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveEntry(entry.id)}
                    className="rounded-full p-1 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                    aria-label="Remove scene from playlist"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-white/60 space-y-1">
                    <span>Loop Duration (s)</span>
                    <input
                      type="number"
                      min={1}
                      value={entry.playDurationSeconds}
                      onChange={(event) =>
                        onUpdateEntry(entry.id, {
                          playDurationSeconds: Math.max(
                            1,
                            Number(event.target.value) || 1
                          ),
                        })
                      }
                      className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-blue-400"
                    />
                  </label>
                  <label className="text-xs text-white/60 space-y-1">
                    <span>Fade Duration (s)</span>
                    <input
                      type="number"
                      min={0}
                      value={entry.fadeDurationSeconds}
                      onChange={(event) =>
                        onUpdateEntry(entry.id, {
                          fadeDurationSeconds: Math.max(
                            0,
                            Number(event.target.value) || 0
                          ),
                        })
                      }
                      className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-blue-400"
                    />
                  </label>
                </div>
              </Reorder.Item>
            ))}
          </Reorder.Group>
        )}
      </div>

      <p className="text-[11px] text-white/60">{helperText}</p>
    </div>
  );
};


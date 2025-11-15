import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Scene, ScenePlaylistEntry } from "../../types/editor";
import { ScenePlaylistPanel } from "../scene/ScenePlaylistPanel";

interface SceneModalProps {
  isOpen: boolean;
  scenes: Scene[];
  currentSceneId: string;
  onClose: () => void;
  onSelectScene: (sceneId: string) => void;
  onCreateScene: () => void;
  playlist: ScenePlaylistEntry[];
  onAddSceneToPlaylist: (sceneId: string) => void;
  onReorderPlaylist: (entries: ScenePlaylistEntry[]) => void;
  onUpdatePlaylistEntry: (
    entryId: string,
    updates: Partial<
      Pick<ScenePlaylistEntry, "playDurationSeconds" | "fadeDurationSeconds">
    >
  ) => void;
  onRemovePlaylistEntry: (entryId: string) => void;
}

export const SceneModal: React.FC<SceneModalProps> = ({
  isOpen,
  scenes,
  currentSceneId,
  onClose,
  onSelectScene,
  onCreateScene,
  playlist,
  onAddSceneToPlaylist,
  onReorderPlaylist,
  onUpdatePlaylistEntry,
  onRemovePlaylistEntry,
}) => {
  const handleSceneSelect = (sceneId: string) => {
    onSelectScene(sceneId);
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={(event) => event.stopPropagation()}
            className="bg-[#1a1a1a] rounded-2xl border border-white/20 p-6 w-full max-w-5xl"
          >
            <div className="flex flex-col gap-2 mb-6">
              <h2 className="text-white text-2xl font-semibold">Scenes</h2>
              <p className="text-sm text-white/60">
                Choose a scene to edit or build a playlist for offline playback.
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
              <div className="space-y-4">
                <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                  {scenes.map((scene) => (
                    <button
                      key={scene.id}
                      onClick={() => handleSceneSelect(scene.id)}
                      className={`w-full p-3 rounded-lg text-left transition-all ${
                        scene.id === currentSceneId
                          ? "bg-blue-500/20 border border-blue-500/50 text-blue-400"
                          : "bg-white/5 hover:bg-white/10 text-white"
                      }`}
                    >
                      {scene.name}
                    </button>
                  ))}
                </div>
                <button
                  onClick={onCreateScene}
                  className="w-full p-3 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-all"
                >
                  Create New Scene
                </button>
              </div>

              <ScenePlaylistPanel
                variant="modal"
                scenes={scenes}
                playlist={playlist}
                currentSceneId={currentSceneId}
                onAddScene={onAddSceneToPlaylist}
                onReorder={onReorderPlaylist}
                onUpdateEntry={onUpdatePlaylistEntry}
                onRemoveEntry={onRemovePlaylistEntry}
              />
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};


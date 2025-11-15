import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Upload, Trash2 } from "lucide-react";

interface SceneSettingsModalProps {
  isOpen: boolean;
  sceneName: string;
  audioFileName?: string;
  disableDelete?: boolean;
  isSaving?: boolean;
  onClose: () => void;
  onSaveName: (name: string) => void;
  onRequestAudioUpload: () => void;
  onRemoveAudio: () => void;
  onDeleteScene: () => void;
}

export const SceneSettingsModal: React.FC<SceneSettingsModalProps> = ({
  isOpen,
  sceneName,
  audioFileName,
  disableDelete = false,
  isSaving = false,
  onClose,
  onSaveName,
  onRequestAudioUpload,
  onRemoveAudio,
  onDeleteScene,
}) => {
  const [nameDraft, setNameDraft] = useState(sceneName);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setNameDraft(sceneName);
      setIsConfirmingDelete(false);
    }
  }, [isOpen, sceneName]);

  const trimmedName = nameDraft.trim();
  const canSave =
    trimmedName.length > 1 &&
    trimmedName.toLowerCase() !== sceneName.trim().toLowerCase();

  const handleSave = () => {
    if (!canSave || isSaving) {
      return;
    }
    onSaveName(trimmedName);
  };

  const handleDeleteClick = () => {
    if (disableDelete) {
      return;
    }
    if (!isConfirmingDelete) {
      setIsConfirmingDelete(true);
      return;
    }
    onDeleteScene();
  };

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#111]/95 backdrop-blur-xl p-6 text-white space-y-6"
          >
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">
                Scene Settings
              </h2>
              <p className="text-sm text-white/70 mt-1">
                Rename the scene, manage audio, or remove the scene entirely.
              </p>
            </div>

            <div className="space-y-3">
              <label className="text-xs uppercase tracking-[0.35em] text-white/50">
                Scene Name
              </label>
              <input
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                placeholder="Enter scene name"
                className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-base outline-none focus:border-blue-400 transition-colors"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave || isSaving}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  canSave && !isSaving
                    ? "bg-blue-500 hover:bg-blue-600 text-white"
                    : "bg-white/10 text-white/50 cursor-not-allowed"
                }`}
              >
                {isSaving ? "Saving..." : "Save Name"}
              </button>
            </div>

            <div className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">Scene Audio</p>
                  <p className="text-xs text-white/60">
                    {audioFileName ? audioFileName : "No audio attached"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onRequestAudioUpload}
                    className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20 transition-colors"
                  >
                    <Upload size={14} />
                    Upload
                  </button>
                  <button
                    type="button"
                    onClick={onRemoveAudio}
                    disabled={!audioFileName}
                    className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                      audioFileName
                        ? "border border-white/15 bg-transparent text-white hover:bg-white/10"
                        : "border border-transparent text-white/30 cursor-not-allowed"
                    }`}
                  >
                    <Trash2 size={14} />
                    Remove
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-white/50">
                Audio files are stored per scene and appear on the timeline once
                uploaded.
              </p>
            </div>

            <div className="space-y-3 rounded-2xl border border-red-500/20 bg-red-500/5 p-4">
              <div className="flex items-center gap-3 text-red-300">
                <AlertTriangle size={18} />
                <div>
                  <p className="text-sm font-semibold">Delete Scene</p>
                  <p className="text-xs text-red-200/70">
                    This removes the scene, devices, and its playlist entries.
                  </p>
                </div>
              </div>
              {disableDelete ? (
                <p className="text-xs text-white/60">
                  You must have at least one scene in the project.
                </p>
              ) : isConfirmingDelete ? (
                <p className="text-xs text-red-200">
                  This action cannot be undone. Tap delete again to confirm.
                </p>
              ) : null}
              <button
                type="button"
                onClick={handleDeleteClick}
                className={`w-full rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
                  disableDelete
                    ? "border-red-500/20 text-red-200/40 cursor-not-allowed"
                    : "border-red-500/40 text-red-200 hover:bg-red-500/10"
                }`}
              >
                {isConfirmingDelete ? "Confirm Delete" : "Delete Scene"}
              </button>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-white/15 px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors"
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};


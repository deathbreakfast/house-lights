import React, { RefObject } from "react";
import { motion } from "framer-motion";
import { Image as ImageIcon, Edit3, Layers, Settings } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import type { EditorMode } from "../../types/editor";

interface TopRightButtonsProps {
  fileInputRef: RefObject<HTMLInputElement>;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  onSceneManagerClick: () => void;
  onSceneSettingsClick: () => void;
}

export const TopRightButtons: React.FC<TopRightButtonsProps> = ({
  fileInputRef,
  mode,
  onModeChange,
  onSceneManagerClick,
  onSceneSettingsClick,
}) => {
  const handleModeToggle = () => {
    if (mode === "view") {
      onModeChange("edit");
    } else if (mode === "edit") {
      onModeChange("paint");
    } else {
      onModeChange("view");
    }
  };

  return (
    <div className="absolute top-4 right-4 flex gap-2 z-20">
      <Tooltip text="Upload Background Image" position="bottom-left">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => fileInputRef.current?.click()}
          className="p-3 rounded-xl backdrop-blur-xl bg-white/10 border border-white/20 hover:bg-white/20 transition-all"
        >
          <ImageIcon size={20} className="text-white" />
        </motion.button>
      </Tooltip>

      <Tooltip
        text={
          mode === "view"
            ? "View Mode"
            : mode === "edit"
            ? "Edit Mode"
            : "Paint Mode"
        }
        position="bottom-left"
      >
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={handleModeToggle}
          className={`p-3 rounded-xl backdrop-blur-xl border transition-all ${
            mode === "edit"
              ? "bg-blue-500/20 border-blue-500/50"
              : mode === "paint"
              ? "bg-purple-500/20 border-purple-500/50"
              : "bg-white/10 border-white/20"
          }`}
        >
          <Edit3
            size={20}
            className={
              mode === "edit"
                ? "text-blue-400"
                : mode === "paint"
                ? "text-purple-400"
                : "text-white"
            }
          />
        </motion.button>
      </Tooltip>

      <Tooltip text="Scene Manager" position="bottom-left">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onSceneManagerClick}
          className="p-3 rounded-xl backdrop-blur-xl bg-white/10 border border-white/20 hover:bg-white/20 transition-all"
        >
          <Layers size={20} className="text-white" />
        </motion.button>
      </Tooltip>

      <Tooltip text="Scene Settings" position="bottom-left">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onSceneSettingsClick}
          className="p-3 rounded-xl backdrop-blur-xl bg-white/10 border border-white/20 hover:bg-white/20 transition-all"
        >
          <Settings size={20} className="text-white" />
        </motion.button>
      </Tooltip>
    </div>
  );
};


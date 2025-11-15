import React from "react";
import { motion } from "framer-motion";
import {
  Hand,
  ZoomIn,
  ZoomOut,
  MousePointer,
  Move,
  Plus,
  Paintbrush,
  PaintBucket,
  Palette,
  Pipette,
} from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import type { Tool, EditorMode } from "../../types/editor";

interface ToolPaletteProps {
  tool: Tool;
  mode: EditorMode;
  onToolChange: (tool: Tool) => void;
  onAddDevice: () => void;
}

export const ToolPalette: React.FC<ToolPaletteProps> = ({
  tool,
  mode,
  onToolChange,
  onAddDevice,
}) => {
  return (
    <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20">
      <div className="flex flex-col gap-2 p-3 rounded-2xl backdrop-blur-xl bg-white/10 border border-white/20">
        <Tooltip text="Pan Tool (p)" position="right">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => onToolChange("pan")}
            className={`p-2 rounded-lg transition-all ${
              tool === "pan"
                ? "bg-blue-500/30 text-blue-400"
                : "hover:bg-white/10 text-gray-400"
            }`}
          >
            <Hand size={20} />
          </motion.button>
        </Tooltip>
        <Tooltip text="Zoom In (+)" position="right">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => onToolChange("zoom-in")}
            className={`p-2 rounded-lg transition-all ${
              tool === "zoom-in"
                ? "bg-blue-500/30 text-blue-400"
                : "hover:bg-white/10 text-gray-400"
            }`}
          >
            <ZoomIn size={20} />
          </motion.button>
        </Tooltip>
        <Tooltip text="Zoom Out (-)" position="right">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => onToolChange("zoom-out")}
            className={`p-2 rounded-lg transition-all ${
              tool === "zoom-out"
                ? "bg-blue-500/30 text-blue-400"
                : "hover:bg-white/10 text-gray-400"
            }`}
          >
            <ZoomOut size={20} />
          </motion.button>
        </Tooltip>
        <div className="h-px bg-white/20 my-1" />
        <Tooltip text="Select Tool (s)" position="right">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => onToolChange("select")}
            className={`p-2 rounded-lg transition-all ${
              tool === "select"
                ? "bg-blue-500/30 text-blue-400"
                : "hover:bg-white/10 text-gray-400"
            }`}
          >
            <MousePointer size={20} />
          </motion.button>
        </Tooltip>
        {mode === "edit" ? (
          <>
            <Tooltip text="Move Tool (m)" position="right">
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => onToolChange("move")}
                className={`p-2 rounded-lg transition-all ${
                  tool === "move"
                    ? "bg-blue-500/30 text-blue-400"
                    : "hover:bg-white/10 text-gray-400"
                }`}
              >
                <Move size={20} />
              </motion.button>
            </Tooltip>
            <Tooltip text="Add Device" position="right">
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={onAddDevice}
                className="p-2 rounded-lg hover:bg-white/10 text-gray-400 transition-all"
              >
                <Plus size={20} />
              </motion.button>
            </Tooltip>
          </>
        ) : mode === "paint" ? (
          <>
            <Tooltip text="Paint Brush (b)" position="right">
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => onToolChange("paint")}
                className={`p-2 rounded-lg transition-all ${
                  tool === "paint"
                    ? "bg-blue-500/30 text-blue-400"
                    : "hover:bg-white/10 text-gray-400"
                }`}
              >
                <Paintbrush size={20} />
              </motion.button>
            </Tooltip>
        <Tooltip text="Fill Bucket (f, Shift: whole strip)" position="right">
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => onToolChange("bucket")}
                className={`p-2 rounded-lg transition-all ${
                  tool === "bucket"
                    ? "bg-blue-500/30 text-blue-400"
                    : "hover:bg-white/10 text-gray-400"
                }`}
              >
                <PaintBucket size={20} />
              </motion.button>
            </Tooltip>
            <Tooltip text="Color Picker (c)" position="right">
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => onToolChange("color-picker")}
                className={`p-2 rounded-lg transition-all ${
                  tool === "color-picker"
                    ? "bg-blue-500/30 text-blue-400"
                    : "hover:bg-white/10 text-gray-400"
                }`}
              >
                <Palette size={20} />
              </motion.button>
            </Tooltip>
            <Tooltip text="Eye Dropper (i)" position="right">
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => onToolChange("eyedropper")}
                className={`p-2 rounded-lg transition-all ${
                  tool === "eyedropper"
                    ? "bg-blue-500/30 text-blue-400"
                    : "hover:bg-white/10 text-gray-400"
                }`}
              >
                <Pipette size={20} />
              </motion.button>
            </Tooltip>
          </>
        ) : null}
      </div>
    </div>
  );
};


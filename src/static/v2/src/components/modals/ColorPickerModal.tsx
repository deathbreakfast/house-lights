/** Color picker modal component for selecting color and opacity. */

import React from "react";
import type { ChangeEvent } from "react";
import type { Tool } from "../../types/editor";

interface ColorPickerModalProps {
  selectedColor: string;
  selectedOpacity: number;
  onColorChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpacityChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onToolChange: (tool: Tool) => void;
}

export const ColorPickerModal: React.FC<ColorPickerModalProps> = ({
  selectedColor,
  selectedOpacity,
  onColorChange,
  onOpacityChange,
  onToolChange,
}) => {
  return (
    <div className="absolute left-28 top-1/2 -translate-y-1/2 w-72 rounded-2xl border border-white/20 bg-[#0f0f0f]/95 backdrop-blur-xl p-5 space-y-4 text-white shadow-2xl z-30">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold tracking-wide">Color Picker</h4>
        <button
          type="button"
          onClick={() => onToolChange("paint")}
          className="text-gray-400 hover:text-white transition-colors"
          aria-label="Close color picker"
        >
          ✕
        </button>
      </div>
      <div className="flex items-center gap-4">
        <input
          type="color"
          value={selectedColor}
          onChange={onColorChange}
          className="w-16 h-16 rounded-lg cursor-pointer border border-white/20 bg-transparent"
        />
        <div className="flex flex-col gap-1 text-xs text-gray-300">
          <span className="uppercase tracking-wider text-sm">
            {selectedColor.toUpperCase()}
          </span>
          <span>Opacity {(selectedOpacity * 100).toFixed(0)}%</span>
        </div>
      </div>
      <div>
        <label className="text-gray-400 text-xs uppercase tracking-widest">
          Opacity
        </label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={selectedOpacity}
          onChange={onOpacityChange}
          className="w-full"
        />
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => onToolChange("paint")}
          className="flex-1 px-3 py-2 rounded-lg bg-blue-500/20 text-blue-200 hover:bg-blue-500/30 transition-colors text-sm"
        >
          Use Brush
        </button>
        <button
          type="button"
          onClick={() => onToolChange("bucket")}
          className="flex-1 px-3 py-2 rounded-lg bg-purple-500/20 text-purple-200 hover:bg-purple-500/30 transition-colors text-sm"
        >
          Use Bucket
        </button>
      </div>
      <p className="text-[11px] text-gray-400">
        The paint brush and bucket tools will use this color.
      </p>
    </div>
  );
};


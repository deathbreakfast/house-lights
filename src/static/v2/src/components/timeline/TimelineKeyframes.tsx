import React from "react";
import { motion } from "framer-motion";
import type { Keyframe } from "../../types/editor";

interface TimelineKeyframesProps {
  keyframes: Keyframe[];
  timelineWindowStart: number;
  timelineWindowWidth: number;
  timelinePosition: number;
  totalDuration: number;
  selectedKeyframeId: string | null;
  showPropertiesPanel: boolean;
  onKeyframeClick?: (keyframe: Keyframe) => void;
}

export const TimelineKeyframes: React.FC<TimelineKeyframesProps> = ({
  keyframes,
  timelineWindowStart,
  timelineWindowWidth,
  timelinePosition,
  totalDuration,
  selectedKeyframeId,
  showPropertiesPanel,
  onKeyframeClick,
}) => {
  const visibleStart = (timelineWindowStart / 100) * totalDuration;
  const visibleEnd = visibleStart + (timelineWindowWidth / 100) * totalDuration;
  const visibleDuration = visibleEnd - visibleStart;

  return (
    <div className="absolute inset-0">
      <div className="w-full h-full bg-gradient-to-r from-blue-500/5 to-purple-500/5 relative">
        {keyframes.map((keyframe) => {
          if (keyframe.timestamp < visibleStart || keyframe.timestamp > visibleEnd) {
            return null;
          }
          const position =
            ((keyframe.timestamp - visibleStart) / visibleDuration) * 100;
          const isSelected = showPropertiesPanel && selectedKeyframeId === keyframe.id;
          const isNearPlayhead =
            showPropertiesPanel &&
            Math.abs(keyframe.timestamp - timelinePosition) < 100;
          return (
            <motion.div
              key={keyframe.id}
              style={{ left: `${position}%` }}
              onClick={(event) => {
                event.stopPropagation();
                onKeyframeClick?.(keyframe);
              }}
              className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 cursor-pointer transition-colors ${
                isSelected ? "rotate-0" : "rotate-45"
              } ${
                isNearPlayhead
                  ? "bg-yellow-400"
                  : isSelected
                  ? "bg-blue-500"
                  : "bg-blue-400"
              }`}
            />
          );
        })}
      </div>
    </div>
  );
};


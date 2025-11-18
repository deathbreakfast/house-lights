import React from "react";
import { motion } from "framer-motion";
import { GripVertical } from "lucide-react";
import { useDrawer } from "../../context/DrawerContext";
import type { Keyframe } from "../../types/editor";

interface TimelineKeyframesProps {
  keyframes: Keyframe[];
  timelineWindowStart: number;
  timelineWindowWidth: number;
  timelinePosition: number;
  totalDuration: number;
  selectedKeyframeId: string | null;
  onKeyframeClick?: (keyframe: Keyframe) => void;
  onKeyframeDragStart?: (keyframeId: string, event: React.MouseEvent) => void;
  onKeyframeDrag?: (event: React.MouseEvent) => void;
  onKeyframeDragEnd?: () => void;
  isDraggingKeyframe?: boolean;
}

export const TimelineKeyframes: React.FC<TimelineKeyframesProps> = ({
  keyframes,
  timelineWindowStart,
  timelineWindowWidth,
  timelinePosition,
  totalDuration,
  selectedKeyframeId,
  onKeyframeClick,
  onKeyframeDragStart,
  onKeyframeDrag,
  onKeyframeDragEnd,
  isDraggingKeyframe = false,
}) => {
  const { isOpen, contentType } = useDrawer();
  const visibleStart = (timelineWindowStart / 100) * totalDuration;
  const visibleEnd = visibleStart + (timelineWindowWidth / 100) * totalDuration;
  const visibleDuration = visibleEnd - visibleStart;

  return (
    <div className="absolute inset-0 pointer-events-none">
      <div className="w-full h-full bg-gradient-to-r from-blue-500/5 to-purple-500/5 relative">
        {keyframes.map((keyframe) => {
          if (keyframe.timestamp < visibleStart || keyframe.timestamp > visibleEnd) {
            return null;
          }
          const position =
            ((keyframe.timestamp - visibleStart) / visibleDuration) * 100;
          const isSelected = isOpen && contentType?.type === "keyframe" && contentType.keyframeId === keyframe.id;
          const canDrag = isSelected && !isDraggingKeyframe;
          
          return (
            <motion.div
              key={keyframe.id}
              data-keyframe={keyframe.id}
              style={{ left: `${position}%`, pointerEvents: "auto", zIndex: 30 }}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center justify-center"
            >
              {/* Keyframe indicator */}
              <div
                onClick={(event) => {
                  event.stopPropagation();
                  onKeyframeClick?.(keyframe);
                }}
                onMouseDown={(event) => {
                  // Always stop propagation to prevent timeline/playhead from handling the event
                  event.stopPropagation();
                }}
                className={`w-3 h-3 transition-colors ${
                  isSelected ? "rotate-0" : "rotate-45"
                } ${
                  isSelected
                    ? "bg-yellow-400"
                    : "bg-blue-400"
                } ${canDrag ? "cursor-pointer" : "cursor-pointer"}`}
              />
              
              {/* Drag handle - only visible when selected and draggable */}
              {canDrag && (
                <div
                  data-keyframe-drag-handle={keyframe.id}
                  style={{ touchAction: "none" }}
                  onMouseDown={(event) => {
                    // Always stop propagation to prevent timeline/playhead from handling the event
                    event.stopPropagation();
                    event.preventDefault();
                    onKeyframeDragStart?.(keyframe.id, event);
                  }}
                  onTouchStart={(event) => {
                    // Always stop propagation to prevent timeline/playhead from handling the event
                    event.stopPropagation();
                    event.preventDefault();
                    // Convert touch event to mouse-like event for compatibility
                    if (event.touches.length === 1 && onKeyframeDragStart) {
                      const touch = event.touches[0];
                      const syntheticEvent = {
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                        preventDefault: () => {},
                        stopPropagation: () => {},
                      } as React.MouseEvent;
                      onKeyframeDragStart(keyframe.id, syntheticEvent);
                    }
                  }}
                  className="absolute -right-2 top-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing opacity-60 hover:opacity-100 transition-opacity z-40"
                  title="Drag to move keyframe"
                >
                  <GripVertical size={12} className="text-white" />
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};


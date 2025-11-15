import React, { RefObject } from "react";
import { MIN_WINDOW_PERCENT } from "../../constants/editor";

interface TimelineZoomSliderProps {
  sliderRef: RefObject<HTMLDivElement>;
  timelineWindowStart: number;
  timelineWindowWidth: number;
  onSliderMouseDown: (
    event: React.MouseEvent<HTMLDivElement>,
    type: "left" | "right" | "middle"
  ) => void;
}

export const TimelineZoomSlider: React.FC<TimelineZoomSliderProps> = ({
  sliderRef,
  timelineWindowStart,
  timelineWindowWidth,
  onSliderMouseDown,
}) => {
  return (
    <div
      ref={sliderRef}
      className="h-8 bg-[#0f0f0f] rounded-lg relative border border-white/10 px-2 flex items-center gap-2 mt-2"
    >
      <span className="text-xs text-gray-500 min-w-[40px]">Zoom:</span>
      <div className="flex-1 relative h-2 bg-white/10 rounded-lg">
        <div
          className="absolute top-0 h-full bg-blue-500/30 rounded-lg cursor-move"
          style={{
            left: `${timelineWindowStart}%`,
            width: `${timelineWindowWidth}%`,
          }}
          onMouseDown={(event) => onSliderMouseDown(event, "middle")}
        >
          <div
            className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-blue-500 rounded-full cursor-ew-resize hover:bg-blue-400 transition-colors z-10"
            onMouseDown={(event) => onSliderMouseDown(event, "left")}
          />
          <div
            className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-4 h-4 bg-blue-500 rounded-full cursor-ew-resize hover:bg-blue-400 transition-colors z-10"
            onMouseDown={(event) => onSliderMouseDown(event, "right")}
          />
        </div>
      </div>
      <span className="text-xs text-gray-500 min-w-[45px] text-right">
        {Math.round(timelineWindowWidth)}%
      </span>
    </div>
  );
};


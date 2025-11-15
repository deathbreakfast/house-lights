import React from "react";

interface TimelinePlayheadProps {
  positionPercent: number;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
}

export const TimelinePlayhead: React.FC<TimelinePlayheadProps> = ({
  positionPercent,
  onMouseDown,
}) => {
  return (
    <div
      className="absolute top-0 bottom-0 z-20"
      style={{ left: `${positionPercent}%` }}
    >
      <div
        className="relative -translate-x-1/2 h-full pointer-events-auto cursor-ew-resize flex items-stretch"
        onMouseDown={onMouseDown}
      >
        <div className="w-6 h-full flex items-stretch justify-center">
          <div className="w-0.5 h-full bg-white shadow-md" />
        </div>
      </div>
    </div>
  );
};


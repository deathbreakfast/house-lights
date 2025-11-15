import React, { useMemo } from "react";

const TARGET_TIME_MARKERS = 8;
const MAX_FRAME_MARKERS = 200;
const NICE_STEPS_MS = [
  50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000,
  300000, 600000,
];

interface TimelineRulerProps {
  timelineWindowStart: number;
  timelineWindowWidth: number;
  framerate: number;
  totalDuration: number;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMouseUp: () => void;
  onMouseMove: (event: React.MouseEvent<HTMLDivElement>) => void;
}

const formatTimeLabel = (timeMs: number) => {
  if (timeMs >= 60000) {
    const minutes = Math.floor(timeMs / 60000);
    const seconds = Math.floor((timeMs % 60000) / 1000)
      .toString()
      .padStart(2, "0");
    return `${minutes}:${seconds}`;
  }
  if (timeMs >= 1000) {
    return `${(timeMs / 1000).toFixed(1)}s`;
  }
  return `${timeMs}ms`;
};

const pickTimeStep = (visibleDuration: number) => {
  const desired = visibleDuration / TARGET_TIME_MARKERS;
  for (const step of NICE_STEPS_MS) {
    if (step >= desired) {
      return step;
    }
  }
  return NICE_STEPS_MS[NICE_STEPS_MS.length - 1];
};

export const TimelineRuler: React.FC<TimelineRulerProps> = ({
  timelineWindowStart,
  timelineWindowWidth,
  framerate,
  totalDuration,
  onClick,
  onMouseDown,
  onMouseUp,
  onMouseMove,
}) => {
  const { timeMarkers, frameMarkers } = useMemo(() => {
    const visibleStart = (timelineWindowStart / 100) * totalDuration;
    const visibleEnd = visibleStart + (timelineWindowWidth / 100) * totalDuration;
    const visibleDuration = Math.max(1, visibleEnd - visibleStart);

    const timeStep = pickTimeStep(visibleDuration);
    const startMarker = Math.floor(visibleStart / timeStep) * timeStep;
    const timeMarkerSet: Array<{ time: number; position: number; label: string }> = [];
    for (let time = startMarker; time <= visibleEnd; time += timeStep) {
      if (time >= visibleStart) {
        const position = ((time - visibleStart) / visibleDuration) * 100;
        timeMarkerSet.push({
          time,
          position,
          label: formatTimeLabel(time),
        });
      }
    }

    const frameDuration = 1000 / framerate;
    const frameCount = Math.ceil(visibleDuration / frameDuration);
    const skip = Math.max(1, Math.ceil(frameCount / MAX_FRAME_MARKERS));
    const frameStep = frameDuration * skip;
    const startFrame = Math.floor(visibleStart / frameStep) * frameStep;
    const frameMarkerSet: Array<{ time: number; position: number }> = [];
    for (let time = startFrame; time <= visibleEnd; time += frameStep) {
      if (time >= visibleStart) {
        const position = ((time - visibleStart) / visibleDuration) * 100;
        frameMarkerSet.push({ time, position });
      }
    }

    return { timeMarkers: timeMarkerSet, frameMarkers: frameMarkerSet };
  }, [timelineWindowStart, timelineWindowWidth, totalDuration, framerate]);

  return (
    <div
      className="relative h-6 mb-1 cursor-pointer"
      onClick={onClick}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseMove={onMouseMove}
    >
      {frameMarkers.map((marker, index) => (
        <div
          key={`frame-${index}`}
          className="absolute w-px h-1.5 bg-gray-700/50 pointer-events-none"
          style={{ left: `${marker.position}%`, transform: "translateX(-50%)" }}
        />
      ))}

      {timeMarkers.map((marker, index) => (
        <div
          key={index}
          className="absolute text-xs text-gray-500 pointer-events-none select-none"
          style={{ left: `${marker.position}%`, transform: "translateX(-50%)" }}
        >
          <div className="flex flex-col items-center pointer-events-none select-none">
            <div className="w-px h-2 bg-gray-600 pointer-events-none" />
            <span className="mt-0.5 pointer-events-none select-none">{marker.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
};


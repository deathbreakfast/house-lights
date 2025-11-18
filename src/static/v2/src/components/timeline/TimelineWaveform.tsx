import React from "react";

interface TimelineWaveformProps {
  hasAudio: boolean;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMouseUp: () => void;
  onMouseMove: (event: React.MouseEvent<HTMLDivElement>) => void;
  onTouchStart?: (event: React.TouchEvent<HTMLDivElement>) => void;
}

export const TimelineWaveform: React.FC<TimelineWaveformProps> = ({
  hasAudio,
  onClick,
  onMouseDown,
  onMouseUp,
  onMouseMove,
  onTouchStart,
}) => {
  return (
    <div
      className="h-32 bg-[#0f0f0f] rounded-b-lg relative overflow-hidden border border-white/10 border-t-0 cursor-pointer"
      style={{ touchAction: "none" }}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseMove={onMouseMove}
      onTouchStart={onTouchStart}
    >
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        {hasAudio ? (
          <div className="w-full h-full bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-pink-500/20 relative">
            <svg className="w-full h-full" preserveAspectRatio="none">
              <path
                d="M 0 64 Q 10 40, 20 64 T 40 64 T 60 64 T 80 64 T 100 64"
                stroke="rgba(59, 130, 246, 0.5)"
                strokeWidth="2"
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>
        ) : (
          <span className="text-gray-600 text-sm select-none">No audio loaded</span>
        )}
      </div>
    </div>
  );
};


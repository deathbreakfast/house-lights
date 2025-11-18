import React, { RefObject, useMemo } from "react";
import { motion } from "framer-motion";
import { Play, Pause, Plus, Upload } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { TimelineRuler } from "./TimelineRuler";
import { TimelineKeyframes } from "./TimelineKeyframes";
import { TimelineWaveform } from "./TimelineWaveform";
import { TimelinePlayhead } from "./TimelinePlayhead";
import { TimelineZoomSlider } from "./TimelineZoomSlider";
import type { Keyframe } from "../../types/editor";
import { FRAMERATE_OPTIONS } from "../../constants/editor";

interface TimelineContainerProps {
  audioInputRef: RefObject<HTMLInputElement>;
  timelineRef: RefObject<HTMLDivElement>;
  sliderRef: RefObject<HTMLDivElement>;
  isPlaying: boolean;
  framerate: number;
  totalDuration: number;
  timelinePosition: number;
  timelineWindowStart: number;
  timelineWindowWidth: number;
  isDraggingTimeline: boolean;
  keyframes: Keyframe[];
  selectedKeyframeId: string | null;
  hasAudio: boolean;
  onPlayPause: () => void;
  onAddKeyframe: () => void;
  onExtendDuration: () => void;
  onFramerateChange: (framerate: number) => void;
  onTimelineClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onTimelineMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onTimelineMouseUp: () => void;
  onTimelineDrag: (event: React.MouseEvent<HTMLDivElement>) => void;
  onPlayheadMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSliderMouseDown: (
    event: React.MouseEvent<HTMLDivElement>,
    type: "left" | "right" | "middle"
  ) => void;
  onKeyframeSelect?: (keyframe: Keyframe) => void;
  onKeyframeDragStart?: (keyframeId: string, event: React.MouseEvent) => void;
  onKeyframeDrag?: (event: React.MouseEvent) => void;
  onKeyframeDragEnd?: () => void;
  isDraggingKeyframe?: boolean;
}

export const TimelineContainer: React.FC<TimelineContainerProps> = ({
  audioInputRef,
  timelineRef,
  sliderRef,
  isPlaying,
  framerate,
  totalDuration,
  timelinePosition,
  timelineWindowStart,
  timelineWindowWidth,
  isDraggingTimeline,
    keyframes,
    selectedKeyframeId,
    hasAudio,
  onPlayPause,
  onAddKeyframe,
  onExtendDuration,
  onFramerateChange,
  onTimelineClick,
  onTimelineMouseDown,
  onTimelineMouseUp,
  onTimelineDrag,
  onPlayheadMouseDown,
  onSliderMouseDown,
  onKeyframeSelect,
  onKeyframeDragStart,
  onKeyframeDrag,
  onKeyframeDragEnd,
  isDraggingKeyframe = false,
}) => {
  const playheadPercent = useMemo(() => {
    const visibleStart = (timelineWindowStart / 100) * totalDuration;
    const visibleEnd =
      visibleStart + (timelineWindowWidth / 100) * totalDuration;
    const visibleDuration = visibleEnd - visibleStart;
    if (visibleDuration <= 0) {
      return 0;
    }
    const clamped = Math.max(
      visibleStart,
      Math.min(timelinePosition, visibleEnd)
    );
    return ((clamped - visibleStart) / visibleDuration) * 100;
  }, [timelinePosition, timelineWindowStart, timelineWindowWidth]);

  return (
    <div className="flex-none w-full h-72 border-t border-white/20 bg-[#1a1a1a] p-4 flex gap-3">
      <div className="flex flex-col gap-2">
        <Tooltip
          text={isPlaying ? "Pause (space)" : "Play (space)"}
          position="right"
        >
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={onPlayPause}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-all"
          >
            {isPlaying ? (
              <Pause size={18} className="text-white" />
            ) : (
              <Play size={18} className="text-white" />
            )}
          </motion.button>
        </Tooltip>

        <Tooltip text="Add Keyframe" position="right">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={onAddKeyframe}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-all"
          >
            <Plus size={18} className="text-white" />
          </motion.button>
        </Tooltip>

        <Tooltip text="Framerate" position="right">
          <select
            value={framerate}
            onChange={(event) => onFramerateChange(Number(event.target.value))}
            className="px-2 py-1.5 rounded-lg bg-white/10 border border-white/20 text-white text-xs [&>option]:bg-[#1a1a1a] [&>option]:text-white cursor-pointer hover:bg-white/20 transition-all"
          >
            {FRAMERATE_OPTIONS.map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
        </Tooltip>

        <Tooltip text="Extend timeline (+10s)" position="right">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={onExtendDuration}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-all text-xs text-white"
          >
            +10s
          </motion.button>
        </Tooltip>

        <div className="flex-1" />

        <Tooltip text="Upload Audio" position="right">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => audioInputRef.current?.click()}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-all"
          >
            <Upload size={18} className="text-white" />
          </motion.button>
        </Tooltip>
      </div>

      <div className="flex-1 flex flex-col gap-0">
        <div className="relative flex flex-col gap-0">
          <TimelineRuler
            timelineWindowStart={timelineWindowStart}
            timelineWindowWidth={timelineWindowWidth}
            framerate={framerate}
            totalDuration={totalDuration}
            onClick={onTimelineClick}
            onMouseDown={onTimelineMouseDown}
            onMouseUp={onTimelineMouseUp}
            onMouseMove={onTimelineDrag}
          />

          <div
            ref={timelineRef}
            className="h-12 relative bg-[#0f0f0f] rounded-t-lg overflow-hidden border border-white/10 border-b-0"
            style={{ cursor: isDraggingKeyframe ? "grabbing" : "crosshair" }}
            onClick={onTimelineClick}
            onMouseDown={onTimelineMouseDown}
            onMouseUp={onTimelineMouseUp}
            onMouseMove={onTimelineDrag}
          >
            <TimelineKeyframes
              keyframes={keyframes}
              timelineWindowStart={timelineWindowStart}
              timelineWindowWidth={timelineWindowWidth}
              timelinePosition={timelinePosition}
              totalDuration={totalDuration}
              selectedKeyframeId={selectedKeyframeId}
              onKeyframeClick={onKeyframeSelect}
              onKeyframeDragStart={onKeyframeDragStart}
              onKeyframeDrag={onKeyframeDrag}
              onKeyframeDragEnd={onKeyframeDragEnd}
              isDraggingKeyframe={isDraggingKeyframe}
            />
          </div>

          <TimelineWaveform
            hasAudio={hasAudio}
            onClick={onTimelineClick}
            onMouseDown={onTimelineMouseDown}
            onMouseUp={onTimelineMouseUp}
            onMouseMove={onTimelineDrag}
          />

          <TimelinePlayhead
            positionPercent={playheadPercent}
            onMouseDown={onPlayheadMouseDown}
          />
        </div>

        <TimelineZoomSlider
          sliderRef={sliderRef}
          timelineWindowStart={timelineWindowStart}
          timelineWindowWidth={timelineWindowWidth}
          onSliderMouseDown={onSliderMouseDown}
        />
      </div>
    </div>
  );
};


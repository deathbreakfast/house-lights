import {
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DEFAULT_TOTAL_DURATION, MIN_WINDOW_PERCENT } from "../constants/editor";

type SliderDragType = "left" | "right" | "middle" | null;

type UseTimelinePlayerOptions = {
  audioRef?: RefObject<HTMLAudioElement>;
  timelineRef?: RefObject<HTMLDivElement>;
  duration?: number;
  initialFramerate?: number;
  playbackWindow?: {
    start?: number;
    end?: number;
  };
};

export const useTimelinePlayer = ({
  audioRef,
  timelineRef,
  duration = DEFAULT_TOTAL_DURATION,
  initialFramerate = 24,
  playbackWindow,
}: UseTimelinePlayerOptions = {}) => {
  const [timelinePosition, setTimelinePosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [framerate, setFramerate] = useState(initialFramerate);
  const [timelineWindowStart, setTimelineWindowStart] = useState(0);
  const [timelineWindowWidth, setTimelineWindowWidth] = useState(50);
  const [isDraggingTimeline, _setIsDraggingTimeline] = useState(false);
  const [isDraggingSlider, setIsDraggingSlider] =
    useState<SliderDragType>(null);

  const frameDurationRef = useRef(1000 / framerate);
  const rafRef = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const isPlayingRef = useRef(false);
  const audioElement = audioRef?.current ?? null;

  useEffect(() => {
    frameDurationRef.current = 1000 / framerate;
  }, [framerate]);

  const setIsDraggingTimeline = useCallback((value: boolean) => {
    scrubbingRef.current = value;
    _setIsDraggingTimeline(value);
  }, []);

  const pausePlayback = useCallback(() => {
    setIsPlaying(false);
    const audio = audioRef?.current;
    if (audio && !audio.paused) {
      audio.pause();
    }
  }, [audioRef]);

  const playPlayback = useCallback(() => {
    setIsPlaying(true);
    const audio = audioRef?.current;
    if (audio) {
      void audio.play().catch((error) => {
        console.warn("Audio play error:", error);
      });
    }
  }, [audioRef]);

  const togglePlayback = useCallback(() => {
    setIsPlaying((prev) => {
      const next = !prev;
      if (next) {
        const audio = audioRef?.current;
        if (audio) {
          void audio.play().catch((error) => {
            console.warn("Audio play error:", error);
          });
        }
      } else {
        const audio = audioRef?.current;
        if (audio && !audio.paused) {
          audio.pause();
        }
      }
      return next;
    });
  }, [audioRef]);

  // Keep audio element in sync when scrubbing/stopped
  useEffect(() => {
    const audio = audioElement;
    if (!audio) return;
    if (audio.paused || scrubbingRef.current) {
      const targetTime = timelinePosition / 1000;
      if (Math.abs(audio.currentTime - targetTime) > 0.01) {
        audio.currentTime = targetTime;
      }
    }
  }, [timelinePosition, audioElement]);

  // Listen for audio progress if available
  useEffect(() => {
    const audio = audioElement;
    if (!audio) return;

    const handleTimeUpdate = () => {
      if (scrubbingRef.current) return;
      setTimelinePosition(Math.min(duration, audio.currentTime * 1000));
    };

    const handleEnded = () => {
      setIsPlaying(false);
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [audioElement, duration]);

  // requestAnimationFrame fallback when no audio is playing
  const normalizedWindow = useMemo(() => {
    const rawStart = playbackWindow?.start ?? 0;
    const rawEnd =
      playbackWindow?.end !== undefined ? playbackWindow.end : duration;
    const start = Math.max(0, Math.min(duration, rawStart));
    const end = Math.max(start, Math.min(duration, rawEnd));
    const loop = playbackWindow !== undefined;
    return {
      start,
      end,
      loop,
    };
  }, [duration, playbackWindow]);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const audio = audioElement;
    let lastTimestamp: number | null = null;
    isPlayingRef.current = true;

    const tick = (timestamp: number) => {
      if (!isPlayingRef.current) {
        return;
      }

      if (audio && !audio.paused) {
        setTimelinePosition(Math.min(duration, audio.currentTime * 1000));
      } else {
        if (lastTimestamp === null) {
          lastTimestamp = timestamp;
        }
        const delta = timestamp - lastTimestamp;
        if (delta >= frameDurationRef.current) {
          lastTimestamp = timestamp;
          setTimelinePosition((prev) => {
            const frameStep = frameDurationRef.current;
            const next = prev + frameStep;
            if (normalizedWindow.loop) {
              if (prev >= normalizedWindow.end) {
                return normalizedWindow.start;
              }
              if (next >= normalizedWindow.end) {
                return normalizedWindow.end;
              }
              if (next < normalizedWindow.start) {
                return normalizedWindow.start;
              }
              return next;
            }
            if (next >= duration) {
              pausePlayback();
              return duration;
            }
            return Math.min(duration, next);
          });
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      isPlayingRef.current = false;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [audioElement, duration, isPlaying, pausePlayback, normalizedWindow]);

  const snapToFrame = useCallback(
    (position: number) => {
      const frameDuration = 1000 / framerate;
      return Math.round(position / frameDuration) * frameDuration;
    },
    [framerate]
  );

  const getTimelinePositionFromPointer = useCallback(
    (clientX: number) => {
      const timeline = timelineRef?.current;
      if (!timeline) return null;
      const rect = timeline.getBoundingClientRect();
      if (rect.width === 0) return null;
      const x = clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, x / rect.width));
      const visibleStart = (timelineWindowStart / 100) * duration;
      const visibleEnd =
        visibleStart + (timelineWindowWidth / 100) * duration;
      const visibleDuration = Math.max(0, visibleEnd - visibleStart);
      return visibleStart + percentage * visibleDuration;
    },
    [timelineRef, timelineWindowStart, timelineWindowWidth, duration]
  );

  const setTimelineFromPointer = useCallback(
    (clientX: number) => {
      const rawPosition = getTimelinePositionFromPointer(clientX);
      if (rawPosition === null) return null;
      const snapped = snapToFrame(rawPosition);
      setTimelinePosition(Math.max(0, Math.min(snapped, duration)));
      return snapped;
    },
    [duration, getTimelinePositionFromPointer, snapToFrame]
  );

  const sliderHandlers = useMemo(
    () => ({
      beginDrag: (type: SliderDragType) => setIsDraggingSlider(type),
      endDrag: () => setIsDraggingSlider(null),
      onMouseMove: (clientX: number, sliderRect?: DOMRect) => {
        if (!isDraggingSlider || !sliderRect) return;
        const x = clientX - sliderRect.left;
        const percentage = Math.max(0, Math.min(100, (x / sliderRect.width) * 100));

        if (isDraggingSlider === "left") {
          const rightEdge = timelineWindowStart + timelineWindowWidth;
          const clampedStart = Math.max(
            0,
            Math.min(percentage, rightEdge - MIN_WINDOW_PERCENT)
          );
          const newWidth = Math.max(MIN_WINDOW_PERCENT, rightEdge - clampedStart);
          setTimelineWindowStart(clampedStart);
          setTimelineWindowWidth(newWidth);
        } else if (isDraggingSlider === "right") {
          const newWidth = Math.max(
            MIN_WINDOW_PERCENT,
            Math.min(100 - timelineWindowStart, percentage - timelineWindowStart)
          );
          setTimelineWindowWidth(newWidth);
        } else if (isDraggingSlider === "middle") {
          const newStart = Math.max(
            0,
            Math.min(100 - timelineWindowWidth, percentage - timelineWindowWidth / 2)
          );
          setTimelineWindowStart(newStart);
        }
      },
    }),
    [isDraggingSlider, timelineWindowStart, timelineWindowWidth]
  );

  return {
    timelinePosition,
    setTimelinePosition,
    isPlaying,
    playPlayback,
    pausePlayback,
    togglePlayback,
    framerate,
    setFramerate,
    timelineWindowStart,
    setTimelineWindowStart,
    timelineWindowWidth,
    setTimelineWindowWidth,
    isDraggingTimeline,
    setIsDraggingTimeline,
    sliderHandlers,
    isDraggingSlider,
    snapToFrame,
    getTimelinePositionFromPointer,
    setTimelineFromPointer,
  };
};



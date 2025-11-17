import type React from "react";
import type { Keyframe, Scene, Device } from "../types/editor";

export type LedState = {
  color: string;
  opacity: number;
};

export type LedStateMap = Record<string, LedState>;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const hexToRgb = (hex: string) => {
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const value = normalized.length === 6 ? normalized : "ffffff";
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
};

const rgbToHex = ({ r, g, b }: { r: number; g: number; b: number }) => {
  const toHex = (component: number) =>
    component.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

export const cloneLedStateMap = (input: LedStateMap): LedStateMap =>
  Object.entries(input).reduce<LedStateMap>((acc, [ledId, state]) => {
    acc[ledId] = { ...state };
    return acc;
  }, {});

const applyKeyframeToState = (
  state: LedStateMap,
  keyframe: Keyframe
): LedStateMap => {
  const next = cloneLedStateMap(state);
  Object.entries(keyframe.ledStates).forEach(([ledId, ledState]) => {
    next[ledId] = {
      color: ledState.color,
      opacity: ledState.opacity,
    };
  });
  return next;
};

export const buildSceneLedState = (devices: Device[]): LedStateMap => {
  const state: LedStateMap = {};
  devices.forEach((device) => {
    device.strips.forEach((strip) => {
      strip.leds.forEach((led) => {
        state[led.id] = {
          color: led.color,
          opacity: led.opacity,
        };
      });
    });
  });
  return state;
};

export const sortKeyframes = (keyframes: Keyframe[]): Keyframe[] =>
  [...keyframes].sort((a, b) => a.timestamp - b.timestamp);

/**
 * Finds a keyframe at a given click position (clientX) within a threshold distance.
 * @param clientX - The x coordinate of the click in client space
 * @param timelineRef - Reference to the timeline DOM element
 * @param keyframes - Array of keyframes to search
 * @param timelineWindowStart - Start position of visible timeline window (percentage)
 * @param timelineWindowWidth - Width of visible timeline window (percentage)
 * @param totalDuration - Total duration of the timeline in milliseconds
 * @param threshold - Distance threshold in pixels (default: 10)
 * @returns The keyframe if found within threshold, null otherwise
 */
export const findKeyframeAtPosition = (
  clientX: number,
  timelineRef: React.RefObject<HTMLDivElement>,
  keyframes: Keyframe[],
  timelineWindowStart: number,
  timelineWindowWidth: number,
  totalDuration: number,
  threshold: number = 10
): Keyframe | null => {
  const timeline = timelineRef.current;
  if (!timeline) return null;
  
  const rect = timeline.getBoundingClientRect();
  const x = clientX - rect.left;
  const percentage = Math.max(0, Math.min(1, x / rect.width));
  
  const visibleStart = (timelineWindowStart / 100) * totalDuration;
  const visibleEnd = visibleStart + (timelineWindowWidth / 100) * totalDuration;
  const visibleDuration = visibleEnd - visibleStart;
  const clickedTimestamp = visibleStart + percentage * visibleDuration;
  
  return keyframes.find((kf) => {
    const kfX = ((kf.timestamp - visibleStart) / visibleDuration) * rect.width;
    const clickedX = ((clickedTimestamp - visibleStart) / visibleDuration) * rect.width;
    return Math.abs(kfX - clickedX) < threshold;
  }) || null;
};

const KEYFRAME_TIMESTAMP_TOLERANCE_MS = 1;

const normalizeKeyframeTimestamp = (timestamp: number): number =>
  Math.round(timestamp / KEYFRAME_TIMESTAMP_TOLERANCE_MS) *
  KEYFRAME_TIMESTAMP_TOLERANCE_MS;

export const dedupeKeyframesByTimestamp = (
  keyframes: Keyframe[]
): Keyframe[] => {
  const byTimestamp = new Map<number, Keyframe>();
  keyframes.forEach((keyframe) => {
    const normalized = normalizeKeyframeTimestamp(keyframe.timestamp);
    const existing = byTimestamp.get(normalized);
    if (!existing || keyframe.timestamp >= existing.timestamp) {
      byTimestamp.set(normalized, keyframe);
    }
  });
  return sortKeyframes(Array.from(byTimestamp.values()));
};

type PreparedKeyframe = {
  keyframe: Keyframe;
  beforeState: LedStateMap;
  afterState: LedStateMap;
};

const prepareKeyframeStates = (
  keyframes: Keyframe[],
  baseState: LedStateMap
): PreparedKeyframe[] => {
  const sorted = sortKeyframes(keyframes);
  let workingState = cloneLedStateMap(baseState);
  return sorted.map((keyframe) => {
    const before = cloneLedStateMap(workingState);
    const after = applyKeyframeToState(before, keyframe);
    workingState = after;
    return {
      keyframe,
      beforeState: before,
      afterState: after,
    };
  });
};

const blendLedStates = (
  from: LedState,
  to: LedState,
  progress: number
): LedState => {
  const clamped = clamp01(progress);
  const fromRgb = hexToRgb(from.color);
  const toRgb = hexToRgb(to.color);
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * clamped);
  return {
    color: rgbToHex({
      r: lerp(fromRgb.r, toRgb.r),
      g: lerp(fromRgb.g, toRgb.g),
      b: lerp(fromRgb.b, toRgb.b),
    }),
    opacity: from.opacity + (to.opacity - from.opacity) * clamped,
  };
};

const blendStateMaps = (
  from: LedStateMap,
  to: LedStateMap,
  progress: number
): LedStateMap => {
  const next = cloneLedStateMap(from);
  const ids = new Set([...Object.keys(from), ...Object.keys(to)]);
  ids.forEach((ledId) => {
    const fromState = from[ledId] ?? { color: "#000000", opacity: 0 };
    const toState = to[ledId] ?? fromState;
    if (
      fromState.color === toState.color &&
      fromState.opacity === toState.opacity
    ) {
      next[ledId] = { ...toState };
    } else {
      next[ledId] = blendLedStates(fromState, toState, progress);
    }
  });
  return next;
};

export const getFrameLedState = ({
  keyframes,
  timelinePosition,
  baseState,
}: {
  keyframes: Keyframe[];
  timelinePosition: number;
  baseState: LedStateMap;
}): LedStateMap => {
  if (keyframes.length === 0) {
    return cloneLedStateMap(baseState);
  }

  const prepared = prepareKeyframeStates(keyframes, baseState);
  const previousIndex = prepared
    .map(({ keyframe }, index) => ({ keyframe, index }))
    .filter(({ keyframe }) => keyframe.timestamp <= timelinePosition)
    .map(({ index }) => index)
    .pop();

  const nextIndex = prepared.findIndex(
    ({ keyframe }) => keyframe.timestamp > timelinePosition
  );

  let resultState =
    previousIndex !== undefined
      ? cloneLedStateMap(prepared[previousIndex].afterState)
      : cloneLedStateMap(baseState);

  if (nextIndex !== -1) {
    const nextEntry = prepared[nextIndex];
    const fadeIn =
      nextEntry.keyframe.effects?.fadeIn && nextEntry.keyframe.effects.fadeIn > 0
        ? nextEntry.keyframe.effects.fadeIn
        : 0;
    if (fadeIn > 0) {
      const fadeStart = nextEntry.keyframe.timestamp - fadeIn;
      if (
        timelinePosition >= fadeStart &&
        timelinePosition < nextEntry.keyframe.timestamp
      ) {
        const progress =
          (timelinePosition - fadeStart) / Math.max(fadeIn, 1);
        return blendStateMaps(
          nextEntry.beforeState,
          nextEntry.afterState,
          progress
        );
      }
    }
  }

  if (previousIndex !== undefined) {
    const prevEntry = prepared[previousIndex];
    const fadeOut =
      prevEntry.keyframe.effects?.fadeOut &&
      prevEntry.keyframe.effects.fadeOut > 0
        ? prevEntry.keyframe.effects.fadeOut
        : 0;
    if (fadeOut > 0) {
      const fadeEnd = prevEntry.keyframe.timestamp + fadeOut;
      if (
        timelinePosition > prevEntry.keyframe.timestamp &&
        timelinePosition <= fadeEnd
      ) {
        const targetState =
          previousIndex > 0
            ? prepared[previousIndex - 1].afterState
            : cloneLedStateMap(baseState);
        const progress =
          (timelinePosition - prevEntry.keyframe.timestamp) /
          Math.max(fadeOut, 1);
        resultState = blendStateMaps(
          prevEntry.afterState,
          targetState,
          progress
        );
      }
    }
  }

  return resultState;
};


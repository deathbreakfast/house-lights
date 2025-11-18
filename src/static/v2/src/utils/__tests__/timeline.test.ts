import { describe, expect, it } from "vitest";
import type { Keyframe, Scene } from "../../types/editor";
import {
  buildSceneLedState,
  getFrameLedState,
  sortKeyframes,
} from "../timeline";

const createScene = (color = "#000000", opacity = 1): Scene => ({
  id: "scene-1",
  name: "Test Scene",
  devices: [
    {
      id: "device-1",
      position: { x: 0, y: 0 },
      ipAddress: "127.0.0.1",
      type: "wifi",
      stripMode: "auto",
      strips: [
        {
          id: "strip-1",
          gpioPin: 18,
          ledCount: 1,
          leds: [
            {
              id: "led-1",
              position: { x: 0, y: 0 },
              color,
              opacity,
            },
          ],
        },
      ],
    },
  ],
  keyframes: [],
});

describe("timeline utilities", () => {
  it("returns base LED state when no keyframes are present", () => {
    const scene = createScene("#123456", 0.8);
    const baseState = buildSceneLedState(scene);
    const result = getFrameLedState({
      keyframes: [],
      timelinePosition: 500,
      baseState,
    });
    expect(result["led-1"]).toEqual({
      color: "#123456",
      opacity: 0.8,
    });
  });

  it("blends colors during fade in before a keyframe", () => {
    const scene = createScene("#000000", 0);
    const baseState = buildSceneLedState(scene);
    const keyframes: Keyframe[] = [
      {
        id: "kf-1",
        timestamp: 2000,
        effects: { fadeIn: 1000 },
        ledStates: {
          "led-1": {
            color: "#ffffff",
            opacity: 1,
          },
        },
      },
    ];
    const result = getFrameLedState({
      keyframes,
      timelinePosition: 1500,
      baseState,
    });
    expect(result["led-1"]).toEqual({
      color: "#808080",
      opacity: 0.5,
    });
  });

  it("blends colors during fade out after a keyframe", () => {
    const scene = createScene("#000000", 0);
    const baseState = buildSceneLedState(scene);
    const keyframes: Keyframe[] = [
      {
        id: "kf-1",
        timestamp: 0,
        effects: { fadeOut: 1000 },
        ledStates: {
          "led-1": {
            color: "#ffffff",
            opacity: 1,
          },
        },
      },
    ];
    const result = getFrameLedState({
      keyframes,
      timelinePosition: 500,
      baseState,
    });
    expect(result["led-1"]).toEqual({
      color: "#808080",
      opacity: 0.5,
    });
  });

  it("sorts keyframes by timestamp", () => {
    const unordered: Keyframe[] = [
      { id: "b", timestamp: 200, effects: {}, ledStates: {} },
      { id: "a", timestamp: 100, effects: {}, ledStates: {} },
      { id: "c", timestamp: 300, effects: {}, ledStates: {} },
    ];
    const sorted = sortKeyframes(unordered);
    expect(sorted.map((kf) => kf.id)).toEqual(["a", "b", "c"]);
  });
});
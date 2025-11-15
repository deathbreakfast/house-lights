import type { Scene } from "../types/editor";

export const DEFAULT_TOTAL_DURATION = 10000;

export const DEFAULT_SCENE: Scene = {
  id: "default",
  name: "New Scene",
  devices: [
    {
      id: "device-local-default",
      position: { x: 400, y: 300 },
      ipAddress: "127.0.0.1",
      strips: [],
      type: "local",
      stripMode: "auto",
    },
  ],
  keyframes: [],
  durationMs: DEFAULT_TOTAL_DURATION,
};

export const MIN_WINDOW_PERCENT = 5;

export const FRAMERATE_OPTIONS = [4, 8, 16, 24, 30, 60];


export type Point = {
  x: number;
  y: number;
};

export type LED = {
  id: string;
  position: Point;
  color: string;
  opacity: number;
};

export type LEDStrip = {
  id: string;
  gpioPin: number;
  ledCount: number;
  leds: LED[];
};

export type DeviceHealth = {
  online?: boolean;
  lastSeenAt?: string | null;
  latencyMs?: number | null;
  clockSkewMs?: number | null;
  wsConnected?: boolean;
  playlistHash?: string | null;
  metadata?: Record<string, unknown>;
};

export type DeviceConnectionState = "idle" | "connecting" | "online" | "error";

export type Device = {
  id: string;
  position: Point;
  ipAddress: string;
  strips: LEDStrip[];
  type: "wifi"; // Device type is simplified - local devices are identified by IP (127.0.0.1/localhost)
  stripMode: "auto" | "manual"; // Auto uses env variables, manual is user-configured
  connectionState?: DeviceConnectionState;
  connectionError?: string | null;
  health?: DeviceHealth | null;
};

export type Keyframe = {
  id: string;
  timestamp: number;
  effects: {
    fadeIn?: number;
    fadeOut?: number;
  };
  ledStates: Record<
    string,
    {
      color: string;
      opacity: number;
    }
  >;
};

export type Scene = {
  id: string;
  name: string;
  keyframes: Keyframe[];
  audioUrl?: string;
  audioFileName?: string;
  durationMs?: number;
  framerate?: number; // Frames per second for timeline playback
};

export type Tool =
  | "pan"
  | "zoom"
  | "zoom-in"
  | "zoom-out"
  | "select"
  | "group-select"
  | "add-device"
  | "paint"
  | "bucket"
  | "color-picker"
  | "eyedropper"
  | "move";

export type EditorMode = "view" | "edit" | "paint";

export type TooltipPosition = "top" | "right" | "bottom-left" | "bottom";

export type ScenePlaylistEntry = {
  id: string;
  sceneId: string;
  position: number;
  playDurationSeconds: number;
  fadeDurationSeconds: number;
};


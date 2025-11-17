/** Device utility functions for the LED Scene Editor. */

import type {
  Device,
  DeviceConnectionState,
  DeviceHealth,
  Point,
} from "../types/editor";

export type SceneDeviceResponse = {
  id: string;
  position: Point;
  ipAddress: string;
  type: Device["type"];
  stripMode: Device["stripMode"];
  strips: Device["strips"];
  health?: DeviceHealth | null;
};

/**
 * Derive device connection state from API response and existing device state.
 */
export const deriveConnectionState = (
  response: SceneDeviceResponse,
  existing?: Device
): { state: DeviceConnectionState; error: string | null } => {
  const isWifi = (existing?.type ?? response.type) === "wifi";
  const online = response.health?.online;

  if (isWifi) {
    if (existing?.connectionState === "connecting" && online !== true) {
      return {
        state: "connecting",
        error: existing.connectionError ?? null,
      };
    }
    if (online === true) {
      return { state: "online", error: null };
    }
    if (online === false) {
      return {
        state: "error",
        error: existing?.connectionError ?? "Device is offline",
      };
    }
    return {
      state: existing?.connectionState ?? "idle",
      error: existing?.connectionError ?? null,
    };
  }

  if (online === true) {
    return { state: "online", error: null };
  }
  return {
    state: existing?.connectionState ?? "idle",
    error: existing?.connectionError ?? null,
  };
};

/**
 * Merge device data from API response with existing device state.
 */
export const mergeDeviceFromResponse = (
  response: SceneDeviceResponse,
  existing?: Device
): Device => {
  const { state, error } = deriveConnectionState(response, existing);
  return {
    id: response.id,
    position: response.position ?? existing?.position ?? { x: 400, y: 300 },
    ipAddress: response.ipAddress ?? existing?.ipAddress ?? "",
    strips: response.strips ?? existing?.strips ?? [],
    type: response.type ?? existing?.type ?? "wifi",
    stripMode: response.stripMode ?? existing?.stripMode ?? "auto",
    connectionState: state,
    connectionError: error,
    health: response.health ?? existing?.health ?? null,
  };
};

/**
 * Generate a unique client ID with optional prefix.
 */
export const createClientId = (prefix: string): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};


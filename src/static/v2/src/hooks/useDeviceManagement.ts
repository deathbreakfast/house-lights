/** Hook for managing device and strip operations. */

import { useCallback } from "react";
import type { Device, LEDStrip, LED, Scene, Point } from "../types/editor";

type UseDeviceManagementOptions = {
  currentSceneId: string;
  devices: Device[];
  canvasRef: React.RefObject<HTMLCanvasElement>;
  backgroundImage: string | null;
  backgroundImageScale: number;
  canvasZoom: number;
  canvasPan: Point;
  setDevices: (devices: Device[]) => void;
  setSelectedDeviceId: (id: string | null) => void;
  setSelectedLEDId: (id: string | null) => void;
  fetchDevices: () => Promise<void>;
};

export const useDeviceManagement = ({
  currentSceneId,
  devices,
  canvasRef,
  backgroundImage,
  backgroundImageScale,
  canvasZoom,
  canvasPan,
  setDevices,
  setSelectedDeviceId,
  setSelectedLEDId,
  fetchDevices,
}: UseDeviceManagementOptions) => {
  const calculateDefaultDevicePosition = useCallback((): Promise<Point> => {
    return new Promise((resolve) => {
      if (backgroundImage) {
        const img = new Image();
        img.onload = () => {
          const displayWidth = img.naturalWidth * (backgroundImageScale / 100);
          const displayHeight = img.naturalHeight * (backgroundImageScale / 100);
          resolve({ x: displayWidth / 2, y: displayHeight / 2 });
        };
        img.onerror = () => {
          if (canvasRef.current) {
            const rect = canvasRef.current.getBoundingClientRect();
            resolve({
              x: (rect.width / 2 - canvasPan.x) / canvasZoom,
              y: (rect.height / 2 - canvasPan.y) / canvasZoom,
            });
          } else {
            resolve({ x: 400, y: 300 });
          }
        };
        img.src = backgroundImage;
      } else if (canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        resolve({
          x: (rect.width / 2 - canvasPan.x) / canvasZoom,
          y: (rect.height / 2 - canvasPan.y) / canvasZoom,
        });
      } else {
        resolve({ x: 400, y: 300 });
      }
    });
  }, [backgroundImage, backgroundImageScale, canvasZoom, canvasPan, canvasRef]);
  const handleAddDevice = useCallback(async () => {
    const newDevice: Device = {
      id: `device-${Date.now()}`,
      position: { x: 400, y: 300 },
      ipAddress: "192.168.1.100",
      strips: [],
      type: "wifi",
      stripMode: "auto",
      connectionState: "idle",
      connectionError: null,
      health: null,
    };

    setDevices([...devices, newDevice]);

    try {
      await fetch(`/api/v2/devices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(newDevice),
      });
      await fetchDevices();
    } catch (error) {
      console.error("Error saving new device:", error);
    }
  }, [devices, fetchDevices, setDevices]);

  const handleAddStrip = useCallback(
    async (deviceId: string, gpioPin: number, ledCount: number) => {
      const device = devices.find((d) => d.id === deviceId);
      if (!device) return;

      const leds: LED[] = Array.from({ length: ledCount }, (_, index) => ({
        id: `led-${deviceId}-${device.strips.length}-${index}`,
        position: {
          x: device.position.x + index * 20,
          y: device.position.y + 50,
        },
        color: "#ffffff",
        opacity: 1,
      }));
      const newStrip: LEDStrip = {
        id: `strip-${Date.now()}`,
        gpioPin,
        ledCount,
        leds,
      };

      const updatedDevice: Device = {
        ...device,
        strips: [...device.strips, newStrip],
      };

      setDevices(devices.map((d) =>
        d.id === deviceId ? updatedDevice : d
      ));

      try {
        const stripsPayload = updatedDevice.strips.map((s: LEDStrip) => ({
          id: s.id,
          gpioPin: s.gpioPin,
          ledCount: s.ledCount,
          leds: s.leds.map((led: LED) => ({
            id: led.id,
            position: led.position,
            color: led.color,
            opacity: led.opacity,
          })),
        }));

        const response = await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            strips: stripsPayload,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            "Error saving strip - response not OK:",
            response.status,
            errorText
          );
        }
      } catch (error) {
        console.error("Error saving strip:", error);
      }
    },
    [devices, setDevices]
  );

  const handleRemoveStrip = useCallback(
    async (deviceId: string, stripId: string) => {
      let updatedStrips: LEDStrip[] = [];

      setDevices(devices.map((device) => {
        if (device.id !== deviceId) {
          return device;
        }
        const updatedDevice = {
          ...device,
          strips: device.strips.filter((strip) => strip.id !== stripId),
        };
        updatedStrips = updatedDevice.strips;
        return updatedDevice;
      }));

      try {
        await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            strips: updatedStrips.map((s) => ({
              id: s.id,
              gpioPin: s.gpioPin,
              ledCount: s.ledCount,
              leds: s.leds.map((led) => ({
                id: led.id,
                position: led.position,
                color: led.color,
                opacity: led.opacity,
              })),
            })),
          }),
        });
      } catch (error) {
        console.error("Error saving strip removal:", error);
      }
    },
    [devices, setDevices]
  );

  const handleUpdateStrip = useCallback(
    async (
      deviceId: string,
      stripId: string,
      gpioPin: number,
      ledCount: number
    ) => {
      const device = devices.find((d) => d.id === deviceId);
      if (!device) return;

      let updatedStrips: LEDStrip[] = [];

      setDevices(devices.map((d) => {
        if (d.id !== deviceId) {
          return d;
        }
        const updatedDevice = {
          ...d,
          strips: d.strips.map((strip) => {
            if (strip.id !== stripId) {
              return strip;
            }
            const currentLedCount = strip.leds.length;
            let newLeds = [...strip.leds];

            if (ledCount > currentLedCount) {
              const additionalLeds: LED[] = Array.from(
                { length: ledCount - currentLedCount },
                (_, index) => ({
                  id: `led-${deviceId}-${stripId}-${currentLedCount + index}`,
                  position: {
                    x: d.position.x + (currentLedCount + index) * 20,
                    y: d.position.y + 50,
                  },
                  color: "#ffffff",
                  opacity: 1,
                })
              );
              newLeds = [...newLeds, ...additionalLeds];
            } else if (ledCount < currentLedCount) {
              newLeds = newLeds.slice(0, ledCount);
            }

            return {
              ...strip,
              gpioPin,
              ledCount,
              leds: newLeds,
            };
          }),
        };
        updatedStrips = updatedDevice.strips;
        return updatedDevice;
      }));

      try {
        await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            strips: updatedStrips.map((s) => ({
              id: s.id,
              gpioPin: s.gpioPin,
              ledCount: s.ledCount,
              leds: s.leds.map((led) => ({
                id: led.id,
                position: led.position,
                color: led.color,
                opacity: led.opacity,
              })),
            })),
          }),
        });
      } catch (error) {
        console.error("Error saving strip update:", error);
      }
    },
    [devices, setDevices]
  );

  const handleResetDevices = useCallback(async () => {
    if (
      !window.confirm(
        "Are you sure you want to reset all devices to default? This will delete all existing devices and create a default local device."
      )
    ) {
      return;
    }

    for (const device of devices) {
      try {
        await fetch(`/api/v2/devices/${device.id}`, {
          method: "DELETE",
        });
      } catch (error) {
        console.error(`Error deleting device ${device.id}:`, error);
      }
    }

    const position = await calculateDefaultDevicePosition();

    const defaultDevice: Device = {
      id: "device-local-default",
      position,
      ipAddress: "127.0.0.1",
      strips: [],
      type: "local",
      stripMode: "auto",
      connectionState: "online",
      connectionError: null,
      health: {
        online: true,
        lastSeenAt: null,
        latencyMs: null,
        clockSkewMs: null,
        wsConnected: false,
      },
    };

    setDevices([defaultDevice]);

    try {
      await fetch(`/api/v2/devices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(defaultDevice),
      });
      await fetchDevices();
    } catch (error) {
      console.error("Error saving default device:", error);
    }

    setSelectedDeviceId(null);
    setSelectedLEDId(null);
  }, [
    devices,
    calculateDefaultDevicePosition,
    setDevices,
    setSelectedDeviceId,
    setSelectedLEDId,
    fetchDevices,
  ]);

  const handleDeviceStripModeChange = useCallback(
    async (deviceId: string, mode: "auto" | "manual") => {
      setDevices(devices.map((device) =>
        device.id === deviceId ? { ...device, stripMode: mode } : device
      ));

      try {
        await fetch(`/api/v2/devices/${deviceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stripMode: mode }),
        });
        await fetchDevices();
      } catch (error) {
        console.error("Error saving device strip mode:", error);
      }
    },
    [devices, setDevices, fetchDevices]
  );

  return {
    handleAddDevice,
    handleAddStrip,
    handleRemoveStrip,
    handleUpdateStrip,
    handleResetDevices,
    handleDeviceStripModeChange,
  };
};


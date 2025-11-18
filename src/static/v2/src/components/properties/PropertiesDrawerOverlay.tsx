import React, { useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Trash2 } from "lucide-react";
import { useDrawer, useDrawerData } from "../../context/DrawerContext";
import { useSceneStore } from "../../state/sceneStore";
import { useGlobalStore } from "../../state/globalStore";
import type { Device, Keyframe, LEDStrip, LED } from "../../types/editor";

// Import the sub-components from PropertiesDrawer
import { StripRow, BackgroundImageScaleInput } from "./PropertiesDrawer";

export const PropertiesDrawerOverlay: React.FC = () => {
  const { isOpen, contentType, closeDrawer, pendingKeyframe } = useDrawer();
  const drawerData = useDrawerData();
  const drawerRef = useRef<HTMLDivElement | null>(null);

  // Get data from stores
  const {
    currentScene,
    selectedDeviceId,
    selectedLEDId,
    selectedKeyframeId,
    selectedBackgroundImage,
  } = useSceneStore();

  const { backgroundImageScale } = useGlobalStore();
  
  const {
    devices,
    timelinePosition,
    frameLedState,
    onColorChange,
    onOpacityChange,
    onKeyframeEffectsChange,
    onBackgroundImageScaleChange,
    onDeviceIpChange,
    onDeviceConnect,
    onDeviceStripModeChange,
    onAddStrip,
    onRemoveStrip,
    onUpdateStrip,
    onResetDevices,
    onDeleteKeyframe,
  } = drawerData;

  // Find device, LED, and keyframe based on contentType from context
  // Also check selectedDeviceId as fallback in case of timing issues
  const selectedDevice = useMemo(() => {
    const deviceId = contentType?.type === "device" ? contentType.deviceId : selectedDeviceId;
    if (deviceId) {
      const found = devices.find((device) => device.id === deviceId);
      if (found) {
        return found;
      }
    }
    return null;
  }, [devices, contentType, selectedDeviceId]);

  const selectedLED = useMemo(() => {
    const ledId = contentType?.type === "led" ? contentType.ledId : selectedLEDId;
    if (ledId) {
      for (const device of devices) {
        for (const strip of device.strips) {
          for (const led of strip.leds) {
            if (led.id === ledId) {
              return led;
            }
          }
        }
      }
    }
    return undefined;
  }, [devices, contentType, selectedLEDId]);

  const selectedKeyframe = useMemo(() => {
    const keyframeId = contentType?.type === "keyframe" ? contentType.keyframeId : selectedKeyframeId;
    if (keyframeId) {
      // First check if we have a pending keyframe (just created, not yet in state)
      if (pendingKeyframe && pendingKeyframe.id === keyframeId) {
        return pendingKeyframe;
      }
      // Otherwise look in the scene
      return currentScene.keyframes.find((keyframe) => keyframe.id === keyframeId) ?? null;
    }
    return null;
  }, [currentScene.keyframes, contentType, selectedKeyframeId, pendingKeyframe]);

  // Get selected color and opacity (use ledId from contentType if available)
  const ledIdForColor = contentType?.type === "led" ? contentType.ledId : selectedLEDId;
  const selectedColor = useMemo(
    () =>
      ledIdForColor
        ? frameLedState[ledIdForColor]?.color ?? selectedLED?.color ?? "#ffffff"
        : "#ffffff",
    [ledIdForColor, frameLedState, selectedLED]
  );

  const selectedOpacity = useMemo(
    () =>
      ledIdForColor
        ? frameLedState[ledIdForColor]?.opacity ?? selectedLED?.opacity ?? 1
        : 1,
    [ledIdForColor, frameLedState, selectedLED]
  );

  const handleOverlayClick = (event: React.MouseEvent) => {
    // Close if clicking on the overlay background (not the drawer panel)
    // The drawer panel has stopPropagation, so if we get here and the target is the overlay container or the background div, close it
    const target = event.target as HTMLElement;
    if (target === event.currentTarget || target.classList.contains("drawer-overlay-background")) {
      closeDrawer();
    }
  };
  
  const handleBackgroundClick = (event: React.MouseEvent) => {
    // Explicitly handle clicks on the background div
    event.stopPropagation();
    closeDrawer();
  };

  // Determine what content to show based on contentType from context
  const showDevice = contentType?.type === "device" && selectedDevice !== null;
  const showLED = contentType?.type === "led" && selectedLED !== undefined;
  const showKeyframe = contentType?.type === "keyframe" && selectedKeyframe !== null;
  const showBackgroundImage = contentType?.type === "background-image";

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex"
          onClick={handleOverlayClick}
        >
          {/* Transparent overlay - clicking here closes drawer */}
          <div className="flex-1 drawer-overlay-background" onClick={handleBackgroundClick} />
          
          {/* Drawer panel */}
          <motion.div
            ref={drawerRef}
            initial={{ x: 400 }}
            animate={{ x: 0 }}
            exit={{ x: 400 }}
            onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside drawer
            className="w-96 backdrop-blur-xl bg-white/10 border-l border-white/20 flex flex-col"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <h3 className="text-white text-lg font-semibold">Properties</h3>
              <button
                type="button"
                className="text-gray-400 hover:text-white transition-colors"
                onClick={closeDrawer}
                aria-label="Close properties panel"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {!showDevice && !showLED && !showKeyframe && !showBackgroundImage ? (
                <div className="text-gray-400 text-sm text-center py-8">
                  Select an element to view its properties
                </div>
              ) : null}
              
              {showDevice && selectedDevice ? (
                <div className="space-y-4">
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">
                      IP Address
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={selectedDevice.ipAddress}
                        onChange={(event) => {
                          const deviceId = contentType?.type === "device" ? contentType.deviceId : selectedDeviceId;
                          if (deviceId) {
                            onDeviceIpChange(deviceId, event.target.value);
                          }
                        }}
                        onBlur={() => {
                          const deviceId = contentType?.type === "device" ? contentType.deviceId : selectedDeviceId;
                          if (deviceId) {
                            onDeviceConnect(deviceId);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            const deviceId = contentType?.type === "device" ? contentType.deviceId : selectedDeviceId;
                            if (deviceId) {
                              onDeviceConnect(deviceId);
                              (event.target as HTMLInputElement).blur();
                            }
                          }
                        }}
                        placeholder="127.0.0.1, localhost, or 192.168.1.100"
                        className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/20 text-white"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const deviceId = contentType?.type === "device" ? contentType.deviceId : selectedDeviceId;
                          if (deviceId) {
                            onDeviceConnect(deviceId);
                          }
                        }}
                        disabled={selectedDevice.connectionState === "connecting"}
                        className="px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-white hover:bg-white/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {selectedDevice.connectionState === "connecting" ? (
                          <span className="flex items-center gap-2">
                            <span className="w-3 h-3 border-2 border-amber-200 border-t-transparent rounded-full animate-spin" />
                            Connecting
                          </span>
                        ) : (
                          "Connect"
                        )}
                      </button>
                    </div>
                    {selectedDevice.connectionState === "connecting" ? (
                      <p className="text-amber-300 text-sm mt-2 flex items-center gap-2">
                        <span className="w-3 h-3 border-2 border-amber-200 border-t-transparent rounded-full animate-spin" />
                        Attempting handshake…
                      </p>
                    ) : null}
                    {selectedDevice.connectionState === "online" ? (
                      <p className="text-green-400 text-sm mt-2">Device connected</p>
                    ) : null}
                    {selectedDevice.connectionState === "error" ? (
                      <p className="text-red-400 text-sm mt-2">
                        {selectedDevice.connectionError ?? "Unable to reach device."}
                      </p>
                    ) : null}
                  </div>
                  {selectedDevice.health ? (
                    <div className="mt-3 p-3 rounded-lg bg-white/5 border border-white/10 text-sm text-gray-300 space-y-1">
                      <div className="flex justify-between">
                        <span>Status</span>
                        <span
                          className={
                            selectedDevice.health.online ? "text-green-400" : "text-red-400"
                          }
                        >
                          {selectedDevice.health.online ? "Online" : "Offline"}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Latency</span>
                        <span>
                          {typeof selectedDevice.health.latencyMs === "number"
                            ? `${selectedDevice.health.latencyMs} ms`
                            : "—"}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Last Seen</span>
                        <span>
                          {selectedDevice.health.lastSeenAt
                            ? new Date(selectedDevice.health.lastSeenAt).toLocaleString()
                            : "—"}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">
                      LED Strips
                    </label>
                    <div className="flex gap-2 mb-4">
                      <button
                        onClick={() => {
                          const deviceId = contentType?.type === "device" ? contentType.deviceId : selectedDeviceId;
                          if (deviceId) {
                            onDeviceStripModeChange(deviceId, "auto");
                          }
                        }}
                        className={`flex-1 p-2 rounded-lg border transition-all ${
                          selectedDevice.stripMode === "auto"
                            ? "bg-blue-500/20 border-blue-500/50 text-blue-400"
                            : "bg-white/5 border-white/20 text-gray-400 hover:bg-white/10"
                        }`}
                        title="Auto (from device env variables)"
                      >
                        Auto
                      </button>
                      <button
                        onClick={() => {
                          const deviceId = contentType?.type === "device" ? contentType.deviceId : selectedDeviceId;
                          if (deviceId) {
                            onDeviceStripModeChange(deviceId, "manual");
                          }
                        }}
                        className={`flex-1 p-2 rounded-lg border transition-all ${
                          selectedDevice.stripMode === "manual"
                            ? "bg-blue-500/20 border-blue-500/50 text-blue-400"
                            : "bg-white/5 border-white/20 text-gray-400 hover:bg-white/10"
                        }`}
                        title="Manual (user-configured)"
                      >
                        Manual
                      </button>
                    </div>
                    
                    <div className="space-y-2">
                      <div className="text-xs text-gray-500 mb-2">
                        {selectedDevice.strips.length === 0
                          ? "No strips configured"
                          : `${selectedDevice.strips.length} strip${selectedDevice.strips.length !== 1 ? "s" : ""}`}
                      </div>
                      
                      {selectedDevice.strips.length > 0 && (
                        <div className="border border-white/20 rounded-lg overflow-hidden">
                          <table className="w-full text-sm">
                            <thead className="bg-white/5">
                              <tr>
                                <th className="px-3 py-2 text-left text-gray-400 font-medium">GPIO Pin</th>
                                <th className="px-3 py-2 text-left text-gray-400 font-medium">LED Count</th>
                                {selectedDevice.stripMode === "manual" && (
                                  <th className="px-3 py-2 text-right text-gray-400 font-medium w-16"></th>
                                )}
                              </tr>
                            </thead>
                            <tbody>
                            {selectedDevice.strips.map((strip) => {
                              const deviceId = contentType?.type === "device" ? contentType.deviceId : selectedDeviceId;
                              return (
                                <StripRow
                                  key={strip.id}
                                  strip={strip}
                                  deviceId={deviceId || ""}
                                  isAuto={selectedDevice.stripMode === "auto"}
                                  onUpdate={(gpioPin, ledCount) => {
                                    if (deviceId) {
                                      onUpdateStrip(deviceId, strip.id, gpioPin, ledCount);
                                    }
                                  }}
                                  onRemove={() => {
                                    if (deviceId) {
                                      onRemoveStrip(deviceId, strip.id);
                                    }
                                  }}
                                />
                              );
                            })}
                            </tbody>
                          </table>
                        </div>
                      )}
                      
                      {selectedDevice.stripMode === "manual" && (
                        <button
                          onClick={() => {
                            const deviceId = contentType?.type === "device" ? contentType.deviceId : selectedDeviceId;
                            if (deviceId) {
                              // Find next available GPIO pin
                              const usedPins = selectedDevice.strips.map((s) => s.gpioPin);
                              let nextPin = 18;
                              while (usedPins.includes(nextPin)) {
                                nextPin++;
                              }
                              onAddStrip(deviceId, nextPin, 10);
                            }
                          }}
                          className="w-full p-2 rounded-lg bg-white/10 border border-white/20 text-white hover:bg-white/20 transition-all flex items-center justify-center gap-2"
                        >
                          <Plus size={16} />
                          Add Strip
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}

              {showLED ? (
                <div className="space-y-4 mt-4">
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">
                      Color
                    </label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={selectedColor}
                        onChange={(event) => onColorChange(event.target.value)}
                        className="w-12 h-12 rounded-lg cursor-pointer border-2 border-white/20"
                      />
                      <div
                        className="flex-1 h-12 rounded-lg border-2 border-white/20"
                        style={{ backgroundColor: selectedColor }}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">
                      Opacity: {selectedOpacity.toFixed(2)}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={selectedOpacity}
                      onChange={(event) =>
                        onOpacityChange(parseFloat(event.target.value))
                      }
                      className="w-full"
                    />
                  </div>
                </div>
              ) : null}

              {showKeyframe && selectedKeyframe ? (
                <div className="space-y-4 mt-4">
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">
                      Fade In (ms)
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={selectedKeyframe.effects?.fadeIn ?? 0}
                      onChange={(event) =>
                        onKeyframeEffectsChange(selectedKeyframe.id, {
                          fadeIn: Math.max(0, Number(event.target.value) || 0),
                        })
                      }
                      className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/20 text-white"
                    />
                  </div>
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">
                      Fade Out (ms)
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={selectedKeyframe.effects?.fadeOut ?? 0}
                      onChange={(event) => {
                        const keyframeId = contentType?.type === "keyframe" ? contentType.keyframeId : selectedKeyframe.id;
                        if (keyframeId) {
                          onKeyframeEffectsChange(keyframeId, {
                            fadeOut: Math.max(0, Number(event.target.value) || 0),
                          });
                        }
                      }}
                      className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/20 text-white"
                    />
                  </div>
                  {onDeleteKeyframe ? (
                    <button
                      type="button"
                      className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30 transition-colors"
                      onClick={() => {
                        const keyframeId = contentType?.type === "keyframe" ? contentType.keyframeId : selectedKeyframe.id;
                        if (keyframeId) {
                          onDeleteKeyframe(keyframeId);
                        }
                      }}
                    >
                      <Trash2 size={16} />
                      Delete Keyframe
                    </button>
                  ) : null}
                </div>
              ) : null}

              {showBackgroundImage ? (
                <div className="space-y-4">
                  <BackgroundImageScaleInput
                    scale={backgroundImageScale}
                    onScaleChange={onBackgroundImageScaleChange}
                  />
                  {onResetDevices && (
                    <div>
                      <button
                        type="button"
                        className="w-full px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/50 text-red-400 hover:bg-red-500/30 transition-colors"
                        onClick={onResetDevices}
                        title="Reset all devices to default"
                      >
                        Reset Devices
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};


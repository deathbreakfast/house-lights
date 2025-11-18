import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Trash2 } from "lucide-react";
import type { Device, Keyframe, LEDStrip } from "../../types/editor";

interface PropertiesDrawerProps {
  isOpen: boolean;
  selectedDeviceId: string | null;
  selectedLEDId: string | null;
  selectedKeyframeId: string | null;
  selectedKeyframe: Keyframe | null;
  selectedBackgroundImage: boolean;
  selectedColor: string;
  selectedOpacity: number;
  backgroundImageScale: number;
  selectedDevice: Device | null;
  onClose: (reason?: "outside" | "explicit") => void;
  protectedRefs?: Array<React.RefObject<HTMLElement | null>>;
  suppressNextOutsideCloseRef?: React.MutableRefObject<boolean>;
  onColorChange: (color: string) => void;
  onOpacityChange: (opacity: number) => void;
  onKeyframeEffectsChange: (
    keyframeId: string,
    updates: { fadeIn?: number; fadeOut?: number }
  ) => void;
  onBackgroundImageScaleChange: (scale: number) => void;
  onDeviceIpChange: (deviceId: string, ipAddress: string) => void;
  onDeviceConnect: (deviceId: string) => void;
  onDeviceStripModeChange: (deviceId: string, mode: "auto" | "manual") => void;
  onAddStrip: (deviceId: string, gpioPin: number, ledCount: number) => void;
  onRemoveStrip: (deviceId: string, stripId: string) => void;
  onUpdateStrip: (deviceId: string, stripId: string, gpioPin: number, ledCount: number) => void;
  onResetDevices?: () => void;
  onDeleteKeyframe?: (keyframeId: string) => void;
}

export const PropertiesDrawer: React.FC<PropertiesDrawerProps> = ({
  isOpen,
  selectedDeviceId,
  selectedLEDId,
  selectedKeyframeId,
  selectedKeyframe,
  selectedBackgroundImage,
  selectedColor,
  selectedOpacity,
  backgroundImageScale,
  selectedDevice,
  onClose,
  protectedRefs,
  suppressNextOutsideCloseRef,
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
}) => {
  const drawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handlePointerUp = (event: MouseEvent | TouchEvent) => {
      const drawer = drawerRef.current;
      if (!drawer) {
        return;
      }
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (drawer.contains(target)) {
        return;
      }
      const isWithinProtected = protectedRefs?.some((ref) => {
        const element = ref?.current;
        return element ? element.contains(target as Node) : false;
      });
      if (isWithinProtected) {
        return;
      }
      if (suppressNextOutsideCloseRef?.current) {
        suppressNextOutsideCloseRef.current = false;
        return;
      }
      onClose("outside");
    };
    document.addEventListener("mouseup", handlePointerUp, true);
    document.addEventListener("touchend", handlePointerUp, true);
    return () => {
      document.removeEventListener("mouseup", handlePointerUp, true);
      document.removeEventListener("touchend", handlePointerUp, true);
    };
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          ref={drawerRef}
          initial={{ x: 400 }}
          animate={{ x: 0 }}
          exit={{ x: 400 }}
          className="fixed right-0 top-0 bottom-0 w-96 backdrop-blur-xl bg-white/10 border-l border-white/20 z-30 flex flex-col"
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
            <h3 className="text-white text-lg font-semibold">Properties</h3>
            <button
              type="button"
              className="text-gray-400 hover:text-white transition-colors"
              onClick={() => onClose("explicit")}
              aria-label="Close properties panel"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {!selectedDeviceId && !selectedLEDId && !selectedKeyframe && !selectedBackgroundImage ? (
              <div className="text-gray-400 text-sm text-center py-8">
                Select an element to view its properties
              </div>
            ) : null}
            {selectedDeviceId && selectedDevice ? (
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
                      onDeviceIpChange(selectedDeviceId, event.target.value);
                    }}
                      onBlur={() => {
                        onDeviceConnect(selectedDeviceId);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onDeviceConnect(selectedDeviceId);
                          (event.target as HTMLInputElement).blur();
                        }
                      }}
                    placeholder="127.0.0.1, localhost, or 192.168.1.100"
                      className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/20 text-white"
                  />
                    <button
                        type="button"
                        onClick={() => onDeviceConnect(selectedDeviceId)}
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
                      onClick={() => onDeviceStripModeChange(selectedDeviceId, "auto")}
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
                      onClick={() => onDeviceStripModeChange(selectedDeviceId, "manual")}
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
                            {selectedDevice.strips.map((strip) => (
                              <StripRow
                                key={strip.id}
                                strip={strip}
                                deviceId={selectedDeviceId}
                                isAuto={selectedDevice.stripMode === "auto"}
                                onUpdate={(gpioPin, ledCount) =>
                                  onUpdateStrip(selectedDeviceId, strip.id, gpioPin, ledCount)
                                }
                                onRemove={() => onRemoveStrip(selectedDeviceId, strip.id)}
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    
                    {selectedDevice.stripMode === "manual" && (
                      <button
                        onClick={() => {
                          // Find next available GPIO pin
                          const usedPins = selectedDevice.strips.map((s) => s.gpioPin);
                          let nextPin = 18;
                          while (usedPins.includes(nextPin)) {
                            nextPin++;
                          }
                          onAddStrip(selectedDeviceId, nextPin, 10);
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

            {selectedLEDId ? (
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

            {selectedKeyframe ? (
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
                    onChange={(event) =>
                      onKeyframeEffectsChange(selectedKeyframe.id, {
                        fadeOut: Math.max(0, Number(event.target.value) || 0),
                      })
                    }
                    className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/20 text-white"
                  />
                </div>
                {onDeleteKeyframe ? (
                  <button
                    type="button"
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30 transition-colors"
                    onClick={() => onDeleteKeyframe(selectedKeyframe.id)}
                  >
                    <Trash2 size={16} />
                    Delete Keyframe
                  </button>
                ) : null}
              </div>
            ) : null}

            {selectedBackgroundImage ? (
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
      ) : null}
    </AnimatePresence>
  );
};

export interface StripRowProps {
  strip: LEDStrip;
  deviceId: string;
  isAuto: boolean;
  onUpdate: (gpioPin: number, ledCount: number) => void;
  onRemove: () => void;
}

export const StripRow: React.FC<StripRowProps> = ({
  strip,
  isAuto,
  onUpdate,
  onRemove,
}) => {
  const [gpioPin, setGpioPin] = useState<string>(strip.gpioPin.toString());
  const [ledCount, setLedCount] = useState<string>(strip.ledCount.toString());

  useEffect(() => {
    setGpioPin(strip.gpioPin.toString());
    setLedCount(strip.ledCount.toString());
  }, [strip.gpioPin, strip.ledCount]);

  const handleGpioPinChange = (value: string) => {
    setGpioPin(value);
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue > 0) {
      onUpdate(numValue, parseInt(ledCount, 10) || strip.ledCount);
    }
  };

  const handleLedCountChange = (value: string) => {
    setLedCount(value);
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue > 0) {
      onUpdate(parseInt(gpioPin, 10) || strip.gpioPin, numValue);
    }
  };

  return (
    <tr className="border-t border-white/10 hover:bg-white/5">
      <td className="px-3 py-2">
        <input
          type="number"
          value={gpioPin}
          onChange={(e) => handleGpioPinChange(e.target.value)}
          disabled={isAuto}
          className={`w-full px-2 py-1 rounded bg-white/5 border border-white/20 text-white text-sm ${
            isAuto ? "opacity-50 cursor-not-allowed" : ""
          }`}
          min="1"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          value={ledCount}
          onChange={(e) => handleLedCountChange(e.target.value)}
          disabled={isAuto}
          className={`w-full px-2 py-1 rounded bg-white/5 border border-white/20 text-white text-sm ${
            isAuto ? "opacity-50 cursor-not-allowed" : ""
          }`}
          min="1"
        />
      </td>
      {!isAuto && (
        <td className="px-3 py-2 text-right">
          <button
            onClick={onRemove}
            className="p-1 rounded hover:bg-red-500/20 text-red-400 transition-colors"
            title="Remove strip"
          >
            <Trash2 size={16} />
          </button>
        </td>
      )}
    </tr>
  );
};

export interface BackgroundImageScaleInputProps {
  scale: number;
  onScaleChange: (scale: number) => void;
}

export const BackgroundImageScaleInput: React.FC<BackgroundImageScaleInputProps> = ({
  scale,
  onScaleChange,
}) => {
  const [localValue, setLocalValue] = useState<string>(scale.toString());
  const [isValid, setIsValid] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string>("");

  // Sync local value when prop changes
  useEffect(() => {
    setLocalValue(scale.toString());
    setIsValid(true);
    setErrorMessage("");
  }, [scale]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setLocalValue(value);

    // Allow empty input for deletion
    if (value === "") {
      setIsValid(true);
      setErrorMessage("");
      return;
    }

    const numValue = parseInt(value, 10);
    
    // Check if it's a valid number
    if (isNaN(numValue)) {
      setIsValid(false);
      setErrorMessage("Must be a number");
      return;
    }

    // Check range
    if (numValue < 10 || numValue > 1000) {
      setIsValid(false);
      setErrorMessage("Must be between 10% and 1000%");
      return;
    }

    // Valid value - update state and call onChange
    setIsValid(true);
    setErrorMessage("");
    onScaleChange(numValue);
  };

  const handleBlur = () => {
    // On blur, if invalid or empty, reset to current scale
    if (!isValid || localValue === "") {
      setLocalValue(scale.toString());
      setIsValid(true);
      setErrorMessage("");
    }
  };

  return (
    <div className="space-y-4 mt-4">
      <div>
        <label className="text-gray-400 text-sm mb-2 block">
          Scale (%)
        </label>
        <input
          type="text"
          value={localValue}
          onChange={handleChange}
          onBlur={handleBlur}
          className={`w-full px-3 py-2 rounded-lg bg-white/5 border text-white transition-colors ${
            isValid
              ? "border-white/20 focus:border-white/40"
              : "border-red-500/50 focus:border-red-500"
          }`}
          placeholder="100"
        />
        {errorMessage ? (
          <p className="text-xs text-red-400 mt-1">{errorMessage}</p>
        ) : (
          <p className="text-xs text-gray-500 mt-1">Range: 10% - 1000%</p>
        )}
      </div>
    </div>
  );
};


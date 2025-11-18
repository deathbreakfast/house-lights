import React, { createContext, useContext, useState, useCallback } from "react";
import type { Device, Keyframe } from "../types/editor";

export type DrawerContentType = 
  | { type: "device"; deviceId: string }
  | { type: "led"; ledId: string }
  | { type: "keyframe"; keyframeId: string }
  | { type: "background-image" }
  | null;

interface DrawerContextValue {
  isOpen: boolean;
  contentType: DrawerContentType;
  openDrawer: (content: DrawerContentType, keyframeData?: Keyframe) => void;
  closeDrawer: () => void;
  pendingKeyframe: Keyframe | null;
}

interface DrawerDataContextValue {
  devices: Device[];
  timelinePosition: number;
  frameLedState: Record<string, { color: string; opacity: number }>;
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

const DrawerContext = createContext<DrawerContextValue | null>(null);
const DrawerDataContext = createContext<DrawerDataContextValue | null>(null);

export const DrawerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [contentType, setContentType] = useState<DrawerContentType>(null);
  const [pendingKeyframe, setPendingKeyframe] = useState<Keyframe | null>(null);

  const openDrawer = useCallback((content: DrawerContentType, keyframeData?: Keyframe) => {
    setContentType(content);
    setPendingKeyframe(keyframeData || null);
    setIsOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setIsOpen(false);
    // Clear content after animation completes
    setTimeout(() => {
      setContentType(null);
      setPendingKeyframe(null);
    }, 300);
  }, []);

  return (
    <DrawerContext.Provider value={{ 
      isOpen, 
      contentType, 
      openDrawer, 
      closeDrawer,
      pendingKeyframe,
    }}>
      {children}
    </DrawerContext.Provider>
  );
};

export const useDrawer = () => {
  const context = useContext(DrawerContext);
  if (!context) {
    throw new Error("useDrawer must be used within DrawerProvider");
  }
  return context;
};

export const DrawerDataProvider: React.FC<{
  children: React.ReactNode;
  value: DrawerDataContextValue;
}> = ({ children, value }) => {
  return (
    <DrawerDataContext.Provider value={value}>
      {children}
    </DrawerDataContext.Provider>
  );
};

export const useDrawerData = () => {
  const context = useContext(DrawerDataContext);
  if (!context) {
    throw new Error("useDrawerData must be used within DrawerDataProvider");
  }
  return context;
};


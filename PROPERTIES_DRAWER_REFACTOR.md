# Properties Drawer Refactoring Plan

## Problem Statement

The properties drawer has a bug where clicking on an LED causes the drawer to open on mouse down and close on mouse up (while the cursor is hovering over the canvas). This happens because:

1. The drawer opens in `handleCanvasMouseDown` when an LED is clicked
2. The drawer listens for `mouseup` events on the document to detect outside clicks
3. When the mouse is released over the canvas, the event handling logic is complex and fragile, leading to the drawer closing unexpectedly

## Current Implementation Analysis

### Drawer Usage Locations

The properties drawer is used in the following scenarios:

1. **Device Properties** - When clicking on a device in the canvas
2. **LED Properties** - When clicking on an LED in the canvas
3. **Keyframe Properties** - When clicking on a keyframe in the timeline
4. **Background Image Properties** - When clicking on empty space in the canvas (if background image exists)

### Current Drawer Opening Mechanisms

#### 1. Device Selection (Canvas)
**Location**: `src/static/v2/src/hooks/useCanvasInteractions.ts`

```611:734:src/static/v2/src/hooks/useCanvasInteractions.ts
  const handleCanvasMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      // ... code ...
      if (mode === "edit" && (tool === "select" || tool === "move")) {
        const shouldOpenProps = tool === "select";
        
        // Check for device hit
        for (const device of devices) {
          const dist = Math.hypot(point.x - device.position.x, point.y - device.position.y);
          if (dist < 15) {
            // Toggle properties panel if clicking same device with select tool
            if (tool === "select" && showPropertiesPanel && selectedDeviceId === device.id) {
              handlePropertiesClose();
              return;
            }
            
            createHistoryCheckpoint();
            setSelectedDeviceId(device.id);
            setSelectedLEDId(null);
            setSelectedBackgroundImage(false);
            suppressNextOutsideCloseRef.current = true;
            setShowPropertiesPanel(shouldOpenProps);
            // ... rest of code ...
          }
        }
      }
    }
  );
```

#### 2. LED Selection (Canvas - Mouse Down)
**Location**: `src/static/v2/src/hooks/useCanvasInteractions.ts`

```737:767:src/static/v2/src/hooks/useCanvasInteractions.ts
        // Check for LED hit
        for (const device of devices) {
          for (const strip of device.strips) {
            for (const led of strip.leds) {
              const ledDist = Math.hypot(point.x - led.position.x, point.y - led.position.y);
              if (ledDist < 8) {
                // Toggle properties panel if clicking same LED with select tool
                if (tool === "select" && showPropertiesPanel && selectedLEDId === led.id) {
                  handlePropertiesClose();
                  return;
                }
                
                createHistoryCheckpoint();
                setSelectedLEDId(led.id);
                setSelectedDeviceId(null);
                setSelectedBackgroundImage(false);
                suppressNextOutsideCloseRef.current = true;
                setShowPropertiesPanel(shouldOpenProps);
                // Only allow dragging with move tool
                if (tool === "move") {
                  setIsDraggingElement(true);
                  setDragStartOffset({
                    x: point.x - led.position.x,
                    y: point.y - led.position.y,
                  });
                }
                return;
              }
            }
          }
        }
```

**Issue**: The drawer opens on `mouseDown`, but the outside click detection listens for `mouseUp`. When you release the mouse over the canvas, the complex logic with `protectedRefs` and `suppressNextOutsideCloseRef` can fail, causing the drawer to close.

#### 3. LED Selection (Canvas - Click)
**Location**: `src/static/v2/src/hooks/useCanvasInteractions.ts`

```1110:1128:src/static/v2/src/hooks/useCanvasInteractions.ts
          device.strips.forEach((strip) => {
            strip.leds.forEach((led) => {
              const ledDist = Math.hypot(x - led.position.x, y - led.position.y);
              if (ledDist < 8) {
                if (
                  !suppressToggle &&
                  showPropertiesPanel &&
                  selectedLEDId === led.id
                ) {
                  handlePropertiesClose();
                } else {
                  setSelectedLEDId(led.id);
                  setSelectedDeviceId(null);
                  setSelectedKeyframeId(null);
                  setSelectedBackgroundImage(false);
                  suppressNextOutsideCloseRef.current = true;
                  setShowPropertiesPanel(true);
                }
                clicked = true;
              }
            });
          });
```

#### 4. Keyframe Selection (Timeline)
**Location**: `src/static/v2/src/hooks/usePropertiesPanel.ts`

```47:70:src/static/v2/src/hooks/usePropertiesPanel.ts
  const handleKeyframeSelect = useCallback(
    (keyframe: Keyframe) => {
      const suppressToggle = pendingExternalCloseRef.current;
      if (!suppressToggle && showPropertiesPanel && selectedKeyframeId === keyframe.id) {
        pendingExternalCloseRef.current = false;
        handlePropertiesClose();
        return;
      }
      pendingExternalCloseRef.current = false;
      suppressNextOutsideCloseRef.current = true;
      setSelectedKeyframeId(keyframe.id);
      setSelectedBackgroundImage(false);
      setShowPropertiesPanel(true);
      // Don't move playhead when selecting a keyframe - keep it at current position
    },
    [
      handlePropertiesClose,
      selectedKeyframeId,
      setSelectedBackgroundImage,
      setSelectedKeyframeId,
      setShowPropertiesPanel,
      showPropertiesPanel,
    ]
  );
```

#### 5. Background Image Selection (Canvas)
**Location**: `src/static/v2/src/hooks/useCanvasInteractions.ts`

```1134:1150:src/static/v2/src/hooks/useCanvasInteractions.ts
        // Check if clicking on background image area (if background exists)
        if (!clicked && backgroundImage) {
          // Select background image if clicking in empty space
          if (
            selectedBackgroundImage &&
            showPropertiesPanel &&
            !suppressToggle
          ) {
            handlePropertiesClose();
          } else {
            setSelectedBackgroundImage(true);
            setSelectedDeviceId(null);
            setSelectedLEDId(null);
            setSelectedKeyframeId(null);
            suppressNextOutsideCloseRef.current = true;
            setShowPropertiesPanel(true);
          }
          clicked = true;
        }
```

### Current Drawer Closing Mechanism

**Location**: `src/static/v2/src/components/properties/PropertiesDrawer.tsx`

```66:101:src/static/v2/src/components/properties/PropertiesDrawer.tsx
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
```

**Problems with current approach**:
- Listens for `mouseup` events on the entire document
- Requires `protectedRefs` array to prevent closing when clicking on canvas/timeline
- Uses `suppressNextOutsideCloseRef` as a workaround to prevent immediate closing
- Complex logic that's error-prone and hard to maintain
- The LED click issue occurs because mouseDown opens the drawer, but mouseUp can trigger the close logic

### Current Drawer Component Structure

**Location**: `src/static/v2/src/components/properties/PropertiesDrawer.tsx`

The drawer is currently rendered inside `LEDSceneEditor` component:

```856:894:src/static/v2/src/pages/LEDSceneEditor.tsx
        <PropertiesDrawer
          isOpen={showPropertiesPanel}
          selectedDeviceId={selectedDeviceId}
          selectedLEDId={selectedLEDId}
          selectedKeyframeId={selectedKeyframeId}
          selectedKeyframe={selectedKeyframe}
          selectedBackgroundImage={selectedBackgroundImage}
          selectedColor={
            selectedLEDId
              ? frameLedState[selectedLEDId]?.color ??
                selectedLED?.color ??
                "#ffffff"
              : "#ffffff"
          }
          selectedOpacity={
            selectedLEDId
              ? frameLedState[selectedLEDId]?.opacity ??
                selectedLED?.opacity ??
                1
              : 1
          }
          backgroundImageScale={backgroundImageScale}
          selectedDevice={selectedDevice}
          onClose={handlePropertiesClose}
          protectedRefs={[canvasRef, timelineRef, sliderRef]}
          suppressNextOutsideCloseRef={suppressNextOutsideCloseRef}
          onAddStrip={handleAddStrip}
          onColorChange={handleColorChange}
          onOpacityChange={handleOpacityChange}
          onKeyframeEffectsChange={handleKeyframeEffectsChange}
          onBackgroundImageScaleChange={handleBackgroundImageScaleChange}
          onDeviceIpChange={handleDeviceIpChange}
          onDeviceConnect={handleDeviceConnect}
          onDeviceStripModeChange={handleDeviceStripModeChange}
          onRemoveStrip={handleRemoveStrip}
          onUpdateStrip={handleUpdateStrip}
          onResetDevices={handleResetDevices}
          onDeleteKeyframe={handleDeleteKeyframe}
        />
```

## Proposed Solution

### Architecture Changes

1. **Create a Drawer Context** - Centralized state management for drawer open/close and content type
2. **Move Drawer to Top Level** - Render drawer as a sibling of the main body content in the app root
3. **Full-Screen Overlay** - Drawer takes up entire screen with transparent overlay outside the drawer panel
4. **Simplified Click Handling** - Click on overlay closes drawer, no need for protected refs or suppress logic

### Implementation Plan

#### Step 1: Create Drawer Context

**New File**: `src/static/v2/src/context/DrawerContext.tsx`

```typescript
import React, { createContext, useContext, useState, useCallback } from "react";

type DrawerContentType = 
  | { type: "device"; deviceId: string }
  | { type: "led"; ledId: string }
  | { type: "keyframe"; keyframeId: string }
  | { type: "background-image" }
  | null;

interface DrawerContextValue {
  isOpen: boolean;
  contentType: DrawerContentType;
  openDrawer: (content: DrawerContentType) => void;
  closeDrawer: () => void;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

export const DrawerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [contentType, setContentType] = useState<DrawerContentType>(null);

  const openDrawer = useCallback((content: DrawerContentType) => {
    setContentType(content);
    setIsOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setIsOpen(false);
    // Clear content after animation completes
    setTimeout(() => setContentType(null), 300);
  }, []);

  return (
    <DrawerContext.Provider value={{ isOpen, contentType, openDrawer, closeDrawer }}>
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
```

#### Step 2: Refactor Drawer Component

**Modified File**: `src/static/v2/src/components/properties/PropertiesDrawer.tsx`

**Before**:
- Drawer is positioned `fixed right-0`
- Uses `protectedRefs` and `suppressNextOutsideCloseRef`
- Listens for document-level `mouseup` events

**After**:
- Drawer has full-screen overlay (transparent outside drawer panel)
- Click on overlay closes drawer
- No need for protected refs or suppress logic
- Uses context for state management

#### Step 3: Update Main App Structure

**Modified File**: `src/static/v2/src/main.tsx`

**Before**:
```typescript
root.render(
  <React.StrictMode>
    <LEDSceneEditor />
  </React.StrictMode>
);
```

**After**:
```typescript
root.render(
  <React.StrictMode>
    <DrawerProvider>
      <LEDSceneEditor />
      <PropertiesDrawerOverlay />
    </DrawerProvider>
  </React.StrictMode>
);
```

#### Step 4: Update All Drawer Opening Locations

Replace all instances of:
- `setShowPropertiesPanel(true)` → `openDrawer({ type: "device", deviceId: "..." })`
- `setShowPropertiesPanel(true)` → `openDrawer({ type: "led", ledId: "..." })`
- `setShowPropertiesPanel(true)` → `openDrawer({ type: "keyframe", keyframeId: "..." })`
- `setShowPropertiesPanel(true)` → `openDrawer({ type: "background-image" })`
- `handlePropertiesClose()` → `closeDrawer()`

Remove:
- `protectedRefs` prop
- `suppressNextOutsideCloseRef` prop
- All `suppressNextOutsideCloseRef.current = true` assignments

## API Comparison: Old vs New

### Old API (Current Implementation)

#### Opening the Drawer

**Pseudo Code:**
```typescript
// Pattern 1: Device selection
setSelectedDeviceId(deviceId);
setSelectedLEDId(null);
setSelectedBackgroundImage(false);
suppressNextOutsideCloseRef.current = true;  // Workaround to prevent immediate close
setShowPropertiesPanel(true);

// Pattern 2: LED selection
setSelectedLEDId(ledId);
setSelectedDeviceId(null);
setSelectedBackgroundImage(false);
suppressNextOutsideCloseRef.current = true;  // Workaround
setShowPropertiesPanel(true);

// Pattern 3: Keyframe selection
setSelectedKeyframeId(keyframeId);
setSelectedBackgroundImage(false);
suppressNextOutsideCloseRef.current = true;  // Workaround
setShowPropertiesPanel(true);

// Pattern 4: Background image selection
setSelectedBackgroundImage(true);
setSelectedDeviceId(null);
setSelectedLEDId(null);
setSelectedKeyframeId(null);
suppressNextOutsideCloseRef.current = true;  // Workaround
setShowPropertiesPanel(true);
```

**Issues:**
- Must manually manage multiple selection states
- Must set `suppressNextOutsideCloseRef.current = true` every time
- Must clear other selection states manually
- State scattered across multiple setters
- No type safety for content type

#### Closing the Drawer

**Pseudo Code:**
```typescript
// Pattern 1: Explicit close
handlePropertiesClose("explicit");

// Pattern 2: Outside close (handled by drawer component)
// Drawer listens for document mouseup events
// Checks if target is within drawer or protected refs
// Uses suppressNextOutsideCloseRef to prevent immediate close
onClose("outside");
```

**Issues:**
- Complex event listener logic in drawer component
- Requires `protectedRefs` array to be passed as prop
- Requires `suppressNextOutsideCloseRef` ref to be passed as prop
- Race conditions between mouseDown and mouseUp events

#### Component Props

**Pseudo Code:**
```typescript
<PropertiesDrawer
  // State props
  isOpen={showPropertiesPanel}
  selectedDeviceId={selectedDeviceId}
  selectedLEDId={selectedLEDId}
  selectedKeyframeId={selectedKeyframeId}
  selectedKeyframe={selectedKeyframe}
  selectedBackgroundImage={selectedBackgroundImage}
  
  // Data props
  selectedColor={selectedColor}
  selectedOpacity={selectedOpacity}
  backgroundImageScale={backgroundImageScale}
  selectedDevice={selectedDevice}
  
  // Event handlers
  onClose={handlePropertiesClose}
  
  // Workaround props
  protectedRefs={[canvasRef, timelineRef, sliderRef]}
  suppressNextOutsideCloseRef={suppressNextOutsideCloseRef}
  
  // Callback props (many)
  onColorChange={handleColorChange}
  onOpacityChange={handleOpacityChange}
  onKeyframeEffectsChange={handleKeyframeEffectsChange}
  onBackgroundImageScaleChange={handleBackgroundImageScaleChange}
  onDeviceIpChange={handleDeviceIpChange}
  onDeviceConnect={handleDeviceConnect}
  onDeviceStripModeChange={handleDeviceStripModeChange}
  onAddStrip={handleAddStrip}
  onRemoveStrip={handleRemoveStrip}
  onUpdateStrip={handleUpdateStrip}
  onResetDevices={handleResetDevices}
  onDeleteKeyframe={handleDeleteKeyframe}
/>
```

**Issues:**
- 20+ props to manage
- Must pass refs for workarounds
- Must pass all selection state separately
- Tight coupling between parent and drawer

### New API (Proposed Implementation)

#### Opening the Drawer

**Pseudo Code:**
```typescript
// Get drawer context hook
const { openDrawer } = useDrawer();

// Pattern 1: Device selection
setSelectedDeviceId(deviceId);
setSelectedLEDId(null);
setSelectedBackgroundImage(false);
openDrawer({ type: "device", deviceId });

// Pattern 2: LED selection
setSelectedLEDId(ledId);
setSelectedDeviceId(null);
setSelectedBackgroundImage(false);
openDrawer({ type: "led", ledId });

// Pattern 3: Keyframe selection
setSelectedKeyframeId(keyframeId);
setSelectedBackgroundImage(false);
openDrawer({ type: "keyframe", keyframeId });

// Pattern 4: Background image selection
setSelectedBackgroundImage(true);
setSelectedDeviceId(null);
setSelectedLEDId(null);
setSelectedKeyframeId(null);
openDrawer({ type: "background-image" });
```

**Benefits:**
- Single function call to open drawer
- Type-safe content type
- No workaround refs needed
- Clear intent with content type

#### Closing the Drawer

**Pseudo Code:**
```typescript
// Get drawer context hook
const { closeDrawer } = useDrawer();

// Pattern 1: Explicit close (button click)
closeDrawer();

// Pattern 2: Outside close (overlay click)
// Handled automatically by PropertiesDrawerOverlay
// Click on overlay triggers closeDrawer()
// No event listeners needed, no protected refs needed
```

**Benefits:**
- Single function call to close
- No complex event listener logic
- No protected refs needed
- No race conditions

#### Component Structure

**Pseudo Code:**
```typescript
// In main.tsx (root level)
<DrawerProvider>
  <LEDSceneEditor />
  <PropertiesDrawerOverlay />
</DrawerProvider>

// PropertiesDrawerOverlay uses context internally
const PropertiesDrawerOverlay: React.FC = () => {
  const { isOpen, contentType, closeDrawer } = useDrawer();
  
  // Drawer reads content type from context
  // Drawer reads selection state from sceneStore/globalStore
  // Drawer reads data (color, opacity, etc.) from sceneStore/globalStore
  
  return (
    <AnimatePresence>
      {isOpen && (
        <Overlay onClick={closeDrawer}>
          <DrawerPanel>
            {contentType?.type === "device" && <DeviceProperties />}
            {contentType?.type === "led" && <LEDProperties />}
            {contentType?.type === "keyframe" && <KeyframeProperties />}
            {contentType?.type === "background-image" && <BackgroundImageProperties />}
          </DrawerPanel>
        </Overlay>
      )}
    </AnimatePresence>
  );
};
```

**Benefits:**
- Drawer is top-level, no props drilling
- Context manages open/close state
- Content type managed by context
- Selection state still in sceneStore (for rendering)
- Data props read directly from stores
- Callback props can be passed via context or still as props (flexible)

### API Summary Table

| Operation | Old API | New API |
|-----------|---------|---------|
| **Open Device Drawer** | `setSelectedDeviceId(id); suppressNextOutsideCloseRef.current = true; setShowPropertiesPanel(true);` | `openDrawer({ type: "device", deviceId: id });` |
| **Open LED Drawer** | `setSelectedLEDId(id); suppressNextOutsideCloseRef.current = true; setShowPropertiesPanel(true);` | `openDrawer({ type: "led", ledId: id });` |
| **Open Keyframe Drawer** | `setSelectedKeyframeId(id); suppressNextOutsideCloseRef.current = true; setShowPropertiesPanel(true);` | `openDrawer({ type: "keyframe", keyframeId: id });` |
| **Open Background Drawer** | `setSelectedBackgroundImage(true); suppressNextOutsideCloseRef.current = true; setShowPropertiesPanel(true);` | `openDrawer({ type: "background-image" });` |
| **Close Drawer** | `handlePropertiesClose("explicit");` | `closeDrawer();` |
| **Check if Open** | `showPropertiesPanel` (boolean) | `isOpen` (boolean from context) |
| **Get Content Type** | Check multiple state vars: `selectedDeviceId`, `selectedLEDId`, etc. | `contentType` (typed union from context) |
| **Outside Click Detection** | Document-level mouseup listener + protected refs + suppress ref | Overlay click handler (simple) |

### Pseudo Code: Complete Usage Example

#### Old API Usage

```typescript
// In useCanvasInteractions.ts
function handleLEDClick(ledId: string) {
  // Must manage multiple state variables
  setSelectedLEDId(ledId);
  setSelectedDeviceId(null);
  setSelectedKeyframeId(null);
  setSelectedBackgroundImage(false);
  
  // Must use workaround ref
  suppressNextOutsideCloseRef.current = true;
  
  // Must set boolean flag
  setShowPropertiesPanel(true);
}

// In PropertiesDrawer component
function PropertiesDrawer({ 
  isOpen, 
  selectedLEDId, 
  protectedRefs, 
  suppressNextOutsideCloseRef,
  onClose 
}) {
  useEffect(() => {
    if (!isOpen) return;
    
    // Complex event listener logic
    const handlePointerUp = (event) => {
      const target = event.target;
      if (drawer.contains(target)) return;
      
      // Check protected refs
      const isWithinProtected = protectedRefs?.some((ref) => {
        return ref.current?.contains(target);
      });
      if (isWithinProtected) return;
      
      // Check suppress ref
      if (suppressNextOutsideCloseRef?.current) {
        suppressNextOutsideCloseRef.current = false;
        return;
      }
      
      onClose("outside");
    };
    
    document.addEventListener("mouseup", handlePointerUp, true);
    return () => document.removeEventListener("mouseup", handlePointerUp, true);
  }, [isOpen]);
  
  // Render drawer...
}
```

#### New API Usage

```typescript
// In useCanvasInteractions.ts
function handleLEDClick(ledId: string) {
  // Still manage selection state (for rendering)
  setSelectedLEDId(ledId);
  setSelectedDeviceId(null);
  setSelectedKeyframeId(null);
  setSelectedBackgroundImage(false);
  
  // Simple, type-safe drawer open
  openDrawer({ type: "led", ledId });
}

// In PropertiesDrawerOverlay component
function PropertiesDrawerOverlay() {
  // Get state from context
  const { isOpen, contentType, closeDrawer } = useDrawer();
  
  // Simple overlay click handler
  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      closeDrawer();
    }
  };
  
  return (
    <AnimatePresence>
      {isOpen && (
        <Overlay onClick={handleOverlayClick}>
          <DrawerPanel onClick={(e) => e.stopPropagation()}>
            {/* Content based on contentType */}
          </DrawerPanel>
        </Overlay>
      )}
    </AnimatePresence>
  );
}
```

### Migration Pseudo Code

```typescript
// Step 1: Replace all setShowPropertiesPanel calls
// OLD:
setShowPropertiesPanel(true);
suppressNextOutsideCloseRef.current = true;

// NEW:
const { openDrawer } = useDrawer();
openDrawer({ type: "led", ledId: selectedLEDId });

// Step 2: Replace all handlePropertiesClose calls
// OLD:
handlePropertiesClose("explicit");

// NEW:
const { closeDrawer } = useDrawer();
closeDrawer();

// Step 3: Replace all showPropertiesPanel checks
// OLD:
if (showPropertiesPanel && selectedLEDId === led.id) {
  handlePropertiesClose();
}

// NEW:
const { isOpen, contentType } = useDrawer();
if (isOpen && contentType?.type === "led" && contentType.ledId === led.id) {
  closeDrawer();
}

// Step 4: Remove props from PropertiesDrawer
// OLD:
<PropertiesDrawer
  isOpen={showPropertiesPanel}
  protectedRefs={[canvasRef, timelineRef, sliderRef]}
  suppressNextOutsideCloseRef={suppressNextOutsideCloseRef}
  onClose={handlePropertiesClose}
/>

// NEW:
// No component needed in LEDSceneEditor
// PropertiesDrawerOverlay is at root level
```

## Before and After Code Examples

### Example 1: LED Selection (Mouse Down)

**Before** (`useCanvasInteractions.ts`):
```typescript
// Check for LED hit
for (const device of devices) {
  for (const strip of device.strips) {
    for (const led of strip.leds) {
      const ledDist = Math.hypot(point.x - led.position.x, point.y - led.position.y);
      if (ledDist < 8) {
        createHistoryCheckpoint();
        setSelectedLEDId(led.id);
        setSelectedDeviceId(null);
        setSelectedBackgroundImage(false);
        suppressNextOutsideCloseRef.current = true;  // Workaround
        setShowPropertiesPanel(shouldOpenProps);
        return;
      }
    }
  }
}
```

**After**:
```typescript
// Check for LED hit
for (const device of devices) {
  for (const strip of device.strips) {
    for (const led of strip.leds) {
      const ledDist = Math.hypot(point.x - led.position.x, point.y - led.position.y);
      if (ledDist < 8) {
        createHistoryCheckpoint();
        setSelectedLEDId(led.id);
        setSelectedDeviceId(null);
        setSelectedBackgroundImage(false);
        if (shouldOpenProps) {
          openDrawer({ type: "led", ledId: led.id });
        }
        return;
      }
    }
  }
}
```

### Example 2: Drawer Component

**Before** (`PropertiesDrawer.tsx`):
```typescript
export const PropertiesDrawer: React.FC<PropertiesDrawerProps> = ({
  isOpen,
  selectedDeviceId,
  selectedLEDId,
  // ... many props
  onClose,
  protectedRefs,
  suppressNextOutsideCloseRef,
  // ... more props
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
          {/* drawer content */}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};
```

**After**:
```typescript
export const PropertiesDrawerOverlay: React.FC = () => {
  const { isOpen, contentType, closeDrawer } = useDrawer();
  const drawerRef = useRef<HTMLDivElement | null>(null);

  const handleOverlayClick = (event: React.MouseEvent) => {
    // Only close if clicking on the overlay, not the drawer itself
    if (event.target === event.currentTarget) {
      closeDrawer();
    }
  };

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
          <div className="flex-1" />
          
          {/* Drawer panel */}
          <motion.div
            ref={drawerRef}
            initial={{ x: 400 }}
            animate={{ x: 0 }}
            exit={{ x: 400 }}
            onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside drawer
            className="w-96 backdrop-blur-xl bg-white/10 border-l border-white/20 flex flex-col"
          >
            {/* drawer content based on contentType */}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};
```

### Example 3: LEDSceneEditor Usage

**Before**:
```typescript
<PropertiesDrawer
  isOpen={showPropertiesPanel}
  selectedDeviceId={selectedDeviceId}
  selectedLEDId={selectedLEDId}
  // ... many props
  onClose={handlePropertiesClose}
  protectedRefs={[canvasRef, timelineRef, sliderRef]}
  suppressNextOutsideCloseRef={suppressNextOutsideCloseRef}
  // ... more props
/>
```

**After**:
- Remove `<PropertiesDrawer />` from `LEDSceneEditor`
- Drawer is now rendered at the root level via `PropertiesDrawerOverlay`
- All drawer state managed through context

## Files That Need Changes

1. **New Files**:
   - `src/static/v2/src/context/DrawerContext.tsx` - Context for drawer state
   - `src/static/v2/src/components/properties/PropertiesDrawerOverlay.tsx` - New drawer component with overlay

2. **Modified Files**:
   - `src/static/v2/src/main.tsx` - Add DrawerProvider and PropertiesDrawerOverlay
   - `src/static/v2/src/components/properties/PropertiesDrawer.tsx` - Refactor to use context and remove protected refs logic
   - `src/static/v2/src/pages/LEDSceneEditor.tsx` - Remove PropertiesDrawer, update to use context
   - `src/static/v2/src/hooks/useCanvasInteractions.ts` - Replace setShowPropertiesPanel with openDrawer
   - `src/static/v2/src/hooks/usePropertiesPanel.ts` - Update to use context
   - `src/static/v2/src/hooks/useTimelineInteractions.ts` - Update to use context
   - `src/static/v2/src/hooks/useKeyframeHandlers.ts` - Update to use context
   - `src/static/v2/src/state/sceneStore.ts` - May need to remove showPropertiesPanel state if it's stored there

## Benefits of This Approach

1. **Fixes the LED Click Bug** - No more mouseDown/mouseUp race condition
2. **Simpler Logic** - No protected refs, no suppress refs, no complex event handling
3. **Better Separation of Concerns** - Drawer state managed in one place
4. **Easier to Maintain** - Clear API for opening/closing drawer
5. **More Reliable** - Click on overlay is unambiguous, no edge cases
6. **Better UX** - Standard modal/drawer pattern that users expect

## Migration Steps

1. Create DrawerContext and DrawerProvider
2. Create PropertiesDrawerOverlay component
3. Update main.tsx to include provider and overlay
4. Update all locations that open/close drawer to use context
5. Remove old PropertiesDrawer component and related props
6. Remove protectedRefs and suppressNextOutsideCloseRef logic
7. Test all drawer opening scenarios
8. Remove unused state (showPropertiesPanel from sceneStore if present)


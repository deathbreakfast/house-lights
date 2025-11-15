import type { Scene, Point } from "../../types/editor";
import type { LedStateMap } from "../../utils/timeline";

export interface RenderOptions {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  scene: Scene;
  frameLedState?: LedStateMap;
  backgroundImage: string | null;
  backgroundImageScale: number;
  canvasZoom: number;
  canvasPan: Point;
  selectedDeviceId: string | null;
  selectedLEDId: string | null;
  powerOn: boolean;
}

export const drawDevicesAndLEDs = (options: RenderOptions) => {
  const {
    ctx,
    scene,
    canvasZoom,
    canvasPan,
    selectedDeviceId,
    selectedLEDId,
    powerOn,
  } = options;

  ctx.save();
  ctx.translate(canvasPan.x, canvasPan.y);
  ctx.scale(canvasZoom, canvasZoom);

  scene.devices.forEach((device) => {
    ctx.fillStyle = selectedDeviceId === device.id ? "#3b82f6" : "#1e40af";
    ctx.strokeStyle =
      selectedDeviceId === device.id ? "#60a5fa" : "#3b82f6";
    ctx.lineWidth = 2;

    const deviceSize = 30;
    const x = device.position.x - deviceSize / 2;
    const y = device.position.y - deviceSize / 2;
    const radius = 6;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + deviceSize - radius, y);
    ctx.quadraticCurveTo(x + deviceSize, y, x + deviceSize, y + radius);
    ctx.lineTo(x + deviceSize, y + deviceSize - radius);
    ctx.quadraticCurveTo(
      x + deviceSize,
      y + deviceSize,
      x + deviceSize - radius,
      y + deviceSize
    );
    ctx.lineTo(x + radius, y + deviceSize);
    ctx.quadraticCurveTo(x, y + deviceSize, x, y + deviceSize - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (device.type === "wifi") {
      ctx.strokeStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(device.position.x, device.position.y + 2, 4, Math.PI, 0, false);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(device.position.x, device.position.y + 2, 8, Math.PI, 0, false);
      ctx.stroke();
      ctx.fillRect(device.position.x - 1.5, device.position.y + 5, 3, 3);
    } else if (device.type === "local") {
      // Local device icon (CPU/chip icon)
      ctx.fillRect(device.position.x - 6, device.position.y - 6, 12, 12);
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1;
      ctx.strokeRect(device.position.x - 8, device.position.y - 8, 16, 16);
    } else if (device.type === "virtual") {
      // Virtual device icon (radio/waves)
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      // Draw concentric arcs for virtual device
      ctx.beginPath();
      ctx.arc(device.position.x, device.position.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(device.position.x, device.position.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    device.strips.forEach((strip) => {
      strip.leds.forEach((led, index) => {
        if (index > 0) {
          const prevLed = strip.leds[index - 1];
          ctx.strokeStyle = "#4b5563";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(prevLed.position.x, prevLed.position.y);
          ctx.lineTo(led.position.x, led.position.y);
          ctx.stroke();
        }
        if (index === 0) {
          ctx.strokeStyle = "#4b5563";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(device.position.x, device.position.y);
          ctx.lineTo(led.position.x, led.position.y);
          ctx.stroke();
        }
        const override = options.frameLedState?.[led.id];
        const ledOpacity = override?.opacity ?? led.opacity;
        const ledColor = override?.color ?? led.color;
        ctx.globalAlpha = powerOn ? ledOpacity : 0.3;
        ctx.fillStyle = powerOn ? ledColor : "#374151";
        ctx.beginPath();
        ctx.arc(led.position.x, led.position.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (selectedLEDId === led.id) {
          ctx.strokeStyle = "#3b82f6";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(led.position.x, led.position.y, 10, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
    });
  });

  ctx.restore();
};

const drawUploadPrompt = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
  // Draw in screen space (not transformed)
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform to screen space
  
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  // Draw semi-transparent background overlay
  ctx.fillStyle = "rgba(15, 15, 15, 0.7)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw upload icon (simplified SVG-like shape)
  const iconX = centerX;
  const iconY = centerY - 40;

  ctx.strokeStyle = "#6b7280";
  ctx.fillStyle = "#6b7280";
  ctx.lineWidth = 3;

  // Draw upload arrow/cloud shape
  ctx.beginPath();
  // Cloud base (three overlapping circles)
  ctx.arc(iconX - 15, iconY, 8, 0, Math.PI * 2);
  ctx.arc(iconX, iconY, 10, 0, Math.PI * 2);
  ctx.arc(iconX + 15, iconY, 8, 0, Math.PI * 2);
  ctx.fill();

  // Arrow pointing up
  ctx.beginPath();
  ctx.moveTo(iconX, iconY - 15);
  ctx.lineTo(iconX - 8, iconY - 5);
  ctx.lineTo(iconX + 8, iconY - 5);
  ctx.closePath();
  ctx.fill();

  // Draw text
  ctx.fillStyle = "#9ca3af";
  ctx.font = "18px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Upload Background Image", centerX, centerY + 20);
  
  ctx.restore();
};

export const renderCanvas = (options: RenderOptions) => {
  const { canvas, ctx, backgroundImage } = options;

  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (backgroundImage) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    
    // Handle both cached and new images
    const drawImage = () => {
      // Use the image's natural dimensions as the fixed coordinate system
      // This ensures LEDs and background stay aligned regardless of canvas size
      const imgNaturalWidth = img.naturalWidth;
      const imgNaturalHeight = img.naturalHeight;
      
      // Apply scale percentage (100% = natural size, 400% = 4x natural size)
      const scaleFactor = options.backgroundImageScale / 100;
      const displayWidth = imgNaturalWidth * scaleFactor;
      const displayHeight = imgNaturalHeight * scaleFactor;
      
      // Draw the background image at (0, 0) in world coordinates
      // The pan/zoom transform will handle the viewport positioning
      ctx.save();
      ctx.translate(options.canvasPan.x, options.canvasPan.y);
      ctx.scale(options.canvasZoom, options.canvasZoom);
      
      // Draw at (0, 0) in world space - this is the fixed position
      ctx.drawImage(img, 0, 0, displayWidth, displayHeight);
      ctx.restore();
      drawDevicesAndLEDs(options);
    };

    // Set up load handlers first
    img.onload = drawImage;
    img.onerror = () => {
      // If image fails to load, just draw devices/LEDs
      drawDevicesAndLEDs(options);
    };
    
    // Set src after handlers are set up
    img.src = backgroundImage;
    
    // If image is already loaded (cached), onload won't fire, so check and draw immediately
    if (img.complete && img.naturalWidth > 0) {
      drawImage();
    }
  } else {
    // Always draw devices and LEDs first
    drawDevicesAndLEDs(options);
    // Then draw the upload prompt overlay
    drawUploadPrompt(ctx, canvas);
  }
};


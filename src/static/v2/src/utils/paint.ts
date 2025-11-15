import type { LEDStrip, Point } from "../types/editor";

export const distanceToSegment = (
  point: Point,
  start: Point,
  end: Point
): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t =
    ((point.x - start.x) * dx + (point.y - start.y) * dy) /
    (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  const closest = {
    x: start.x + clamped * dx,
    y: start.y + clamped * dy,
  };
  return Math.hypot(point.x - closest.x, point.y - closest.y);
};

export const collectContiguousLedIds = (
  strip: LEDStrip,
  startIndex: number,
  matcher: (ledId: string) => boolean
): string[] => {
  if (startIndex < 0 || startIndex >= strip.leds.length) {
    return [];
  }
  const ids: string[] = [];
  for (let index = startIndex; index >= 0; index--) {
    const ledId = strip.leds[index].id;
    if (!matcher(ledId)) {
      break;
    }
    ids.push(ledId);
  }
  for (let index = startIndex + 1; index < strip.leds.length; index++) {
    const ledId = strip.leds[index].id;
    if (!matcher(ledId)) {
      break;
    }
    ids.push(ledId);
  }
  return ids;
};



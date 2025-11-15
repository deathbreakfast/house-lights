import { describe, expect, it } from "vitest";
import type { LEDStrip } from "../../types/editor";
import { collectContiguousLedIds, distanceToSegment } from "../paint";

describe("paint utils", () => {
  it("computes the shortest distance from a point to a segment", () => {
    const pointOnLine = { x: 5, y: 5 };
    const start = { x: 0, y: 0 };
    const end = { x: 10, y: 10 };
    expect(distanceToSegment(pointOnLine, start, end)).toBeCloseTo(0);

    const pointOffLine = { x: 5, y: 7 };
    expect(distanceToSegment(pointOffLine, start, end)).toBeCloseTo(
      Math.sqrt(2)
    );
  });

  it("collects contiguous LED ids that satisfy the matcher", () => {
    const strip: LEDStrip = {
      id: "strip-1",
      gpioPin: 18,
      ledCount: 5,
      leds: Array.from({ length: 5 }, (_, index) => ({
        id: `led-${index}`,
        position: { x: index * 10, y: 0 },
        color: index < 3 ? "#ff0000" : "#00ff00",
        opacity: 1,
      })),
    };
    const colors = Object.fromEntries(
      strip.leds.map((led) => [led.id, led.color])
    );
    const ids = collectContiguousLedIds(strip, 1, (ledId) => colors[ledId] === "#ff0000");
    expect(ids).toEqual(["led-1", "led-0", "led-2"]);
  });
});



import { describe, expect, it } from "vitest";
import liveFixture from "../../tests/fixtures/ws/live_subscribe.json";
import { applyLive } from "../src/api/live";
import type { Frame, LiveMessage } from "../src/api/types";
import { MOCK_FRAMES, liveMessages } from "../mock/hass";

describe("live frames", () => {
  it("applies the fixture's full frame and delta", () => {
    const [full, delta] = liveFixture.events as LiveMessage[];
    const first = applyLive(null, full!);
    const second = applyLive(first, delta!);
    expect(second?.t).toBe((delta as { delta: { t: number } }).delta.t);
    expect(second?.rooms.hall?.p).toBe(0.4);
    expect(second?.rooms.living).toEqual(first?.rooms.living);
    expect(second?.directions.length).toBe(first?.directions.length);
  });

  it("ignores a delta before any full frame", () => {
    const [, delta] = liveFixture.events as LiveMessage[];
    expect(applyLive(null, delta!)).toBeNull();
  });

  it("rebuilds every mock frame from full plus deltas", () => {
    let frame: Frame | null = null;
    liveMessages(MOCK_FRAMES).forEach((message, i) => {
      frame = applyLive(frame, message);
      expect(frame).toEqual(MOCK_FRAMES[i]);
    });
    expect(liveMessages(MOCK_FRAMES).filter((m) => m.kind === "delta").length).toBeGreaterThan(10);
  });
});

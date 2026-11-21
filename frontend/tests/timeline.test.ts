import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Frame, HistoryEvent, RoomSample } from "../src/api/types";
import {
  advance,
  areaPath,
  cluster,
  dayBounds,
  dayStart,
  defaultCursor,
  earliestDay,
  emptySpans,
  follow,
  frameAt,
  lastEventBefore,
  marked,
  mergeFrames,
  motionRuns,
  needsFrames,
  shiftDay,
  stepCursor,
  ticks,
  windowAround,
} from "../src/timeline";

const ZONE = process.env.TZ;

function at(text: string): number {
  return new Date(text).getTime() / 1000;
}

function event(t: number, kind: HistoryEvent["kind"], room: string | null = null): HistoryEvent {
  return { t, kind, room, data: {} };
}

function frame(t: number): Frame {
  return { t, status: "ready", model_version: 1, directions: [], pairs: [], rooms: {}, veto: null, gates: {}, trail: [], illustrative_xy: {} };
}

describe("days in local time", () => {
  beforeEach(() => {
    process.env.TZ = "Europe/Warsaw";
  });
  afterEach(() => {
    process.env.TZ = ZONE;
  });

  it("starts the day at local midnight", () => {
    const t = at("2026-11-21T15:30:00+01:00");
    expect(dayStart(t)).toBe(at("2026-11-21T00:00:00+01:00"));
    expect(dayBounds(t)).toEqual([at("2026-11-21T00:00:00+01:00"), at("2026-11-22T00:00:00+01:00")]);
  });

  it("has 23 hours on the spring change and 25 on the autumn one", () => {
    const [s1, e1] = dayBounds(at("2026-03-29T12:00:00+02:00"));
    expect((e1 - s1) / 3600).toBe(23);
    const [s2, e2] = dayBounds(at("2026-10-25T12:00:00+01:00"));
    expect((e2 - s2) / 3600).toBe(25);
    expect(shiftDay(s2, 1)).toBe(at("2026-10-26T00:00:00+01:00"));
    expect(shiftDay(s1, -1)).toBe(at("2026-03-28T00:00:00+01:00"));
  });

  it("keeps hour ticks on local hours across the change", () => {
    const [start, end] = dayBounds(at("2026-10-25T12:00:00+01:00"));
    const hours = ticks(start, end, 60);
    expect(hours.length).toBe(26);
    expect(hours[0]).toBe(start);
    expect(hours.at(-1)).toBe(end);
    const labels = ticks(start, start + 3 * 3600, 180).map((t) => new Date(t * 1000).getHours());
    expect(labels).toEqual([0]);
  });

  it("aligns ticks that start mid-hour", () => {
    const start = at("2026-11-21T10:07:00+01:00");
    const list = ticks(start, start + 3600, 15).map((t) => new Date(t * 1000).getMinutes());
    expect(list).toEqual([15, 30, 45, 0]);
  });

  it("goes back 14 days at most", () => {
    const now = at("2026-11-21T10:00:00+01:00");
    expect(earliestDay(now)).toBe(at("2026-11-08T00:00:00+01:00"));
  });
});

describe("room bands", () => {
  const samples: RoomSample[] = [
    [0, 0.02, false],
    [60, 0.9, true],
    [120, 0.95, true],
    [180, 0.1, false],
    [300, 0.97, true],
  ];

  it("joins motion samples into runs", () => {
    expect(motionRuns(samples, 60)).toEqual([
      [60, 180],
      [300, 360],
    ]);
  });

  it("draws a step area and breaks it at gaps and filtered samples", () => {
    const path = areaPath(samples, 60, (t) => t / 10, 10);
    expect(path.startsWith("M0.0 10.0L0.0 9.8L6.0 9.8L6.0 1.0")).toBe(true);
    expect(path.match(/M/g)?.length).toBe(2);
    const motion = areaPath(samples, 60, (t) => t / 10, 10, (s) => s[2]);
    expect(motion).toBe("M6.0 10.0L6.0 1.0L12.0 1.0L12.0 0.5L18.0 0.5L18.0 10.0ZM30.0 10.0L30.0 0.3L36.0 0.3L36.0 10.0Z");
    expect(areaPath([], 60, (t) => t, 10)).toBe("");
  });
});

describe("events", () => {
  const events = [event(100, "false_alarm", "hall"), event(105, "veto"), event(400, "bulb_write"), event(50, "motion_on", "hall")];

  it("clusters markers closer than the gap", () => {
    const clusters = cluster(events.slice(0, 3), (t) => t, 26);
    expect(clusters.map((c) => c.events.length)).toEqual([2, 1]);
    expect(clusters[0]!.x).toBe(102.5);
    expect(clusters[0]!.t).toBe(100);
    expect(cluster([event(0, "veto"), event(20, "veto"), event(40, "veto")], (t) => t, 26).length).toBe(1);
  });

  it("hides motion markers unless asked", () => {
    expect(marked(events, false).map((e) => e.kind)).toEqual(["false_alarm", "veto", "bulb_write"]);
    expect(marked(events, true).length).toBe(4);
  });

  it("turns empty-house events into spans", () => {
    expect(emptySpans([event(10, "house_empty"), event(20, "house_occupied"), event(50, "house_empty")], 0, 100)).toEqual([
      [10, 20],
      [50, 100],
    ]);
    expect(emptySpans([event(30, "house_occupied")], 0, 100)).toEqual([[0, 30]]);
    expect(emptySpans([], 0, 100)).toEqual([]);
  });

  it("finds the event before the cursor and a default cursor", () => {
    expect(lastEventBefore(events, 104)?.kind).toBe("false_alarm");
    expect(lastEventBefore(events, 10)).toBeNull();
    expect(defaultCursor(events, 0, 1000, 5000)).toBe(50);
    expect(defaultCursor([], 0, 1000, 500)).toBe(440);
    expect(defaultCursor([], 0, 1000, 5000)).toBe(500);
  });
});

describe("frames and playback", () => {
  const frames = [frame(10), frame(10.4), frame(10.8), frame(20)];

  it("finds the frame shown at a time", () => {
    expect(frameAt(frames, 10.5)?.t).toBe(10.4);
    expect(frameAt(frames, 9)?.t).toBe(10);
    expect(frameAt(frames, 5)).toBeNull();
    expect(frameAt(frames, 15)).toBeNull();
    expect(frameAt([], 15)).toBeNull();
  });

  it("merges windows without duplicates", () => {
    expect(mergeFrames([frame(1), frame(2)], [frame(2), frame(3)]).map((f) => f.t)).toEqual([1, 2, 3]);
  });

  it("steps by half a second with frames and by a minute without", () => {
    expect(stepCursor(10.3, 1, true)).toBe(10.5);
    expect(stepCursor(10.3, -1, true)).toBe(10);
    expect(stepCursor(100, -1, false)).toBe(40);
    expect(advance(100, 500, 4)).toBe(102);
  });

  it("keeps the zoom window inside the day and follows the cursor", () => {
    expect(windowAround(50, 20, 0, 100)).toEqual([40, 60]);
    expect(windowAround(5, 20, 0, 100)).toEqual([0, 20]);
    expect(windowAround(50, 200, 0, 100)).toEqual([0, 100]);
    expect(follow([40, 60], 55, 0, 100)).toEqual([40, 60]);
    expect(follow([40, 60], 61, 0, 100)).toEqual([57, 77]);
    expect(follow([40, 60], 30, 0, 100)).toEqual([14, 34]);
  });

  it("asks for frames when the cursor leaves the loaded window", () => {
    expect(needsFrames(null, 10)).toBe(true);
    expect(needsFrames([0, 120], 50)).toBe(false);
    expect(needsFrames([0, 120], 110)).toBe(true);
    expect(needsFrames([0, 120], -1)).toBe(true);
  });
});

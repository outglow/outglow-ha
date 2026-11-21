import { describe, expect, it } from "vitest";
import type { Frame, Plan, Room } from "../src/api/types";
import { MOCK_PLAN } from "../mock/backend";
import {
  TRANSITION,
  buildSteps,
  current,
  done,
  entranceOf,
  initialState,
  isTimed,
  labelFor,
  liveFeedback,
  progress,
  reduce,
  remaining,
  roomOrder,
  totalSeconds,
  type RunState,
  type Transition,
} from "../src/wizard";

function room(id: string, entrance = false): Room {
  return { id, name: id, outline: [], colour: "#000", area_id: null, entrance };
}

function plan(rooms: Room[], adjacent: [string, string][]): Plan {
  return { ...MOCK_PLAN, rooms, adjacent };
}

function run(t: Transition, ...events: Parameters<typeof reduce>[1][]): { state: RunState; labels: Transition["labels"] } {
  let state = t.state;
  const labels = [...t.labels];
  for (const event of events) {
    const next = reduce(state, event);
    state = next.state;
    labels.push(...next.labels);
  }
  return { state, labels };
}

describe("room order", () => {
  it("walks the mock flat from the entrance through doors", () => {
    expect(roomOrder(MOCK_PLAN)).toEqual(["hall", "living", "office"]);
    expect(entranceOf(MOCK_PLAN)).toBe("hall");
  });

  it("does a breadth-first walk and appends rooms without doors", () => {
    const p = plan(
      [room("a"), room("b"), room("c", true), room("d"), room("e")],
      [
        ["c", "d"],
        ["a", "c"],
        ["a", "b"],
      ],
    );
    expect(roomOrder(p)).toEqual(["c", "a", "d", "b", "e"]);
  });

  it("starts from the first room when there is no entrance", () => {
    const p = plan([room("x"), room("y")], [["y", "x"]]);
    expect(roomOrder(p)).toEqual(["x", "y"]);
  });

  it("ignores adjacency to unknown rooms", () => {
    const p = plan([room("x"), room("y")], [["x", "ghost"]]);
    expect(roomOrder(p)).toEqual(["x", "y"]);
  });
});

describe("steps", () => {
  it("builds an empty step of N minutes and four steps per chosen room", () => {
    const steps = buildSteps({ rooms: ["hall", "office"], empty: true, emptyMinutes: 15 });
    expect(steps.map((s) => s.id)).toEqual([
      "empty",
      "hall:edge",
      "hall:walk",
      "hall:sit",
      "hall:leave",
      "office:edge",
      "office:walk",
      "office:sit",
      "office:leave",
    ]);
    expect(steps[0]!.seconds).toBe(900);
    expect(steps[4]!.next).toBe("office");
    expect(steps[8]!.next).toBeNull();
    expect(totalSeconds(steps)).toBe(900 + 2 * (20 + 60 + 20 + 15));
  });

  it("leaves out the empty step and skipped rooms", () => {
    const steps = buildSteps({ rooms: ["living"], empty: false, emptyMinutes: 10 });
    expect(steps.map((s) => s.kind)).toEqual(["edge", "walk", "sit", "leave"]);
  });

  it("labels each step as the contract expects", () => {
    const steps = buildSteps({ rooms: ["hall"], empty: true, emptyMinutes: 5 });
    expect(steps.map(labelFor)).toEqual([
      { kind: "empty", activity: "any" },
      { kind: "room", room: "hall", activity: "walk" },
      { kind: "room", room: "hall", activity: "walk" },
      { kind: "room", room: "hall", activity: "still" },
      TRANSITION,
    ]);
  });

  it("keeps a stand-still step saved by an older version working", () => {
    const old = { id: "hall:still", kind: "still" as const, room: "hall", next: null, seconds: 20, deferred: false };
    expect(labelFor(old)).toEqual({ kind: "room", room: "hall", activity: "still" });
    expect(isTimed(old)).toBe(true);
  });
});

describe("run", () => {
  const steps = buildSteps({ rooms: ["hall", "living"], empty: true, emptyMinutes: 10 });

  it("goes through every step with one label per step", () => {
    const start = initialState(steps, "hall", 0);
    expect(start.labels).toEqual([]);
    expect(current(start.state)?.kind).toBe("empty");
    let n = 0;
    const events = [{ type: "start" as const, now: 1 }, ...Array.from({ length: 9 }, () => ({ type: "next" as const, now: (n += 10) }))];
    const result = run(start, ...events);
    expect(done(result.state)).toBe(true);
    expect(result.labels).toEqual([
      { kind: "empty", activity: "any" },
      TRANSITION,
      { kind: "room", room: "hall", activity: "walk" },
      { kind: "room", room: "hall", activity: "walk" },
      { kind: "room", room: "hall", activity: "still" },
      TRANSITION,
      { kind: "room", room: "living", activity: "walk" },
      { kind: "room", room: "living", activity: "walk" },
      { kind: "room", room: "living", activity: "still" },
      TRANSITION,
    ]);
  });

  it("waits until the user is in the first room when it is not the entrance", () => {
    const only = buildSteps({ rooms: ["living"], empty: false, emptyMinutes: 10 });
    const start = initialState(only, "hall", 0);
    expect(start.state.started).toBe(false);
    const after = run(start, { type: "next", now: 5 });
    expect(after.state.started).toBe(true);
    expect(after.labels).toEqual([{ kind: "room", room: "living", activity: "walk" }]);
  });

  it("defers the empty home step to the end and drops it when deferred last", () => {
    const start = initialState(steps, "hall", 0);
    const deferred = run(start, { type: "defer", now: 1 });
    expect(current(deferred.state)?.id).toBe("hall:edge");
    expect(deferred.state.steps.at(-1)).toMatchObject({ id: "empty", deferred: true });
    expect(deferred.state.steps).toHaveLength(steps.length);
    const lastIndex = deferred.state.steps.length - 1;
    const atEnd = { ...deferred.state, index: lastIndex };
    const dropped = reduce(atEnd, { type: "defer", now: 2 });
    expect(dropped.state.steps).toHaveLength(steps.length - 1);
    expect(done(dropped.state)).toBe(true);
  });

  it("skips the rest of a room and closes its label", () => {
    const start = initialState(steps.slice(1), "hall", 0);
    const entered = run(start, { type: "next", now: 1 });
    expect(current(entered.state)?.id).toBe("hall:edge");
    const skipped = reduce(entered.state, { type: "skip_room", now: 2 });
    expect(skipped.labels).toEqual([TRANSITION]);
    expect(current(skipped.state)?.id).toBe("living:edge");
    expect(skipped.state.started).toBe(false);
  });

  it("pauses with a transition label and resumes the same label and timer", () => {
    const start = initialState(steps.slice(1), "hall", 0);
    const entered = run(start, { type: "next", now: 0 });
    expect(remaining(entered.state, 5000)).toBe(15);
    const paused = reduce(entered.state, { type: "pause", now: 5000 });
    expect(paused.labels).toEqual([TRANSITION]);
    expect(remaining(paused.state, 60000)).toBe(15);
    const resumed = reduce(paused.state, { type: "resume", now: 60000 });
    expect(resumed.labels).toEqual([{ kind: "room", room: "hall", activity: "walk" }]);
    expect(remaining(resumed.state, 70000)).toBe(5);
    expect(remaining(resumed.state, 99000)).toBe(0);
  });

  it("counts progress per step", () => {
    const start = initialState(steps, "hall", 0);
    expect(progress(start.state)).toMatchObject({ step: 1, total: 9, fraction: 0 });
    const left = run(start, { type: "start", now: 0 });
    expect(progress(left.state).fraction).toBeCloseTo(0.5 / 9);
    const back = run(left, { type: "next", now: 1 });
    expect(progress(back.state)).toMatchObject({ step: 2, total: 9 });
    expect(remaining(back.state, 1)).toBe(20);
    expect(remaining({ ...back.state, index: 4 }, 1)).toBeNull();
  });

  it("ignores events that do not apply", () => {
    const start = initialState(steps, "hall", 0);
    expect(reduce(start.state, { type: "pause", now: 1 }).labels).toEqual([]);
    expect(reduce(start.state, { type: "resume", now: 1 }).labels).toEqual([]);
    expect(reduce(start.state, { type: "skip_room", now: 1 }).labels).toEqual([]);
    const finished = { ...start.state, index: steps.length };
    expect(reduce(finished, { type: "next", now: 1 }).state).toBe(finished);
  });
});

describe("live feedback", () => {
  it("follows the live frame, not the session snapshot", () => {
    const stored = { pairs_reacting: 0, veto: true };
    const frame = {
      t: 1,
      status: "ready",
      model_version: 0,
      directions: [],
      pairs: [
        { a: "a", b: "b", obs: 2, weight: 1 },
        { a: "a", b: "c", obs: 0, weight: 1 },
        { a: "b", b: "c", obs: 1, weight: 1 },
      ],
      rooms: {},
      veto: null,
      gates: {},
      trail: [],
      illustrative_xy: {},
    } as unknown as Frame;
    expect(liveFeedback(frame, stored)).toEqual({ pairs: 2, veto: false });
    expect(liveFeedback(null, stored)).toEqual({ pairs: 0, veto: true });
    expect(liveFeedback(null, undefined)).toEqual({ pairs: 0, veto: false });
  });
});

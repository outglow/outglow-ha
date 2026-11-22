import { describe, expect, it } from "vitest";
import type { Plan, Point } from "../src/api/types";
import { moveWall, nudge, resizeRoom, translateRoom, wallGroup, wallOffset, wallSelection } from "../src/editor/ops";
import {
  boxMap,
  boxOf,
  doorCentre,
  edgeNormal,
  handlePoint,
  isRectangle,
  offsetEdges,
  rectangle,
  resizeBox,
  snapValue,
  validate,
  type Box,
} from "../src/geometry";
import { exportName, exportText } from "../src/views/plan-editor";
import { MOCK_PLAN } from "../mock/backend";

function plan(): Plan {
  return structuredClone(MOCK_PLAN);
}

function room(p: Plan, id: string): Point[] {
  return p.rooms.find((r) => r.id === id)!.outline;
}

const box: Box = [0, 0, 4, 2];

describe("resize box", () => {
  it("places handles on corners and side middles, pushed out by the padding", () => {
    expect(handlePoint(box, "nw")).toEqual([0, 0]);
    expect(handlePoint(box, "e")).toEqual([4, 1]);
    expect(handlePoint(box, "s", 0.5)).toEqual([2, 2.5]);
    expect(handlePoint(box, "ne", 0.5)).toEqual([4.5, -0.5]);
  });

  it("scales against the opposite corner", () => {
    expect(resizeBox(box, "se", [6, 3])).toEqual([0, 0, 6, 3]);
    expect(resizeBox(box, "nw", [-1, -1])).toEqual([-1, -1, 5, 3]);
    expect(resizeBox(box, "ne", [5, -2])).toEqual([0, -2, 5, 4]);
  });

  it("moves only one side with a side handle", () => {
    expect(resizeBox(box, "e", [5, 40])).toEqual([0, 0, 5, 2]);
    expect(resizeBox(box, "n", [-30, -1])).toEqual([0, -1, 4, 3]);
  });

  it("keeps proportions with the larger of the two scales", () => {
    expect(resizeBox(box, "se", [8, 2.5], { keepRatio: true })).toEqual([0, 0, 8, 4]);
    expect(resizeBox(box, "se", [4.5, 3], { keepRatio: true })).toEqual([0, 0, 6, 3]);
    expect(resizeBox(box, "nw", [-4, 0], { keepRatio: true })).toEqual([-4, -2, 8, 4]);
  });

  it("grows the other axis around the middle with a side handle and proportions", () => {
    expect(resizeBox(box, "e", [8, 0], { keepRatio: true })).toEqual([0, -1, 8, 4]);
  });

  it("scales from the centre", () => {
    expect(resizeBox(box, "e", [5, 0], { fromCentre: true })).toEqual([-1, 0, 6, 2]);
    expect(resizeBox(box, "se", [5, 3], { fromCentre: true })).toEqual([-1, -1, 6, 4]);
    expect(resizeBox(box, "se", [6, 1], { fromCentre: true, keepRatio: true })).toEqual([-2, -1, 8, 4]);
  });

  it("does not flip or collapse past the minimum size", () => {
    expect(resizeBox(box, "e", [-3, 0], { min: 0.5 })).toEqual([0, 0, 0.5, 2]);
    expect(resizeBox(box, "w", [9, 0], { min: 0.5 })).toEqual([3.5, 0, 0.5, 2]);
    expect(resizeBox(box, "e", [1, 0], { min: 0.5, fromCentre: true })).toEqual([1.75, 0, 0.5, 2]);
  });

  it("maps points from one box to another", () => {
    const map = boxMap(box, [1, 1, 8, 1]);
    expect(map([4, 2])).toEqual([9, 2]);
    expect(map([2, 1])).toEqual([5, 1.5]);
  });
});

describe("snapping a coordinate", () => {
  it("prefers a nearby edge of another room over the grid", () => {
    expect(snapValue(3.07, 0.25, [3.1, 9], 0.1)).toEqual({ value: 3.1, guide: 3.1 });
    expect(snapValue(3.07, 0.25, [9], 0.1)).toEqual({ value: 3, guide: null });
    expect(snapValue(3.07, 0, [], 0.1)).toEqual({ value: 3.07, guide: null });
  });
});

describe("moving edges", () => {
  it("keeps the neighbouring right angles of a rectangle", () => {
    const next = offsetEdges(rectangle([0, 0], [4, 3]), new Map([[1, [0.5, 0] as Point]]));
    expect(next).toEqual([
      [0, 0],
      [4.5, 0],
      [4.5, 3],
      [0, 3],
    ]);
  });

  it("slides the ends along slanted neighbours", () => {
    const trapezoid: Point[] = [
      [0, 0],
      [4, 0],
      [3, 2],
      [1, 2],
    ];
    const next = offsetEdges(trapezoid, new Map([[2, [0, 1] as Point]]));
    expect(next[2]![0]).toBeCloseTo(2.5);
    expect(next[2]![1]).toBeCloseTo(3);
    expect(next[3]![0]).toBeCloseTo(1.5);
    expect(next[3]![1]).toBeCloseTo(3);
  });

  it("tells rectangles apart and gives the left normal", () => {
    expect(isRectangle(rectangle([0, 0], [2, 1]))).toBe(true);
    expect(isRectangle([[0, 0], [2, 0], [1, 1]])).toBe(false);
    expect(edgeNormal([0, 0], [2, 0])).toEqual([-0, 1]);
  });
});

describe("resizing a room", () => {
  it("scales the outline and the bulbs inside it", () => {
    const next = resizeRoom(plan(), "office", [2, 4, 6, 3]);
    expect(room(next, "office")).toEqual(rectangle([2, 4], [8, 7]));
    expect(next.bulbs.find((b) => b.ieee.endsWith("4"))).toMatchObject({ x: 5, y: 5.5 });
    expect(next.bulbs.find((b) => b.ieee.endsWith("1"))).toMatchObject({ x: 1.5, y: 1.5 });
  });

  it("leaves neighbours alone and the checks see the overlap", () => {
    const next = resizeRoom(plan(), "living", [0, 0, 6, 4]);
    expect(room(next, "hall")).toEqual(room(plan(), "hall"));
    expect(validate(next).some((i) => i.code === "overlapping_rooms" && i.room === "living" && i.other === "hall")).toBe(true);
  });

  it("keeps the door on a shared wall that stays shared", () => {
    const next = resizeRoom(plan(), "living", [0, -1, 5, 5]);
    expect(next.doors).toHaveLength(2);
  });

  it("leaves a door where it is when its wall does not move, inside what is left of the shared wall", () => {
    const next = resizeRoom(plan(), "living", [0, -1, 5, 5]);
    expect(doorCentre(next, next.doors[0]!)).toEqual([5, 2.4]);
    const inside = resizeRoom(plan(), "living", [0, 2, 5, 2]);
    expect(doorCentre(inside, inside.doors[0]!)).toEqual([5, 2.45]);
    const past = resizeRoom(plan(), "living", [0, 3, 5, 1]);
    expect(doorCentre(past, past.doors[0]!)).toEqual([5, 3.55]);
  });
});

describe("moving a wall", () => {
  it("finds every room on the same wall line", () => {
    const p = plan();
    expect(wallGroup(p, "living", 1).map(([r, e]) => p.rooms[r]!.id + e)).toEqual(["living1", "hall3", "office1"]);
    expect(wallGroup(p, "living", 1, false)).toEqual([[0, 1]]);
  });

  it("moves a shared wall in every room on it, with its doors", () => {
    const p = plan();
    const offset = wallOffset(p, "living", 1, [0.5, 0]);
    expect(offset).toBeCloseTo(-0.5);
    const next = moveWall(p, "living", 1, offset);
    expect(room(next, "living")).toEqual(rectangle([0, 0], [5.5, 4]));
    expect(room(next, "hall")).toEqual(rectangle([5.5, 0], [7, 6]));
    expect(room(next, "office")).toEqual(rectangle([2, 4], [5.5, 7]));
    expect(next.doors).toHaveLength(2);
    expect(doorCentre(next, next.doors[0]!)).toEqual([5.5, 2.4]);
    expect(validate(next).some((i) => i.code === "overlapping_rooms")).toBe(false);
  });

  it("moves only this room's wall when detached", () => {
    const p = plan();
    const next = moveWall(p, "living", 1, wallOffset(p, "living", 1, [-1, 0]), false);
    expect(room(next, "living")).toEqual(rectangle([0, 0], [4, 4]));
    expect(room(next, "hall")).toEqual(room(p, "hall"));
  });

  it("refuses to fold a room over itself", () => {
    const p = plan();
    expect(moveWall(p, "living", 1, wallOffset(p, "living", 1, [-6, 0]))).toBe(p);
  });

  it("nudges a selected wall across itself only", () => {
    const p = plan();
    const next = nudge(p, wallSelection(p, 0), [0.1, 0.3]);
    expect(room(next, "hall")[0]).toEqual([5.1, 0]);
  });
});

describe("moving a room", () => {
  it("takes the doors on its walls along when the wall stays shared", () => {
    const p = plan();
    const next = translateRoom(p, "living", [0, 0.5]);
    expect(room(next, "living")).toEqual(rectangle([0, 0.5], [5, 4.5]));
    expect(next.doors).toHaveLength(2);
    expect(doorCentre(next, next.doors[0]!)).toEqual([5, 2.9]);
    expect(next.bulbs.find((b) => b.ieee.endsWith("1"))).toMatchObject({ x: 1.5, y: 2 });
  });

  it("drops a door whose wall is no longer shared", () => {
    const next = translateRoom(plan(), "living", [-1, 0]);
    expect(next.doors).toHaveLength(1);
  });
});

describe("export", () => {
  it("names the file after the day and writes the plan as JSON", () => {
    expect(exportName(new Date(2026, 10, 5, 23, 59))).toBe("outglow-plan-2026-11-05.json");
    const p = plan();
    expect(JSON.parse(exportText(p))).toEqual(p);
    expect(boxOf(JSON.parse(exportText(p)).rooms[0].outline)).toEqual([0, 0, 5, 4]);
  });
});

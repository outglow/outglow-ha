import { describe, expect, it } from "vitest";
import type { Plan, Point, Room } from "../src/api/types";
import {
  addDoor,
  cutCorner,
  emptyPlan,
  insertVertex,
  mergedArea,
  mergeRooms,
  mergeTrouble,
  moveWall,
  normalize,
  nudge,
  nudgeSelection,
  remove,
  removeCorner,
  resizeRoom,
  retireGone,
  setWallKind,
  trackSelection,
  vertexSelection,
} from "../src/editor/ops";
import { doorCentre, project, rectangle, validate, wallPairs } from "../src/geometry";

function room(id: string, outline: Point[], area_id: string | null = null): Room {
  return { id, name: id, outline, colour: "#4e9af1", area_id, entrance: false };
}

function plan(...rooms: Room[]): Plan {
  return normalize({ ...emptyPlan(), rooms });
}

function outlines(p: Plan | null): Record<string, Point[]> {
  return Object.fromEntries((p?.rooms ?? []).map((r) => [r.id, r.outline]));
}

const L: Point[] = [
  [0, 0],
  [6, 0],
  [6, 3],
  [3, 3],
  [3, 6],
  [0, 6],
];

describe("removing a corner", () => {
  it("joins the two walls beside it", () => {
    expect(outlines(removeCorner(plan(room("l", L)), "l", 3))).toEqual({
      l: [
        [0, 0],
        [6, 0],
        [6, 3],
        [3, 6],
        [0, 6],
      ],
    });
  });

  it("keeps at least three corners", () => {
    const p = plan(room("t", [[0, 0], [4, 0], [0, 3]]));
    expect(removeCorner(p, "t", 1)).toBeNull();
    expect(remove(p, { kind: "vertex", id: "t", index: 1, at: [4, 0] })).toBe(p);
  });

  it("goes in both rooms when it is a bend in the wall they share, which stays shared", () => {
    const p = plan(
      room("a", [[0, 0], [4, 0], [4.5, 1.5], [4, 3], [0, 3]]),
      room("b", [[4, 0], [8, 0], [8, 3], [4, 3], [4.5, 1.5]]),
    );
    const next = removeCorner(p, "a", 2)!;
    expect(outlines(next)).toEqual({ a: rectangle([0, 0], [4, 3]), b: [[4, 0], [8, 0], [8, 3], [4, 3]] });
    expect(wallPairs(next)).toEqual(["a|b"]);
  });

  it("goes in both rooms at the inner corner of an L with a room in its notch", () => {
    const next = removeCorner(plan(room("l", L), room("n", rectangle([3, 3], [6, 6]))), "l", 3)!;
    expect(outlines(next)).toEqual({
      l: [
        [0, 0],
        [6, 0],
        [6, 3],
        [3, 6],
        [0, 6],
      ],
      n: [
        [6, 3],
        [6, 6],
        [3, 6],
      ],
    });
    expect(validate(next).filter((i) => i.code === "overlapping_rooms")).toEqual([]);
  });

  it("goes only in the chosen room at the end of a shared wall", () => {
    const p = plan(room("a", rectangle([0, 0], [4, 3])), room("b", rectangle([4, 0], [8, 3])));
    expect(outlines(removeCorner(p, "a", 1))).toEqual({
      a: [
        [0, 0],
        [4, 3],
        [0, 3],
      ],
      b: rectangle([4, 0], [8, 3]),
    });
  });

  it("stays when the room would run over its neighbour", () => {
    expect(removeCorner(plan(room("l", L), room("n", rectangle([3.5, 3.5], [6, 6]))), "l", 3)).toBeNull();
  });

  it("says why it stays: too few corners, an outline crossing itself, or a neighbour run over", () => {
    expect(cutCorner(plan(room("t", [[0, 0], [4, 0], [0, 3]])), "t", 1)).toBe("min");
    expect(cutCorner(plan(room("h", [[0, 0], [6, 0], [6, 4], [3, 1], [0, 4]])), "h", 1)).toBe("shape");
    expect(cutCorner(plan(room("l", L), room("n", rectangle([3.5, 3.5], [6, 6]))), "l", 3)).toBe("overlap");
    expect(cutCorner(plan(room("l", L)), "l", 3)).toEqual(removeCorner(plan(room("l", L)), "l", 3));
  });

  it("says the corner is not there for a room or a corner that is gone, rather than too few corners", () => {
    const square = plan(room("s", rectangle([0, 0], [2, 2])));
    expect(cutCorner(square, "zz", 0)).toBe("missing");
    expect(cutCorner(square, "s", 9)).toBe("missing");
    expect(cutCorner(plan(room("t", [[0, 0], [2, 0], [0, 2]])), "t", 9)).toBe("missing");
  });
});

describe("a picked corner", () => {
  it("follows its point when a corner is added before it and when that is undone", () => {
    const p = plan(room("r", rectangle([0, 0], [4, 3])));
    const picked = vertexSelection(p, "r", 2);
    expect(picked).toEqual({ kind: "vertex", id: "r", index: 2, at: [4, 3] });
    const added = insertVertex(p, "r", 0, [2, 0]);
    expect(trackSelection(added, picked)).toEqual({ kind: "vertex", id: "r", index: 3, at: [4, 3] });
    expect(trackSelection(p, trackSelection(added, picked))).toEqual(picked);
  });

  it("stays the same corner by its number when a resize moves another corner to where it was", () => {
    const L4: Point[] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
    const p = plan(room("l", L4));
    const picked = vertexSelection(p, "l", 3);
    const resized = resizeRoom(p, "l", [0, 0, 2, 4]);
    expect(resized.rooms[0]!.outline[2]).toEqual([2, 2]);
    expect(trackSelection(resized, picked, p)).toEqual({ kind: "vertex", id: "l", index: 3, at: [1, 2] });
  });

  it("stays the same corner when a wall drag renumbers the corners but keeps their count", () => {
    const p = plan(room("r", [[2, 0], [4, 0], [4, 3], [0, 3], [0, 1], [0, 0]]));
    const picked = vertexSelection(p, "r", 2);
    const moved = moveWall(p, "r", 5, 1);
    expect(moved.rooms[0]!.outline).toEqual([[2, 1], [2, 0], [4, 0], [4, 3], [0, 3], [0, 1]]);
    const after = trackSelection(moved, picked, p);
    expect(after).toEqual({ kind: "vertex", id: "r", index: 3, at: [4, 3] });
    expect(trackSelection(p, after, moved)).toEqual(picked);
  });

  it("moves with the arrows and stays picked", () => {
    const p = plan(room("r", rectangle([0, 0], [4, 3])));
    const picked = vertexSelection(p, "r", 2);
    const moved = nudge(p, picked, [0.5, 0]);
    const after = nudgeSelection(p, moved, picked, [0.5, 0]);
    expect(after).toEqual({ kind: "vertex", id: "r", index: 2, at: [4.5, 3] });
    expect(trackSelection(moved, after)).toEqual(after);
  });

  it("is dropped with its room, and kept by index when its point is gone", () => {
    const p = plan(room("r", rectangle([0, 0], [4, 3])));
    expect(trackSelection(p, { kind: "vertex", id: "gone", index: 0, at: [0, 0] })).toBeNull();
    expect(trackSelection(p, { kind: "vertex", id: "r", index: 1, at: [9, 9] })).toEqual({ kind: "vertex", id: "r", index: 1, at: [4, 0] });
    expect(trackSelection(p, { kind: "vertex", id: "r", index: 7, at: [9, 9] })).toBeNull();
  });
});

describe("merging two rooms", () => {
  it("retires the merged-away room and keeps the ones retired before", () => {
    const saved: Plan = { ...plan(room("a", rectangle([0, 0], [4, 3])), room("b", rectangle([4, 0], [9, 3]))), retired_rooms: ["old"] };
    const result = mergeRooms(saved, "a", "b")!;
    expect(result.plan.retired_rooms).toEqual(["old"]);
    expect(retireGone(result.plan, saved).retired_rooms).toEqual(["a", "old"]);
  });

  it("makes one room of two side by side, without the wall and door between them", () => {
    const base = plan(room("a", rectangle([0, 0], [4, 3])), room("b", rectangle([4, 0], [9, 3])));
    const p: Plan = {
      ...addDoor(base, 0, 0.5).plan,
      bulbs: [{ ieee: "0x0000000000000001", x: 2, y: 1, height: "ceiling", room: "a" }],
    };
    const result = mergeRooms(p, "a", "b")!;
    expect(result.id).toBe("b");
    expect(outlines(result.plan)).toEqual({ b: rectangle([0, 0], [9, 3]) });
    expect(result.plan.doors).toEqual([]);
    expect(result.plan.walls).toEqual([]);
    expect(result.plan.bulbs[0]!.room).toBe("b");
  });

  it("joins a room along part of a wall and keeps the doors to the others", () => {
    const base = plan(room("a", rectangle([0, 0], [6, 2])), room("b", rectangle([0, 2], [3, 5])), room("c", rectangle([3, 2], [6, 5])));
    const index = wallPairs(base).indexOf("b|c");
    const wall = base.walls[index]!;
    const p = {
      ...addDoor(base, index, project([3, 3.5], wall.a, wall.b).t, 0.8).plan,
    };
    const glass = { ...p, walls: p.walls.map((w, i) => (i === wallPairs(p).indexOf("b|c") ? { ...w, kind: "glass" as const } : w)) };
    const result = mergeRooms(glass, "b", "a")!;
    expect(result.id).toBe("a");
    expect(outlines(result.plan).a).toEqual([
      [0, 0],
      [6, 0],
      [6, 2],
      [3, 2],
      [3, 5],
      [0, 5],
    ]);
    expect(wallPairs(result.plan)).toEqual(["a|c", "a|c"]);
    expect(result.plan.walls.map((w) => [w.a[0] === w.b[0] ? "upright" : "across", w.kind]).sort()).toEqual([
      ["across", "partition"],
      ["upright", "glass"],
    ]);
    expect(result.plan.doors).toHaveLength(1);
    expect(doorCentre(result.plan, result.plan.doors[0]!)).toEqual([3, 3.5]);
    expect(result.plan.adjacent).toEqual([["a", "c"]]);
  });

  it("gives the kept room the area of the other when its own is empty or no longer in Home Assistant", () => {
    const a = room("a", rectangle([0, 0], [4, 3]), "gone_area");
    const b = room("b", rectangle([4, 0], [6, 3]), "kitchen");
    const live = new Set(["kitchen", "living"]);
    expect(mergedArea(a, b, live)).toBe("kitchen");
    expect(mergedArea(a, b)).toBe("gone_area");
    expect(mergedArea({ ...a, area_id: "living" }, b, live)).toBe("living");
    expect(mergedArea({ ...a, area_id: "" }, b)).toBe("kitchen");
    expect(mergedArea({ ...a, area_id: "" }, { ...b, area_id: null })).toBeNull();
    expect(mergedArea(a, { ...b, area_id: "other" }, live)).toBe("gone_area");
    expect(mergeRooms(plan(a, b), "a", "b", live)!.plan.rooms[0]!.area_id).toBe("kitchen");
  });

  it("gives the kept room the area of the other when it has none", () => {
    const p = plan(room("a", rectangle([0, 0], [4, 3])), room("b", rectangle([4, 0], [6, 3])));
    const withArea = (keep: string | null, gone: string | null): Plan => ({ ...p, rooms: p.rooms.map((r) => ({ ...r, area_id: r.id === "a" ? keep : gone })) });
    expect(mergeRooms(withArea(null, "kitchen"), "a", "b")!.plan.rooms[0]!.area_id).toBe("kitchen");
    expect(mergeRooms(withArea("living", "kitchen"), "a", "b")!.plan.rooms[0]!.area_id).toBe("living");
  });

  it("says when the wall to a third room had more than one type", () => {
    let p = plan(room("a", rectangle([0, 0], [3, 3])), room("b", rectangle([3, 0], [5, 3])), room("c", rectangle([0, 3], [5, 6])));
    p = setWallKind(p, wallPairs(p).indexOf("a|c"), "glass");
    p = setWallKind(p, wallPairs(p).indexOf("b|c"), "brick");
    expect(mergeRooms(p, "a", "b")!.mixed).toEqual([{ room: "c", kind: "glass" }]);
    const same = setWallKind(p, wallPairs(p).indexOf("b|c"), "glass");
    expect(mergeRooms(same, "a", "b")!.mixed).toEqual([]);
    const apart = plan(room("a", rectangle([0, 0], [3, 3])), room("b", rectangle([3, 0], [6, 3])), room("c", rectangle([0, 3], [3, 6])), room("d", rectangle([3, 3], [6, 6])));
    expect(mergeRooms(setWallKind(apart, wallPairs(apart).indexOf("a|c"), "glass"), "a", "b")!.mixed).toEqual([]);
  });

  it("says why two rooms cannot be merged", () => {
    const big = room("a", rectangle([0, 0], [4, 4]));
    expect(mergeTrouble(plan(big, room("closet", rectangle([3, 0], [4, 1]))), "a", "closet")).toBe("inside");
    expect(mergeTrouble(plan(big, room("over", [[3, 0], [6, 0], [6, 1], [3, 1]])), "a", "over")).toBe("overlap");
    expect(mergeTrouble(plan(big, room("b", rectangle([4, 0], [6, 4]))), "a", "b")).toBeNull();
    expect(mergeTrouble(plan(big, room("far", rectangle([6, 0], [8, 2]))), "a", "far")).toBe("hole");
    expect(mergeTrouble(plan(big), "a", "zz")).toBe("hole");
  });

  it("does not merge rooms that only touch at a corner or not at all", () => {
    const p = plan(room("a", rectangle([0, 0], [2, 2])), room("b", rectangle([2, 2], [4, 4])), room("c", rectangle([6, 0], [8, 2])));
    expect(mergeRooms(p, "a", "b")).toBeNull();
    expect(mergeRooms(p, "a", "c")).toBeNull();
  });

  it("does not merge two rooms that would leave a hole between them", () => {
    const u: Point[] = [
      [0, 0],
      [6, 0],
      [6, 4],
      [4, 4],
      [4, 1],
      [2, 1],
      [2, 4],
      [0, 4],
    ];
    expect(mergeRooms(plan(room("u", u), room("lid", rectangle([0, 4], [6, 5]))), "u", "lid")).toBeNull();
  });
});

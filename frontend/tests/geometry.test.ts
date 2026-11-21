import { describe, expect, it } from "vitest";
import type { Plan, Point } from "../src/api/types";
import {
  area,
  bulbRoom,
  centroid,
  contains,
  deriveWalls,
  doorBetween,
  labelPoint,
  overlaps,
  rectangle,
  roomAt,
  selfIntersects,
  sharedEdges,
  slug,
  snap,
  trailPath,
  validate,
} from "../src/geometry";
import { MOCK_PLAN } from "../mock/backend";

const square: Point[] = rectangle([0, 0], [4, 3]);

function plan(): Plan {
  return structuredClone(MOCK_PLAN);
}

describe("polygons", () => {
  it("measures area and centroid", () => {
    expect(area(square)).toBeCloseTo(12);
    expect(centroid(square)).toEqual([2, 1.5]);
    expect(area([[0, 0], [2, 0], [0, 2]])).toBeCloseTo(2);
  });

  it("tells inside from outside", () => {
    expect(contains(square, [1, 1])).toBe(true);
    expect(contains(square, [5, 1])).toBe(false);
    const ell: Point[] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
    expect(contains(ell, [3, 3])).toBe(false);
    expect(contains(ell, labelPoint(ell))).toBe(true);
  });

  it("finds crossing edges and overlaps but not shared walls", () => {
    expect(selfIntersects([[0, 0], [2, 2], [2, 0], [0, 2]])).toBe(true);
    expect(selfIntersects(square)).toBe(false);
    expect(overlaps(square, rectangle([4, 0], [6, 3]))).toBe(false);
    expect(overlaps(square, rectangle([3, 1], [6, 2]))).toBe(true);
    expect(overlaps(square, rectangle([1, 1], [2, 2]))).toBe(true);
  });
});

describe("snapping", () => {
  const outlines = [square];

  it("snaps to the grid", () => {
    expect(snap([1.234, 2.71], { grid: 0.1, outlines: [], threshold: 0.05 })).toMatchObject({ point: [1.2, 2.7], kind: "grid" });
    expect(snap([1.234, 2.71], { grid: 0.25, outlines: [], threshold: 0.05 }).point).toEqual([1.25, 2.75]);
  });

  it("prefers corners, then walls", () => {
    expect(snap([3.97, 3.02], { grid: 0.1, outlines, threshold: 0.1 })).toMatchObject({ point: [4, 3], kind: "vertex" });
    const edge = snap([4.04, 1.23], { grid: 0.1, outlines, threshold: 0.1 });
    expect(edge.kind).toBe("edge");
    expect(edge.point[0]).toBeCloseTo(4);
    expect(edge.point[1]).toBeCloseTo(1.2);
    expect(edge.guide).toEqual([[4, 0], [4, 3]]);
  });

  it("keeps right angles from the previous corner", () => {
    const s = snap([5.03, 7.2], { grid: 0.1, outlines: [], threshold: 0.1, anchor: [5, 3] });
    expect(s.kind).toBe("angle");
    expect(s.point).toEqual([5, 7.2]);
    const h = snap([8.4, 3.12], { grid: 0.1, outlines: [], threshold: 0.1, anchor: [5, 3] });
    expect(h.point).toEqual([8.4, 3]);
  });

  it("ignores rooms without the magnet", () => {
    expect(snap([3.97, 3.02], { grid: 0.1, outlines, threshold: 0.1, magnet: false }).kind).toBe("grid");
  });
});

describe("walls and doors", () => {
  it("finds shared edges between rooms", () => {
    const edges = sharedEdges(plan().rooms);
    expect(edges.map((e) => e.rooms)).toEqual([
      ["living", "hall"],
      ["living", "office"],
      ["hall", "office"],
    ]);
  });

  it("keeps wall kinds and moves doors to the new walls", () => {
    const p = plan();
    const derived = deriveWalls(p);
    expect(derived.walls.map((w) => w.kind)).toEqual(["partition", "brick", "partition"]);
    expect(derived.doors).toHaveLength(2);
    expect(derived.adjacent).toEqual([
      ["living", "hall"],
      ["hall", "office"],
    ]);
    const reordered: Plan = { ...p, walls: [p.walls[2]!, p.walls[0]!, p.walls[1]!], doors: [{ ...p.doors[0]!, wall: 1 }, { ...p.doors[1]!, wall: 0 }] };
    const again = deriveWalls(reordered);
    expect(again.doors.map((d) => d.wall).sort()).toEqual([0, 2]);
    expect(doorBetween({ ...p, ...derived }, "hall", "office")).not.toBeNull();
    expect(doorBetween({ ...p, ...derived }, "living", "office")).toBeNull();
  });

  it("draws trails through doors", () => {
    expect(trailPath(plan(), "living", "hall")).toHaveLength(3);
    expect(trailPath(plan(), "living", "office")).toHaveLength(2);
    expect(trailPath(plan(), "living", "nope")).toBeNull();
  });
});

describe("rooms and bulbs", () => {
  it("finds the room under a bulb unless overridden", () => {
    const p = plan();
    expect(roomAt(p, [6, 3])).toBe("hall");
    expect(roomAt(p, [9, 9])).toBeNull();
    expect(bulbRoom(p, { ...p.bulbs[0]!, room: "office" })).toBe("office");
  });

  it("puts a point in nested rooms in the smallest, like the backend", () => {
    const big = { id: "big", name: "Big", outline: rectangle([0, 0], [10, 10]), colour: "#4e9af1", area_id: null, entrance: false };
    const small = { ...big, id: "small", name: "Small", outline: rectangle([2, 2], [4, 4]) };
    for (const rooms of [[big, small], [small, big]]) {
      const p = { ...plan(), rooms };
      expect(roomAt(p, [3, 3])).toBe("small");
      expect(roomAt(p, [8, 8])).toBe("big");
    }
  });

  it("validates the plan", () => {
    const p = plan();
    expect(validate(p)).toEqual([]);
    const broken: Plan = {
      ...p,
      rooms: [...p.rooms, { id: "x", name: "X", outline: rectangle([2.2, 0.2], [3, 1]), colour: "#000", area_id: null, entrance: false }],
      bulbs: [...p.bulbs, { ieee: "0x0000000000000009", x: 20, y: 20, height: "ceiling", room: null }],
    };
    const codes = validate(broken).map((i) => i.code);
    expect(codes).toContain("overlapping_rooms");
    expect(codes).toContain("bulb_outside_rooms");
    expect(codes).toContain("room_without_bulb");
    expect(validate({ ...p, rooms: [], bulbs: [] }).map((i) => i.code)).toEqual(["no_rooms", "no_bulbs"]);
  });

  it("makes stable ids from names", () => {
    expect(slug("Łazienka główna", [])).toBe("lazienka_glowna");
    expect(slug("Hall", ["hall"])).toBe("hall_2");
    expect(slug("!!!", [])).toBe("room");
    expect(slug("Sypialnia", ["sypialnia", "sypialnia_2"])).toBe("sypialnia_3");
  });
});

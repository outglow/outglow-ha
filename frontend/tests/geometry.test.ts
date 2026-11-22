import { describe, expect, it } from "vitest";
import type { Door, Plan, Point, Room } from "../src/api/types";
import {
  area,
  bulbRoom,
  centroid,
  contains,
  deriveWalls,
  doorBetween,
  encloses,
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
  wallPairs,
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
    expect(overlaps(square, rectangle([1, 1], [2, 2]))).toBe(false);
  });

  it("warns about rooms that share part of their floor, like the import check, and lets one sit inside another", () => {
    const ell: Point[] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
    const thin: Point[] = [[0, 0], [4, 0], [4, 0.5], [0.5, 0.5], [0.5, 4], [0, 4]];
    const notch = rectangle([0.5, 0.5], [4, 4]);
    expect(contains(notch, centroid(thin))).toBe(true);
    expect(overlaps(thin, notch)).toBe(false);
    expect(overlaps(notch, thin)).toBe(false);
    expect(overlaps(ell, rectangle([1, 1], [4, 4]))).toBe(false);
    expect(overlaps(ell, rectangle([0.5, 0.5], [2, 2]))).toBe(true);
    expect(overlaps(rectangle([0, 0], [2, 2]), rectangle([1, 1], [3, 3]))).toBe(true);
    expect(overlaps(rectangle([0, 0], [4, 1]), rectangle([1, -1], [2, 2]))).toBe(true);
    expect(overlaps([[0, 0], [2, 0], [2, 2]], rectangle([1, 0], [3, 2]))).toBe(true);
    expect(overlaps([[0, 0], [2, 2], [0, 2]], [[0, 0], [2, 0], [2, 2], [1, 1]])).toBe(false);
    expect(overlaps(rectangle([0, 0], [5, 5]), rectangle([1, 1], [2, 2]))).toBe(false);
    expect(overlaps(rectangle([1, 1], [2, 2]), rectangle([0, 0], [5, 5]))).toBe(false);
    expect(overlaps(rectangle([0, 0], [5, 5]), rectangle([0, 0], [2, 5]))).toBe(false);
    expect(overlaps(rectangle([0, 0], [2, 2]), rectangle([0, 0], [2, 2]))).toBe(false);
    expect(overlaps([[0, 0], [2, 0], [2, 2]], rectangle([0, 0], [2, 2]))).toBe(false);
    expect(overlaps(ell, rectangle([0, 0], [1, 1]))).toBe(false);
    expect(encloses(ell, rectangle([0, 0], [2, 2]))).toBe(false);
  });
});

describe("corners on slanted walls", () => {
  const slope: Point[] = [[0, 0], [3.7, 0], [0, 2.3]];
  const n = Math.hypot(3.7, 2.3);
  const onSlope = (t: number, off: number): Point => [3.7 * (1 - t) + (off * 2.3) / n, 2.3 * t + (off * 3.7) / n];

  it("takes a corner within a millimetre of a slanted wall as on it, like the backend", () => {
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const off of [-0.0004, 0.00005, 0.0004, 0.0009]) {
        const p = onSlope(t, off);
        expect(overlaps(slope, [[0, 0], [p[0], 0], p, [0, p[1]]])).toBe(false);
        const q = onSlope(t + 0.05, -off);
        expect(overlaps(slope, [p, [p[0] + 2, p[1] + 2], [q[0] + 2, q[1] + 2], q])).toBe(false);
      }
      const p = onSlope(t, 0.01);
      expect(overlaps(slope, [[0, 0], [p[0], 0], p, [0, p[1]]])).toBe(true);
    }
  });

  it("does not warn after snapping a corner to a slanted wall", () => {
    for (let i = 1; i < 60; i += 1) {
      const t = i / 60;
      const p = snap([3.7 * (1 - t) + 0.004, 2.3 * t + 0.003], { grid: 0.05, outlines: [slope], threshold: 0.1 }).point;
      expect(overlaps(slope, [[0, 0], [p[0], 0], p, [0, p[1]]])).toBe(false);
    }
  });

  it("checks many detailed rooms for overlap quickly", () => {
    const traced = (cx: number, cy: number, r: number, count: number): Point[] =>
      [0, 1, 2, 3].flatMap((side) =>
        Array.from({ length: count / 4 }, (_, i): Point => {
          const s = (2 * r * i) / (count / 4);
          const [x, y] = ([[-r + s, -r], [r, -r + s], [r - s, r], [-r, r - s]] as Point[])[side]!;
          return [cx + x, cy + y + (side % 2 === 0 ? 0.01 * Math.sin(i * 1.7) : 0)];
        }),
      );
    const rooms = Array.from({ length: 20 }, (_, i) => traced((i % 5) * 4, Math.floor(i / 5) * 4, 1.99, 200));
    const start = process.cpuUsage();
    let hits = 0;
    rooms.forEach((a, i) => rooms.slice(i + 1).forEach((b) => (hits += overlaps(a, b) ? 1 : 0)));
    const used = process.cpuUsage(start);
    expect(hits).toBe(0);
    expect((used.user + used.system) / 1000).toBeLessThan(100);
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

  it("draws trails on a large plan with doors without going over every room each frame", () => {
    let reads = 0;
    const dense = (x: number, y: number): Point[] =>
      ([[x, y], [x + 4, y], [x + 4, y + 4], [x, y + 4], [x, y]] as Point[]).slice(0, 4).flatMap((a, k, all) => {
        const b = all[(k + 1) % 4]!;
        return Array.from({ length: 16 }, (_, i): Point => [a[0] + ((b[0] - a[0]) * i) / 16, a[1] + ((b[1] - a[1]) * i) / 16]);
      });
    const rooms: Room[] = Array.from({ length: 12 }, (_, k) => {
      const outline = dense((k % 4) * 4, Math.floor(k / 4) * 4);
      return {
        id: `r${k}`,
        name: `r${k}`,
        colour: "#000000",
        area_id: null,
        entrance: false,
        get outline() {
          reads += 1;
          return outline;
        },
      };
    });
    const bare = { ...plan(), rooms, walls: [], doors: [], adjacent: [], bulbs: [] };
    const { walls } = deriveWalls(bare);
    const pairs = wallPairs({ rooms, walls });
    const doors: Door[] = walls.flatMap((_, k) => (pairs.indexOf(pairs[k]!) === k ? [{ wall: k, at: 0.5, width: 0.1, kind: "door" as const }] : []));
    const big: Plan = { ...bare, walls, doors };
    expect(trailPath(big, "r0", "r1")).toHaveLength(3);
    reads = 0;
    for (let frame = 0; frame < 3; frame += 1) {
      expect(trailPath(big, "r0", "r11")).toHaveLength(2);
    }
    expect(reads).toBeLessThan(3 * rooms.length);
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
      rooms: [...p.rooms, { id: "x", name: "X", outline: rectangle([4.5, 0.2], [5.5, 1]), colour: "#000", area_id: null, entrance: false }],
      bulbs: [...p.bulbs, { ieee: "0x0000000000000009", x: 20, y: 20, height: "ceiling", room: null }],
    };
    const codes = validate(broken).map((i) => i.code);
    expect(codes).toContain("overlapping_rooms");
    const nested: Plan = { ...p, rooms: [...p.rooms, { id: "x", name: "X", outline: rectangle([2.2, 0.2], [3, 1]), colour: "#000", area_id: null, entrance: false }] };
    expect(validate(nested).map((i) => i.code)).not.toContain("overlapping_rooms");
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

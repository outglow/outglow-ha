import { describe, expect, it } from "vitest";
import type { Plan, Point, Room } from "../src/api/types";
import { emptyPlan, moveSharedWall, moveWall, normalize, nudge, wallSelection, type Selection } from "../src/editor/ops";
import { edges, rectangle, validate } from "../src/geometry";

function room(id: string, outline: Point[]): Room {
  return { id, name: id, outline, colour: "#4e9af1", area_id: null, entrance: false };
}

function plan(...rooms: Room[]): Plan {
  return normalize({ ...emptyPlan(), rooms });
}

const L: Point[] = [
  [0, 0],
  [6, 0],
  [6, 4.5],
  [5, 4.5],
  [5, 6],
  [0, 6],
];

const STAIRS: Point[] = [
  [0, 0],
  [6, 0],
  [6, 2],
  [4, 2],
  [4, 3],
  [2, 3],
  [2, 4],
  [0, 4],
];

const STEPPED: Point[] = [
  [4, 0],
  [8, 0],
  [8, 4],
  [4.03, 4],
  [4.03, 2],
  [4, 2],
];

const LIVING: Point[] = [
  [0, 0],
  [4, 0],
  [4, 1],
  [4.1, 1],
  [4.1, 1.9],
  [4, 1.9],
  [4, 3],
  [1.4, 3],
  [1.4, 3.1],
  [0.5, 3.1],
  [0.5, 3],
  [0, 3],
];

const KITCHEN: Point[] = [
  [4.2, 0],
  [6.2, 0],
  [6.2, 3],
  [4.2, 3],
  [4.2, 1.9],
  [4.1, 1.9],
  [4.1, 1],
  [4.2, 1],
];

const SHAPES: [string, Plan][] = [
  ["an L-shaped room", plan(room("l", L))],
  ["an L-shaped room with a room in its notch", plan(room("l", L), room("n", rectangle([5, 4.5], [6, 6])))],
  ["a room with stairs", plan(room("z", STAIRS))],
  ["two rooms, one with a 3 cm step next to the shared wall", plan(room("a", rectangle([0, 0], [4, 4])), room("b", STEPPED))],
  ["rooms traced from a robot map at 5 cm", plan(room("living", LIVING), room("kitchen", KITCHEN), room("hall", rectangle([0, 3.1], [6.2, 5])))],
];

const OFFSETS = [
  ...Array.from({ length: 81 }, (_, i) => Number((i * 0.05 - 2).toFixed(2))),
  ...[0.01, 0.02, 0.03, 0.04, 0.96, 0.97, 1.46, 1.47, 1.97].flatMap((d) => [d, -d]),
].filter((d) => d !== 0);

function square(outline: Point[]): string[] {
  return edges(outline).flatMap(([a, b]) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const off = (Math.atan2(Math.min(Math.abs(dx), Math.abs(dy)), Math.max(Math.abs(dx), Math.abs(dy))) * 180) / Math.PI;
    return off > 1 ? [`${JSON.stringify(a)}-${JSON.stringify(b)}`] : [];
  });
}

function crooked(next: Plan): string[] {
  return next.rooms.flatMap((r) => square(r.outline).map((e) => `${r.id} ${e}`));
}

type W = Extract<Selection, { kind: "wall" }>;

describe("closing a small step while moving a wall", () => {
  for (const [name, p] of SHAPES) {
    it(`keeps every wall square in ${name}`, () => {
      const bad: string[] = [];
      for (const [r, shape] of p.rooms.entries()) {
        for (const e of edges(shape.outline).keys()) {
          for (const linked of [true, false]) {
            for (const offset of OFFSETS) {
              const next = moveWall(p, shape.id, e, offset, linked);
              bad.push(...crooked(next).map((c) => `room ${r} edge ${e} ${linked ? "linked" : "alone"} by ${offset}: ${c}`));
            }
          }
        }
      }
      for (const w of p.walls.keys()) {
        const sel = wallSelection(p, w) as W;
        for (const offset of OFFSETS) {
          const next = moveSharedWall(p, sel, offset);
          bad.push(...crooked(next).map((c) => `wall ${w} by ${offset}: ${c}`));
          expect(validate(next).filter((i) => i.severity !== "info" && i.code !== "bulb_outside_rooms")).toEqual([]);
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });
  }

  it("closes the step of an L when its wall comes within 5 cm of the far corner", () => {
    const p = plan(room("l", L));
    for (const offset of [-1.45, -1.46, -1.48, -1.5]) {
      expect(moveWall(p, "l", 2, offset).rooms[0]!.outline).toEqual(rectangle([0, 0], [6, 6]));
    }
    expect(moveWall(p, "l", 2, -1.4).rooms[0]!.outline).toEqual([
      [0, 0],
      [6, 0],
      [6, 5.9],
      [5, 5.9],
      [5, 6],
      [0, 6],
    ]);
  });

  it("moves the shared wall onto the neighbour's 3 cm step instead of slanting both rooms", () => {
    const p = plan(room("a", rectangle([0, 0], [4, 4])), room("b", STEPPED));
    const next = nudge(p, wallSelection(p, 0), [0.02, 0]);
    expect(next.rooms.map((r) => r.outline)).toEqual([
      [
        [0, 0],
        [4.03, 0],
        [4.03, 2],
        [4, 2],
        [4, 4],
        [0, 4],
      ],
      rectangle([4.03, 0], [8, 4]),
    ]);
  });

  it("does not pull a wall back towards a corner it moves away from", () => {
    const p = plan(room("l", [[0, 0], [6, 0], [6, 5.97], [5, 5.97], [5, 6], [0, 6]]));
    expect(moveWall(p, "l", 2, 0.01).rooms[0]!.outline).toEqual([
      [0, 0],
      [6, 0],
      [6, 5.96],
      [5, 5.96],
      [5, 6],
      [0, 6],
    ]);
  });

  it("lets a lobe the wall closes fold away", () => {
    const p = plan(room("z", STAIRS));
    expect(moveWall(p, "z", 5, 1.97).rooms[0]!.outline).toEqual([
      [0, 0],
      [6, 0],
      [6, 2],
      [4, 2],
      [4, 3],
      [0, 3],
    ]);
  });
});

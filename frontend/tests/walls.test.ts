import { describe, expect, it } from "vitest";
import type { Plan, Point, Room } from "../src/api/types";
import {
  emptyPlan,
  addDoor,
  lostDoors,
  movedBulbs,
  moveSharedWall,
  moveWall,
  normalize,
  nudge,
  nudgeSelection,
  placeBulb,
  shiftedWall,
  resizeRoom,
  trackSelection,
  translateRoom,
  updateBulb,
  wallIndex,
  wallSelection,
  type Selection,
} from "../src/editor/ops";
import { bulbRoom, doorCentre, offsetEdges, pairKey, project, rectangle, validate, wallPairs } from "../src/geometry";
import { MOCK_PLAN } from "../mock/backend";

function room(id: string, outline: Point[]): Room {
  return { id, name: id, outline, colour: "#4e9af1", area_id: null, entrance: false };
}

function corridor(): Plan {
  const base = normalize({
    ...emptyPlan(),
    rooms: [
      room("hall", [
        [0, 0],
        [6, 0],
        [6, 4],
        [4, 4],
        [4, 1],
        [2, 1],
        [2, 4],
        [0, 4],
      ]),
      room("bath", rectangle([2, 1], [4, 2.5])),
      room("wc", rectangle([2, 2.5], [4, 4])),
    ],
  });
  const index = base.walls.findIndex((w) => w.a[1] === 2.5 && w.b[1] === 2.5);
  return normalize({
    ...base,
    walls: base.walls.map((w, i) => (i === index ? { ...w, kind: "glass" } : w)),
    doors: [{ wall: index, at: 0.5, width: 0.8, kind: "door" }],
  });
}

function glassDoor(plan: Plan): { kind: string; centre: Point | null }[] {
  return plan.doors.map((d) => ({ kind: plan.walls[d.wall]!.kind, centre: doorCentre(plan, d) }));
}

describe("moving a room around two others", () => {
  it("keeps the wall and door between the rooms it surrounds", () => {
    const p = corridor();
    expect(glassDoor(p)).toEqual([{ kind: "glass", centre: [3, 2.5] }]);
    const there = translateRoom(p, "hall", [0, -0.1]);
    expect(glassDoor(there)).toEqual([{ kind: "glass", centre: [3, 2.5] }]);
    expect(glassDoor(translateRoom(there, "hall", [0, 0.1]))).toEqual([{ kind: "glass", centre: [3, 2.5] }]);
  });

  it("keeps them when it is resized", () => {
    const p = corridor();
    const next = resizeRoom(p, "hall", [0, -0.5, 6, 4.5]);
    expect(glassDoor(next)).toEqual([{ kind: "glass", centre: [3, 2.5] }]);
  });
});

describe("moving part of a straight wall", () => {
  const notched: Point[] = [
    [0, 0],
    [2, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ];

  it("steps out from the rest of the line instead of slanting it", () => {
    expect(offsetEdges(notched, new Map([[0, [0, -0.5] as Point]]))).toEqual([
      [0, -0.5],
      [2, -0.5],
      [2, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
  });

  it("does not push into the room on the other side of the rest of the line", () => {
    const p = normalize({ ...emptyPlan(), rooms: [room("a", notched), room("b", rectangle([2, -2], [4, 0]))] });
    const next = moveWall(p, "a", 0, -0.5, false);
    expect(next.rooms[0]!.outline).toEqual([
      [0, -0.5],
      [2, -0.5],
      [2, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
    expect(validate(next).filter((i) => i.code === "overlapping_rooms")).toEqual([]);
  });

  it("treats a bend of a few centimetres as a straight line", () => {
    const bent: Point[] = [
      [0, 0],
      [4, 0],
      [8, 0.02],
      [8, 3],
      [0, 3],
    ];
    const p = normalize({ ...emptyPlan(), rooms: [room("a", bent)] });
    expect(moveWall(p, "a", 0, 0.01).rooms[0]!.outline).toEqual([
      [0, 0.01],
      [4, 0.01],
      [4, 0],
      [8, 0.02],
      [8, 3],
      [0, 3],
    ]);
    expect(moveWall(p, "a", 0, 0.5).rooms[0]!.outline).toEqual([
      [0, 0.5],
      [4, 0.5],
      [4, 0],
      [8, 0.02],
      [8, 3],
      [0, 3],
    ]);
  });

  it("straightens the line again when the step is moved back", () => {
    const p = normalize({ ...emptyPlan(), rooms: [room("a", notched)] });
    const out = moveWall(p, "a", 0, 0.5);
    const back = moveWall(out, "a", 0, -0.5);
    expect(back.rooms[0]!.outline).toEqual([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
  });
});

function threeRooms(): Plan {
  const base = normalize({
    ...emptyPlan(),
    rooms: [room("b", rectangle([4, 0], [8, 3])), room("c", rectangle([0, 3], [3, 6])), room("a", rectangle([0, 0], [4, 3]))],
  });
  return { ...base, walls: base.walls.map((w) => (w.a[1] === 3 && w.b[1] === 3 ? { ...w, kind: "glass" } : w)) };
}

function selected(plan: Plan, selection: Selection): { a: Point; b: Point; kind: string } | null {
  if (selection?.kind !== "wall") return null;
  const wall = plan.walls[wallIndex(plan, selection)];
  if (!wall) return null;
  const [a, b] = [wall.a, wall.b].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return { a: a!, b: b!, kind: wall.kind };
}

describe("a selected wall", () => {
  it("stays selected when the list of walls changes under it", () => {
    const p = threeRooms();
    const sel = wallSelection(p, p.walls.findIndex((w) => w.a[0] === 4 && w.b[0] === 4));
    expect(selected(p, sel)).toMatchObject({ kind: "partition" });
    const next = nudge(p, sel, [-1.2, 0]);
    expect(next.walls).toHaveLength(3);
    const tracked = trackSelection(next, sel);
    expect(selected(next, tracked)).toEqual({ a: [2.8, 0], b: [2.8, 3], kind: "partition" });
    const again = nudge(next, tracked, [-0.1, 0]);
    expect(selected(again, trackSelection(again, tracked))).toMatchObject({ a: [2.7, 0], b: [2.7, 3] });
  });

  it("does not hand its kind to a new piece between other rooms", () => {
    const p = threeRooms();
    const next = nudge(p, wallSelection(p, p.walls.findIndex((w) => w.a[0] === 4)), [-1.2, 0]);
    const kinds = next.walls.map((w) => [[w.a, w.b].sort((p, q) => p[0] - q[0]), w.kind]);
    expect(kinds).toContainEqual([[[2.8, 3], [3, 3]], "partition"]);
    expect(kinds).toContainEqual([[[0, 3], [2.8, 3]], "glass"]);
  });

  it("is forgotten when its rooms no longer touch", () => {
    const p = threeRooms();
    const sel = wallSelection(p, p.walls.findIndex((w) => w.a[0] === 4));
    expect(trackSelection(translateRoom(p, "b", [1, 0]), sel)).toBeNull();
  });
});

describe("dragging the wall between two rooms", () => {
  function mock(): Plan {
    return structuredClone(MOCK_PLAN);
  }

  it("moves only the piece the two rooms share", () => {
    const p = mock();
    const sel = wallSelection(p, 0)!;
    const next = nudge(p, sel, [-1.5, 0]);
    const outline = (id: string) => next.rooms.find((r) => r.id === id)!.outline;
    expect(outline("living")).toEqual(rectangle([0, 0], [3.5, 4]));
    expect(outline("hall")).toEqual([
      [3.5, 0],
      [7, 0],
      [7, 6],
      [5, 6],
      [5, 4],
      [3.5, 4],
    ]);
    expect(outline("office")).toEqual(rectangle([2, 4], [5, 7]));
    expect(next.doors).toHaveLength(2);
  });

  it("lets a bulb the wall passes over go to the other room, and says so", () => {
    const p = mock();
    const next = nudge(p, wallSelection(p, 0), [-1.5, 0]);
    const rooms = Object.fromEntries(next.bulbs.map((b) => [b.ieee.slice(-1), bulbRoom(next, b)]));
    expect(rooms).toEqual({ 1: "living", 2: "hall", 3: "hall", 4: "office" });
    expect(next.bulbs.every((b) => b.room === null)).toBe(true);
    expect(movedBulbs(p, next)).toEqual([{ ieee: "0x0000000000000002", from: "living", to: "hall" }]);
    expect(movedBulbs(p, moveWall(p, "living", 1, 1.5)).map((m) => [m.ieee.slice(-1), m.from, m.to])).toEqual([
      ["2", "living", "hall"],
      ["4", "office", "hall"],
    ]);
  });

  it("keeps a pinned bulb in its room and flags it while it stands in another", () => {
    const p = updateBulb(mock(), "0x0000000000000002", { room: "living" });
    expect(validate(p).filter((i) => i.code === "bulb_pinned_elsewhere")).toEqual([]);
    const next = nudge(p, wallSelection(p, 0), [-1.5, 0]);
    expect(bulbRoom(next, next.bulbs[1]!)).toBe("living");
    expect(movedBulbs(p, next)).toEqual([]);
    expect(validate(next).filter((i) => i.code === "bulb_pinned_elsewhere")).toEqual([
      { code: "bulb_pinned_elsewhere", severity: "warning", bulb: "0x0000000000000002", room: "living", other: "hall" },
    ]);
    const outside: Plan = { ...p, bulbs: p.bulbs.map((b, i) => (i === 0 ? { ...b, x: 20, y: 20, room: "living" } : b)) };
    expect(validate(outside).find((i) => i.code === "bulb_pinned_elsewhere")).toEqual({
      code: "bulb_pinned_elsewhere",
      severity: "warning",
      bulb: "0x0000000000000001",
      room: "living",
    });
  });

  it("unpins a bulb moved by hand into another room, not one moved within its room", () => {
    const p = updateBulb(mock(), "0x0000000000000002", { room: "hall" });
    expect(placeBulb(p, "0x0000000000000002", [3, 2.5]).bulbs[1]!.room).toBe("hall");
    expect(nudge(p, { kind: "bulb", ieee: "0x0000000000000002" }, [0.1, 0]).bulbs[1]!.room).toBe("hall");
    expect(placeBulb(p, "0x0000000000000002", [6, 2.5]).bulbs[1]!.room).toBeNull();
  });
});

describe("a wall dragged far in an L-shaped room", () => {
  function niche(): Plan {
    return normalize({
      ...emptyPlan(),
      rooms: [
        room("l", [
          [0, 0],
          [6, 0],
          [6, 4.5],
          [5, 4.5],
          [5, 6],
          [0, 6],
        ]),
        room("n", rectangle([5, 4.5], [6, 6])),
      ],
    });
  }

  it("stays the wall that was dragged, not the nearest other wall of the two rooms", () => {
    const p = niche();
    const sel = wallSelection(p, p.walls.findIndex((w) => w.a[1] === 4.5 && w.b[1] === 4.5)) as Extract<Selection, { kind: "wall" }>;
    const next = moveSharedWall(p, sel, -1.5 * Math.sign(sel.b[0] - sel.a[0]));
    expect(selected(next, trackSelection(next, shiftedWall(p, sel, -1.5 * Math.sign(sel.b[0] - sel.a[0]))))).toMatchObject({ a: [5, 3], b: [6, 3] });
    const pressed = nudge(p, sel, [0, -1.5]);
    expect(selected(pressed, trackSelection(pressed, nudgeSelection(p, pressed, sel, [0, -1.5])))).toMatchObject({ a: [5, 3], b: [6, 3] });
  });
});

describe("a door next to a moved wall", () => {
  function tee(): Plan {
    const base = normalize({
      ...emptyPlan(),
      rooms: [room("a", rectangle([0, 0], [6, 2])), room("b", rectangle([0, 2], [3, 5])), room("c", rectangle([3, 2], [6, 5]))],
    });
    const index = wallPairs(base).indexOf("b|c");
    const wall = base.walls[index]!;
    return addDoor(base, index, project([3, 2.75], wall.a, wall.b).t, 0.9).plan;
  }

  function doorPairs(plan: Plan): string[] {
    const pairs = wallPairs(plan);
    return plan.doors.map((d) => pairs[d.wall]!);
  }

  it("stays between its two rooms when the wall beside it moves", () => {
    const p = tee();
    expect(doorPairs(p)).toEqual(["b|c"]);
    expect(p.adjacent.map(pairKey)).toEqual(["b|c"]);
    const sel = wallSelection(p, wallPairs(p).indexOf("a|b")) as Extract<Selection, { kind: "wall" }>;
    const next = nudge(p, sel, [0, 0.8]);
    expect(next.rooms.find((r) => r.id === "b")!.outline).toEqual(rectangle([0, 2.8], [3, 5]));
    expect(doorPairs(next)).toEqual(["b|c"]);
    expect(next.adjacent.map(pairKey)).toEqual(["b|c"]);
    const centre = doorCentre(next, next.doors[0]!)!;
    expect(centre[0]).toBeCloseTo(3, 6);
    expect(centre[1]).toBeCloseTo(3.25, 3);
    expect(lostDoors(p, next)).toEqual([]);
  });

  it("goes, and says so, when its two rooms no longer share a wall", () => {
    const p = tee();
    const next = translateRoom(p, "c", [1, 0]);
    expect(next.doors).toEqual([]);
    expect(next.adjacent.map(pairKey)).toEqual(["b|c"]);
    expect(lostDoors(p, next)).toEqual([["b", "c"]]);
  });
});

describe("a slanted wall two rooms share, with a slight bend at one end", () => {
  function slant(): Plan {
    return normalize({
      ...emptyPlan(),
      rooms: [
        room("a", [
          [0, -3],
          [8, -3],
          [8, 1.5],
          [4, 1],
          [0, 0],
        ]),
        room("b", [
          [0, 0],
          [4, 1],
          [4, 4],
          [0, 4],
        ]),
      ],
    });
  }

  it("moves the same in both rooms, leaving no gap", () => {
    const p = slant();
    const next = moveWall(p, "b", 0, 0.3);
    const b = next.rooms.find((r) => r.id === "b")!.outline;
    const a = next.rooms.find((r) => r.id === "a")!.outline;
    expect(b).toEqual([
      [0, 0.309],
      [4, 1.309],
      [4, 4],
      [0, 4],
    ]);
    expect(a).toEqual([
      [0, -3],
      [8, -3],
      [8, 1.5],
      [4, 1],
      [4, 1.309],
      [0, 0.309],
    ]);
    expect(validate(next).filter((i) => i.code === "overlapping_rooms")).toEqual([]);
    expect(moveWall(next, "b", 0, -0.3).rooms).toEqual(p.rooms);
  });

  it("comes back exactly after moving there and back again and again", () => {
    const p = slant();
    let plan = p;
    let sel = wallSelection(plan, 0) as Extract<Selection, { kind: "wall" }>;
    for (let i = 0; i < 6; i += 1) {
      const offset = i % 2 === 0 ? 0.3 : -0.3;
      const next = moveSharedWall(plan, sel, offset);
      sel = trackSelection(next, shiftedWall(plan, sel, offset)) as Extract<Selection, { kind: "wall" }>;
      plan = next;
      const a = plan.rooms.find((r) => r.id === "a")!.outline;
      const b = plan.rooms.find((r) => r.id === "b")!.outline;
      expect(b.filter((v) => !a.some((w) => w[0] === v[0] && w[1] === v[1]))).toHaveLength(2);
    }
    expect(plan.rooms).toEqual(p.rooms);
    expect(plan.walls).toEqual(p.walls);
  });

  const shapes: [string, Point, number, number][] = [
    ["a bend of 7°", [4, 1], 1.5, 0],
    ["a bend of 14°", [4, 1.3], 1.6, 0],
    ["a bend of 17° the other way", [4, 1], 0.8, 0],
    ["a steep wall", [5, 2], 2.4, 0],
    ["a slanted side on one room", [4, 1], 1.5, 0.7],
    ["a slanted side leaning back", [4, 1], 1.5, -0.7],
  ];
  for (const [name, corner, rise, lean] of shapes) {
    it(`comes back exactly with ${name}`, () => {
      const p = normalize({
        ...emptyPlan(),
        rooms: [
          room("a", [[0, -3], [8, -3], [8, rise], corner, [0, 0]]),
          room("b", [[0, 0], corner, [corner[0] + lean, 4], [0, 4]]),
        ],
      });
      for (const offset of [0.1, -0.1, 0.3, -0.05]) {
        let plan = p;
        let sel = wallSelection(plan, 0) as Extract<Selection, { kind: "wall" }>;
        let steps = 0;
        for (const way of [1, -1]) {
          for (let i = 0; i < (way > 0 ? 5 : steps); i += 1) {
            const next = moveSharedWall(plan, sel, offset * way);
            if (next === plan) break;
            if (way > 0) steps += 1;
            sel = trackSelection(next, shiftedWall(plan, sel, offset * way)) as Extract<Selection, { kind: "wall" }>;
            plan = next;
            expect(validate(plan).filter((issue) => issue.severity !== "info")).toEqual([]);
          }
        }
        expect(plan.rooms).toEqual(p.rooms);
      }
    });
  }
});

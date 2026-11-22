import { describe, expect, it } from "vitest";
import type { Plan } from "../src/api/types";
import {
  addDoor,
  addRoom,
  doorSelection,
  edgeLengths,
  emptyPlan,
  importPlan,
  linkedVertices,
  looksRetired,
  moveVertex,
  nearestWall,
  normalize,
  nudge,
  placeBulb,
  remove,
  removeBulb,
  removeRoom,
  sameContent,
  samePlan,
  retiredOver,
  retireGone,
  reviveRetired,
  setEdgeLength,
  setWallKind,
  trackSelection,
  translateRoom,
  updateBulb,
  updateDoor,
  updateRoom,
  wallSelection,
} from "../src/editor/ops";
import { History } from "../src/editor/undo";
import { rectangle } from "../src/geometry";
import { warningText } from "../src/views/plan-editor";
import { MOCK_PLAN } from "../mock/backend";

function plan(): Plan {
  return structuredClone(MOCK_PLAN);
}

describe("rooms", () => {
  it("adds a room with a fresh id and colour and derives the shared wall", () => {
    const { plan: next, id } = addRoom(plan(), rectangle([7, 0], [10, 3]), "Kitchen");
    expect(id).toBe("kitchen");
    const room = next.rooms.at(-1)!;
    expect(room.colour).toBe("#e2598b");
    expect(next.walls).toHaveLength(4);
    expect(next.walls.at(-1)).toMatchObject({ kind: "partition" });
    expect(next.doors).toHaveLength(2);
  });

  it("moves shared corners of neighbouring rooms together", () => {
    const p = plan();
    expect(linkedVertices(p, [5, 4])).toEqual([
      [0, 2],
      [2, 1],
    ]);
    const moved = moveVertex(p, "living", 2, [5.5, 4]);
    expect(moved.rooms[0]!.outline[2]).toEqual([5.5, 4]);
    expect(moved.rooms[2]!.outline[1]).toEqual([5.5, 4]);
    const alone = moveVertex(p, "living", 2, [5.5, 4], false);
    expect(alone.rooms[2]!.outline[1]).toEqual([5, 4]);
  });

  it("sets an edge length along the edge", () => {
    const { plan: p } = addRoom(emptyPlan(), rectangle([0, 0], [3, 2]), "A");
    const next = setEdgeLength(p, "a", 0, 4.25);
    expect(edgeLengths(next.rooms[0]!.outline)[0]).toBeCloseTo(4.25);
    expect(next.rooms[0]!.outline[1]).toEqual([4.25, 0]);
  });

  it("moves a room with its bulbs and keeps walls derived", () => {
    const p = plan();
    const moved = translateRoom(p, "office", [0, 1]);
    expect(moved.rooms[2]!.outline[0]).toEqual([2, 5]);
    expect(moved.bulbs.find((b) => b.ieee.endsWith("4"))).toMatchObject({ x: 3.5, y: 6.5 });
    expect(moved.walls.some((w) => w.kind === "brick")).toBe(false);
  });

  it("removes a room and the bulbs' override", () => {
    const p = updateBulb(plan(), "0x0000000000000003", { room: "hall" });
    const next = removeRoom(p, "hall");
    expect(next.rooms.map((r) => r.id)).toEqual(["living", "office"]);
    expect(next.bulbs.find((b) => b.ieee.endsWith("3"))!.room).toBeNull();
    expect(next.doors).toHaveLength(0);
    expect(next.adjacent).toEqual([]);
    expect(next.retired_rooms).toEqual(["hall"]);
  });

  it("never gives a new room the id of a removed one", () => {
    const gone = removeRoom(plan(), "office");
    const { plan: next, id } = addRoom(gone, rectangle([2, 4], [5, 7]), "Office");
    expect(id).toBe("office_2");
    expect(next.retired_rooms).toEqual(["office"]);
    const saved = { ...plan(), retired_rooms: ["office_2"] };
    expect(addRoom(removeRoom(saved, "office"), rectangle([2, 4], [5, 7]), "Office").id).toBe("office_3");
  });
});

describe("doors and walls", () => {
  it("adds a door on the nearest wall and derives adjacency", () => {
    const p = normalize(plan());
    const wall = nearestWall(p, [3.5, 4.05], 0.2)!;
    expect(p.walls[wall.index]!.kind).toBe("brick");
    const { plan: next, index } = addDoor(p, wall.index, wall.at, 0.8);
    expect(next.doors[index]).toMatchObject({ width: 0.8, kind: "door" });
    expect(next.adjacent.map((a) => [...a].sort().join("|"))).toContain("living|office");
  });

  it("keeps doors within their wall", () => {
    const p = normalize(plan());
    const moved = updateDoor(p, 0, { at: 0.99 });
    const wall = moved.walls[moved.doors[0]!.wall]!;
    const length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
    expect(moved.doors[0]!.at).toBeCloseTo(1 - 0.45 / length);
    const nudged = nudge(p, doorSelection(p, 0), [0, -0.4]);
    expect(nudged.doors[0]!.at).not.toBe(p.doors[0]!.at);
  });

  it("keeps the same door selected when another door comes back before it", () => {
    const p = normalize(plan());
    const removed = remove(p, doorSelection(p, 0));
    const selected = doorSelection(removed, 0);
    expect(trackSelection(removed, selected)).toMatchObject({ kind: "door", index: 0 });
    expect(trackSelection(p, selected)).toMatchObject({ kind: "door", index: 1 });
    expect(trackSelection(remove(removed, selected), selected)).toBeNull();
  });

  it("changes a wall kind and removes it as no wall", () => {
    const p = normalize(plan());
    expect(setWallKind(p, 1, "concrete").walls[1]!.kind).toBe("concrete");
    expect(remove(p, wallSelection(p, 1)).walls[1]!.kind).toBe("none");
  });
});

describe("bulbs", () => {
  it("places, moves and removes a bulb", () => {
    const placed = placeBulb(plan(), "0x0000000000000005", [1.234, 3.3]);
    expect(placed.bulbs.at(-1)).toEqual({ ieee: "0x0000000000000005", x: 1.234, y: 3.3, height: "ceiling", room: null });
    const moved = placeBulb(placed, "0x0000000000000005", [2, 2]);
    expect(moved.bulbs).toHaveLength(5);
    expect(moved.bulbs.at(-1)).toMatchObject({ x: 2, y: 2 });
    const skipped: Plan = { ...moved, excluded_directions: [{ rx: "0x0000000000000005", tx: "0x0000000000000001", reason: "" }] };
    const gone = removeBulb(skipped, "0x0000000000000005");
    expect(gone.bulbs).toHaveLength(4);
    expect(gone.excluded_directions).toEqual([]);
    expect(nudge(plan(), { kind: "bulb", ieee: "0x0000000000000001" }, [0.1, 0]).bulbs[0]).toMatchObject({ x: 1.6, y: 1.5 });
  });
});

describe("undo history", () => {
  it("undoes, redoes and forgets the future after a new step", () => {
    const h = new History(1);
    h.push(2);
    h.push(3);
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.canUndo).toBe(false);
    expect(h.redo()).toBe(2);
    h.push(9);
    expect(h.canRedo).toBe(false);
    expect(h.present).toBe(9);
  });

  it("keeps at most the limit of steps", () => {
    const h = new History(0, 100);
    for (let i = 1; i <= 150; i += 1) h.push(i);
    expect(h.depth).toBe(100);
    let last = h.present;
    while (h.canUndo) last = h.undo();
    expect(last).toBe(50);
  });

  it("coalesces steps with the same key, like typing a name", () => {
    const h = new History("");
    h.push("S", "name");
    h.push("Sa", "name");
    h.push("Sal", "name");
    expect(h.depth).toBe(1);
    h.push("Salon!", null);
    expect(h.undo()).toBe("Sal");
    expect(h.undo()).toBe("");
  });

  it("drops the step when edits with the same key come back to where they started", () => {
    const h = new History(0);
    h.push(1);
    h.push(2, "nudge");
    h.push(3, "nudge");
    h.push(1, "nudge");
    expect(h.depth).toBe(1);
    expect(h.present).toBe(1);
    expect(h.canRedo).toBe(false);
    h.push(2, "nudge");
    expect(h.depth).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
  });

  it("compares the start of a coalesced step by content", () => {
    const p = plan();
    const h = new History(p, 100, samePlan);
    h.push(nudge(p, { kind: "room", id: "living" }, [0.1, 0]), "nudge");
    h.push(structuredClone(p), "nudge");
    expect(h.canUndo).toBe(false);
    expect(h.present).toBe(p);
    expect(h.key).toBeNull();
  });

  it("adds no step for an edit that changes nothing", () => {
    const p = plan();
    const h = new History(p, 100, samePlan);
    h.push(nudge(p, wallSelection(p, 0), [0, 0.1]), "nudge");
    h.push(updateRoom(p, "living", { name: "Living room" }));
    h.push(normalize(structuredClone(p)));
    expect(h.canUndo).toBe(false);
    expect(h.present).toBe(p);
    h.push(updateRoom(p, "living", { name: "Salon" }));
    expect(h.depth).toBe(1);
  });
});

describe("retired rooms", () => {
  it("renames rooms that came back with a retired id and leaves other plans alone", () => {
    const p = updateBulb(plan(), "0x0000000000000004", { room: "office" });
    const { plan: next, renamed } = reviveRetired(p, ["office"]);
    expect(renamed).toEqual([{ from: "office", to: "office_2", name: "Office" }]);
    expect(next.rooms.map((r) => r.id)).toEqual(["living", "hall", "office_2"]);
    expect(next.bulbs.find((b) => b.ieee.endsWith("4"))!.room).toBe("office_2");
    expect(next.adjacent.flat()).not.toContain("office");
    expect(next.retired_rooms).toEqual(["office"]);
    const untouched = { ...plan(), retired_rooms: ["attic"] };
    expect(reviveRetired(untouched, ["attic"]).plan).toBe(untouched);
    expect(reviveRetired(untouched, ["cellar"]).plan.retired_rooms).toEqual(["attic", "cellar"]);
  });

  it("retires a room that left the plan by any edit, so a room drawn with its name gets a new id", () => {
    const saved = { ...plan(), retired_rooms: ["attic"] };
    const replaced = { ...saved, rooms: saved.rooms.filter((r) => r.id !== "office"), adjacent: saved.adjacent.filter((a) => !a.includes("office")) };
    const next = retireGone(replaced, saved);
    expect(next.retired_rooms).toEqual(["attic", "office"]);
    expect(addRoom(next, rectangle([0, 9], [3, 12]), "Office").id).toBe("office_2");
    expect(retireGone(next, saved)).toBe(next);
    expect(retireGone(saved, saved)).toBe(saved);
    expect(retireGone(replaced, null)).toBe(replaced);
  });

  it("keeping my plan over another client's retires what that client removed or added", () => {
    const base = { ...plan(), retired_rooms: ["attic"] };
    const theirs = { ...base, rooms: [...base.rooms.filter((r) => r.id !== "office"), { ...base.rooms[2]!, id: "room_4", name: "Room 4" }], retired_rooms: ["attic", "office"] };
    const mine = addRoom(base, rectangle([0, 9], [3, 12]), "Room 4");
    expect(mine.id).toBe("room_4");
    const retired = retiredOver(base, theirs);
    expect(retired).toEqual(["attic", "office", "room_4"]);
    const { plan: kept, renamed } = reviveRetired(mine.plan, retired);
    expect(renamed.map((r) => [r.from, r.to])).toEqual([
      ["office", "office_2"],
      ["room_4", "room_4_2"],
    ]);
    expect(kept.rooms.map((r) => r.id)).toEqual(["living", "hall", "office_2", "room_4_2"]);
  });

  it("spots a room named like a retired one", () => {
    const room = { ...plan().rooms[2]!, id: "room_4", name: "Office" };
    expect(looksRetired(room, ["office"])).toBe(true);
    expect(looksRetired(room, ["hall"])).toBe(false);
    expect(looksRetired({ ...room, id: "office" }, ["office"])).toBe(false);
  });
});

describe("import", () => {
  it("takes the imported plan but keeps the editor's revision", () => {
    const current = { ...plan(), rev: 7 };
    const imported = { ...emptyPlan(), rooms: plan().rooms };
    const next = importPlan(current, imported, current).plan;
    expect(next.rev).toBe(7);
    expect(next.rooms).toHaveLength(3);
  });

  it("renames imported rooms whose ids belonged to saved removed rooms", () => {
    const saved = { ...plan(), rooms: plan().rooms.filter((r) => r.id !== "office"), retired_rooms: ["office"], rev: 7 };
    const imported = { ...plan(), retired_rooms: ["attic"], bulbs: plan().bulbs.map((b) => ({ ...b, room: b.ieee.endsWith("4") ? "office" : b.room })) };
    const { plan: next, renamed } = importPlan(saved, imported, saved);
    expect(renamed).toEqual([{ from: "office", to: "office_2", name: "Office" }]);
    expect(next.rooms.map((r) => r.id)).toEqual(["living", "hall", "office_2"]);
    expect(next.bulbs.find((b) => b.ieee.endsWith("4"))!.room).toBe("office_2");
    expect(next.adjacent.flat()).not.toContain("office");
    expect(next.adjacent.flat()).toContain("office_2");
    expect(new Set(next.retired_rooms)).toEqual(new Set(["office", "attic"]));
  });

  it("brings back a room removed only in the editor under its own id", () => {
    const saved = plan();
    const current = removeRoom(saved, "office");
    const { plan: next, renamed } = importPlan(current, saved, saved);
    expect(renamed).toEqual([]);
    expect(next.rooms.map((r) => r.id)).toEqual(["living", "hall", "office"]);
    expect(next.retired_rooms).toEqual([]);
  });

  it("retires the saved rooms the import leaves out and keeps the ones it brings back", () => {
    const current = { ...plan(), rev: 3, retired_rooms: [] };
    const only = { ...emptyPlan(), rooms: plan().rooms.filter((r) => r.id === "living") };
    const first = importPlan(current, only, current).plan;
    expect(first.retired_rooms).toEqual(["hall", "office"]);
    const again = importPlan(first, { ...plan(), retired_rooms: [] }, current);
    expect(again.plan.rooms.map((r) => r.id)).toEqual(["living", "hall", "office"]);
    expect(again.renamed).toEqual([]);
    const gone = { ...current, retired_rooms: ["office"] };
    expect(importPlan(current, plan(), gone).plan.rooms.map((r) => r.id)).toEqual(["living", "hall", "office_2"]);
  });

  it("never gives a new room the id of an old room Home Assistant still knows", () => {
    expect(addRoom(emptyPlan(), rectangle([0, 0], [3, 2]), "Room 1", ["room_1"]).id).toBe("room_1_2");
  });

  it("translates import warnings", () => {
    expect(warningText("pl", { code: "room_simplified", params: { room: "salon", vertices: 120, tolerance_m: 0.2 } })).toBe(
      "Pokój salon miał za dużo narożników; narysowany z 120 narożnikami, z odchyłką do 0,2 m",
    );
    expect(warningText("en", { code: "background_dropped", params: { limit_mb: 10 } })).toBe(
      "The map is too detailed for a background (over 10 MB); it is left out",
    );
    expect(warningText("pl", { code: "unknown_bulb", params: { ieee: "0x09" } })).toBe("Żarówki 0x09 nie ma w Zigbee2MQTT");
    expect(warningText("en", { code: "dropped_field", params: { field: "z2m" } })).toBe("Ignored field z2m");
    expect(warningText("en", { code: "unknown_room", params: { name: "x" } })).toBe("Unknown room x");
    expect(warningText("pl", { code: "dropped_segment", params: { segment: "2", name: null, area_m2: 0.16 } })).toBe(
      "Pominięto fragment mapy 2: tylko 0,16 m²",
    );
    expect(warningText("en", { code: "no_doors", params: {} })).toBe("No doorways found between the rooms; draw the doors yourself");
  });
});

describe("the plan as the server keeps it", () => {
  it("is the same whatever the order of keys and retired rooms, and the revision", () => {
    const p: Plan = { ...structuredClone(MOCK_PLAN), retired_rooms: ["office", "hall"] };
    const server = JSON.parse(JSON.stringify({ ...p, rev: p.rev + 1, retired_rooms: ["hall", "office"] }, (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v,
    )) as Plan;
    expect(samePlan(p, server)).toBe(false);
    expect(sameContent(p, server)).toBe(true);
    expect(sameContent(p, { ...server, rooms: server.rooms.slice(1) })).toBe(false);
    const placed: Plan = { ...p, background: { file: "import.svg", x: 0, y: 0, m_per_px: 0.05, opacity: 0.35 } };
    const stored: Plan = { ...placed, background: { ...placed.background!, file: "plan-0123456789abcdef.svg" } };
    expect(sameContent(placed, stored)).toBe(false);
    expect(sameContent(placed, stored, true)).toBe(true);
    expect(sameContent(placed, p, true)).toBe(false);
  });
});

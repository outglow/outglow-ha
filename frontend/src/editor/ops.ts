import type { BulbHeight, Door, DoorKind, Plan, PlanBulb, Point, Room, RoomId, Wall, WallKind } from "../api/types";
import {
  add,
  area,
  boxMap,
  boxOf,
  bulbRoom,
  contains,
  cross,
  deriveWalls,
  dist,
  dot,
  edgeNormal,
  edges,
  edgesOverlap,
  lerp,
  mul,
  offsetOutline,
  pairKey,
  pointKey,
  project,
  roomAt,
  roundPoint,
  samePoint,
  selfIntersects,
  sharedEdges,
  slug,
  straight,
  sub,
  wallPairs,
  type Box,
} from "../geometry";
import { ROOM_PALETTE } from "../theme";

export type Selection =
  | { kind: "room"; id: RoomId }
  | WallSelection
  | DoorSelection
  | { kind: "bulb"; ieee: string }
  | null;

export type WallSelection = { kind: "wall"; pair: string; a: Point; b: Point };
export type DoorSelection = { kind: "door"; index: number; pair: string; at: Point };

const LINK = 0.002;
const MERGE = 0.05;

export function emptyPlan(): Plan {
  return {
    version: 1,
    rev: 0,
    floor_id: null,
    north_deg: 0,
    view_rotation_deg: 0,
    background: null,
    rooms: [],
    walls: [],
    doors: [],
    adjacent: [],
    bulbs: [],
    excluded_directions: [],
    retired_rooms: [],
  };
}

export function normalize(plan: Plan, walls: readonly (string | null)[] = wallPairs(plan)): Plan {
  const derived = deriveWalls(plan, walls);
  const ids = new Set(plan.rooms.map((r) => r.id));
  const touching = new Set(sharedEdges(plan.rooms).map((e) => pairKey(e.rooms)));
  const pairs = new Map<string, [RoomId, RoomId]>();
  for (const pair of derived.adjacent) {
    pairs.set(pairKey(pair), pair);
  }
  for (const pair of plan.adjacent) {
    const key = pairKey(pair);
    if (ids.has(pair[0]) && ids.has(pair[1]) && pair[0] !== pair[1] && !touching.has(key) && !pairs.has(key)) {
      pairs.set(key, pair);
    }
  }
  return { ...plan, walls: derived.walls, doors: derived.doors, adjacent: [...pairs.values()] };
}

export function nextColour(plan: Plan): string {
  const used = new Set(plan.rooms.map((r) => r.colour.toLowerCase()));
  return ROOM_PALETTE.find((c) => !used.has(c)) ?? ROOM_PALETTE[plan.rooms.length % ROOM_PALETTE.length]!;
}

export function addRoom(plan: Plan, outline: Point[], name: string): { plan: Plan; id: RoomId } {
  const id = slug(name, [...plan.rooms.map((r) => r.id), ...plan.retired_rooms]);
  const room: Room = {
    id,
    name,
    outline: outline.map((p) => roundPoint(p)),
    colour: nextColour(plan),
    area_id: null,
    entrance: false,
  };
  return { plan: normalize({ ...plan, rooms: [...plan.rooms, room] }, wallPairs(plan)), id };
}

export function updateRoom(plan: Plan, id: RoomId, patch: Partial<Pick<Room, "name" | "area_id" | "colour" | "entrance">>): Plan {
  return { ...plan, rooms: plan.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

export function removeRoom(plan: Plan, id: RoomId): Plan {
  return normalize({
    ...plan,
    rooms: plan.rooms.filter((r) => r.id !== id),
    bulbs: plan.bulbs.map((b) => (b.room === id ? { ...b, room: null } : b)),
    adjacent: plan.adjacent.filter((pair) => !pair.includes(id)),
    retired_rooms: [...new Set([...plan.retired_rooms, id])],
  }, wallPairs(plan));
}

export function linkedVertices(plan: Plan, point: Point, tolerance = LINK): [number, number][] {
  const found: [number, number][] = [];
  plan.rooms.forEach((room, r) => {
    room.outline.forEach((v, i) => {
      if (samePoint(v, point, tolerance)) {
        found.push([r, i]);
      }
    });
  });
  return found;
}

function settle(before: Plan, after: Plan): Plan {
  return normalize(after, wallPairs(before));
}

export function movedBulbs(before: Plan, after: Plan): { ieee: string; from: RoomId | null; to: RoomId | null }[] {
  return after.bulbs.flatMap((bulb) => {
    const old = before.bulbs.find((b) => b.ieee === bulb.ieee);
    if (!old || old.x !== bulb.x || old.y !== bulb.y) return [];
    const from = bulbRoom(before, old);
    const to = bulbRoom(after, bulb);
    return from === to ? [] : [{ ieee: bulb.ieee, from, to }];
  });
}

export function lostDoors(before: Plan, after: Plan): [RoomId, RoomId][] {
  const count = (plan: Plan): Map<string, number> => {
    const pairs = wallPairs(plan);
    const counts = new Map<string, number>();
    for (const door of plan.doors) {
      const key = pairs[door.wall];
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const now = count(after);
  return [...count(before)].flatMap(([key, n]) => ((now.get(key) ?? 0) < n ? [key.split("|") as [RoomId, RoomId]] : []));
}

export function moveVertex(plan: Plan, id: RoomId, index: number, to: Point, linked = true): Plan {
  const roomIndex = plan.rooms.findIndex((r) => r.id === id);
  const from = plan.rooms[roomIndex]?.outline[index];
  if (!from) return plan;
  const targets = linked ? linkedVertices(plan, from) : [[roomIndex, index] as [number, number]];
  const point = roundPoint(to);
  const rooms = plan.rooms.map((room, r) => {
    const hits = targets.filter(([tr]) => tr === r).map(([, i]) => i);
    if (hits.length === 0) return room;
    return { ...room, outline: room.outline.map((v, i) => (hits.includes(i) ? point : v)) };
  });
  return settle(plan, { ...plan, rooms });
}

function transformRoom(plan: Plan, id: RoomId, map: (p: Point) => Point, withBulbs: boolean, stretch: boolean): Plan {
  const room = plan.rooms.find((r) => r.id === id);
  if (!room) return plan;
  const moving = new Set(withBulbs ? plan.bulbs.filter((b) => bulbRoom(plan, b) === id).map((b) => b.ieee) : []);
  const sides = edges(room.outline);
  const own = (w: { a: Point; b: Point }): boolean => sides.some(([a, b]) => edgesOverlap(a, b, w.a, w.b));
  const still = (w: Wall, index: number): boolean => {
    const [a, b] = [map(w.a), map(w.b)];
    const doors = plan.doors.filter((d) => d.wall === index).map((d) => lerp(w.a, w.b, d.at));
    return stretch && edgesOverlap(a, b, w.a, w.b) && doors.every((p) => project(p, a, b).d < 0.001);
  };
  return settle(plan, {
    ...plan,
    rooms: plan.rooms.map((r) => (r.id === id ? { ...r, outline: r.outline.map((p) => roundPoint(map(p))) } : r)),
    walls: plan.walls.map((w, i) => (own(w) && !still(w, i) ? { ...w, a: map(w.a), b: map(w.b) } : w)),
    bulbs: plan.bulbs.map((b) => {
      if (!moving.has(b.ieee)) return b;
      const [x, y] = roundPoint(map([b.x, b.y]));
      return { ...b, x, y };
    }),
  });
}

export function translateRoom(plan: Plan, id: RoomId, delta: Point, withBulbs = true): Plan {
  return transformRoom(plan, id, (p) => add(p, delta), withBulbs, false);
}

export function resizeRoom(plan: Plan, id: RoomId, box: Box, withBulbs = true): Plan {
  const room = plan.rooms.find((r) => r.id === id);
  if (!room) return plan;
  return transformRoom(plan, id, boxMap(boxOf(room.outline), box), withBulbs, true);
}

export function wallGroup(plan: Plan, id: RoomId, edge: number, linked = true): [number, number][] {
  const start = plan.rooms.findIndex((r) => r.id === id);
  const room = plan.rooms[start];
  if (!room || !room.outline[edge]) return [];
  const found: [number, number][] = [[start, edge]];
  if (!linked) return found;
  for (let k = 0; k < found.length; k += 1) {
    const [r, e] = found[k]!;
    const [a, b] = edges(plan.rooms[r]!.outline)[e]!;
    plan.rooms.forEach((other, o) => {
      edges(other.outline).forEach(([c, d], i) => {
        if (!found.some(([fr, fe]) => fr === o && fe === i) && edgesOverlap(a, b, c, d)) {
          found.push([o, i]);
        }
      });
    });
  }
  return found;
}

interface Shifted {
  points: Point[];
  loose: Point[];
}

function shiftEdges(outline: Point[], moves: ReadonlyMap<number, Point>, fixed: ReadonlyMap<string, Point>): Shifted | null {
  const { outline: shifted, sides } = offsetOutline(outline, moves, fixed);
  const bad = edges(outline).some(([a, b], e) => {
    const [c, d] = sides[e]!;
    const length = dist(c, d);
    return dist(a, b) >= 0.05 && length > 0.002 && (dot(sub(b, a), sub(d, c)) <= 0 || length < 0.05);
  });
  if (bad) return null;
  const rounded = shifted.map((p) => roundPoint(p));
  const loose = [...moves.keys()].flatMap((e) => [...sides[e]!, outline[e]!, outline[(e + 1) % outline.length]!].map((p) => roundPoint(p)));
  return { points: rounded.filter((p, i) => !samePoint(p, rounded[(i + 1) % rounded.length]!, 0.0005)), loose };
}

function almostStraight(a: Point, v: Point, b: Point): boolean {
  const ab = sub(b, a);
  const length = Math.hypot(ab[0], ab[1]);
  return length > 1e-9 && Math.abs(cross(ab, sub(v, a))) / length <= LINK && dot(sub(v, a), sub(b, v)) > 0;
}

function straighten({ points, loose }: Shifted, shared: (p: Point) => boolean): Point[] {
  let out = points;
  for (;;) {
    const n = out.length;
    const at = out.findIndex((p, i) => {
      const [a, b] = [out[(i - 1 + n) % n]!, out[(i + 1) % n]!];
      return loose.some((q) => samePoint(p, q, 0.0005)) && (straight(a, p, b) || (!shared(p) && almostStraight(a, p, b)));
    });
    if (at < 0 || n <= 3) return out;
    out = out.filter((_, i) => i !== at);
  }
}

interface Shift {
  outline: Point[];
  moves: Map<number, Point>;
}

function shiftRooms(plan: Plan, parts: ReadonlyMap<number, Shift>): Map<number, Point[]> | null {
  const found = new Map<string, { at: Point; rank: number }>();
  const fars = new Map<string, Point[]>();
  for (const { outline, moves } of parts.values()) {
    const [edge, shift] = [...moves][0]!;
    const [a, b] = edges(outline)[edge]!;
    const step = Math.hypot(shift[0], shift[1]);
    const shrinks = step > 0 && contains(outline, add(lerp(a, b, 0.5), mul(shift, 0.001 / step)));
    for (const [key, end] of offsetOutline(outline, moves).ends) {
      const rank = end.miter ? (shrinks ? 2 : 1) : 0;
      const known = found.get(key);
      if (!known || rank > known.rank) found.set(key, { at: end.at, rank });
      fars.set(key, [...(fars.get(key) ?? []), end.far]);
    }
  }
  const vertices = plan.rooms.flatMap((r) => r.outline);
  const settle = (key: string, at: Point): Point => {
    const near = fars.get(key)!.find((p) => samePoint(p, at, MERGE)) ?? vertices.find((v) => samePoint(v, at, LINK));
    return roundPoint(near ?? at);
  };
  const fixed = new Map([...found].map(([key, { at }]): [string, Point] => [key, settle(key, at)]));
  const shifted = new Map<number, Shifted>();
  for (const [r, { outline, moves }] of parts) {
    const next = shiftEdges(outline, moves, fixed);
    if (!next) return null;
    shifted.set(r, next);
  }
  const outlines = plan.rooms.map((room, r) => shifted.get(r)?.points ?? room.outline);
  const moved = new Map<number, Point[]>();
  for (const [r, part] of shifted) {
    const shared = (p: Point): boolean => outlines.some((o, i) => i !== r && o.some((q) => samePoint(p, q, 0.0005)));
    const next = straighten(part, shared);
    if (next.length < 3 || area(next) < 0.05 || selfIntersects(next)) return null;
    moved.set(r, next);
  }
  return moved;
}

export function moveWall(plan: Plan, id: RoomId, edge: number, offset: number, linked = true): Plan {
  const room = plan.rooms.find((r) => r.id === id);
  const pair = room ? edges(room.outline)[edge] : undefined;
  if (!room || !pair || Math.abs(offset) < 1e-9) return plan;
  const shift = mul(edgeNormal(pair[0], pair[1]), offset);
  const group = wallGroup(plan, id, edge, linked);
  const parts = new Map<number, Shift>();
  for (const [r] of group) {
    if (parts.has(r)) continue;
    const moves = new Map(group.filter(([gr]) => gr === r).map(([, e]): [number, Point] => [e, shift]));
    parts.set(r, { outline: plan.rooms[r]!.outline, moves });
  }
  const moved = shiftRooms(plan, parts);
  if (!moved) return plan;
  const lines = group.map(([r, e]) => edges(plan.rooms[r]!.outline)[e]!);
  const onLine = (w: { a: Point; b: Point }): boolean => lines.some(([a, b]) => edgesOverlap(a, b, w.a, w.b));
  return settle(plan, {
    ...plan,
    rooms: plan.rooms.map((r, i) => {
      const outline = moved.get(i);
      return outline ? { ...r, outline } : r;
    }),
    walls: plan.walls.map((w) => (onLine(w) ? { ...w, a: add(w.a, shift), b: add(w.b, shift) } : w)),
  });
}

function splitAlong(outline: Point[], a: Point, b: Point): { outline: Point[]; inside: number[] } {
  const points = edges(outline).flatMap(([p, q]) => {
    if (!edgesOverlap(p, q, a, b)) return [p];
    const cuts = [a, b]
      .map((c) => ({ c, t: project(c, p, q).t }))
      .filter(({ c, t }) => t > 0 && t < 1 && !samePoint(c, p, LINK) && !samePoint(c, q, LINK))
      .sort((x, y) => x.t - y.t)
      .map(({ c }) => c);
    return [p, ...cuts];
  });
  const along = (p: Point): boolean => project(p, a, b).d <= 0.001;
  const inside = edges(points).flatMap(([p, q], e) => (along(p) && along(q) && dist(p, q) > LINK ? [e] : []));
  return { outline: points, inside };
}

export function wallOffset(plan: Plan, id: RoomId, edge: number, delta: Point): number {
  const room = plan.rooms.find((r) => r.id === id);
  const pair = room ? edges(room.outline)[edge] : undefined;
  return pair ? dot(delta, edgeNormal(pair[0], pair[1])) : 0;
}

export function wallSelection(plan: Plan, index: number): Selection {
  const wall = plan.walls[index];
  return wall ? { kind: "wall", pair: wallPairs(plan)[index] ?? "", a: wall.a, b: wall.b } : null;
}

export function wallIndex(plan: Plan, selection: WallSelection): number {
  const pairs = wallPairs(plan);
  const mid = lerp(selection.a, selection.b, 0.5);
  let best = -1;
  let bestD = Infinity;
  plan.walls.forEach((wall, i) => {
    if ((pairs[i] ?? "") !== selection.pair) return;
    const d = dist(lerp(wall.a, wall.b, 0.5), mid) + (edgesOverlap(wall.a, wall.b, selection.a, selection.b) ? 0 : 1000);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

export function doorSelection(plan: Plan, index: number): Selection {
  const door = plan.doors[index];
  const centre = door ? wallPoint(plan, door.wall, door.at) : null;
  return door && centre ? { kind: "door", index, pair: wallPairs(plan)[door.wall] ?? "", at: centre } : null;
}

export function doorIndex(plan: Plan, selection: DoorSelection): number {
  const pairs = wallPairs(plan);
  let best = -1;
  let bestD = Infinity;
  plan.doors.forEach((door, i) => {
    const centre = wallPoint(plan, door.wall, door.at);
    if (!centre || (pairs[door.wall] ?? "") !== selection.pair) return;
    const d = dist(centre, selection.at);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

export function trackSelection(plan: Plan, selection: Selection): Selection {
  if (selection?.kind === "door") {
    const index = doorIndex(plan, selection);
    return index < 0 ? null : doorSelection(plan, index);
  }
  if (selection?.kind !== "wall") return exists(plan, selection) ? selection : null;
  const index = wallIndex(plan, selection);
  return index < 0 ? null : wallSelection(plan, index);
}

export function moveSharedWall(plan: Plan, selection: WallSelection, offset: number): Plan {
  const wall = plan.walls[wallIndex(plan, selection)];
  if (!wall || Math.abs(offset) < 1e-9) return plan;
  const shift = mul(edgeNormal(wall.a, wall.b), offset);
  const parts = new Map<number, Shift>();
  for (const [r, room] of plan.rooms.entries()) {
    const split = splitAlong(room.outline, wall.a, wall.b);
    if (split.inside.length === 0) continue;
    parts.set(r, { outline: split.outline, moves: new Map(split.inside.map((e): [number, Point] => [e, shift])) });
  }
  const moved = shiftRooms(plan, parts);
  if (!moved) return plan;
  return settle(plan, {
    ...plan,
    rooms: plan.rooms.map((r, i) => {
      const outline = moved.get(i);
      return outline ? { ...r, outline } : r;
    }),
    walls: plan.walls.map((w) => (edgesOverlap(wall.a, wall.b, w.a, w.b) ? { ...w, a: add(w.a, shift), b: add(w.b, shift) } : w)),
  });
}

export function shiftedWall(plan: Plan, selection: WallSelection, offset: number): WallSelection {
  const wall = plan.walls[wallIndex(plan, selection)];
  if (!wall) return selection;
  const shift = mul(edgeNormal(wall.a, wall.b), offset);
  return { ...selection, a: add(wall.a, shift), b: add(wall.b, shift) };
}

export function sharedWallOffset(plan: Plan, selection: WallSelection, delta: Point): number {
  const wall = plan.walls[wallIndex(plan, selection)];
  return wall ? dot(delta, edgeNormal(wall.a, wall.b)) : 0;
}

export function insertVertex(plan: Plan, id: RoomId, edge: number, point: Point): Plan {
  return settle(plan, {
    ...plan,
    rooms: plan.rooms.map((r) => {
      if (r.id !== id) return r;
      const outline = [...r.outline];
      outline.splice(edge + 1, 0, roundPoint(point));
      return { ...r, outline };
    }),
  });
}

export function removeVertex(plan: Plan, id: RoomId, index: number): Plan {
  return settle(plan, {
    ...plan,
    rooms: plan.rooms.map((r) => (r.id === id && r.outline.length > 3 ? { ...r, outline: r.outline.filter((_, i) => i !== index) } : r)),
  });
}

export function edgeLengths(outline: Point[]): number[] {
  return edges(outline).map(([a, b]) => dist(a, b));
}

export function setEdgeLength(plan: Plan, id: RoomId, edge: number, length: number): Plan {
  const room = plan.rooms.find((r) => r.id === id);
  if (!room || length <= 0) return plan;
  const n = room.outline.length;
  const a = room.outline[edge % n]!;
  const b = room.outline[(edge + 1) % n]!;
  const current = dist(a, b);
  if (current < 1e-9) return plan;
  const to = add(a, [((b[0] - a[0]) / current) * length, ((b[1] - a[1]) / current) * length]);
  return moveVertex(plan, id, (edge + 1) % n, to);
}

export function placeBulb(plan: Plan, ieee: string, point: Point): Plan {
  const [x, y] = roundPoint(point);
  const existing = plan.bulbs.find((b) => b.ieee === ieee);
  if (existing) {
    const moved = roomAt(plan, [existing.x, existing.y]) !== roomAt(plan, [x, y]);
    return { ...plan, bulbs: plan.bulbs.map((b) => (b.ieee === ieee ? { ...b, x, y, room: moved ? null : b.room } : b)) };
  }
  const bulb: PlanBulb = { ieee, x, y, height: "ceiling", room: null };
  return { ...plan, bulbs: [...plan.bulbs, bulb] };
}

export function updateBulb(plan: Plan, ieee: string, patch: Partial<{ height: BulbHeight; room: RoomId | null }>): Plan {
  return { ...plan, bulbs: plan.bulbs.map((b) => (b.ieee === ieee ? { ...b, ...patch } : b)) };
}

export function removeBulb(plan: Plan, ieee: string): Plan {
  return {
    ...plan,
    bulbs: plan.bulbs.filter((b) => b.ieee !== ieee),
    excluded_directions: plan.excluded_directions.filter((d) => d.rx !== ieee && d.tx !== ieee),
  };
}

export function nearestWall(plan: Plan, point: Point, tolerance: number): { index: number; at: number; d: number } | null {
  let best: { index: number; at: number; d: number } | null = null;
  plan.walls.forEach((wall, index) => {
    const hit = project(point, wall.a, wall.b);
    if (hit.d <= tolerance && (!best || hit.d < best.d)) {
      best = { index, at: hit.t, d: hit.d };
    }
  });
  return best;
}

export function clampDoor(plan: Plan, wallIndex: number, at: number, width: number): { at: number; width: number } {
  const wall = plan.walls[wallIndex];
  if (!wall) return { at, width };
  const length = dist(wall.a, wall.b);
  const w = Math.min(width, length);
  const half = length > 0 ? w / 2 / length : 0.5;
  return { at: Number(Math.min(1 - half, Math.max(half, at)).toFixed(4)), width: Number(w.toFixed(3)) };
}

export function addDoor(plan: Plan, wallIndex: number, at: number, width = 0.9, kind: DoorKind = "door"): { plan: Plan; index: number } {
  const fit = clampDoor(plan, wallIndex, at, width);
  const door: Door = { wall: wallIndex, at: fit.at, width: fit.width, kind };
  const next = normalize({ ...plan, doors: [...plan.doors, door] });
  const index = next.doors.findIndex((d) => d.wall === door.wall && Math.abs(d.at - door.at) < 1e-3);
  return { plan: next, index: index < 0 ? next.doors.length - 1 : index };
}

export function updateDoor(plan: Plan, index: number, patch: Partial<Pick<Door, "at" | "width" | "kind">>): Plan {
  const door = plan.doors[index];
  if (!door) return plan;
  const merged = { ...door, ...patch };
  const fit = clampDoor(plan, merged.wall, merged.at, merged.width);
  return normalize({ ...plan, doors: plan.doors.map((d, i) => (i === index ? { ...merged, ...fit } : d)) });
}

export function removeDoor(plan: Plan, index: number): Plan {
  return normalize({ ...plan, doors: plan.doors.filter((_, i) => i !== index) });
}

export function setWallKind(plan: Plan, index: number, kind: WallKind): Plan {
  return { ...plan, walls: plan.walls.map((w, i) => (i === index ? { ...w, kind } : w)) };
}

export function nudge(plan: Plan, selection: Selection, delta: Point): Plan {
  if (selection?.kind === "room") return translateRoom(plan, selection.id, delta);
  if (selection?.kind === "bulb") {
    const bulb = plan.bulbs.find((b) => b.ieee === selection.ieee);
    return bulb ? placeBulb(plan, bulb.ieee, add([bulb.x, bulb.y], delta)) : plan;
  }
  if (selection?.kind === "wall") return moveSharedWall(plan, selection, sharedWallOffset(plan, selection, delta));
  if (selection?.kind === "door") {
    const door = plan.doors[selection.index];
    const wall = door ? plan.walls[door.wall] : undefined;
    if (!door || !wall) return plan;
    const length = dist(wall.a, wall.b);
    const dir = sub(wall.b, wall.a);
    const along = length > 0 ? (delta[0] * dir[0] + delta[1] * dir[1]) / (length * length) : 0;
    return updateDoor(plan, selection.index, { at: door.at + along });
  }
  return plan;
}

export function nudgeSelection(before: Plan, after: Plan, selection: Selection, delta: Point): Selection {
  if (selection?.kind === "door") return doorSelection(after, selection.index);
  if (selection?.kind === "wall") return shiftedWall(before, selection, sharedWallOffset(before, selection, delta));
  return selection;
}

export function remove(plan: Plan, selection: Selection): Plan {
  if (selection?.kind === "room") return removeRoom(plan, selection.id);
  if (selection?.kind === "bulb") return removeBulb(plan, selection.ieee);
  if (selection?.kind === "door") return removeDoor(plan, selection.index);
  if (selection?.kind === "wall") return setWallKind(plan, wallIndex(plan, selection), "none");
  return plan;
}

export function wallPoint(plan: Plan, index: number, at: number): Point | null {
  const wall = plan.walls[index];
  return wall ? lerp(wall.a, wall.b, at) : null;
}

export function exists(plan: Plan, selection: Selection): boolean {
  if (!selection) return true;
  if (selection.kind === "room") return plan.rooms.some((r) => r.id === selection.id);
  if (selection.kind === "bulb") return plan.bulbs.some((b) => b.ieee === selection.ieee);
  if (selection.kind === "door") return doorIndex(plan, selection) >= 0;
  return wallIndex(plan, selection) >= 0;
}

export function samePlan(a: Plan, b: Plan): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function importPlan(current: Plan, imported: Plan): Plan {
  const retired = new Set([...current.retired_rooms, ...(imported.retired_rooms ?? [])]);
  const taken = [...retired, ...imported.rooms.map((r) => r.id)];
  const ids = new Map<RoomId, RoomId>();
  for (const room of imported.rooms) {
    if (retired.has(room.id)) {
      const id = slug(room.name, taken);
      ids.set(room.id, id);
      taken.push(id);
    }
  }
  const rename = (id: RoomId): RoomId => ids.get(id) ?? id;
  return {
    ...imported,
    version: 1,
    rev: current.rev,
    rooms: imported.rooms.map((r) => ({ ...r, id: rename(r.id) })),
    bulbs: imported.bulbs.map((b) => (b.room === null ? b : { ...b, room: rename(b.room) })),
    adjacent: imported.adjacent.map(([a, b]) => [rename(a), rename(b)]),
    retired_rooms: [...retired],
  };
}

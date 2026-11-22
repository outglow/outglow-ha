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
  EPS,
  edgeNormal,
  edges,
  edgesOverlap,
  encloses,
  lerp,
  mul,
  offsetOutline,
  overlaps,
  pairKey,
  pointKey,
  project,
  roomAt,
  roundPoint,
  samePoint,
  selfIntersects,
  sharedEdges,
  signedArea,
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
  | VertexSelection
  | { kind: "bulb"; ieee: string }
  | null;

export type VertexSelection = { kind: "vertex"; id: RoomId; index: number; at: Point };

export function vertexSelection(plan: Plan, id: RoomId, index: number): Selection {
  const at = plan.rooms.find((r) => r.id === id)?.outline[index];
  return at ? { kind: "vertex", id, index, at } : null;
}

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

export function addRoom(plan: Plan, outline: Point[], name: string, reserved: Iterable<RoomId> = []): { plan: Plan; id: RoomId } {
  const id = slug(name, [...plan.rooms.map((r) => r.id), ...plan.retired_rooms, ...reserved]);
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

export function unpinnedBulbs(before: Plan, after: Plan): { ieee: string; from: RoomId; to: RoomId | null }[] {
  return after.bulbs.flatMap((bulb) => {
    const old = before.bulbs.find((b) => b.ieee === bulb.ieee);
    if (!old || old.room === null || bulb.room !== null || (old.x === bulb.x && old.y === bulb.y)) return [];
    return [{ ieee: bulb.ieee, from: old.room, to: roomAt(after, [bulb.x, bulb.y]) }];
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

function spike(a: Point, v: Point, b: Point): boolean {
  const length = Math.max(dist(a, v), dist(v, b));
  return length > 1e-9 && Math.abs(cross(sub(v, a), sub(b, v))) / length <= EPS && dot(sub(v, a), sub(b, v)) < 0;
}

function straighten({ points, loose }: Shifted, shared: (p: Point) => boolean): Point[] {
  let out = points;
  for (;;) {
    const n = out.length;
    const at = out.findIndex((p, i) => {
      const [a, b] = [out[(i - 1 + n) % n]!, out[(i + 1) % n]!];
      return loose.some((q) => samePoint(p, q, 0.0005)) && (straight(a, p, b) || spike(a, p, b) || (!shared(p) && almostStraight(a, p, b)));
    });
    if (at < 0 || n <= 3) return out;
    out = out.filter((_, i) => i !== at);
  }
}

interface Part {
  outline: Point[];
  edges: number[];
}

function partMoves(part: Part, shift: Point): Map<number, Point> {
  return new Map(part.edges.map((e): [number, Point] => [e, shift]));
}

function closingGaps(parts: ReadonlyMap<number, Part>, normal: Point, offset: number): number[] {
  const shift = mul(normal, offset);
  return [...parts.values()]
    .flatMap((part) =>
      [...offsetOutline(part.outline, partMoves(part, shift)).ends.values()].flatMap(({ at, far }) => (samePoint(at, far, MERGE) ? [dot(sub(far, at), normal)] : [])),
    )
    .sort((x, y) => Math.abs(x) - Math.abs(y));
}

interface Moved {
  rooms: Map<number, Point[]>;
  shift: Point;
}

function shiftRooms(plan: Plan, parts: ReadonlyMap<number, Part>, normal: Point, offset: number): Moved | null {
  const gaps = closingGaps(parts, normal, offset);
  const ahead = gaps.filter((gap) => gap * offset > 0 && Math.abs(gap) > LINK).slice(0, 1);
  const tries: [number, boolean][] = [...ahead.map((gap): [number, boolean] => [offset + gap, false]), [offset, true], [offset, false], ...gaps.slice(0, 1).map((gap): [number, boolean] => [offset + gap, false])];
  for (const [at, tidy] of tries) {
    const moved = shiftRoomsBy(plan, parts, normal, at, tidy);
    if (moved) return moved;
  }
  return null;
}

function shiftRoomsBy(plan: Plan, parts: ReadonlyMap<number, Part>, normal: Point, offset: number, tidy: boolean): Moved | null {
  const shift = mul(normal, offset);
  const found = new Map<string, { at: Point; rank: number }>();
  const tidied = new Map<string, Point>();
  for (const part of parts.values()) {
    const moves = partMoves(part, shift);
    const [a, b] = edges(part.outline)[part.edges[0]!]!;
    const step = Math.hypot(shift[0], shift[1]);
    const shrinks = step > 0 && contains(part.outline, add(lerp(a, b, 0.5), mul(shift, 0.001 / step)));
    for (const [key, end] of offsetOutline(part.outline, moves).ends) {
      const rank = end.miter ? (shrinks ? 2 : 1) : 0;
      const known = found.get(key);
      if (!known || rank > known.rank) found.set(key, { at: end.at, rank });
      if (tidy && samePoint(end.at, end.far, MERGE) && Math.abs(dot(sub(end.far, end.at), normal)) <= LINK) tidied.set(key, end.far);
    }
  }
  const vertices = plan.rooms.flatMap((r) => r.outline);
  const near = (key: string, at: Point): Point => tidied.get(key) ?? vertices.find((v) => samePoint(v, at, LINK)) ?? at;
  const fixed = new Map([...found].map(([key, { at }]): [string, Point] => [key, roundPoint(near(key, at))]));
  const shifted = new Map<number, Shifted>();
  for (const [r, part] of parts) {
    const next = shiftEdges(part.outline, partMoves(part, shift), fixed);
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
  return { rooms: moved, shift };
}

export function moveWall(plan: Plan, id: RoomId, edge: number, offset: number, linked = true): Plan {
  const room = plan.rooms.find((r) => r.id === id);
  const pair = room ? edges(room.outline)[edge] : undefined;
  if (!room || !pair || Math.abs(offset) < 1e-9) return plan;
  const group = wallGroup(plan, id, edge, linked);
  const parts = new Map<number, Part>();
  for (const [r] of group) {
    if (!parts.has(r)) parts.set(r, { outline: plan.rooms[r]!.outline, edges: group.filter(([gr]) => gr === r).map(([, e]) => e) });
  }
  const moved = shiftRooms(plan, parts, edgeNormal(pair[0], pair[1]), offset);
  if (!moved) return plan;
  const lines = group.map(([r, e]) => edges(plan.rooms[r]!.outline)[e]!);
  const onLine = (w: { a: Point; b: Point }): boolean => lines.some(([a, b]) => edgesOverlap(a, b, w.a, w.b));
  return settle(plan, {
    ...plan,
    rooms: plan.rooms.map((r, i) => {
      const outline = moved.rooms.get(i);
      return outline ? { ...r, outline } : r;
    }),
    walls: plan.walls.map((w) => (onLine(w) ? { ...w, a: add(w.a, moved.shift), b: add(w.b, moved.shift) } : w)),
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

function shiftedIndex(before: Point[], after: Point[], index: number): number {
  const n = after.length;
  const scores = after.map((_, k) => before.filter((p, i) => samePoint(p, after[(i + k) % n]!, EPS)).length);
  const best = Math.max(0, ...scores);
  const shifts = scores.flatMap((score, k) => (score === best ? [k] : []));
  return best > 0 && shifts.length === 1 ? (index + shifts[0]!) % n : index;
}

export function trackSelection(plan: Plan, selection: Selection, before: Plan | null = null): Selection {
  if (selection?.kind === "door") {
    const index = doorIndex(plan, selection);
    return index < 0 ? null : doorSelection(plan, index);
  }
  if (selection?.kind === "vertex") {
    const outline = plan.rooms.find((r) => r.id === selection.id)?.outline ?? [];
    const was = before?.rooms.find((r) => r.id === selection.id)?.outline;
    const found = was?.length === outline.length ? shiftedIndex(was, outline, selection.index) : outline.findIndex((p) => samePoint(p, selection.at, EPS));
    return vertexSelection(plan, selection.id, found >= 0 ? found : selection.index);
  }
  if (selection?.kind !== "wall") return exists(plan, selection) ? selection : null;
  const index = wallIndex(plan, selection);
  return index < 0 ? null : wallSelection(plan, index);
}

export function moveSharedWall(plan: Plan, selection: WallSelection, offset: number): Plan {
  const wall = plan.walls[wallIndex(plan, selection)];
  if (!wall || Math.abs(offset) < 1e-9) return plan;
  const parts = new Map<number, Part>();
  for (const [r, room] of plan.rooms.entries()) {
    const split = splitAlong(room.outline, wall.a, wall.b);
    if (split.inside.length > 0) parts.set(r, { outline: split.outline, edges: split.inside });
  }
  const moved = shiftRooms(plan, parts, edgeNormal(wall.a, wall.b), offset);
  if (!moved) return plan;
  return settle(plan, {
    ...plan,
    rooms: plan.rooms.map((r, i) => {
      const outline = moved.rooms.get(i);
      return outline ? { ...r, outline } : r;
    }),
    walls: plan.walls.map((w) => (edgesOverlap(wall.a, wall.b, w.a, w.b) ? { ...w, a: add(w.a, moved.shift), b: add(w.b, moved.shift) } : w)),
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

function overlapping(rooms: readonly Room[]): Set<string> {
  const found = new Set<string>();
  rooms.forEach((r, i) => rooms.slice(i + 1).forEach((o) => (overlaps(r.outline, o.outline) ? found.add(pairKey([r.id, o.id])) : undefined)));
  return found;
}

export type CornerTrouble = "missing" | "min" | "shape" | "overlap";

function roomTrouble(plan: Plan, rooms: Room[], changed: ReadonlySet<number>): CornerTrouble | null {
  if (rooms.some((r, i) => changed.has(i) && (r.outline.length < 3 || area(r.outline) < 0.05 || selfIntersects(r.outline)))) return "shape";
  const before = overlapping(plan.rooms);
  return [...overlapping(rooms)].every((pair) => before.has(pair)) ? null : "overlap";
}

function throughCorner(outline: Point[], v: Point, other: Point[]): boolean {
  const n = outline.length;
  const at = outline.findIndex((p) => samePoint(p, v, LINK));
  const sides = [
    [outline[(at - 1 + n) % n]!, v],
    [v, outline[(at + 1) % n]!],
  ];
  return sides.every(([a, b]) => edges(other).some(([c, d]) => edgesOverlap(a!, b!, c, d)));
}

export function cutCorner(plan: Plan, id: RoomId, index: number): Plan | CornerTrouble {
  const r = plan.rooms.findIndex((room) => room.id === id);
  const room = plan.rooms[r];
  const v = room?.outline[index];
  if (!room || !v) return "missing";
  if (room.outline.length <= 3) return "min";
  const attempt = (changed: Set<number>): Plan | CornerTrouble => {
    const rooms = plan.rooms.map((x, i) => (changed.has(i) ? { ...x, outline: x.outline.filter((p) => !samePoint(p, v, LINK)) } : x));
    const trouble = roomTrouble(plan, rooms, changed);
    if (trouble) return trouble;
    const before = new Set(sharedEdges(plan.rooms).map((e) => pairKey(e.rooms)));
    const after = new Set(sharedEdges(rooms).map((e) => pairKey(e.rooms)));
    const kept = [...changed].every((i) => i === r || after.has(pairKey([id, plan.rooms[i]!.id])) || !before.has(pairKey([id, plan.rooms[i]!.id])));
    return kept ? settle(plan, { ...plan, rooms }) : "overlap";
  };
  const together = linkedVertices(plan, v)
    .map(([i]) => i)
    .filter((i) => i !== r && plan.rooms[i]!.outline.length > 3 && throughCorner(room.outline, v, plan.rooms[i]!.outline) && throughCorner(plan.rooms[i]!.outline, v, room.outline));
  const joint = together.length > 0 ? attempt(new Set([r, ...together])) : "overlap";
  return typeof joint === "string" ? attempt(new Set([r])) : joint;
}

export function removeCorner(plan: Plan, id: RoomId, index: number): Plan | null {
  const result = cutCorner(plan, id, index);
  return typeof result === "string" ? null : result;
}

function oriented(outline: Point[]): Point[] {
  return signedArea(outline) < 0 ? [...outline].reverse() : outline;
}

function splitAt(outline: Point[], points: readonly Point[]): Point[] {
  return edges(outline).flatMap(([p, q]) => {
    const cuts = points
      .map((c) => ({ c, hit: project(c, p, q) }))
      .filter(({ c, hit }) => hit.d <= 0.001 && hit.t > 0 && hit.t < 1 && !samePoint(c, p, LINK) && !samePoint(c, q, LINK))
      .sort((x, y) => x.hit.t - y.hit.t)
      .map(({ c }) => c);
    return [p, ...cuts];
  });
}

function union(a: Point[], b: Point[]): Point[] | null {
  const pa = oriented(a);
  const pb = oriented(b).map((p) => pa.find((q) => samePoint(p, q, LINK)) ?? p);
  const sa = splitAt(pa, pb);
  const sb = splitAt(pb, pa);
  const shared = (p: Point, q: Point, other: Point[]): boolean => edges(other).some(([c, d]) => samePoint(p, d, LINK) && samePoint(q, c, LINK));
  const rest = [...edges(sa).filter(([p, q]) => !shared(p, q, sb)), ...edges(sb).filter(([p, q]) => !shared(p, q, sa))];
  const joints = [...edges(sa).filter(([p, q]) => shared(p, q, sb))].flat();
  if (joints.length === 0 || rest.length < 3) return null;
  const loop: Point[] = [];
  let edge = rest[0]!;
  for (let k = 0; k < rest.length; k += 1) {
    loop.push(edge[0]);
    const end = edge[1];
    const next = rest.filter(([p]) => samePoint(p, end, LINK));
    if (next.length !== 1) return null;
    edge = next[0]!;
    if (edge === rest[0]) break;
  }
  if (loop.length !== rest.length || edge !== rest[0]) return null;
  const n = loop.length;
  const tidy = loop.filter((p, i) => !(joints.some((j) => samePoint(j, p, LINK)) && straight(loop[(i - 1 + n) % n]!, p, loop[(i + 1) % n]!)));
  return tidy.length >= 3 && !selfIntersects(tidy) && Math.abs(area(tidy) - area(a) - area(b)) < 0.01 ? tidy : null;
}

export interface Merged {
  plan: Plan;
  id: RoomId;
  mixed: { room: RoomId; kind: WallKind }[];
}

function mixedWalls(before: Plan, pairs: readonly (string | null)[], after: Plan, keep: RoomId): Merged["mixed"] {
  const now = wallPairs(after);
  return after.walls.flatMap((wall, i) => {
    const key = now[i];
    const kinds = new Set(before.walls.filter((old, j) => pairs[j] === key && edgesOverlap(old.a, old.b, wall.a, wall.b)).map((old) => old.kind));
    const ends = key?.split("|") ?? [];
    const room = ends.find((x) => x !== keep);
    return room && ends.includes(keep) && kinds.size > 1 ? [{ room, kind: wall.kind }] : [];
  });
}

export type MergeTrouble = "inside" | "overlap" | "hole";

export function mergeSides(plan: Plan, a: RoomId, b: RoomId): { keep: Room; gone: Room; joined: Point[] | null } | null {
  const ra = plan.rooms.find((r) => r.id === a);
  const rb = plan.rooms.find((r) => r.id === b);
  if (!ra || !rb || a === b) return null;
  const [keep, gone] = area(ra.outline) >= area(rb.outline) ? [ra, rb] : [rb, ra];
  return { keep, gone, joined: union(ra.outline, rb.outline) };
}

export function mergeTrouble(plan: Plan, a: RoomId, b: RoomId): MergeTrouble | null {
  const sides = mergeSides(plan, a, b);
  if (!sides) return "hole";
  const { keep, gone, joined } = sides;
  if (joined) return null;
  if (encloses(keep.outline, gone.outline)) return "inside";
  return overlaps(keep.outline, gone.outline) ? "overlap" : "hole";
}

export function mergedArea(keep: Room, gone: Room, live: ReadonlySet<string> | null = null): string | null {
  const alive = (id: string | null): id is string => id !== null && id !== "" && (live === null || live.has(id));
  if (alive(keep.area_id)) return keep.area_id;
  if (alive(gone.area_id)) return gone.area_id;
  return keep.area_id || gone.area_id || null;
}

export function mergeRooms(plan: Plan, a: RoomId, b: RoomId, live: ReadonlySet<string> | null = null): Merged | null {
  const sides = mergeSides(plan, a, b);
  if (!sides?.joined) return null;
  const { keep, gone, joined } = sides;
  const start = Math.max(0, joined.findIndex((p) => samePoint(p, keep.outline[0]!, LINK)));
  const outline = [...joined.slice(start), ...joined.slice(0, start)];
  const rename = (id: RoomId): RoomId => (id === gone.id ? keep.id : id);
  const pairs = wallPairs(plan).map((key) => {
    if (key === null) return null;
    const [x, y] = key.split("|") as [RoomId, RoomId];
    return rename(x) === rename(y) ? null : pairKey([rename(x), rename(y)]);
  });
  const merged = normalize(
    {
      ...plan,
      rooms: plan.rooms.flatMap((r) => (r.id === gone.id ? [] : r.id === keep.id ? [{ ...r, outline, area_id: mergedArea(keep, gone, live), entrance: keep.entrance || gone.entrance }] : [r])),
      doors: plan.doors.filter((d) => pairs[d.wall] !== null || wallPairs(plan)[d.wall] === null),
      adjacent: plan.adjacent.flatMap(([x, y]): [RoomId, RoomId][] => (rename(x) === rename(y) ? [] : [[rename(x), rename(y)]])),
      bulbs: plan.bulbs.map((bulb) => (bulb.room === gone.id ? { ...bulb, room: keep.id } : bulb)),
    },
    pairs,
  );
  return { plan: merged, id: keep.id, mixed: mixedWalls(plan, pairs, merged, keep.id) };
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
  const half = length > 0 ? Math.min(width, length) / 2 / length : 0.5;
  return { at: Number(Math.min(1 - half, Math.max(half, at)).toFixed(4)), width: Number(width.toFixed(3)) };
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
  if (selection?.kind === "vertex") {
    const point = plan.rooms.find((r) => r.id === selection.id)?.outline[selection.index];
    return point ? moveVertex(plan, selection.id, selection.index, add(point, delta)) : plan;
  }
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
  if (selection?.kind === "vertex") return vertexSelection(after, selection.id, selection.index);
  return selection;
}

export function remove(plan: Plan, selection: Selection): Plan {
  if (selection?.kind === "room") return removeRoom(plan, selection.id);
  if (selection?.kind === "bulb") return removeBulb(plan, selection.ieee);
  if (selection?.kind === "door") return removeDoor(plan, selection.index);
  if (selection?.kind === "vertex") return removeCorner(plan, selection.id, selection.index) ?? plan;
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
  if (selection.kind === "vertex") return (plan.rooms.find((r) => r.id === selection.id)?.outline.length ?? 0) > selection.index;
  return wallIndex(plan, selection) >= 0;
}

export function samePlan(a: Plan, b: Plan): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

export function canonicalPlan(plan: Plan, anyFile = false): string {
  const background = plan.background && anyFile ? { ...plan.background, file: "" } : plan.background;
  return JSON.stringify({ ...plan, rev: 0, background, retired_rooms: [...(plan.retired_rooms ?? [])].sort() }, sortedKeys);
}

export function sameContent(a: Plan, b: Plan, anyFile = false): boolean {
  return a === b || canonicalPlan(a, anyFile) === canonicalPlan(b, anyFile);
}

export type Renamed = { from: RoomId; to: RoomId; name: string };

export function reviveRetired(plan: Plan, retired: Iterable<RoomId>): { plan: Plan; renamed: Renamed[] } {
  const gone = new Set([...plan.retired_rooms, ...retired]);
  const taken = [...gone, ...plan.rooms.map((r) => r.id)];
  const renamed: Renamed[] = [];
  for (const room of plan.rooms) {
    if (gone.has(room.id)) {
      const id = slug(room.name, taken);
      renamed.push({ from: room.id, to: id, name: room.name });
      taken.push(id);
    }
  }
  const ids = new Map(renamed.map((r) => [r.from, r.to]));
  const rename = (id: RoomId): RoomId => ids.get(id) ?? id;
  const next: Plan = {
    ...plan,
    rooms: plan.rooms.map((r) => ({ ...r, id: rename(r.id) })),
    bulbs: plan.bulbs.map((b) => (b.room === null ? b : { ...b, room: rename(b.room) })),
    adjacent: plan.adjacent.map(([a, b]) => [rename(a), rename(b)]),
    retired_rooms: [...gone].sort(),
  };
  return { plan: renamed.length || gone.size !== plan.retired_rooms.length ? next : plan, renamed };
}

export function retireGone(plan: Plan, saved: Plan | null): Plan {
  if (!saved) return plan;
  const kept = new Set([...plan.rooms.map((r) => r.id), ...plan.retired_rooms]);
  const gone = saved.rooms.map((r) => r.id).filter((id) => !kept.has(id));
  return gone.length ? { ...plan, retired_rooms: [...plan.retired_rooms, ...gone].sort() } : plan;
}

export function retiredOver(base: Plan, server: Plan): RoomId[] {
  const known = new Set(base.rooms.map((r) => r.id));
  return [...new Set([...base.retired_rooms, ...server.retired_rooms, ...server.rooms.map((r) => r.id).filter((id) => !known.has(id))])].sort();
}

export function looksRetired(room: Room, retired: Iterable<RoomId>): boolean {
  const base = slug(room.name, []);
  return base !== room.id && new Set(retired).has(base);
}

export function importPlan(current: Plan, imported: Plan, saved: Plan | null): { plan: Plan; renamed: Renamed[] } {
  const ids = new Set(imported.rooms.map((r) => r.id));
  const replaced = (saved?.rooms ?? []).map((r) => r.id).filter((id) => !ids.has(id));
  return reviveRetired(
    { ...imported, version: 1, rev: current.rev, retired_rooms: imported.retired_rooms ?? [] },
    [...(saved?.retired_rooms ?? []), ...replaced],
  );
}

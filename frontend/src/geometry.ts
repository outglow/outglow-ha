import type { Door, Plan, PlanBulb, Point, Room, RoomId, Wall, WallKind } from "./api/types";

export const EPS = 1e-6;
const ON_LINE = 1e-3;
const MIN_WALL = 0.05;
const PROBE = 0.004;

export type Box = [number, number, number, number];

export function add(a: Point, b: Point): Point {
  return [a[0] + b[0], a[1] + b[1]];
}

export function sub(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1]];
}

export function mul(a: Point, k: number): Point {
  return [a[0] * k, a[1] * k];
}

export function dot(a: Point, b: Point): number {
  return a[0] * b[0] + a[1] * b[1];
}

export function cross(a: Point, b: Point): number {
  return a[0] * b[1] - a[1] * b[0];
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function round(value: number, step = 0.001): number {
  return Math.round(value / step) * step;
}

export function roundPoint(p: Point, step = 0.001): Point {
  return [Number(round(p[0], step).toFixed(4)), Number(round(p[1], step).toFixed(4))];
}

export function samePoint(a: Point, b: Point, tolerance = ON_LINE): boolean {
  return dist(a, b) <= tolerance;
}

export function edges(poly: Point[]): [Point, Point][] {
  return poly.map((p, i) => [p, poly[(i + 1) % poly.length]!]);
}

export function signedArea(poly: Point[]): number {
  return edges(poly).reduce((sum, [a, b]) => sum + cross(a, b), 0) / 2;
}

export function area(poly: Point[]): number {
  return Math.abs(signedArea(poly));
}

export function centroid(poly: Point[]): Point {
  const a = signedArea(poly);
  if (Math.abs(a) < EPS) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (const [p, q] of edges(poly)) {
    const f = cross(p, q);
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function project(p: Point, a: Point, b: Point): { point: Point; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < EPS ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
  const point = lerp(a, b, t);
  return { point, t, d: dist(p, point) };
}

export function distanceToBoundary(p: Point, poly: Point[]): number {
  return Math.min(...edges(poly).map(([a, b]) => project(p, a, b).d));
}

export function onBoundary(p: Point, poly: Point[], tolerance = ON_LINE): boolean {
  return distanceToBoundary(p, poly) <= tolerance;
}

export function contains(poly: Point[], p: Point): boolean {
  let inside = false;
  for (const [a, b] of edges(poly)) {
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
      if (p[0] < x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

export function strictlyInside(poly: Point[], p: Point, tolerance = ON_LINE): boolean {
  return contains(poly, p) && !onBoundary(p, poly, tolerance);
}

function orientation(a: Point, b: Point, c: Point): number {
  const v = cross(sub(b, a), sub(c, a));
  return Math.abs(v) < EPS ? 0 : Math.sign(v);
}

export function properCrossing(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function side(a: Point, b: Point, c: Point): number {
  const v = cross(sub(b, a), sub(c, a));
  return Math.abs(v) <= ON_LINE * dist(a, b) ? 0 : Math.sign(v);
}

export function edgesCross(a: Point, b: Point, c: Point, d: Point): boolean {
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

export function selfIntersects(poly: Point[]): boolean {
  const list = edges(poly);
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (j === i + 1 || (i === 0 && j === list.length - 1)) {
        continue;
      }
      const [a, b] = list[i]!;
      const [c, d] = list[j]!;
      if (properCrossing(a, b, c, d)) {
        return true;
      }
    }
  }
  return false;
}

export function encloses(outer: Point[], inner: Point[]): boolean {
  const within = (p: Point): boolean => contains(outer, p) || onBoundary(p, outer);
  return (
    inner.every(within) &&
    edges(inner).every(([a, b]) => within(lerp(a, b, 0.5))) &&
    !edges(inner).some(([a, b]) => edges(outer).some(([c, d]) => edgesCross(a, b, c, d)))
  );
}

function boxesMeet(p: Point[], q: Point[]): boolean {
  const [px, py, pw, ph] = boxOf(p);
  const [qx, qy, qw, qh] = boxOf(q);
  return px < qx + qw - ON_LINE && qx < px + pw - ON_LINE && py < qy + qh - ON_LINE && qy < py + ph - ON_LINE;
}

export function overlaps(p: Point[], q: Point[]): boolean {
  if (p.length < 3 || q.length < 3 || !boxesMeet(p, q)) {
    return false;
  }
  return shareFloor(p, q) && !encloses(p, q) && !encloses(q, p);
}

function shareFloor(p: Point[], q: Point[]): boolean {
  if (p.some((v) => strictlyInside(q, v)) || q.some((v) => strictlyInside(p, v))) {
    return true;
  }
  if (edges(p).some(([a, b]) => edges(q).some(([c, d]) => edgesCross(a, b, c, d)))) {
    return true;
  }
  return edges(p).some(([a, b]) => strictlyInside(q, lerp(a, b, 0.5))) || edges(q).some(([a, b]) => strictlyInside(p, lerp(a, b, 0.5)));
}

export function labelPoint(poly: Point[]): Point {
  const c = centroid(poly);
  if (poly.length < 3 || (contains(poly, c) && distanceToBoundary(c, poly) > 0.3)) {
    return c;
  }
  const [x, y, w, h] = boxOf(poly);
  let best = c;
  let bestD = contains(poly, c) ? distanceToBoundary(c, poly) : -1;
  const steps = 24;
  for (let i = 1; i < steps; i += 1) {
    for (let j = 1; j < steps; j += 1) {
      const p: Point = [x + (w * i) / steps, y + (h * j) / steps];
      if (!contains(poly, p)) continue;
      const d = distanceToBoundary(p, poly);
      if (d > bestD + 1e-9) {
        best = p;
        bestD = d;
      }
    }
  }
  return best;
}

export function boxOf(points: Point[]): Box {
  if (points.length === 0) {
    return [0, 0, 0, 0];
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
}

export function planPoints(plan: Plan): Point[] {
  return [...plan.rooms.flatMap((r) => r.outline), ...plan.bulbs.map((b): Point => [b.x, b.y])];
}

export function planBox(plan: Plan, margin = 0.5, rooms?: readonly string[]): Box {
  const subset = rooms ? plan.rooms.filter((r) => rooms.includes(r.id)) : plan.rooms;
  const bulbs = rooms ? plan.bulbs.filter((b) => subset.some((r) => contains(r.outline, [b.x, b.y]))) : plan.bulbs;
  const points = [...subset.flatMap((r) => r.outline), ...bulbs.map((b): Point => [b.x, b.y])];
  if (points.length === 0) {
    return [0, 0, 6, 4];
  }
  const [x, y, w, h] = boxOf(points);
  return [x - margin, y - margin, Math.max(w, 1) + 2 * margin, Math.max(h, 1) + 2 * margin];
}

export function rectangle(a: Point, b: Point): Point[] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

export type SnapKind = "vertex" | "edge" | "grid" | "angle" | "free";

export interface SnapOptions {
  grid: number;
  outlines: Point[][];
  threshold: number;
  anchor?: Point | null;
  magnet?: boolean;
}

export interface Snap {
  point: Point;
  kind: SnapKind;
  guide: [Point, Point] | null;
}

export function snapToGrid(p: Point, grid: number): Point {
  if (grid <= 0) {
    return p;
  }
  return [Number((Math.round(p[0] / grid) * grid).toFixed(4)), Number((Math.round(p[1] / grid) * grid).toFixed(4))];
}

export function snap(p: Point, options: SnapOptions): Snap {
  if (options.magnet !== false) {
    let vertex: Point | null = null;
    let vertexD = options.threshold;
    for (const poly of options.outlines) {
      for (const v of poly) {
        const d = dist(p, v);
        if (d <= vertexD) {
          vertex = v;
          vertexD = d;
        }
      }
    }
    if (vertex) {
      return { point: [vertex[0], vertex[1]], kind: "vertex", guide: null };
    }
    let edge: { point: Point; a: Point; b: Point } | null = null;
    let edgeD = options.threshold;
    for (const poly of options.outlines) {
      for (const [a, b] of edges(poly)) {
        const hit = project(p, a, b);
        if (hit.d <= edgeD) {
          edge = { point: hit.point, a, b };
          edgeD = hit.d;
        }
      }
    }
    if (edge) {
      const along = snapAlong(edge.point, edge.a, edge.b, options.grid);
      return { point: roundPoint(along), kind: "edge", guide: [edge.a, edge.b] };
    }
  }
  const anchor = options.anchor;
  if (anchor) {
    const d = sub(p, anchor);
    const tolerance = Math.max(options.threshold, Math.hypot(d[0], d[1]) * Math.tan((6 * Math.PI) / 180));
    if (Math.abs(d[1]) <= tolerance && Math.abs(d[0]) > Math.abs(d[1])) {
      const x = snapToGrid(p, options.grid)[0];
      return { point: [x, anchor[1]], kind: "angle", guide: [anchor, [x, anchor[1]]] };
    }
    if (Math.abs(d[0]) <= tolerance && Math.abs(d[1]) >= Math.abs(d[0])) {
      const y = snapToGrid(p, options.grid)[1];
      return { point: [anchor[0], y], kind: "angle", guide: [anchor, [anchor[0], y]] };
    }
  }
  if (options.grid > 0) {
    return { point: snapToGrid(p, options.grid), kind: "grid", guide: null };
  }
  return { point: roundPoint(p), kind: "free", guide: null };
}

function snapAlong(p: Point, a: Point, b: Point, grid: number): Point {
  if (grid <= 0) {
    return p;
  }
  const length = dist(a, b);
  if (length < EPS) {
    return a;
  }
  const s = Math.round((dist(a, p) / grid)) * grid;
  return lerp(a, b, Math.min(1, s / length));
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const HANDLE_SIDES: Record<Handle, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

export function handleSides(handle: Handle): [number, number] {
  return HANDLE_SIDES[handle];
}

export function handlePoint(box: Box, handle: Handle, pad = 0): Point {
  const [hx, hy] = HANDLE_SIDES[handle];
  const [x, y, w, h] = box;
  return [x + (w * (hx + 1)) / 2 + hx * pad, y + (h * (hy + 1)) / 2 + hy * pad];
}

export interface ResizeOptions {
  keepRatio?: boolean;
  fromCentre?: boolean;
  min?: number;
}

function resizeAxis(start: number, size: number, side: number, to: number, fromCentre: boolean, min: number): [number, number] {
  if (side === 0) {
    return [start, size];
  }
  if (fromCentre) {
    const centre = start + size / 2;
    const half = Math.max(min / 2, side * (to - centre));
    return [centre - half, 2 * half];
  }
  const anchor = side > 0 ? start : start + size;
  const extent = Math.max(min, side * (to - anchor));
  return side > 0 ? [anchor, extent] : [anchor - extent, extent];
}

function scaleAxis(start: number, size: number, side: number, next: number, fromCentre: boolean): [number, number] {
  if (side === 0 || fromCentre) {
    const centre = start + size / 2;
    return [centre - next / 2, next];
  }
  return side > 0 ? [start, next] : [start + size - next, next];
}

export function resizeBox(box: Box, handle: Handle, to: Point, options: ResizeOptions = {}): Box {
  const [hx, hy] = HANDLE_SIDES[handle];
  const min = options.min ?? 0.2;
  const centre = options.fromCentre === true;
  const [x, w] = resizeAxis(box[0], box[2], hx, to[0], centre, min);
  const [y, h] = resizeAxis(box[1], box[3], hy, to[1], centre, min);
  if (!options.keepRatio || box[2] < EPS || box[3] < EPS) {
    return [x, y, w, h];
  }
  const sx = w / box[2];
  const sy = h / box[3];
  const k = hx === 0 ? sy : hy === 0 ? sx : Math.max(sx, sy);
  const [rx, rw] = scaleAxis(box[0], box[2], hx, box[2] * k, centre);
  const [ry, rh] = scaleAxis(box[1], box[3], hy, box[3] * k, centre);
  return [rx, ry, rw, rh];
}

export function boxMap(from: Box, to: Box): (p: Point) => Point {
  const kx = from[2] < EPS ? 1 : to[2] / from[2];
  const ky = from[3] < EPS ? 1 : to[3] / from[3];
  return (p) => [to[0] + (p[0] - from[0]) * kx, to[1] + (p[1] - from[1]) * ky];
}

export interface AxisSnap {
  value: number;
  guide: number | null;
}

export function snapValue(value: number, grid: number, candidates: readonly number[], threshold: number): AxisSnap {
  let best: number | null = null;
  let bestD = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  if (best !== null) {
    return { value: best, guide: best };
  }
  return { value: grid > 0 ? Number((Math.round(value / grid) * grid).toFixed(4)) : value, guide: null };
}

export function isRectangle(poly: Point[]): boolean {
  return poly.length === 4 && edges(poly).every(([a, b]) => Math.abs(a[0] - b[0]) < EPS || Math.abs(a[1] - b[1]) < EPS);
}

export function edgeNormal(a: Point, b: Point): Point {
  const length = dist(a, b);
  return length < EPS ? [0, 0] : [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
}

function meet(a1: Point, d1: Point, a2: Point, d2: Point): Point | null {
  const den = cross(d1, d2);
  if (Math.abs(den) < EPS) {
    return null;
  }
  return add(a1, mul(d1, cross(sub(a2, a1), d2) / den));
}

const PARALLEL = Math.sin((10 * Math.PI) / 180);

function nearlyParallel(d1: Point, d2: Point): boolean {
  const lengths = Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]);
  return lengths < EPS || Math.abs(cross(d1, d2)) / lengths < PARALLEL;
}

export interface Offset {
  outline: Point[];
  sides: [Point, Point][];
  ends: Map<string, { at: Point; miter: boolean; far: Point }>;
}

export function pointKey(p: Point): string {
  return `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
}

export function offsetOutline(poly: Point[], moves: ReadonlyMap<number, Point>, fixed: ReadonlyMap<string, Point> = new Map()): Offset {
  const n = poly.length;
  const ends = new Map<string, { at: Point; miter: boolean; far: Point }>();
  const corners = poly.map((v, j): [Point, Point] => {
    const prev = (j - 1 + n) % n;
    const mp = moves.get(prev);
    const mn = moves.get(j);
    if (!mp && !mn) {
      return [v, v];
    }
    const before = poly[prev]!;
    const after = poly[(j + 1) % n]!;
    const shiftP = mp ?? [0, 0];
    const shiftN = mn ?? [0, 0];
    const hit = nearlyParallel(sub(v, before), sub(after, v)) ? null : meet(add(before, shiftP), sub(v, before), add(v, shiftN), sub(after, v));
    if (mp && mn) {
      return hit ? [hit, hit] : [add(v, shiftP), add(v, shiftN)];
    }
    const own = hit ?? add(v, mp ?? shiftN);
    ends.set(pointKey(v), { at: own, miter: hit !== null, far: mp ? after : before });
    const end = fixed.get(pointKey(v)) ?? own;
    const far = mp ? after : before;
    const side = sub(far, v);
    const across = Math.abs(cross(side, sub(end, v))) / Math.max(EPS, Math.hypot(side[0], side[1]));
    if (hit && (across <= EPS || (across <= 0.003 && dot(sub(end, v), side) > 0))) {
      return [end, end];
    }
    return mp ? [end, v] : [v, end];
  });
  return {
    outline: corners.flatMap(([into, out]) => (samePoint(into, out, EPS) ? [into] : [into, out])),
    sides: poly.map((_, e) => [corners[e]![1], corners[(e + 1) % n]![0]]),
    ends,
  };
}

export function offsetEdges(poly: Point[], moves: ReadonlyMap<number, Point>): Point[] {
  return offsetOutline(poly, moves).outline;
}

export function straight(a: Point, v: Point, b: Point): boolean {
  const ab = sub(b, a);
  const length = Math.hypot(ab[0], ab[1]);
  return length > EPS && Math.abs(cross(ab, sub(v, a))) / length <= EPS && dot(sub(v, a), sub(b, v)) > 0;
}

export function edgesOverlap(a: Point, b: Point, c: Point, d: Point): boolean {
  return overlap(a, b, c, d) !== null;
}

export interface SharedEdge {
  a: Point;
  b: Point;
  rooms: [RoomId, RoomId];
}

function collinear(a: Point, b: Point, c: Point, d: Point): boolean {
  const ab = sub(b, a);
  const length = Math.hypot(ab[0], ab[1]);
  if (length < EPS) {
    return false;
  }
  const distance = (p: Point): number => Math.abs(cross(ab, sub(p, a))) / length;
  return distance(c) <= ON_LINE && distance(d) <= ON_LINE;
}

function overlap(a: Point, b: Point, c: Point, d: Point): [Point, Point] | null {
  if (!collinear(a, b, c, d)) {
    return null;
  }
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const tc = dot(sub(c, a), ab) / l2;
  const td = dot(sub(d, a), ab) / l2;
  const t0 = Math.max(0, Math.min(tc, td));
  const t1 = Math.min(1, Math.max(tc, td));
  if ((t1 - t0) * Math.sqrt(l2) < MIN_WALL) {
    return null;
  }
  return [roundPoint(lerp(a, b, t0)), roundPoint(lerp(a, b, t1))];
}

function collinearEdges(rooms: Room[]): SharedEdge[] {
  const found: SharedEdge[] = [];
  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      const r = rooms[i]!;
      const s = rooms[j]!;
      for (const [a, b] of edges(r.outline)) {
        for (const [c, d] of edges(s.outline)) {
          const hit = overlap(a, b, c, d);
          if (hit) {
            found.push({ a: hit[0], b: hit[1], rooms: [r.id, s.id] });
          }
        }
      }
    }
  }
  return found;
}

function inBox(box: Box, p: Point): boolean {
  return p[0] >= box[0] - ON_LINE && p[0] <= box[0] + box[2] + ON_LINE && p[1] >= box[1] - ON_LINE && p[1] <= box[1] + box[3] + ON_LINE;
}

function nestedRooms(rooms: Room[], boxes: Box[]): Set<number> {
  const inner = new Set<number>();
  rooms.forEach((child, c) => {
    const [x, y, w, h] = boxes[c]!;
    const fits = (box: Box): boolean => inBox(box, [x, y]) && inBox(box, [x + w, y + h]);
    if (child.outline.length >= 3 && rooms.some((parent, p) => p !== c && parent.outline.length >= 3 && fits(boxes[p]!) && encloses(parent.outline, child.outline))) {
      inner.add(c);
    }
  });
  return inner;
}

const sharedEdgesOf = new WeakMap<readonly Room[], SharedEdge[]>();

export function sharedEdges(rooms: Room[]): SharedEdge[] {
  const known = sharedEdgesOf.get(rooms);
  if (known) return known;
  const found = findSharedEdges(rooms);
  sharedEdgesOf.set(rooms, found);
  return found;
}

function findSharedEdges(rooms: Room[]): SharedEdge[] {
  const collinear = collinearEdges(rooms);
  const boxes = rooms.map((r) => boxOf(r.outline));
  const inner = nestedRooms(rooms, boxes);
  if (inner.size === 0) {
    return collinear;
  }
  const order = new Map(rooms.map((r, i) => [r.id, i]));
  const vertices = rooms.flatMap((r) => r.outline);
  const areas = rooms.map((r) => area(r.outline));
  const at = (p: Point): RoomId | null => {
    let best = -1;
    rooms.forEach((r, i) => {
      if (r.outline.length >= 3 && inBox(boxes[i]!, p) && contains(r.outline, p) && (best < 0 || areas[i]! < areas[best]!)) best = i;
    });
    return best < 0 ? null : rooms[best]!.id;
  };
  const candidates: [Point, Point][] = [
    ...collinear.map((e): [Point, Point] => [e.a, e.b]),
    ...[...inner].flatMap((c) => edges(rooms[c]!.outline)),
  ];
  const found: SharedEdge[] = [];
  const covered = (p: Point): boolean => found.some((e) => project(p, e.a, e.b).d <= ON_LINE);
  for (const [a, b] of candidates) {
    const length = dist(a, b);
    if (length < MIN_WALL) continue;
    const normal = edgeNormal(a, b);
    const cuts = [0, 1, ...vertices.map((v) => project(v, a, b)).filter((h) => h.d <= ON_LINE && h.t > 0 && h.t < 1).map((h) => h.t)].sort((x, y) => x - y);
    const runs: { from: number; to: number; rooms: [RoomId, RoomId] }[] = [];
    for (let k = 0; k + 1 < cuts.length; k += 1) {
      const t0 = cuts[k]!;
      const t1 = cuts[k + 1]!;
      if ((t1 - t0) * length < EPS) continue;
      const mid = lerp(a, b, (t0 + t1) / 2);
      const left = at(add(mid, mul(normal, PROBE)));
      const right = at(sub(mid, mul(normal, PROBE)));
      if (!left || !right || left === right || covered(mid)) continue;
      const pair: [RoomId, RoomId] = order.get(left)! < order.get(right)! ? [left, right] : [right, left];
      const last = runs[runs.length - 1];
      if (last && pairKey(last.rooms) === pairKey(pair) && (t0 - last.to) * length <= ON_LINE) {
        last.to = t1;
      } else {
        runs.push({ from: t0, to: t1, rooms: pair });
      }
    }
    for (const run of runs) {
      if ((run.to - run.from) * length >= MIN_WALL) {
        found.push({ a: roundPoint(lerp(a, b, run.from)), b: roundPoint(lerp(a, b, run.to)), rooms: run.rooms });
      }
    }
  }
  return found;
}

function sameSegment(w: { a: Point; b: Point }, v: { a: Point; b: Point }): boolean {
  return (samePoint(w.a, v.a) && samePoint(w.b, v.b)) || (samePoint(w.a, v.b) && samePoint(w.b, v.a));
}

function segmentsOverlap(w: { a: Point; b: Point }, v: { a: Point; b: Point }): boolean {
  return overlap(w.a, w.b, v.a, v.b) !== null;
}

export function doorPoint(wall: Wall, at: number): Point {
  return lerp(wall.a, wall.b, at);
}

export function doorCentre(plan: Plan, door: Door): Point | null {
  const wall = plan.walls[door.wall];
  return wall ? doorPoint(wall, door.at) : null;
}

export function pairKey(rooms: readonly [RoomId, RoomId]): string {
  return rooms[0] < rooms[1] ? `${rooms[0]}|${rooms[1]}` : `${rooms[1]}|${rooms[0]}`;
}

export function wallPairs(plan: Pick<Plan, "rooms" | "walls">): (string | null)[] {
  const shared = sharedEdges(plan.rooms);
  return plan.walls.map((w) => {
    const hit = shared.find((e) => sameSegment(w, e)) ?? shared.find((e) => segmentsOverlap(w, e));
    return hit ? pairKey(hit.rooms) : null;
  });
}

function endClamp(t: number, width: number, length: number): number {
  const half = length > 0 ? Math.min(width, length) / 2 / length : 0.5;
  return Math.min(1 - half, Math.max(half, t));
}

function packDoors(row: readonly { door: Door; t: number; moved: boolean }[], length: number): (number | null)[] {
  const order = row.map((_, i) => i).sort((i, j) => row[i]!.t - row[j]!.t || i - j);
  const width = (i: number): number => Math.min(row[i]!.door.width, length);
  const kept = [...order];
  while (kept.length > 1 && kept.reduce((sum, i) => sum + width(i), 0) > length + 1e-9) {
    const drop = [...kept].reverse().find((i) => row[i]!.moved) ?? kept[kept.length - 1]!;
    kept.splice(kept.indexOf(drop), 1);
  }
  const at = new Map(kept.map((i) => [i, row[i]!.t * length]));
  let low = 0;
  for (const i of kept) {
    const s = Math.max(at.get(i)!, low + width(i) / 2);
    at.set(i, s);
    low = s + width(i) / 2;
  }
  let high = length;
  for (const i of [...kept].reverse()) {
    const s = Math.min(at.get(i)!, high - width(i) / 2);
    at.set(i, s);
    high = s - width(i) / 2;
  }
  return row.map((_, i) => (at.has(i) ? (length > 0 ? at.get(i)! / length : 0.5) : null));
}

export function deriveWalls(plan: Plan, pairs: readonly (string | null)[] = wallPairs(plan)): Pick<Plan, "walls" | "doors" | "adjacent"> {
  const shared = sharedEdges(plan.rooms);
  const keys = shared.map((edge) => pairKey(edge.rooms));
  const walls: Wall[] = shared.map((edge, e) => {
    const fits = (i: number): boolean => (pairs[i] ?? keys[e]) === keys[e];
    const exact = plan.walls.find((w, i) => fits(i) && sameSegment(w, edge));
    const near = exact ?? plan.walls.find((w, i) => fits(i) && segmentsOverlap(w, edge));
    const kind: WallKind = near?.kind ?? "partition";
    const a = exact && samePoint(exact.a, edge.b) ? edge.b : edge.a;
    const b = a === edge.b ? edge.a : edge.b;
    return { a, b, kind };
  });
  const placed: { door: Door; wall: number; t: number; moved: boolean }[] = [];
  plan.doors.forEach((door) => {
    const centre = doorCentre(plan, door);
    if (!centre) return;
    const pair = pairs[door.wall] ?? null;
    let index = -1;
    let best = Infinity;
    walls.forEach((w, e) => {
      const d = project(centre, w.a, w.b).d;
      if ((pair === null || keys[e] === pair) && d < best) {
        index = e;
        best = d;
      }
    });
    if (index < 0 || (pair === null && best > 0.01)) return;
    const wall = walls[index]!;
    placed.push({ door, wall: index, t: project(centre, wall.a, wall.b).t, moved: best > 0.01 });
  });
  const doors = placed.flatMap((place) => {
    const wall = walls[place.wall]!;
    const length = dist(wall.a, wall.b);
    const row = placed.filter((p) => p.wall === place.wall);
    const fitted = row.some((p) => p.moved) ? packDoors(row, length) : row.map((p) => endClamp(p.t, p.door.width, length));
    const at = fitted[row.indexOf(place)];
    return at === undefined || at === null ? [] : [{ ...place.door, wall: place.wall, at: Number(at.toFixed(4)) }];
  });
  const adjacent = new Map<string, [RoomId, RoomId]>();
  for (const door of doors) {
    const rooms = shared[door.wall]?.rooms;
    if (rooms) {
      adjacent.set(pairKey(rooms), rooms);
    }
  }
  return { walls, doors, adjacent: [...adjacent.values()] };
}

export function wallRooms(plan: Plan, wall: Wall): RoomId[] {
  const shared = sharedEdges(plan.rooms);
  const hit = shared.find((e) => sameSegment(wall, e)) ?? shared.find((e) => segmentsOverlap(wall, e));
  if (hit) return [...hit.rooms];
  const mid = lerp(wall.a, wall.b, 0.5);
  return plan.rooms.filter((r) => onBoundary(mid, r.outline, 0.01)).map((r) => r.id);
}

export function doorBetween(plan: Plan, a: RoomId, b: RoomId): Door | null {
  return (
    plan.doors.find((door) => {
      const wall = plan.walls[door.wall];
      if (!wall) return false;
      const rooms = wallRooms(plan, wall);
      return rooms.includes(a) && rooms.includes(b);
    }) ?? null
  );
}

export function roomAt(plan: Plan, p: Point): RoomId | null {
  const inside = plan.rooms.filter((r) => r.outline.length >= 3 && contains(r.outline, p));
  if (inside.length === 0) {
    return null;
  }
  return inside.reduce((best, r) => (area(r.outline) < area(best.outline) ? r : best)).id;
}

export function bulbRoom(plan: Plan, bulb: PlanBulb): RoomId | null {
  return bulb.room ?? roomAt(plan, [bulb.x, bulb.y]);
}

export type IssueCode =
  | "bulb_outside_rooms"
  | "bulb_pinned_elsewhere"
  | "room_without_bulb"
  | "overlapping_rooms"
  | "self_intersecting"
  | "too_few_points"
  | "unknown_room"
  | "no_rooms"
  | "no_bulbs";

export interface Issue {
  code: IssueCode;
  severity: "warning" | "error" | "info";
  room?: RoomId;
  other?: RoomId;
  bulb?: string;
}

export function validate(plan: Plan): Issue[] {
  const issues: Issue[] = [];
  if (plan.rooms.length === 0) {
    issues.push({ code: "no_rooms", severity: "info" });
  }
  if (plan.bulbs.length === 0) {
    issues.push({ code: "no_bulbs", severity: "info" });
  }
  const ids = new Set(plan.rooms.map((r) => r.id));
  for (const room of plan.rooms) {
    if (room.outline.length < 3) {
      issues.push({ code: "too_few_points", severity: "error", room: room.id });
    } else if (selfIntersects(room.outline)) {
      issues.push({ code: "self_intersecting", severity: "error", room: room.id });
    }
  }
  for (let i = 0; i < plan.rooms.length; i += 1) {
    for (let j = i + 1; j < plan.rooms.length; j += 1) {
      const r = plan.rooms[i]!;
      const s = plan.rooms[j]!;
      if (overlaps(r.outline, s.outline)) {
        issues.push({ code: "overlapping_rooms", severity: "warning", room: r.id, other: s.id });
      }
    }
  }
  for (const bulb of plan.bulbs) {
    const at = roomAt(plan, [bulb.x, bulb.y]);
    if (bulb.room !== null && !ids.has(bulb.room)) {
      issues.push({ code: "unknown_room", severity: "error", bulb: bulb.ieee, room: bulb.room });
    } else if (bulb.room !== null && at !== bulb.room) {
      issues.push({ code: "bulb_pinned_elsewhere", severity: "warning", bulb: bulb.ieee, room: bulb.room, ...(at ? { other: at } : {}) });
    } else if (bulbRoom(plan, bulb) === null) {
      issues.push({ code: "bulb_outside_rooms", severity: "warning", bulb: bulb.ieee });
    }
  }
  if (plan.bulbs.length > 0) {
    for (const room of plan.rooms) {
      if (!plan.bulbs.some((b) => bulbRoom(plan, b) === room.id)) {
        issues.push({ code: "room_without_bulb", severity: "info", room: room.id });
      }
    }
  }
  return issues;
}

export function slug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ł/g, "l")
      .replace(/Ł/g, "l")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "room";
  const start = /^[a-z0-9]/.test(base) ? base : `r${base}`;
  let id = start;
  for (let n = 2; used.has(id); n += 1) {
    id = `${start}_${n}`;
  }
  return id;
}

export function trailPath(plan: Plan, from: RoomId, to: RoomId): Point[] | null {
  const a = plan.rooms.find((r) => r.id === from);
  const b = plan.rooms.find((r) => r.id === to);
  if (!a || !b) {
    return null;
  }
  const pa = labelPoint(a.outline);
  const pb = labelPoint(b.outline);
  const door = doorBetween(plan, from, to);
  const mid = door ? doorCentre(plan, door) : null;
  return mid ? [pa, mid, pb] : [pa, pb];
}

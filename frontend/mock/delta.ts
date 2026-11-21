import type { DirectionFrame, Frame, FrameDelta, PairFrame } from "../src/api/types";

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedList<T>(prev: T[], cur: T[], key: (item: T) => string): T[] | null {
  const before = new Map(prev.map((item) => [key(item), item]));
  const now = new Set(cur.map(key));
  if ([...before.keys()].some((k) => !now.has(k))) {
    return null;
  }
  return cur.filter((item) => !same(before.get(key(item)), item));
}

function changedMap<T>(prev: Record<string, T>, cur: Record<string, T>): Record<string, T> | null {
  if (Object.keys(prev).some((k) => !(k in cur))) {
    return null;
  }
  return Object.fromEntries(Object.entries(cur).filter(([k, v]) => !same(prev[k], v)));
}

export function diffFrames(prev: Frame, cur: Frame): FrameDelta | null {
  const directions = changedList(prev.directions, cur.directions, (d: DirectionFrame) => `${d.rx}<${d.tx}`);
  const pairs = changedList(prev.pairs, cur.pairs, (p: PairFrame) => `${p.a}|${p.b}`);
  const rooms = changedMap(prev.rooms, cur.rooms);
  const gates = changedMap(prev.gates, cur.gates);
  if (!directions || !pairs || !rooms || !gates) {
    return null;
  }
  const delta: FrameDelta = { t: cur.t };
  if (prev.status !== cur.status) delta.status = cur.status;
  if (prev.model_version !== cur.model_version) delta.model_version = cur.model_version;
  if (directions.length) delta.directions = directions;
  if (pairs.length) delta.pairs = pairs;
  if (Object.keys(rooms).length) delta.rooms = rooms;
  if (!same(prev.veto, cur.veto)) delta.veto = cur.veto;
  if (Object.keys(gates).length) delta.gates = gates;
  if (!same(prev.trail, cur.trail)) delta.trail = cur.trail;
  if (!same(prev.illustrative_xy, cur.illustrative_xy)) delta.illustrative_xy = cur.illustrative_xy;
  return delta;
}

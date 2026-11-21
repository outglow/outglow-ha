import type { DirectionFrame, Frame, FrameDelta, LiveMessage, PairFrame } from "./types";

function directionKey(d: DirectionFrame): string {
  return `${d.rx}<${d.tx}`;
}

function pairKey(p: PairFrame): string {
  return `${p.a}|${p.b}`;
}

function mergeList<T>(base: T[], changed: T[] | undefined, key: (item: T) => string): T[] {
  if (!changed || changed.length === 0) {
    return base;
  }
  const updates = new Map(changed.map((item) => [key(item), item]));
  const merged = base.map((item) => updates.get(key(item)) ?? item);
  const known = new Set(base.map(key));
  return merged.concat(changed.filter((item) => !known.has(key(item))));
}

export function applyDelta(frame: Frame, delta: FrameDelta): Frame {
  return {
    t: delta.t,
    status: delta.status ?? frame.status,
    model_version: delta.model_version ?? frame.model_version,
    directions: mergeList(frame.directions, delta.directions, directionKey),
    pairs: mergeList(frame.pairs, delta.pairs, pairKey),
    rooms: { ...frame.rooms, ...delta.rooms },
    veto: delta.veto === undefined ? frame.veto : delta.veto,
    gates: { ...frame.gates, ...delta.gates },
    trail: delta.trail ?? frame.trail,
    illustrative_xy: delta.illustrative_xy ?? frame.illustrative_xy,
  };
}

export function applyLive(frame: Frame | null, message: LiveMessage): Frame | null {
  if (message.kind === "full") {
    return message.frame;
  }
  return frame === null ? null : applyDelta(frame, message.delta);
}

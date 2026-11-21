import type { Frame, Plan, Point } from "./api/types";
import type { Box } from "./geometry";

export interface HeatGrid {
  box: Box;
  cols: number;
  rows: number;
  cell: number;
  values: Float32Array;
}

export interface HeatSource {
  a: Point;
  b: Point;
  strength: number;
}

export const ELLIPSE_M = 0.45;
export const BLOB_M = 0.9;

export function heatGrid(box: Box, maxCells = 110): HeatGrid {
  const cell = Math.max(box[2], box[3]) / maxCells;
  const cols = Math.max(1, Math.ceil(box[2] / cell));
  const rows = Math.max(1, Math.ceil(box[3] / cell));
  return { box, cols, rows, cell, values: new Float32Array(cols * rows) };
}

export function pairSources(plan: Plan, frame: Frame | null): HeatSource[] {
  if (!frame) {
    return [];
  }
  const at = new Map(plan.bulbs.map((b) => [b.ieee, [b.x, b.y] as Point]));
  const sources: HeatSource[] = [];
  for (const pair of frame.pairs) {
    if (pair.obs !== 1 && pair.obs !== 2) continue;
    const a = at.get(pair.a);
    const b = at.get(pair.b);
    if (!a || !b) continue;
    const strength = (pair.obs === 2 ? 1 : 0.4) * (0.35 + 0.65 * Math.min(1, Math.max(0, pair.weight)));
    sources.push({ a, b, strength });
  }
  return sources;
}

export function blobSources(frame: Frame | null): { at: Point; strength: number }[] {
  if (!frame) {
    return [];
  }
  return Object.entries(frame.illustrative_xy).map(([room, at]) => ({ at, strength: frame.rooms[room]?.p ?? 0.5 }));
}

export function fillHeat(grid: HeatGrid, pairs: HeatSource[], blobs: { at: Point; strength: number }[]): HeatGrid {
  const { box, cols, rows, cell, values } = grid;
  values.fill(0);
  const k = 1 / (2 * ELLIPSE_M * ELLIPSE_M);
  const kb = 1 / (2 * BLOB_M * BLOB_M);
  for (let j = 0; j < rows; j += 1) {
    const y = box[1] + (j + 0.5) * cell;
    for (let i = 0; i < cols; i += 1) {
      const x = box[0] + (i + 0.5) * cell;
      let v = 0;
      for (const s of pairs) {
        const length = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
        const excess = Math.hypot(x - s.a[0], y - s.a[1]) + Math.hypot(x - s.b[0], y - s.b[1]) - length;
        v += (s.strength * Math.exp(-excess * excess * k)) / Math.sqrt(Math.max(1, length));
      }
      for (const b of blobs) {
        const d2 = (x - b.at[0]) ** 2 + (y - b.at[1]) ** 2;
        v += 0.9 * b.strength * Math.exp(-d2 * kb);
      }
      values[j * cols + i] = 1 - Math.exp(-1.4 * v);
    }
  }
  return grid;
}

export function approach(current: Float32Array, target: Float32Array, factor: number): number {
  let change = 0;
  for (let i = 0; i < current.length; i += 1) {
    const d = target[i]! - current[i]!;
    current[i] = current[i]! + d * factor;
    change = Math.max(change, Math.abs(d));
  }
  return change;
}

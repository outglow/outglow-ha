import { describe, expect, it } from "vitest";
import type { Frame } from "../src/api/types";
import { approach, blobSources, fillHeat, heatGrid, pairSources } from "../src/heat";
import { MOCK_FRAMES, MOCK_PLAN } from "../mock/backend";

function busiest(): Frame {
  return MOCK_FRAMES.reduce((best, f) =>
    f.pairs.filter((p) => p.obs === 2).length > best.pairs.filter((p) => p.obs === 2).length ? f : best,
  );
}

describe("heat field", () => {
  it("sizes the grid to the box", () => {
    const grid = heatGrid([0, 0, 10, 5], 100);
    expect(grid.cols).toBe(100);
    expect(grid.rows).toBe(50);
    expect(grid.values.length).toBe(5000);
  });

  it("is empty without motion and bright along an active pair", () => {
    const grid = heatGrid([0, 0, 8, 8], 80);
    fillHeat(grid, [], []);
    expect(Math.max(...grid.values)).toBe(0);
    fillHeat(grid, [{ a: [1, 4], b: [7, 4], strength: 1 }], []);
    const at = (x: number, y: number): number => grid.values[Math.floor(y / grid.cell) * grid.cols + Math.floor(x / grid.cell)]!;
    expect(at(4, 4)).toBeGreaterThan(0.2);
    expect(at(4, 4)).toBeGreaterThan(at(4, 7) * 5);
    expect(Math.max(...grid.values)).toBeLessThan(1);
  });

  it("weights two-sided pairs above one-sided ones", () => {
    const frame = busiest();
    const sources = pairSources(MOCK_PLAN, frame);
    const both = sources.filter((s) => s.strength > 0.5);
    expect(both.length).toBe(frame.pairs.filter((p) => p.obs === 2).length);
    expect(sources.every((s) => s.strength > 0 && s.strength <= 1)).toBe(true);
    expect(pairSources(MOCK_PLAN, null)).toEqual([]);
  });

  it("adds a soft blob at the illustrative point", () => {
    const frame = MOCK_FRAMES.find((f) => Object.keys(f.illustrative_xy).length > 0)!;
    const blobs = blobSources(frame);
    expect(blobs.length).toBe(1);
    expect(blobs[0]!.strength).toBeGreaterThan(0.5);
  });

  it("eases towards the target", () => {
    const current = new Float32Array([0, 1]);
    const change = approach(current, new Float32Array([1, 0]), 0.25);
    expect(change).toBe(1);
    expect(current[0]).toBeCloseTo(0.25);
    expect(current[1]).toBeCloseTo(0.75);
  });
});

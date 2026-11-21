import { describe, expect, it } from "vitest";
import type { Frame } from "../src/api/types";
import "../src/plan-view";
import { MOCK_FRAMES, MOCK_PLAN } from "../mock/backend";

type PlanView = HTMLElement & {
  updateComplete: Promise<boolean>;
  plan: unknown;
  frame: Frame | null;
  calm: boolean;
  layers: unknown;
  _pulses: unknown[];
};

const flip = (frame: Frame, state: "quiet" | "exceed"): Frame => ({
  ...frame,
  directions: frame.directions.map((d) => ({ ...d, state })),
});

async function pulses(calm: boolean): Promise<number> {
  const el = document.createElement("outglow-plan-view") as PlanView;
  el.plan = MOCK_PLAN;
  el.layers = { lines: true, trail: false, heat: true, bulbNames: false };
  el.calm = calm;
  document.body.append(el);
  const base = MOCK_FRAMES[0]!;
  el.frame = flip(base, "quiet");
  await el.updateComplete;
  el.frame = flip(base, "exceed");
  await el.updateComplete;
  const n = el._pulses.length;
  el.remove();
  return n;
}

describe("plan view", () => {
  it("draws no pulses when calm", async () => {
    expect(await pulses(false)).toBeGreaterThan(0);
    expect(await pulses(true)).toBe(0);
  });
});

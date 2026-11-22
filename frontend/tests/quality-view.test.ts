import { describe, expect, it } from "vitest";
import type { Point, Recommendation } from "../src/api/types";
import "../src/views/quality-view";
import { MockBackend, mockHass } from "../mock/hass";

type View = HTMLElement & {
  updateComplete: Promise<boolean>;
  hass: unknown;
  _highlight: Point[] | null;
};

async function settle(el: View): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await el.updateComplete;
  }
}

describe("quality view candidates", () => {
  it("shows a recommendation's own spots, and none of the others when it has none", async () => {
    const backend = new MockBackend();
    backend.latency = 0;
    const lone: Recommendation = {
      id: "one_bulb:hall",
      kind: "one_bulb",
      severity: "info",
      action: "show_candidates",
      room: "hall",
      rx: null,
      tx: null,
      bulb: null,
      numbers: { own_m: 0, lines_m: 0 },
      candidates: [],
    };
    backend.quality = { ...backend.quality, recommendations: [...backend.quality.recommendations, lone] };
    const el = document.createElement("outglow-quality-view") as View;
    el.hass = mockHass(false, "en", backend);
    document.body.append(el);
    await settle(el);
    const show = (id: string) => el.shadowRoot!.querySelector<HTMLButtonElement>(`[data-rec='${id}'] .buttons button`)!;
    show("coverage:office").click();
    await settle(el);
    expect(el._highlight).toEqual([[3.0, 6.0]]);
    show("one_bulb:hall").click();
    await settle(el);
    expect(el._highlight).toEqual([]);
    const plan = el.shadowRoot!.querySelector("outglow-plan-view") as HTMLElement & { markers: Point[] };
    expect(plan.markers).toEqual([]);
    expect(plan.classList.contains("flash")).toBe(false);
    el.remove();
  });
});

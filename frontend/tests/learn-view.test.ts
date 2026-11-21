import { describe, expect, it, vi } from "vitest";
import type { Frame, Plan, Session, SessionSummary } from "../src/api/types";
import "../src/views/learn-view";
import { MockBackend, mockHass } from "../mock/hass";
import { MOCK_FRAMES } from "../mock/backend";
import { buildSteps, initialState } from "../src/wizard";

type View = HTMLElement & {
  updateComplete: Promise<boolean>;
  plan: Plan | null;
  hass: unknown;
  _phase: string;
  _mode: string | null;
  _session: Session | null;
  _run: unknown;
  _scored: string | null;
  frame: Frame | null;
};

async function settle(el: View): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await el.updateComplete;
  }
}

async function view(): Promise<{ el: View; plan: Plan; backend: MockBackend }> {
  const backend = new MockBackend();
  backend.latency = 0;
  const plan: Plan = {
    ...backend.plan,
    rooms: [...backend.plan.rooms, { id: "store", name: "Store", outline: [[20, 20], [22, 20], [22, 22], [20, 22]], colour: "#888888", area_id: null, entrance: false }],
  };
  const el = document.createElement("outglow-learn-view") as View;
  el.hass = mockHass(false, "en", backend);
  el.plan = plan;
  document.body.append(el);
  await settle(el);
  return { el, plan, backend };
}

const text = (el: View): string => el.shadowRoot!.textContent ?? "";

describe("learning view and rooms without bulbs", () => {
  it("marks them before the start and during their steps", async () => {
    const { el } = await view();
    expect(el._mode).toBe("rules");
    const badges = [...el.shadowRoot!.querySelectorAll(".room-list .badge.warning")].map((b) => b.textContent?.trim());
    expect(badges).toEqual(["no bulbs"]);
    el._run = initialState(buildSteps({ rooms: ["store"], empty: false, emptyMinutes: 10 }), null, Date.now()).state;
    el._phase = "run";
    await settle(el);
    expect(el.shadowRoot!.querySelector(".homeless")?.textContent).toContain(
      "This room has no bulbs. Only lines crossing it can see you. Rules mode never lights it.",
    );
    expect(el.shadowRoot!.querySelector(".live-map outglow-plan-view")).not.toBeNull();
    el._mode = "bayes";
    await settle(el);
    expect(el.shadowRoot!.querySelector(".homeless")?.textContent).not.toContain("Rules mode");
    el.remove();
  });

  it("summarises the rules mode honestly and names rooms without bulbs", async () => {
    const { el } = await view();
    const summary: SessionSummary = {
      rooms: ["living", "hall", "office", "store"],
      matrix_before: [[1, 3, 0, 0, 0], [0, 4, 0, 0, 0], [0, 4, 0, 0, 0], [0, 4, 0, 0, 0]],
      matrix_after: [[1, 3, 0, 0, 0], [0, 4, 0, 0, 0], [0, 4, 0, 0, 0], [0, 4, 0, 0, 0]],
      accuracy_before: 0.31,
      accuracy_after: 0.31,
      weak_rooms: [],
      pending_id: "p-0001-0001",
      mode: "rules",
      bayes: { matrix_before: [[2, 2, 0, 0, 0]], matrix_after: [[4, 0, 0, 0, 0]], accuracy_before: 0.37, accuracy_after: 0.64 },
      suggest_mode: "bayes",
      rooms_without_bulbs: ["store"],
    };
    el._session = { session_id: "s-1", name: "Test", started: 0, state: "stopped", raised_rate: false, steps: [], live_feedback: { pairs_reacting: 0, veto: false }, summary };
    el._phase = "summary";
    await settle(el);
    expect(text(el)).toContain("Rules mode does not learn");
    expect(text(el)).toContain(
      "In bayes mode the same walks score 37 % now and 64 % after learning, checked within this same session, so optimistic.",
    );
    expect(text(el)).toContain("No bulbs in: Store");
    expect(text(el)).toContain("Switch to bayes and apply");
    const values = () => [...el.shadowRoot!.querySelectorAll(".score .value")].map((v) => v.textContent?.trim());
    expect(values()).toEqual(["31 %", "31 %"]);
    el._scored = "bayes";
    await settle(el);
    expect(values()).toEqual(["37 %", "64 %"]);
    expect(el.shadowRoot!.querySelector(".room-map outglow-plan-view")).not.toBeNull();
    el.remove();
  });

  it("shows only the active mode for a bayes session without a suggestion", async () => {
    const { el } = await view();
    const summary: SessionSummary = {
      rooms: ["living"],
      matrix_before: [[1, 1]],
      matrix_after: [[2, 0]],
      accuracy_before: 0.5,
      accuracy_after: 1,
      weak_rooms: [],
      pending_id: "p-0001-0001",
      mode: "bayes",
      bayes: null,
      suggest_mode: null,
      rooms_without_bulbs: [],
    };
    el._session = { session_id: "s-1", name: "Test", started: 0, state: "stopped", raised_rate: false, steps: [], live_feedback: { pairs_reacting: 0, veto: false }, summary };
    el._phase = "summary";
    await settle(el);
    expect(text(el)).not.toContain("Rules mode does not learn");
    expect(text(el)).toContain("Apply learning");
    expect(text(el)).toContain("checked on the half of each walk");
    expect(el.shadowRoot!.querySelector(".mode-switch")).toBeNull();
    el.remove();
  });

  const rulesSummary = (extra: Partial<SessionSummary>): SessionSummary => ({
    rooms: ["living"],
    matrix_before: [[1, 3]],
    matrix_after: [[1, 3]],
    accuracy_before: 0.25,
    accuracy_after: 0.25,
    weak_rooms: [],
    pending_id: "p-0008",
    mode: "rules",
    bayes: { matrix_before: [[2, 2]], matrix_after: [[4, 0]], accuracy_before: 0.5, accuracy_after: 1 },
    suggest_mode: "bayes",
    rooms_without_bulbs: [],
    ...extra,
  });

  const show = async (el: View, summary: SessionSummary): Promise<void> => {
    el._session = { session_id: "s-1", name: "Test", started: 0, state: "stopped", raised_rate: false, steps: [], live_feedback: { pairs_reacting: 0, veto: false }, summary };
    el._phase = "summary";
    await settle(el);
  };

  const button = (el: View, label: string): HTMLButtonElement =>
    [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".summary-actions button")].find((b) => b.textContent?.includes(label))!;

  it("says false alarms in an empty home are unknown and keeps rules as the first choice", async () => {
    const { el } = await view();
    await show(el, rulesSummary({ empty_house_hours: 0 }));
    expect(el.shadowRoot!.querySelector(".empty-unknown")?.textContent).toContain("False alarms in an empty home are unknown");
    expect(text(el)).toContain("Bayes has not seen your home empty yet.");
    expect(text(el)).toContain("with the empty home step, or leave learning on while everyone is out for at least 2 h.");
    expect(button(el, "Switch to bayes and apply").classList.contains("tonal")).toBe(true);
    expect(button(el, "Apply and stay in rules mode").classList.contains("filled")).toBe(true);
    await show(el, rulesSummary({ empty_house_hours: 0.5 }));
    expect(text(el)).toContain("Bayes has seen your home empty for only 30 min.");
    await show(el, rulesSummary({ empty_house_hours: 2.5 }));
    expect(el.shadowRoot!.querySelector(".empty-unknown")).toBeNull();
    expect(button(el, "Switch to bayes and apply").classList.contains("filled")).toBe(true);
    expect(button(el, "Apply and stay in rules mode").classList.contains("tonal")).toBe(true);
    el.remove();
  });

  it("reads a summary saved before it carried its mode in the current mode", async () => {
    const { el } = await view();
    el._mode = "bayes";
    const { mode: _mode, bayes: _bayes, suggest_mode: _suggest, ...old } = rulesSummary({});
    await show(el, old);
    expect(text(el)).toContain("checked on the half of each walk");
    expect(text(el)).not.toContain("Rules mode does not use the learned model");
    expect(el.shadowRoot!.querySelector(".mode-switch")).toBeNull();
    el.remove();
  });

  it("switches to bayes in the same call that applies, leaving other settings alone", async () => {
    const { el, backend } = await view();
    backend.model = { ...backend.model, pending: { pending_id: "p-0008", created: 0, labels: { wizard: 4 }, rooms: [] } };
    await show(el, rulesSummary({ empty_house_hours: 3 }));
    const seen: { type: string; mode?: unknown }[] = [];
    const dispatch = backend.dispatch.bind(backend);
    backend.dispatch = (msg) => {
      seen.push({ type: String(msg.type), mode: msg.mode });
      return dispatch(msg);
    };
    backend.settings = { ...backend.settings, global: { ...backend.settings.global, others_may_be_home: true } };
    button(el, "Switch to bayes and apply").click();
    await settle(el);
    expect(seen.map((m) => m.type)).toEqual(["outglow/model/apply"]);
    expect(seen[0]?.mode).toBe("bayes");
    expect(backend.settings.global.mode).toBe("bayes");
    expect(backend.settings.global.others_may_be_home).toBe(true);
    expect(el._phase).toBe("finished");
    el.remove();
  });

  it("refreshes the live map at most once a second", async () => {
    const { el } = await view();
    el._run = initialState(buildSteps({ rooms: ["living"], empty: false, emptyMinutes: 10 }), "living", Date.now()).state;
    el._phase = "run";
    const clock = vi.spyOn(Date, "now");
    const shown = (): Frame | null =>
      (el.shadowRoot!.querySelector(".live-map outglow-plan-view") as unknown as { frame: Frame | null }).frame;
    const at = async (ms: number, frame: Frame): Promise<void> => {
      clock.mockReturnValue(1_800_000_000_000 + ms);
      el.frame = frame;
      await settle(el);
    };
    const [a, b, c, d] = MOCK_FRAMES as [Frame, Frame, Frame, Frame];
    await at(0, a);
    expect(shown()).toBe(a);
    expect((el.shadowRoot!.querySelector(".live-map outglow-plan-view") as unknown as { calm: boolean }).calm).toBe(true);
    await at(250, b);
    await at(750, c);
    expect(shown()).toBe(a);
    await at(1000, d);
    expect(shown()).toBe(d);
    clock.mockRestore();
    el.remove();
  });
});

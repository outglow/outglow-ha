import { describe, expect, it } from "vitest";
import type { Settings, Snapshot } from "../src/api/types";
import "../src/views/settings-view";
import { MockBackend, mockHass } from "../mock/hass";

type View = HTMLElement & {
  updateComplete: Promise<boolean>;
  hass: unknown;
  _rollback: Snapshot | null;
  _saved: Settings | null;
  _draft: Settings | null;
};

async function settle(el: View): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await el.updateComplete;
  }
}

describe("settings view rollback", () => {
  it("restores the mode a switch and apply changed, and says so first", async () => {
    const backend = new MockBackend();
    backend.latency = 0;
    backend.settings = { ...backend.settings, global: { ...backend.settings.global, mode: "bayes" } };
    const switched: Snapshot = { snapshot_id: "m-0042", t: 1, reason: "before_apply", model_version: 6, mode: "rules" };
    backend.snapshots.push(switched);
    const el = document.createElement("outglow-settings-view") as View;
    el.hass = mockHass(false, "en", backend);
    document.body.append(el);
    await settle(el);
    const marks = [...el.shadowRoot!.querySelectorAll(".snapshots .snapshot-mode")].map((m) => m.textContent);
    expect(marks).toEqual(["also sets rules mode back"]);
    expect(el.shadowRoot!.querySelector(".snapshots-hint")?.textContent).toContain("goes back only with a snapshot taken before an apply that switched it");
    const note = () => el.shadowRoot!.querySelector(".rollback-mode")?.textContent ?? "";
    el._rollback = backend.snapshots[0]!;
    await settle(el);
    expect(note()).toBe("");
    el._rollback = switched;
    await settle(el);
    expect(note()).toBe("Detection also goes back to rules mode, which was on before this change.");
    el.shadowRoot!.querySelector<HTMLButtonElement>("[data-action=rollback]")!.click();
    await settle(el);
    expect(backend.settings.global.mode).toBe("rules");
    expect(el._saved?.global.mode).toBe("rules");
    expect(el._draft?.global.mode).toBe("rules");
    expect(el.shadowRoot!.querySelector(".savebar")).toBeNull();
    expect(backend.snapshots.at(-1)).toMatchObject({ reason: "before_rollback", mode: "bayes" });
    el.remove();
  });
});

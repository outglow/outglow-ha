import { describe, expect, it, vi } from "vitest";
import type { Plan } from "../src/api/types";
import type { HassMessage } from "../src/hass";
import "../src/outglow-panel";
import { RESYNC_MAX_MS, parseRoute, type OutglowPanel } from "../src/outglow-panel";
import { MOCK_PLAN } from "../mock/backend";
import { MockBackend, mockHass, type MockConnection } from "../mock/hass";

async function settle(panel: HTMLElement & { updateComplete: Promise<boolean> }): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await panel.updateComplete;
  }
}

function backend(): MockBackend {
  const b = new MockBackend();
  b.latency = 0;
  return b;
}

describe("outglow-panel on the mock", () => {
  it("renders rooms and bulbs from the contract", async () => {
    const panel = document.createElement("outglow-panel") as OutglowPanel;
    panel.hass = mockHass(false, "en", backend());
    document.body.append(panel);
    await settle(panel);
    const live = panel.shadowRoot!.querySelector("outglow-live-view") as unknown as OutglowPanel;
    await settle(live);
    const names = [...live.shadowRoot!.querySelectorAll(".rooms .name")].map((e) => e.textContent);
    expect(names).toEqual(["Living room", "Hall", "Office"]);
    const view = live.shadowRoot!.querySelector("outglow-plan-view") as unknown as OutglowPanel;
    await settle(view);
    expect(view.shadowRoot!.querySelectorAll("circle.bulb").length).toBe(4);
    expect(panel.shadowRoot!.querySelector(".status")?.textContent).toContain("5/6");
    panel.remove();
  });

  it("speaks Polish when Home Assistant does", async () => {
    const panel = document.createElement("outglow-panel") as OutglowPanel;
    panel.hass = mockHass(false, "pl", backend());
    document.body.append(panel);
    await settle(panel);
    const tabs = [...panel.shadowRoot!.querySelectorAll(".appbar [role=tab]")].map((e) => e.textContent?.trim());
    expect(tabs).toEqual(["Na żywo", "Plan", "Nauka", "Jakość", "Ustawienia", "Historia"]);
    panel.remove();
  });
});

describe("routes", () => {
  it("maps paths to tabs and keeps the rest", () => {
    expect(parseRoute("/settings/hall")).toEqual({ tab: "settings", subpath: "hall" });
    expect(parseRoute("/learn")).toEqual({ tab: "learn", subpath: "" });
    expect(parseRoute("")).toEqual({ tab: "live", subpath: "" });
    expect(parseRoute("/nope/x")).toEqual({ tab: "live", subpath: "" });
  });
});

describe("outglow-panel after Home Assistant restarts", () => {
  it("asks for the plan again until the integration answers, without a toast meanwhile", async () => {
    const mock = backend();
    const panel = document.createElement("outglow-panel") as OutglowPanel;
    const hass = mockHass(false, "en", mock);
    panel.hass = hass;
    document.body.append(panel);
    await settle(panel);
    const connection = hass.connection as MockConnection;
    const send = connection.sendMessagePromise.bind(connection);
    let refusals = 3;
    connection.sendMessagePromise = <T,>(message: HassMessage): Promise<T> => {
      if (message.type === "outglow/plan/get" && refusals > 0) {
        refusals -= 1;
        return Promise.reject({ code: "unknown_command", message: "Unknown command." });
      }
      return send<T>(message);
    };
    const renamed = structuredClone(MOCK_PLAN);
    renamed.rooms[0]!.name = "Lounge";
    const state = panel as unknown as { _plan: Plan; _toast: unknown };
    await mock.handle({ type: "outglow/plan/save", rev: mock.rev, plan: renamed });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      connection.drop();
      connection.restore();
      for (let i = 0; i < 6; i += 1) {
        await vi.advanceTimersByTimeAsync(RESYNC_MAX_MS);
      }
    } finally {
      vi.useRealTimers();
    }
    await settle(panel);
    expect(refusals).toBe(0);
    expect(state._plan.rooms[0]!.name).toBe("Lounge");
    expect(state._toast).toBeNull();
    panel.remove();
  });
});

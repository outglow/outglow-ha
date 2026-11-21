import { describe, expect, it } from "vitest";
import "../src/outglow-panel";
import { parseRoute, type OutglowPanel } from "../src/outglow-panel";
import { MockBackend, mockHass } from "../mock/hass";

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

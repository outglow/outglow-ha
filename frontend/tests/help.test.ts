import { describe, expect, it } from "vitest";
import "../src/outglow-panel";
import { HELP, HELP_URL, helpUrl } from "../src/help";
import { TABS, type OutglowPanel } from "../src/outglow-panel";
import { MockBackend, mockHass } from "../mock/hass";

async function settle(panel: HTMLElement & { updateComplete: Promise<boolean> }): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await panel.updateComplete;
  }
}

describe("help", () => {
  it("has a README section for every tab", () => {
    expect(Object.keys(HELP).sort()).toEqual(TABS.map((t) => t.id).sort());
    expect(new Set(Object.values(HELP)).size).toBe(TABS.length);
    expect(helpUrl("plan")).toBe(`${HELP_URL}#plan-editor`);
  });

  it("links the header to the section of the open tab, in a new window", async () => {
    const backend = new MockBackend();
    backend.latency = 0;
    const panel = document.createElement("outglow-panel") as OutglowPanel;
    panel.hass = mockHass(false, "pl", backend);
    panel.route = { prefix: "/outglow", path: "/quality" };
    document.body.append(panel);
    await settle(panel);
    const link = panel.shadowRoot!.querySelector<HTMLAnchorElement>("a.help")!;
    expect(link.getAttribute("href")).toBe(helpUrl("quality"));
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("aria-label")).toBe("Pomoc");
    panel.route = { prefix: "/outglow", path: "/history" };
    await settle(panel);
    expect(link.getAttribute("href")).toBe(helpUrl("history"));
    panel.remove();
  });
});

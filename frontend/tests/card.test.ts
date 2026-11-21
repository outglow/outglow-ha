import { describe, expect, it } from "vitest";
import { OutglowMapCard, normaliseConfig } from "../src/outglow-cards";
import { MockBackend, mockHass } from "../mock/hass";

describe("outglow-map-card", () => {
  it("fills defaults and rejects bad options", () => {
    expect(normaliseConfig({ type: "custom:outglow-map-card" })).toMatchObject({
      show_lines: true,
      show_trail: true,
      show_heat: true,
      show_rooms: true,
    });
    expect(() => normaliseConfig({ type: "x", rooms: "hall" as never })).toThrow();
    expect(() => normaliseConfig({ type: "x", height: 10 })).toThrow();
    expect(OutglowMapCard.getStubConfig().type).toBe("custom:outglow-map-card");
  });

  it("renders only the chosen rooms", async () => {
    const backend = new MockBackend();
    backend.latency = 0;
    const card = document.createElement("outglow-map-card") as OutglowMapCard;
    card.setConfig({ type: "custom:outglow-map-card", rooms: ["hall"] });
    card.hass = mockHass(false, "en", backend);
    document.body.append(card);
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await card.updateComplete;
    }
    const chips = [...card.shadowRoot!.querySelectorAll(".room")].map((e) => e.textContent?.replace(/\s+/g, " ").trim());
    expect(chips.length).toBe(1);
    expect(chips[0]).toContain("Hall");
    card.remove();
  });
});

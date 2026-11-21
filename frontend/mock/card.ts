import "../src/outglow-cards";
import type { OutglowMapCard } from "../src/outglow-cards";
import { MockBackend } from "./backend";
import { mockHass } from "./hass";

class HaCard extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:block;background:var(--card-background-color);border-radius:var(--ha-card-border-radius,12px);border:1px solid var(--divider-color);color:var(--primary-text-color);font-family:var(--ha-font-family-body)}</style><slot></slot>`;
  }
}

if (!customElements.get("ha-card")) {
  customElements.define("ha-card", HaCard);
}

const params = new URLSearchParams(location.search);
const root = document.documentElement;
const backend = new MockBackend();
backend.latency = Number(params.get("latency") ?? 60);
let dark = params.get("theme") === "dark";
let language = params.get("lang") ?? (navigator.language || "en");
if (params.has("shot")) {
  document.body.classList.add("shot");
}

const full = document.querySelector<OutglowMapCard>("#full");
const subset = document.querySelector<OutglowMapCard>("#subset");
full?.setConfig({ type: "custom:outglow-map-card" });
subset?.setConfig({ type: "custom:outglow-map-card", title: "Hall & office", rooms: ["hall", "office"], show_heat: false, height: 260 });

function apply(): void {
  root.dataset.theme = dark ? "dark" : "light";
  root.lang = language;
  for (const card of [full, subset]) {
    if (!card) continue;
    const hass = mockHass(dark, language, backend);
    if (card.hass) hass.connection = card.hass.connection;
    card.hass = hass;
  }
}

apply();

document.querySelector("#theme")?.addEventListener("click", () => {
  dark = !dark;
  apply();
});
document.querySelector("#lang")?.addEventListener("click", () => {
  language = language.startsWith("pl") ? "en" : "pl";
  apply();
});

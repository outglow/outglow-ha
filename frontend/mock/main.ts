import "../src/outglow-panel";
import type { OutglowPanel } from "../src/outglow-panel";
import { MockBackend } from "./backend";
import { mockHass } from "./hass";

const root = document.documentElement;
const params = new URLSearchParams(location.search);
const panel = document.querySelector<OutglowPanel>("outglow-panel");
const themeButton = document.querySelector<HTMLButtonElement>("#theme");
const langButton = document.querySelector<HTMLButtonElement>("#lang");
const backend = new MockBackend();
if (params.has("shot")) {
  document.body.classList.add("shot");
}
const latency = params.get("latency");
if (latency !== null) {
  backend.latency = Number(latency);
}

let dark = params.get("theme") === "dark" || (params.get("theme") === null && matchMedia("(prefers-color-scheme: dark)").matches);
let language = params.get("lang") ?? (navigator.language || "en");

function route(): { prefix: string; path: string } {
  const path = location.pathname.replace(/^\/outglow/, "") || "/live";
  return { prefix: "/outglow", path };
}

function apply(): void {
  root.dataset.theme = dark ? "dark" : "light";
  root.lang = language;
  if (!panel) return;
  const hass = mockHass(dark, language, backend);
  if (panel.hass) {
    hass.connection = panel.hass.connection;
  }
  panel.hass = hass;
  panel.narrow = window.innerWidth < 870;
}

if (panel) {
  if (!location.pathname.startsWith("/outglow")) {
    history.replaceState(null, "", `/outglow/live${location.search}`);
  }
  panel.route = route();
  apply();
}

window.addEventListener("location-changed", () => {
  if (panel) panel.route = route();
});
window.addEventListener("popstate", () => {
  if (panel) panel.route = route();
});
window.addEventListener("resize", () => {
  if (panel) panel.narrow = window.innerWidth < 870;
});

themeButton?.addEventListener("click", () => {
  dark = !dark;
  apply();
});

langButton?.addEventListener("click", () => {
  language = language.startsWith("pl") ? "en" : "pl";
  apply();
});

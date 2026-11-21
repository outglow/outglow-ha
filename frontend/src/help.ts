import type { Tab } from "./outglow-panel";

export const HELP_URL = "https://github.com/outglow/outglow-ha";

export const HELP: Record<Tab, string> = {
  live: "#live",
  plan: "#plan-editor",
  learn: "#learning-wizard",
  quality: "#quality",
  settings: "#settings",
  history: "#history",
};

export function helpUrl(tab: Tab): string {
  return `${HELP_URL}${HELP[tab]}`;
}

import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { call, subscribe } from "./api/client";
import { applyLive } from "./api/live";
import type { Frame, Plan } from "./api/types";
import { fmtPercent } from "./format";
import type { Hass, Unsubscribe } from "./hass";
import { locOf, strings, type Loc } from "./i18n";
import "./plan-view";
import type { Layers } from "./plan-view";
import { errorText } from "./strings/common";
import { shared, tokens } from "./theme";

export interface CardConfig {
  type: string;
  title?: string;
  rooms?: string[];
  show_lines?: boolean;
  show_trail?: boolean;
  show_heat?: boolean;
  show_rooms?: boolean;
  height?: number;
}

interface CustomCardEntry {
  type: string;
  name: string;
  description: string;
  preview?: boolean;
}

const t = strings(
  {
    title: "Outglow",
    motion: "motion",
    no_plan: "No floor plan yet. Draw it in the Outglow panel.",
    loading: "Loading…",
  },
  {
    title: "Outglow",
    motion: "ruch",
    no_plan: "Nie ma jeszcze planu. Narysuj go w panelu Outglow.",
    loading: "Ładowanie…",
  },
);

export function normaliseConfig(config: CardConfig): Required<Omit<CardConfig, "title" | "rooms" | "height">> & CardConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Invalid configuration");
  }
  if (config.rooms !== undefined && !Array.isArray(config.rooms)) {
    throw new Error("rooms must be a list of room ids");
  }
  if (config.height !== undefined && (typeof config.height !== "number" || config.height < 80)) {
    throw new Error("height must be a number of pixels, at least 80");
  }
  return {
    ...config,
    show_lines: config.show_lines ?? true,
    show_trail: config.show_trail ?? true,
    show_heat: config.show_heat ?? true,
    show_rooms: config.show_rooms ?? true,
  };
}

export class OutglowMapCard extends LitElement {
  static override properties = {
    hass: { attribute: false },
    _config: { state: true },
    _plan: { state: true },
    _frame: { state: true },
    _names: { state: true },
    _error: { state: true },
  };

  declare hass: Hass | undefined;
  declare _config: ReturnType<typeof normaliseConfig> | null;
  declare _plan: Plan | null;
  declare _frame: Frame | null;
  declare _names: Record<string, string>;
  declare _error: string | null;

  private _unsubscribe: Promise<Unsubscribe> | null = null;
  private _loading = false;

  constructor() {
    super();
    this._config = null;
    this._plan = null;
    this._frame = null;
    this._names = {};
    this._error = null;
  }

  static getStubConfig(): CardConfig {
    return { type: "custom:outglow-map-card", show_lines: true, show_trail: true };
  }

  static override styles = [
    tokens,
    shared,
    css`
      :host {
        display: block;
      }
      ha-card {
        display: block;
        overflow: hidden;
        height: 100%;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 16px 16px 0;
      }
      .head h2 {
        flex: 1;
        font-size: var(--ha-card-header-font-size, 20px);
        font-weight: 400;
        line-height: 28px;
      }
      outglow-plan-view {
        padding: 8px 12px;
      }
      .rooms {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 0 16px 14px;
      }
      .room {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 28px;
        padding: 0 10px;
        border-radius: 14px;
        background: var(--og-tint);
        font-size: 13px;
        font-weight: 500;
        transition: background-color 300ms;
      }
      .room.on {
        background: var(--og-motion-tint);
      }
      .room .swatch {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      .room .p {
        color: var(--og-fg2);
        font-variant-numeric: tabular-nums;
        font-weight: 400;
      }
      .message {
        padding: 16px;
        color: var(--og-fg2);
      }
    `,
  ];

  setConfig(config: CardConfig): void {
    this._config = normaliseConfig(config);
  }

  getCardSize(): number {
    const height = this._config?.height ?? 300;
    return Math.max(3, Math.round(height / 50) + 1);
  }

  getGridOptions(): { columns: number; rows: number | "auto"; min_rows: number } {
    return { columns: 12, rows: "auto", min_rows: 4 };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hass) void this._start();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    const pending = this._unsubscribe;
    this._unsubscribe = null;
    if (pending) {
      void pending.then((unsubscribe) => unsubscribe()).catch(() => undefined);
    }
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has("hass") && this.hass && !this._unsubscribe) {
      void this._start();
    }
  }

  private get _loc(): Loc {
    return locOf(this.hass);
  }

  private async _start(): Promise<void> {
    const hass = this.hass;
    if (!hass || this._unsubscribe || this._loading || !this.isConnected) return;
    this._loading = true;
    try {
      const [plan, bulbs] = await Promise.all([call(hass, "outglow/plan/get", {}), call(hass, "outglow/bulbs", {})]);
      this._plan = plan.plan;
      this._names = Object.fromEntries(bulbs.bulbs.map((b) => [b.ieee, b.name]));
      this._error = null;
      this._unsubscribe = subscribe(hass, "outglow/live/subscribe", { rate_hz: 2 }, (message) => {
        this._frame = applyLive(this._frame, message);
      });
      this._unsubscribe.catch((err: unknown) => {
        this._error = errorText(this._loc, err);
        this._unsubscribe = null;
      });
    } catch (err) {
      this._error = errorText(this._loc, err);
    } finally {
      this._loading = false;
    }
  }

  override render() {
    const config = this._config;
    if (!config) return nothing;
    const loc = this._loc;
    const plan = this._plan;
    const rooms = plan ? (config.rooms ? plan.rooms.filter((r) => config.rooms!.includes(r.id)) : plan.rooms) : [];
    const layers: Layers = { lines: config.show_lines, trail: config.show_trail, heat: config.show_heat, bulbNames: false };
    return html`<ha-card>
      ${config.title !== "" ? html`<div class="head"><h2>${config.title ?? t(loc, "title")}</h2></div>` : nothing}
      ${this._error
        ? html`<div class="message" role="alert">${this._error}</div>`
        : !plan
          ? html`<div class="message">${t(loc, "loading")}</div>`
          : plan.rooms.length === 0
            ? html`<div class="message">${t(loc, "no_plan")}</div>`
            : html`<outglow-plan-view
                  .plan=${plan}
                  .frame=${this._frame}
                  .names=${this._names}
                  .loc=${loc}
                  .layers=${layers}
                  .rooms=${config.rooms ?? null}
                  .dark=${Boolean(this.hass?.themes?.darkMode)}
                  max-height=${config.height ? `${config.height}px` : "420px"}
                ></outglow-plan-view>
                ${config.show_rooms
                  ? html`<div class="rooms">
                      ${rooms.map((room) => {
                        const state = this._frame?.rooms[room.id];
                        return html`<span class="room ${state?.motion ? "on" : ""}">
                          <span class="swatch" style="background:${room.colour}"></span>${room.name}
                          <span class="p">${state?.motion ? t(loc, "motion") : fmtPercent(loc, state?.p ?? 0)}</span>
                        </span>`;
                      })}
                    </div>`
                  : nothing}`}
    </ha-card>`;
  }
}

if (!customElements.get("outglow-map-card")) {
  customElements.define("outglow-map-card", OutglowMapCard);
  const registry = window as unknown as { customCards?: CustomCardEntry[] };
  registry.customCards = registry.customCards ?? [];
  registry.customCards.push({
    type: "outglow-map-card",
    name: "Outglow map",
    description: "Rooms, lines and motion of Outglow sensing on your floor plan",
    preview: true,
  });
}

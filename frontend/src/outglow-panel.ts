import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { call, subscribe } from "./api/client";
import { applyLive } from "./api/live";
import type { Bulb, Frame, Info, Plan } from "./api/types";
import type { Hass, Unsubscribe } from "./hass";
import { helpUrl } from "./help";
import { locOf, type Loc } from "./i18n";
import {
  icon,
  mdiChartBox,
  mdiCog,
  mdiFloorPlan,
  mdiHelpCircleOutline,
  mdiHistory,
  mdiMenu,
  mdiMotionSensor,
  mdiSchool,
  mdiWifiOff,
} from "./icons";
import { errorText, statusText, tc } from "./strings/common";
import { shared, tokens } from "./theme";
import type { Toast } from "./views/base";
import "./plan-view";
import "./components/og-sheet";
import "./views/live-view";
import "./views/plan-editor";
import "./views/learn-view";
import "./views/quality-view";
import "./views/settings-view";
import "./views/history-view";

export type Tab = "live" | "plan" | "learn" | "quality" | "settings" | "history";

export const TABS: { id: Tab; icon: string }[] = [
  { id: "live", icon: mdiMotionSensor },
  { id: "plan", icon: mdiFloorPlan },
  { id: "learn", icon: mdiSchool },
  { id: "quality", icon: mdiChartBox },
  { id: "settings", icon: mdiCog },
  { id: "history", icon: mdiHistory },
];

const LIVE_RATE_HZ = 4;

export function parseRoute(path: string | undefined): { tab: Tab; subpath: string } {
  const parts = (path ?? "").split("/").filter(Boolean);
  const first = parts[0] as Tab | undefined;
  const tab = first && TABS.some((t) => t.id === first) ? first : "live";
  return { tab, subpath: tab === first ? parts.slice(1).join("/") : "" };
}

interface Route {
  prefix?: string;
  path: string;
}

export class OutglowPanel extends LitElement {
  static override properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    route: { attribute: false },
    panel: { attribute: false },
    _tab: { state: true },
    _subpath: { state: true },
    _info: { state: true },
    _plan: { state: true },
    _rev: { state: true },
    _frame: { state: true },
    _bulbs: { state: true },
    _error: { state: true },
    _toast: { state: true },
  };

  declare hass: Hass | undefined;
  declare narrow: boolean;
  declare route: Route | undefined;
  declare panel: unknown;
  declare _tab: Tab;
  declare _subpath: string;
  declare _info: Info | null;
  declare _plan: Plan | null;
  declare _rev: number;
  declare _frame: Frame | null;
  declare _bulbs: Bulb[];
  declare _error: string | null;
  declare _toast: Toast | null;

  private _connected = false;

  private _unsubscribe: Promise<Unsubscribe> | null = null;
  private _dirty = false;
  private _toastTimer: ReturnType<typeof setTimeout> | undefined;
  private _visibility = (): void => {
    if (document.hidden) {
      void this._stopLive();
    } else {
      this._startLive();
    }
  };

  constructor() {
    super();
    this.narrow = false;
    this._tab = "live";
    this._subpath = "";
    this._info = null;
    this._plan = null;
    this._rev = 0;
    this._frame = null;
    this._bulbs = [];
    this._error = null;
    this._toast = null;
    this.addEventListener("og-navigate", (e) => this._navigate((e as CustomEvent<{ path: string }>).detail.path));
    this.addEventListener("og-toast", (e) => this._showToast((e as CustomEvent<Toast>).detail));
    this.addEventListener("og-plan", (e) => {
      const detail = (e as CustomEvent<{ plan: Plan; rev: number }>).detail;
      this._plan = detail.plan;
      this._rev = detail.rev;
    });
    this.addEventListener("og-dirty", (e) => {
      this._dirty = (e as CustomEvent<{ dirty: boolean }>).detail.dirty;
    });
    this.addEventListener("og-refresh-bulbs", () => void this._loadBulbs());
  }

  static override styles = [
    tokens,
    shared,
    css`
      :host {
        display: block;
        min-height: 100vh;
        background: var(--og-bg);
        color: var(--og-fg);
      }
      .top {
        position: sticky;
        top: 0;
        z-index: 3;
        background: var(--app-header-background-color, var(--og-card));
        color: var(--app-header-text-color, var(--og-fg));
        border-bottom: var(--app-header-border-bottom, 1px solid var(--og-divider));
      }
      .appbar {
        display: flex;
        align-items: center;
        gap: 4px;
        height: 56px;
        padding: 0 8px 0 16px;
        max-width: 1600px;
        margin: 0 auto;
      }
      .appbar.narrow {
        padding-left: 4px;
      }
      .menu {
        color: inherit;
      }
      h1 {
        font-size: 20px;
        font-weight: 400;
        letter-spacing: 0.01em;
        margin-right: 20px;
        white-space: nowrap;
      }
      nav {
        display: flex;
        gap: 2px;
        overflow-x: auto;
        scrollbar-width: none;
        align-self: stretch;
      }
      nav::-webkit-scrollbar {
        display: none;
      }
      nav button {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 44px;
        padding: 0 14px;
        border: none;
        background: transparent;
        color: var(--og-fg2);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        border-radius: 0;
        transition: color 150ms;
      }
      nav button .icon {
        opacity: 0.85;
      }
      nav button:hover {
        color: var(--og-fg);
        background: var(--og-tint);
      }
      nav button[aria-selected="true"] {
        color: var(--og-primary);
      }
      nav button::after {
        content: "";
        position: absolute;
        left: 10px;
        right: 10px;
        bottom: 0;
        height: 3px;
        border-radius: 3px 3px 0 0;
        background: var(--og-primary);
        transform: scaleX(0);
        transition: transform 200ms var(--og-ease);
      }
      nav button[aria-selected="true"]::after {
        transform: scaleX(1);
      }
      nav button:focus-visible {
        outline-offset: -3px;
      }
      .spacer {
        flex: 1;
      }
      a.help {
        color: inherit;
        text-decoration: none;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 0 8px;
        font-size: 13px;
        color: var(--og-fg2);
        white-space: nowrap;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--og-success);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--og-success) 20%, transparent);
      }
      .dot.learning {
        background: var(--og-info);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--og-info) 20%, transparent);
      }
      .dot.degraded {
        background: var(--og-warning);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--og-warning) 22%, transparent);
      }
      .dot.paused,
      .dot.off {
        background: var(--og-fg2);
        box-shadow: none;
      }
      .tabs-row {
        display: none;
      }
      @media (max-width: 860px) {
        .appbar nav {
          display: none;
        }
        .tabs-row {
          display: block;
        }
        .tabs-row nav {
          padding: 0 4px;
        }
        .tabs-row nav button {
          flex: 1 0 auto;
          padding: 0 12px;
        }
      }
      @media (max-width: 480px) {
        .tabs-row nav button .icon {
          display: none;
        }
        .status .label {
          display: none;
        }
      }
      main {
        max-width: 1600px;
        margin: 0 auto;
        padding: 16px;
      }
      @media (max-width: 600px) {
        main {
          padding: 12px 12px 24px;
        }
      }
      .error-card {
        max-width: 560px;
        margin: 48px auto;
      }
      .toast {
        position: fixed;
        left: 50%;
        bottom: calc(24px + env(safe-area-inset-bottom));
        transform: translateX(-50%);
        z-index: 10;
        display: flex;
        align-items: center;
        gap: 12px;
        max-width: min(560px, calc(100vw - 32px));
        min-height: 48px;
        padding: 12px 16px;
        border-radius: 8px;
        background: color-mix(in srgb, var(--og-fg) 92%, var(--og-bg));
        color: var(--og-bg);
        font-size: 14px;
        line-height: 20px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
        animation: toast 220ms var(--og-ease);
      }
      .toast.error {
        border-left: 4px solid var(--og-error);
      }
      @keyframes toast {
        from {
          opacity: 0;
          transform: translate(-50%, 12px);
        }
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._visibility);
    window.addEventListener("beforeunload", this._beforeUnload);
    if (this.hass) {
      void this._start();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._visibility);
    window.removeEventListener("beforeunload", this._beforeUnload);
    void this._stopLive();
  }

  private _beforeUnload = (event: BeforeUnloadEvent): void => {
    if (this._dirty) {
      event.preventDefault();
    }
  };

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("route")) {
      const { tab, subpath } = parseRoute(this.route?.path);
      this._tab = tab;
      this._subpath = subpath;
    }
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has("hass") && changed.get("hass") === undefined && this.hass) {
      void Promise.resolve().then(() => this._start());
    }
  }

  private get _loc(): Loc {
    return locOf(this.hass);
  }

  private async _start(): Promise<void> {
    const hass = this.hass;
    if (!hass || this._connected) {
      return;
    }
    this._connected = true;
    this._startLive();
    try {
      const [info, plan] = await Promise.all([call(hass, "outglow/info", {}), call(hass, "outglow/plan/get", {})]);
      this._info = info;
      this._plan = plan.plan;
      this._rev = plan.rev;
      this._error = null;
      await this._loadBulbs();
    } catch (err) {
      this._error = errorText(this._loc, err);
      this._connected = false;
    }
  }

  private async _loadBulbs(): Promise<void> {
    if (!this.hass) return;
    try {
      this._bulbs = (await call(this.hass, "outglow/bulbs", {})).bulbs;
    } catch (err) {
      this._showToast({ text: errorText(this._loc, err), error: true });
    }
  }

  private _startLive(): void {
    const hass = this.hass;
    if (!hass || this._unsubscribe || document.hidden) {
      return;
    }
    this._unsubscribe = subscribe(hass, "outglow/live/subscribe", { rate_hz: LIVE_RATE_HZ }, (message) => {
      this._frame = applyLive(this._frame, message);
    });
    this._unsubscribe.catch(() => {
      this._unsubscribe = null;
    });
  }

  private async _stopLive(): Promise<void> {
    const pending = this._unsubscribe;
    this._unsubscribe = null;
    if (pending) {
      try {
        await (await pending)();
      } catch {
        return;
      }
    }
  }

  private _navigate(path: string): void {
    const { tab } = parseRoute(path);
    if (this._dirty && tab !== "plan" && !window.confirm(tc(this._loc, "unsaved"))) {
      return;
    }
    if (tab !== "plan") {
      this._dirty = false;
    }
    const prefix = this.route?.prefix ?? "/outglow";
    const url = `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
    history.pushState(null, "", url);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
    const parsed = parseRoute(path);
    this._tab = parsed.tab;
    this._subpath = parsed.subpath;
  }

  private _showToast(toast: Toast): void {
    this._toast = toast;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (this._toast = null), toast.error ? 6000 : 3200);
  }

  private _tabKey(event: KeyboardEvent, index: number): void {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    if (event.key in keys || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next =
        event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + keys[event.key]! + TABS.length) % TABS.length;
      this._navigate(`/${TABS[next]!.id}`);
      const nav = (event.currentTarget as HTMLElement).parentElement;
      void this.updateComplete.then(() => (nav?.querySelectorAll("button")[next] as HTMLElement | undefined)?.focus());
    }
  }

  private _nav() {
    return html`<nav role="tablist" aria-label=${tc(this._loc, "app")}>
      ${TABS.map(
        (tab, i) =>
          html`<button
            role="tab"
            aria-selected=${tab.id === this._tab}
            tabindex=${tab.id === this._tab ? 0 : -1}
            @click=${() => this._navigate(`/${tab.id}`)}
            @keydown=${(e: KeyboardEvent) => this._tabKey(e, i)}
          >
            ${icon(tab.icon, 20)}<span>${tc(this._loc, tab.id)}</span>
          </button>`,
      )}
    </nav>`;
  }

  private _status() {
    const loc = this._loc;
    const gates = Object.values(this._frame?.gates ?? {});
    const total = this._bulbs.length || gates.length;
    const online = this._bulbs.length ? this._bulbs.filter((b) => b.available).length : gates.filter((g) => g !== "offline").length;
    const status = this._frame?.status ?? this._info?.status;
    if (!status && !total) return nothing;
    return html`<span class="status" role="status">
      ${status ? html`<span class="dot ${status}"></span><span class="label">${statusText(loc, status)}</span>` : nothing}
      ${total
        ? html`<span class="badge num" title=${tc(loc, "bulbs_online", { n: online, total })}>
            ${online < total ? icon(mdiWifiOff, 14) : nothing}${tc(loc, "bulbs_online", { n: online, total })}
          </span>`
        : nothing}
    </span>`;
  }

  override render() {
    const loc = this._loc;
    return html`
      <header class="top">
        <div class="appbar ${this.narrow ? "narrow" : ""}">
          ${this.narrow
            ? html`<button
                class="icon-btn menu"
                aria-label=${tc(loc, "menu")}
                @click=${() => this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }))}
              >
                ${icon(mdiMenu)}
              </button>`
            : nothing}
          <h1>${tc(loc, "app")}</h1>
          ${this._nav()}
          <span class="spacer"></span>
          ${this._status()}
          <a
            class="icon-btn help"
            href=${helpUrl(this._tab)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${tc(loc, "help")}
            title=${tc(loc, "help")}
          >
            ${icon(mdiHelpCircleOutline)}
          </a>
        </div>
        <div class="tabs-row">${this._nav()}</div>
      </header>
      <main>${this._error ? this._errorCard() : this._view()}</main>
      ${this._toast
        ? html`<div class="toast ${this._toast.error ? "error" : ""}" role=${this._toast.error ? "alert" : "status"}>${this._toast.text}</div>`
        : nothing}
    `;
  }

  private _errorCard() {
    const loc = this._loc;
    return html`<div class="card error-card">
      <div class="empty-state">
        ${icon(mdiWifiOff, 48)}
        <div class="headline">${tc(loc, "error")}</div>
        <div class="small">${this._error}</div>
        <button class="btn filled" @click=${() => void this._start()}>${tc(loc, "retry")}</button>
      </div>
    </div>`;
  }

  private _view() {
    if (!this._info || !this._plan) {
      return html`<div class="empty-state" aria-busy="true">${tc(this._loc, "loading")}</div>`;
    }
    const common = {
      hass: this.hass,
      loc: this._loc,
      plan: this._plan,
      rev: this._rev,
      frame: this._frame,
      bulbs: this._bulbs,
      info: this._info,
      narrow: this.narrow,
      dark: Boolean(this.hass?.themes?.darkMode),
      subpath: this._subpath,
    };
    switch (this._tab) {
      case "live":
        return html`<outglow-live-view .hass=${common.hass} .loc=${common.loc} .plan=${common.plan} .rev=${common.rev}
          .frame=${common.frame} .bulbs=${common.bulbs} .info=${common.info} .narrow=${common.narrow} .dark=${common.dark}
          .subpath=${common.subpath}></outglow-live-view>`;
      case "plan":
        return html`<outglow-plan-editor .hass=${common.hass} .loc=${common.loc} .plan=${common.plan} .rev=${common.rev}
          .frame=${common.frame} .bulbs=${common.bulbs} .info=${common.info} .narrow=${common.narrow} .dark=${common.dark}
          .subpath=${common.subpath}></outglow-plan-editor>`;
      case "learn":
        return html`<outglow-learn-view .hass=${common.hass} .loc=${common.loc} .plan=${common.plan} .rev=${common.rev}
          .frame=${common.frame} .bulbs=${common.bulbs} .info=${common.info} .narrow=${common.narrow} .dark=${common.dark}
          .subpath=${common.subpath}></outglow-learn-view>`;
      case "quality":
        return html`<outglow-quality-view .hass=${common.hass} .loc=${common.loc} .plan=${common.plan} .rev=${common.rev}
          .frame=${common.frame} .bulbs=${common.bulbs} .info=${common.info} .narrow=${common.narrow} .dark=${common.dark}
          .subpath=${common.subpath}></outglow-quality-view>`;
      case "settings":
        return html`<outglow-settings-view .hass=${common.hass} .loc=${common.loc} .plan=${common.plan} .rev=${common.rev}
          .frame=${common.frame} .bulbs=${common.bulbs} .info=${common.info} .narrow=${common.narrow} .dark=${common.dark}
          .subpath=${common.subpath}></outglow-settings-view>`;
      case "history":
        return html`<outglow-history-view .hass=${common.hass} .loc=${common.loc} .plan=${common.plan} .rev=${common.rev}
          .frame=${common.frame} .bulbs=${common.bulbs} .info=${common.info} .narrow=${common.narrow} .dark=${common.dark}
          .subpath=${common.subpath}></outglow-history-view>`;
    }
  }
}

if (!customElements.get("outglow-panel")) {
  customElements.define("outglow-panel", OutglowPanel);
}

import { css, html, nothing } from "lit";
import type { DirectionFrame, DirectionQuality, PairFrame, QualityReport, Room, RoomFrame } from "../api/types";
import { Backdrop } from "../background";
import { fmtAgo, fmtClock, fmtNumber, fmtPercent } from "../format";
import { strings } from "../i18n";
import {
  icon,
  mdiArrowRight,
  mdiChartBox,
  mdiCog,
  mdiEyeOff,
  mdiFloorPlan,
  mdiLayers,
  mdiLightningBolt,
  mdiShieldCheck,
  mdiWifiOff,
} from "../icons";
import { legend, legendStyles } from "../legend";
import { DEFAULT_LAYERS, pairKey, type Layers } from "../plan-view";
import { tc } from "../strings/common";
import { shared, tokens } from "../theme";
import { ViewBase } from "./base";

export const tl = strings(
  {
    rooms: "Rooms",
    now: "Now",
    motion: "motion",
    hold: "holding",
    empty: "empty",
    since: "for {when}",
    left: "left {when}",
    pairs_seeing: { one: "{n} pair sees motion", other: "{n} pairs see motion" },
    pairs_both: { one: "{n} in both directions", other: "{n} in both directions" },
    no_motion: "No motion anywhere",
    veto_none: "Interference: none",
    veto_common: "Interference across many lines, ignored",
    veto_receiver: "Interference at {bulb}, ignored",
    offline: { one: "{n} bulb offline", other: "{n} bulbs offline" },
    trail: "Trail",
    trail_empty: "No room changes yet",
    layers: "Layers",
    layer_lines: "Lines",
    layer_trail: "Trail",
    layer_heat: "Heat",
    layer_names: "Bulb names",
    layer_background: "Background",
    pair_title: "{a} ↔ {b}",
    obs_2: "Both directions see motion",
    obs_1: "One direction sees motion",
    obs_0: "Quiet",
    obs_null: "No data",
    direction: "{rx} hears {tx}",
    level: "Level",
    z: "z",
    state: "State",
    state_quiet: "quiet",
    state_exceed: "motion",
    state_quiet_censored: "quiet (gate closed)",
    state_none: "no data",
    background: "In the background",
    per_h: "{n}/h",
    theta: "Learnt sensitivity by room",
    no_theta: "Not learnt yet",
    skip: "Skip direction",
    unskip: "Use again",
    skipped: "skipped",
    details: "Details in Quality",
    weight: "Information {n}",
    room_settings: "Room settings",
    probability: "Probability",
    coverage: "Coverage",
    coverage_good: "good",
    coverage_weak: "weak",
    coverage_none: "none",
    top_pairs: "Pairs that see this room best",
    status: "Model",
    model_version: "version {n}",
    flag_one_sided: "one-sided",
    flag_single_direction: "single direction",
    flag_frozen: "frozen",
    flag_weak: "weak signal",
    flag_excluded: "skipped",
    flag_asymmetric_noisy: "noisy, asymmetric",
    flag_blanked: "blanked after a light change",
    flag_vetoed: "vetoed",
    reason: "skipped from the live view",
  },
  {
    rooms: "Pokoje",
    now: "Teraz",
    motion: "ruch",
    hold: "podtrzymanie",
    empty: "pusto",
    since: "od {when}",
    left: "wyjście {when}",
    pairs_seeing: { one: "{n} para widzi ruch", few: "{n} pary widzą ruch", many: "{n} par widzi ruch", other: "{n} pary widzą ruch" },
    pairs_both: { one: "{n} w obie strony", few: "{n} w obie strony", many: "{n} w obie strony", other: "{n} w obie strony" },
    no_motion: "Nigdzie nie ma ruchu",
    veto_none: "Zakłócenia: brak",
    veto_common: "Zakłócenie na wielu liniach, pominięte",
    veto_receiver: "Zakłócenie przy {bulb}, pominięte",
    offline: { one: "{n} żarówka offline", few: "{n} żarówki offline", many: "{n} żarówek offline", other: "{n} żarówki offline" },
    trail: "Ślad",
    trail_empty: "Jeszcze bez przejść",
    layers: "Warstwy",
    layer_lines: "Linie",
    layer_trail: "Ślad",
    layer_heat: "Ciepło",
    layer_names: "Nazwy żarówek",
    layer_background: "Tło",
    pair_title: "{a} ↔ {b}",
    obs_2: "Ruch widzą oba kierunki",
    obs_1: "Ruch widzi jeden kierunek",
    obs_0: "Cisza",
    obs_null: "Brak danych",
    direction: "{rx} słyszy {tx}",
    level: "Poziom",
    z: "z",
    state: "Stan",
    state_quiet: "cisza",
    state_exceed: "ruch",
    state_quiet_censored: "cisza (bramka zamknięta)",
    state_none: "brak danych",
    background: "W tle",
    per_h: "{n}/h",
    theta: "Wyuczona czułość wg pokoju",
    no_theta: "Jeszcze niewyuczona",
    skip: "Pomijaj kierunek",
    unskip: "Używaj znowu",
    skipped: "pomijany",
    details: "Szczegóły w Jakości",
    weight: "Informacja {n}",
    room_settings: "Ustawienia pokoju",
    probability: "Prawdopodobieństwo",
    coverage: "Pokrycie",
    coverage_good: "dobre",
    coverage_weak: "słabe",
    coverage_none: "brak",
    top_pairs: "Pary, które najlepiej widzą ten pokój",
    status: "Model",
    model_version: "wersja {n}",
    flag_one_sided: "jednostronny",
    flag_single_direction: "jeden kierunek",
    flag_frozen: "zamrożony",
    flag_weak: "słaby sygnał",
    flag_excluded: "pomijany",
    flag_asymmetric_noisy: "zaszumiony, asymetryczny",
    flag_blanked: "wygaszony po zmianie światła",
    flag_vetoed: "zawetowany",
    reason: "pominięty z widoku na żywo",
  },
);

const LAYERS_KEY = "outglow.live.layers";

function loadLayers(): Layers {
  try {
    const raw = localStorage.getItem(LAYERS_KEY);
    return raw ? { ...DEFAULT_LAYERS, ...(JSON.parse(raw) as Partial<Layers>) } : DEFAULT_LAYERS;
  } catch {
    return DEFAULT_LAYERS;
  }
}

function saveLayers(layers: Layers): void {
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
  } catch {
    return;
  }
}

export function lastSeen(trail: [string, number][], room: string): number | null {
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    if (trail[i]![0] === room) {
      return trail[i + 1]?.[1] ?? null;
    }
  }
  return null;
}

export class OutglowLiveView extends ViewBase {
  static override properties = {
    ...ViewBase.properties,
    _layers: { state: true },
    _layersOpen: { state: true },
    _pair: { state: true },
    _room: { state: true },
    _quality: { state: true },
  };

  declare _layers: Layers;
  declare _layersOpen: boolean;
  declare _pair: { a: string; b: string } | null;
  declare _room: string | null;
  declare _quality: QualityReport | null;

  private _qualityLoading = false;
  private _backdrop = new Backdrop(this);

  constructor() {
    super();
    this._layers = loadLayers();
    this._layersOpen = false;
    this._pair = null;
    this._room = null;
    this._quality = null;
  }

  static override styles = [
    tokens,
    shared,
    legendStyles,
    css`
      :host {
        display: block;
      }
      .layout {
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(0, 1fr);
        align-items: start;
      }
      @media (min-width: 1024px) {
        .layout {
          grid-template-columns: minmax(0, 1fr) 320px;
        }
      }
      .map {
        position: relative;
        overflow: hidden;
      }
      .map-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 8px 0 16px;
        min-height: 52px;
      }
      .map-head .headline {
        flex: 1;
      }
      outglow-plan-view {
        padding: 4px 12px 8px;
      }
      .map-foot {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 24px;
        padding: 12px 16px 14px;
        border-top: 1px solid var(--og-divider);
      }
      .map-foot .legend {
        flex: 1 1 340px;
      }
      .trail {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 6px;
        font-size: 13px;
        color: var(--og-fg2);
        flex: 1 1 320px;
      }
      .trail .eyebrow {
        margin-right: 4px;
      }
      .trail .step {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--og-fg);
      }
      .trail .step time {
        color: var(--og-fg2);
        font-variant-numeric: tabular-nums;
      }
      .trail .icon {
        opacity: 0.5;
      }
      .layers-pop {
        position: absolute;
        right: 8px;
        top: 52px;
        z-index: 2;
        min-width: 210px;
        padding: 8px 0;
        border-radius: 12px;
        background: var(--og-card);
        border: 1px solid var(--og-divider);
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
      }
      .layers-pop label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 44px;
        padding: 0 16px;
        font-size: 14px;
        cursor: pointer;
      }
      .rooms {
        list-style: none;
        margin: 0;
        padding: 0 8px 8px;
      }
      .rooms li button {
        display: grid;
        grid-template-columns: 12px minmax(0, 1fr) auto;
        grid-template-rows: auto auto;
        align-items: center;
        column-gap: 12px;
        row-gap: 6px;
        width: 100%;
        min-height: 60px;
        padding: 10px 8px;
        border: none;
        border-radius: 10px;
        background: transparent;
        text-align: left;
        cursor: pointer;
      }
      .rooms li button:hover {
        background: var(--og-tint);
      }
      .rooms .swatch {
        width: 12px;
        height: 12px;
        border-radius: 4px;
        grid-row: 1 / span 2;
      }
      .rooms .name {
        font-size: 15px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .rooms .right {
        text-align: right;
      }
      .rooms .bar {
        grid-column: 2 / span 2;
        height: 4px;
      }
      .rooms .bar > span {
        transition: width 400ms var(--og-ease);
      }
      .p {
        font-size: 13px;
        color: var(--og-fg2);
        font-variant-numeric: tabular-nums;
        min-width: 3.5em;
        display: inline-block;
        text-align: right;
      }
      .facts {
        list-style: none;
        margin: 0;
        padding: 0 16px 16px;
        display: grid;
        gap: 12px;
        font-size: 14px;
      }
      .facts li {
        display: flex;
        gap: 12px;
        align-items: center;
      }
      .facts .icon {
        color: var(--og-fg2);
      }
      .big {
        font-size: 28px;
        line-height: 32px;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
      }
      .pills {
        display: none;
        gap: 8px;
        overflow-x: auto;
        padding: 2px 2px 10px;
        margin: 0 -2px;
        scrollbar-width: none;
      }
      .pills::-webkit-scrollbar {
        display: none;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 40px;
        padding: 0 14px 0 10px;
        border-radius: 20px;
        border: 1px solid var(--og-divider);
        background: var(--og-card);
        font-size: 14px;
        font-weight: 500;
        white-space: nowrap;
        cursor: pointer;
        transition: background-color 300ms, border-color 300ms;
      }
      .pill.on {
        border-color: color-mix(in srgb, var(--og-motion) 55%, transparent);
        background: var(--og-motion-tint);
      }
      .pill .swatch {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }
      .side {
        display: grid;
        gap: 16px;
      }
      @media (max-width: 599px) {
        .pills {
          display: flex;
        }
        .side .rooms-card {
          display: none;
        }
      }
      @media (min-width: 600px) and (max-width: 1023px) {
        .side {
          grid-template-columns: 1fr 1fr;
        }
      }
      .dir {
        display: grid;
        gap: 6px;
        padding: 12px 0;
        border-top: 1px solid var(--og-divider);
      }
      .dir:first-of-type {
        border-top: none;
      }
      .kv {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      .kv div {
        display: grid;
        gap: 2px;
      }
      .kv b {
        font-weight: 500;
        font-size: 16px;
        font-variant-numeric: tabular-nums;
      }
      .theta {
        display: grid;
        gap: 6px;
        margin-top: 6px;
      }
      .theta-row {
        display: grid;
        grid-template-columns: 96px minmax(0, 1fr) 44px;
        align-items: center;
        gap: 10px;
        font-size: 13px;
      }
      .theta-row .bar {
        height: 8px;
        border-radius: 4px;
      }
      .obs {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
        margin-bottom: 4px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
        width: 100%;
      }
      .flags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
    `,
  ];

  override willUpdate(): void {
    if (this.subpath && !this._room && this.plan?.rooms.some((r) => r.id === this.subpath)) {
      this._room = this.subpath;
    }
    const file = this._layers.background === false ? null : (this.plan?.background?.file ?? null);
    this._backdrop.show(file ? { hass: this.hass, file } : null);
  }

  private _setLayer(key: keyof Layers, on: boolean): void {
    this._layers = { ...this._layers, [key]: on };
    saveLayers(this._layers);
  }

  private async _loadQuality(): Promise<void> {
    if (this._quality || this._qualityLoading) return;
    this._qualityLoading = true;
    try {
      this._quality = await this.call("outglow/quality", { days: 7 });
    } catch {
      this._quality = null;
    } finally {
      this._qualityLoading = false;
    }
  }

  private _openPair(a: string, b: string): void {
    this._pair = { a, b };
    void this._loadQuality();
  }

  private _roomState(room: Room, state: RoomFrame | undefined) {
    const loc = this.loc;
    const now = this.frame?.t ?? Date.now() / 1000;
    if (state?.motion) {
      return html`<span class="badge motion">${tl(loc, "motion")}</span>`;
    }
    if (state?.occupied) {
      return html`<span class="badge">${tl(loc, "hold")}</span>`;
    }
    const seen = lastSeen(this.frame?.trail ?? [], room.id);
    return html`<span class="muted small">${seen ? fmtAgo(loc, now - seen) : tl(loc, "empty")}</span>`;
  }

  private _roomsCard() {
    const plan = this.plan!;
    const loc = this.loc;
    return html`<section class="card rooms-card" aria-labelledby="rooms-h">
      <div class="card-head"><h2 class="headline" id="rooms-h">${tl(loc, "rooms")}</h2></div>
      <ul class="rooms">
        ${plan.rooms.map((room) => {
          const state = this.frame?.rooms[room.id];
          const p = state?.p ?? 0;
          return html`<li>
            <button @click=${() => (this._room = room.id)} aria-label=${`${room.name}, ${fmtPercent(loc, p)}`}>
              <span class="swatch" style="background:${room.colour}"></span>
              <span class="name">${room.name}</span>
              <span class="right">${this._roomState(room, state)} <span class="p">${fmtPercent(loc, p)}</span></span>
              <span class="bar"><span style="width:${(p * 100).toFixed(1)}%;background:${room.colour}"></span></span>
            </button>
          </li>`;
        })}
      </ul>
    </section>`;
  }

  private _nowCard() {
    const loc = this.loc;
    const frame = this.frame;
    const active = (frame?.pairs ?? []).filter((p) => p.obs === 1 || p.obs === 2);
    const both = active.filter((p) => p.obs === 2).length;
    const offline = Object.values(frame?.gates ?? {}).filter((g) => g === "offline").length;
    const veto = frame?.veto;
    return html`<section class="card" aria-labelledby="now-h">
      <div class="card-head"><h2 class="headline" id="now-h">${tl(loc, "now")}</h2></div>
      <ul class="facts">
        <li>
          <span class="big" aria-hidden="true">${active.length}</span>
          <span>
            ${active.length ? tl(loc, "pairs_seeing", { n: active.length }) : tl(loc, "no_motion")}
            ${active.length ? html`<br /><span class="muted small">${tl(loc, "pairs_both", { n: both })}</span>` : nothing}
          </span>
        </li>
        <li>
          ${icon(veto ? mdiLightningBolt : mdiShieldCheck, 20)}
          <span>
            ${veto
              ? veto.kind === "receiver" && veto.rx
                ? tl(loc, "veto_receiver", { bulb: this.bulbName(veto.rx) })
                : tl(loc, "veto_common")
              : tl(loc, "veto_none")}
          </span>
        </li>
        ${offline ? html`<li>${icon(mdiWifiOff, 20)}<span>${tl(loc, "offline", { n: offline })}</span></li>` : nothing}
        ${frame
          ? html`<li class="muted small">${tl(loc, "status")}: ${tc(loc, `status_${frame.status}`)} · ${tl(loc, "model_version", { n: frame.model_version })}</li>`
          : nothing}
      </ul>
    </section>`;
  }

  private _trail() {
    const loc = this.loc;
    const steps = (this.frame?.trail ?? []).slice(-4);
    return html`<div class="trail" aria-live="polite">
      <span class="eyebrow">${tl(loc, "trail")}</span>
      ${steps.length === 0
        ? html`<span>${tl(loc, "trail_empty")}</span>`
        : steps.map(
            ([room, t], i) =>
              html`${i > 0 ? icon(mdiArrowRight, 14) : nothing}<span class="step"
                  ><span class="swatch" style="background:${this.roomColour(room)}"></span>${this.roomName(room)}
                  <time>${fmtClock(loc, t)}</time></span
                >`,
          )}
    </div>`;
  }

  private _layersMenu() {
    const loc = this.loc;
    const items: [keyof Layers, string][] = [
      ["lines", tl(loc, "layer_lines")],
      ["heat", tl(loc, "layer_heat")],
      ["trail", tl(loc, "layer_trail")],
      ["bulbNames", tl(loc, "layer_names")],
      ...(this.plan?.background ? ([["background", tl(loc, "layer_background")]] as [keyof Layers, string][]) : []),
    ];
    return html`<div class="layers-pop" role="group" aria-label=${tl(loc, "layers")} @keydown=${(e: KeyboardEvent) => {
      if (e.key === "Escape") this._layersOpen = false;
    }}>
      ${items.map(
        ([key, label]) => html`<label>
          <span>${label}</span>
          <span class="switch"
            ><input type="checkbox" .checked=${this._layers[key] !== false} @change=${(e: Event) => this._setLayer(key, (e.target as HTMLInputElement).checked)} /><span></span
          ></span>
        </label>`,
      )}
    </div>`;
  }

  override render() {
    const plan = this.plan;
    const loc = this.loc;
    if (!plan || plan.rooms.length === 0) {
      return html`<div class="card">
        <div class="empty-state">
          ${icon(mdiFloorPlan, 48)}
          <div class="headline">${tc(loc, "no_plan")}</div>
          <div>${tc(loc, "no_plan_hint")}</div>
          <button class="btn filled" @click=${() => this.navigate("/plan")}>${tc(loc, "open_plan")}</button>
        </div>
      </div>`;
    }
    const narrow = window.innerWidth < 600;
    return html`
      ${this._pills()}
      <div class="layout">
        <section class="card map" aria-label=${tc(loc, "live")}>
          <div class="map-head">
            <h2 class="headline">${tc(loc, "live")}</h2>
            <button
              class="icon-btn"
              aria-label=${tl(loc, "layers")}
              aria-expanded=${this._layersOpen}
              aria-pressed=${this._layersOpen}
              @click=${() => (this._layersOpen = !this._layersOpen)}
            >
              ${icon(mdiLayers)}
            </button>
          </div>
          ${this._layersOpen ? this._layersMenu() : nothing}
          <outglow-plan-view
            .plan=${plan}
            .frame=${this.frame}
            .names=${this.names()}
            .loc=${loc}
            .layers=${this._layers}
            .background=${this._backdrop.url}
            .selected=${this._pair ? pairKey(this._pair.a, this._pair.b) : null}
            .dark=${this.dark}
            interactive
            max-height=${narrow ? "62vh" : "72vh"}
            @pair-select=${(e: CustomEvent<{ a: string; b: string }>) => this._openPair(e.detail.a, e.detail.b)}
            @room-select=${(e: CustomEvent<{ room: string }>) => (this._room = e.detail.room)}
          ></outglow-plan-view>
          <div class="map-foot">${legend(loc, { lines: this._layers.lines, heat: this._layers.heat, trail: this._layers.trail })} ${this._trail()}</div>
        </section>
        <div class="side">${this._roomsCard()} ${this._nowCard()}</div>
      </div>
      ${this._pairSheet()} ${this._roomSheet()}
    `;
  }

  private _pills() {
    const plan = this.plan!;
    const loc = this.loc;
    return html`<div class="pills" role="list" aria-label=${tl(loc, "rooms")}>
      ${plan.rooms.map((room) => {
        const state = this.frame?.rooms[room.id];
        return html`<button role="listitem" class="pill ${state?.motion ? "on" : ""}" @click=${() => (this._room = room.id)}>
          <span class="swatch" style="background:${room.colour}"></span>${room.name}
          <span class="p">${fmtPercent(loc, state?.p ?? 0)}</span>
        </button>`;
      })}
    </div>`;
  }

  private _direction(d: DirectionFrame | undefined, rx: string, tx: string, quality: DirectionQuality | undefined) {
    const loc = this.loc;
    const excluded = this.isExcluded(rx, tx);
    const theta = Object.entries(quality?.theta ?? {}).sort((a, b) => b[1] - a[1]);
    const flags = [...new Set([...(d?.flags ?? []), ...(quality?.flags ?? []), ...(excluded ? (["excluded"] as const) : [])])];
    return html`<div class="dir">
      <div class="row">
        <span class="headline grow">${tl(loc, "direction", { rx: this.bulbName(rx), tx: this.bulbName(tx) })}</span>
        ${d?.state === "exceed" ? html`<span class="badge motion">${tl(loc, "state_exceed")}</span>` : nothing}
      </div>
      <div class="kv">
        <div><span class="eyebrow">${tl(loc, "level")}</span><b>${d?.level ?? "—"}</b></div>
        <div><span class="eyebrow">${tl(loc, "z")}</span><b>${fmtNumber(loc, d?.z ?? null, 1)}</b></div>
        <div><span class="eyebrow">${tl(loc, "background")}</span><b>${quality ? tl(loc, "per_h", { n: Math.round(quality.exceed_per_h) }) : "—"}</b></div>
      </div>
      <div class="small muted">${tl(loc, "state")}: ${tl(loc, `state_${d?.state ?? "none"}`)}</div>
      ${flags.length ? html`<div class="flags">${flags.map((f) => html`<span class="badge ${f === "excluded" ? "warning" : ""}">${tl(loc, `flag_${f}`)}</span>`)}</div>` : nothing}
      <div class="theta">
        <span class="eyebrow">${tl(loc, "theta")}</span>
        ${theta.length
          ? theta.map(
              ([room, value]) => html`<div class="theta-row">
                <span>${this.roomName(room)}</span>
                <span class="bar"><span style="width:${Math.min(100, value * 100)}%;background:${this.roomColour(room)}"></span></span>
                <span class="num small">${fmtNumber(loc, value, 2, 2)}</span>
              </div>`,
            )
          : html`<span class="small muted">${tl(loc, "no_theta")}</span>`}
      </div>
      <div>
        <button class="btn ${excluded ? "tonal" : "outlined"} neutral" @click=${() => void this.setExcluded(rx, tx, !excluded, tl(loc, "reason"))}>
          ${icon(mdiEyeOff, 18)} ${excluded ? tl(loc, "unskip") : tl(loc, "skip")}
        </button>
      </div>
    </div>`;
  }

  private _pairSheet() {
    const loc = this.loc;
    const sel = this._pair;
    const pair: PairFrame | undefined = sel ? this.frame?.pairs.find((p) => pairKey(p.a, p.b) === pairKey(sel.a, sel.b)) : undefined;
    const dir = (rx: string, tx: string): DirectionFrame | undefined => this.frame?.directions.find((d) => d.rx === rx && d.tx === tx);
    const q = (rx: string, tx: string): DirectionQuality | undefined => this._quality?.directions.find((d) => d.rx === rx && d.tx === tx);
    return html`<og-sheet
      .open=${Boolean(sel)}
      heading=${sel ? tl(loc, "pair_title", { a: this.bulbName(sel.a), b: this.bulbName(sel.b) }) : ""}
      close-label=${tc(loc, "close")}
      @closed=${() => (this._pair = null)}
    >
      ${sel
        ? html`<div class="obs">
              <span class="badge ${pair?.obs === 2 || pair?.obs === 1 ? "motion" : ""}">${tl(loc, `obs_${pair?.obs ?? "null"}`)}</span>
              ${pair ? html`<span class="small muted">${tl(loc, "weight", { n: fmtNumber(loc, pair.weight, 2, 2) })}</span>` : nothing}
            </div>
            ${this._direction(dir(sel.a, sel.b), sel.a, sel.b, q(sel.a, sel.b))} ${this._direction(dir(sel.b, sel.a), sel.b, sel.a, q(sel.b, sel.a))}`
        : nothing}
      <div slot="actions" class="actions">
        <button class="btn" @click=${() => this.navigate("/quality")}>${icon(mdiChartBox, 18)} ${tl(loc, "details")}</button>
      </div>
    </og-sheet>`;
  }

  private _roomSheet() {
    const loc = this.loc;
    const room = this.plan?.rooms.find((r) => r.id === this._room);
    const state = room ? this.frame?.rooms[room.id] : undefined;
    const now = this.frame?.t ?? Date.now() / 1000;
    return html`<og-sheet .open=${Boolean(room)} heading=${room?.name ?? ""} close-label=${tc(loc, "close")} @closed=${() => (this._room = null)}>
      ${room
        ? html`<div class="stack">
            <div class="row wrap">
              ${this._roomState(room, state)}
              ${state?.since && (state.motion || state.occupied) ? html`<span class="small muted">${tl(loc, "since", { when: fmtAgo(loc, now - state.since) })}</span>` : nothing}
            </div>
            <div class="kv">
              <div><span class="eyebrow">${tl(loc, "probability")}</span><b>${fmtPercent(loc, state?.p ?? 0)}</b></div>
              <div><span class="eyebrow">${tl(loc, "coverage")}</span><b>${tl(loc, `coverage_${state?.coverage ?? "none"}`)}</b></div>
            </div>
            ${state?.top_pairs.length
              ? html`<div class="stack" style="gap:6px">
                  <span class="eyebrow">${tl(loc, "top_pairs")}</span>
                  ${state.top_pairs.map(
                    ([a, b]) => html`<button class="btn outlined neutral" style="justify-content:flex-start" @click=${() => {
                      this._room = null;
                      this._openPair(a, b);
                    }}>${this.bulbName(a)} ↔ ${this.bulbName(b)}</button>`,
                  )}
                </div>`
              : nothing}
          </div>`
        : nothing}
      <div slot="actions" class="actions">
        <button class="btn" @click=${() => room && this.navigate(`/settings/${room.id}`)}>${icon(mdiCog, 18)} ${tl(loc, "room_settings")}</button>
      </div>
    </og-sheet>`;
  }
}

if (!customElements.get("outglow-live-view")) {
  customElements.define("outglow-live-view", OutglowLiveView);
}

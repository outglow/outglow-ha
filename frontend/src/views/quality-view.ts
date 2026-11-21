import { css, html, nothing, type PropertyValues } from "lit";
import {
  mdiAlert,
  mdiCheckCircle,
  mdiChevronRight,
  mdiClose,
  mdiEyeOff,
  mdiEyeOutline,
  mdiInformation,
  mdiRefresh,
} from "@mdi/js";
import type { Bulb, BulbSetting, BulbValue, DirectionQuality, Frame, Point, QualityReport, Recommendation, RoomQuality, Settings } from "../api/types";
import "../components/bulb-write-dialog";
import { fmtNumber, fmtPercent } from "../format";
import { strings } from "../i18n";
import { icon } from "../icons";
import { DEFAULT_LAYERS, pairKey, type Layers } from "../plan-view";
import {
  actionText,
  coverageDots,
  flagText,
  loadDismissed,
  NOISE_MAX_PER_H,
  noiseAt,
  noiseColour,
  noiseGradient,
  overBudget,
  pairInformation,
  pairNoise,
  recommendationText,
  saveDismissed,
  sortDirections,
  tq,
  type DirectionSort,
} from "../quality";
import { tc } from "../strings/common";
import { shared, tokens } from "../theme";
import { ViewBase } from "./base";

export const tqv = strings(
  {
    title: "Quality",
    last_days: { one: "last day", other: "last {n} days" },
    period: "Period",
    days: { one: "{n} day", other: "{n} days" },
    empty_home: "Empty-home data",
    hours: "{n} h",
    enough: "enough for calibration",
    too_little: "too little for calibration",
    traffic: "Activity reports",
    per_s: "{n}/s in the network",
    rooms: "Rooms",
    room: "Room",
    false_day: "False alarms / day",
    detection: "Entries detected",
    latency: "Delay",
    latency_value: "{median} s · p90 {p90} s",
    coverage: "Coverage",
    vetoes: "Vetoes",
    not_known: "not known yet",
    over_budget: "above the budget of {budget}/day",
    budget: "budget {budget}/day",
    coverage_good: "good",
    coverage_weak: "weak",
    coverage_none: "none",
    directions: "Directions",
    view: "View",
    map: "Map",
    table: "Table",
    sort: "Sort by",
    sort_noise: "noise",
    sort_signal: "signal",
    sort_asymmetry: "asymmetry",
    direction: "Direction",
    background: "Background",
    per_h: "{n}/h",
    signal: "Signal",
    asymmetry: "Asymmetry",
    gate: "Gate open",
    theta: "Sensitivity by room",
    flags: "Notes",
    skip: "Skip",
    unskip: "Use again",
    details: "Details",
    skipped: "skipped",
    reason: "skipped from Quality",
    noise_scale: "Background noise of the noisier direction",
    quiet: "quiet",
    noisy: "noisy",
    candidate: "suggested bulb spot",
    recommendations: "Recommendations",
    none: "Nothing to improve right now.",
    dismiss: "Dismiss",
    dismissed: { one: "{n} dismissed", other: "{n} dismissed" },
    restore: "Show again",
    pair_title: "{a} ↔ {b}",
    hears: "{rx} hears {tx}",
    information: "Information by room",
    no_data: "No data",
    loading: "Loading quality…",
    refresh: "Refresh",
    dbm: "{n} dBm",
    times: "×{n}",
  },
  {
    title: "Jakość",
    last_days: { one: "ostatnia doba", few: "ostatnie {n} dni", many: "ostatnie {n} dni", other: "ostatnie {n} dni" },
    period: "Okres",
    days: { one: "{n} doba", few: "{n} dni", many: "{n} dni", other: "{n} dni" },
    empty_home: "Dane pustego domu",
    hours: "{n} h",
    enough: "wystarczy do kalibracji",
    too_little: "za mało do kalibracji",
    traffic: "Raporty aktywności",
    per_s: "{n}/s w sieci",
    rooms: "Pokoje",
    room: "Pokój",
    false_day: "Pomyłki / dobę",
    detection: "Wykryte wejścia",
    latency: "Opóźnienie",
    latency_value: "{median} s · p90 {p90} s",
    coverage: "Pokrycie",
    vetoes: "Weta",
    not_known: "jeszcze nie wiadomo",
    over_budget: "ponad budżet {budget}/dobę",
    budget: "budżet {budget}/dobę",
    coverage_good: "dobre",
    coverage_weak: "słabe",
    coverage_none: "brak",
    directions: "Kierunki",
    view: "Widok",
    map: "Mapa",
    table: "Tabela",
    sort: "Sortuj",
    sort_noise: "szum",
    sort_signal: "sygnał",
    sort_asymmetry: "asymetria",
    direction: "Kierunek",
    background: "W tle",
    per_h: "{n}/h",
    signal: "Sygnał",
    asymmetry: "Asymetria",
    gate: "Bramka otwarta",
    theta: "Czułość wg pokoju",
    flags: "Uwagi",
    skip: "Pomijaj",
    unskip: "Używaj znowu",
    details: "Szczegóły",
    skipped: "pomijany",
    reason: "pominięty z ekranu Jakość",
    noise_scale: "Szum w tle głośniejszego kierunku",
    quiet: "cicho",
    noisy: "głośno",
    candidate: "proponowane miejsce żarówki",
    recommendations: "Rekomendacje",
    none: "Teraz nie ma czego poprawiać.",
    dismiss: "Ukryj",
    dismissed: { one: "{n} ukryta", few: "{n} ukryte", many: "{n} ukrytych", other: "{n} ukryte" },
    restore: "Pokaż ponownie",
    pair_title: "{a} ↔ {b}",
    hears: "{rx} słyszy {tx}",
    information: "Informacja wg pokoju",
    no_data: "Brak danych",
    loading: "Wczytywanie jakości…",
    refresh: "Odśwież",
    dbm: "{n} dBm",
    times: "×{n}",
  },
);

const PERIODS = [1, 7, 30] as const;
const SORTS: DirectionSort[] = ["noise", "signal", "asymmetry"];
const MAP_LAYERS: Layers = { ...DEFAULT_LAYERS, lines: true, heat: false, trail: false, bulbNames: true };
const EXCLUDED_COLOUR = "rgb(140, 140, 140)";

interface WriteTarget {
  bulb: Bulb;
  setting: BulbSetting;
  value: BulbValue | null;
}

export class OutglowQualityView extends ViewBase {
  static override properties = {
    ...ViewBase.properties,
    _days: { state: true },
    _report: { state: true },
    _settings: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _mode: { state: true },
    _sort: { state: true },
    _pair: { state: true },
    _write: { state: true },
    _dismissed: { state: true },
    _highlight: { state: true },
  };

  declare _days: number;
  declare _report: QualityReport | null;
  declare _settings: Settings | null;
  declare _loading: boolean;
  declare _error: string | null;
  declare _mode: "map" | "table";
  declare _sort: DirectionSort;
  declare _pair: { a: string; b: string } | null;
  declare _write: WriteTarget | null;
  declare _dismissed: Set<string>;
  declare _highlight: Point[] | null;

  private _requested = false;

  constructor() {
    super();
    this._days = 7;
    this._report = null;
    this._settings = null;
    this._loading = false;
    this._error = null;
    this._mode = "map";
    this._sort = "noise";
    this._pair = null;
    this._write = null;
    this._dismissed = loadDismissed();
    this._highlight = null;
  }

  static override styles = [
    tokens,
    shared,
    css`
      :host {
        display: block;
      }
      .page {
        display: grid;
        gap: 16px;
      }
      .summary {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 16px 32px;
        padding: 16px 20px;
      }
      .summary .heading {
        display: grid;
        gap: 2px;
        margin-right: auto;
      }
      .stat {
        display: grid;
        gap: 2px;
        min-width: 140px;
      }
      .stat b {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 20px;
        line-height: 28px;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
      }
      .stat .ok {
        color: var(--og-success);
      }
      .stat .warn {
        color: var(--og-warning);
      }
      .two-col {
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas: "rooms" "recs" "dirs";
        align-items: start;
      }
      .a-rooms {
        grid-area: rooms;
      }
      .a-recs {
        grid-area: recs;
      }
      .a-dirs {
        grid-area: dirs;
      }
      @media (min-width: 1100px) {
        .two-col {
          grid-template-columns: minmax(0, 1fr) 400px;
          grid-template-areas: "rooms recs" "dirs recs";
          grid-template-rows: auto 1fr;
        }
      }
      .table-wrap {
        padding: 0 4px 8px;
        overflow-x: auto;
      }
      td.num,
      th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .room-cell {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-weight: 500;
      }
      .dots {
        display: inline-flex;
        gap: 3px;
        vertical-align: middle;
      }
      .dots i {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--og-tint-strong);
      }
      .dots i.on {
        background: var(--og-primary);
      }
      .dots.weak i.on {
        background: var(--og-warning);
      }
      .cov {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
      }
      .warn-text {
        color: color-mix(in srgb, var(--og-warning) 70%, var(--og-fg));
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .warn-text .icon {
        color: var(--og-warning);
      }
      .unknown {
        color: var(--og-fg2);
      }
      .unknown small {
        display: block;
        font-size: 11px;
      }
      .room-cards {
        display: none;
        padding: 0 12px 12px;
        gap: 10px;
      }
      .room-card {
        border: 1px solid var(--og-divider);
        border-radius: var(--og-radius-s);
        padding: 12px 14px;
        display: grid;
        gap: 10px;
      }
      .room-card dl {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px 16px;
        margin: 0;
      }
      .room-card dt {
        font-size: 12px;
        color: var(--og-fg2);
      }
      .room-card dd {
        margin: 2px 0 0;
        font-size: 15px;
        font-variant-numeric: tabular-nums;
      }
      @media (max-width: 720px) {
        .rooms-table {
          display: none;
        }
        .room-cards {
          display: grid;
        }
      }
      .dir-tools {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 16px;
        padding: 0 16px 12px;
      }
      .dir-tools .label {
        font-size: 12px;
        color: var(--og-fg2);
        margin-right: -8px;
      }
      .map-wrap {
        padding: 0 12px 4px;
      }
      .scale {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 20px;
        padding: 10px 16px 16px;
        border-top: 1px solid var(--og-divider);
        font-size: 12px;
        color: var(--og-fg2);
      }
      .scale .ramp {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .scale .ramp span.g {
        width: 120px;
        height: 8px;
        border-radius: 4px;
      }
      .scale .x {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .dirs {
        width: 100%;
      }
      .dirs td {
        padding: 8px 12px;
      }
      .dir-name {
        display: grid;
        gap: 2px;
      }
      .dir-name b {
        font-weight: 500;
        white-space: nowrap;
      }
      .dir-name span {
        font-size: 13px;
        color: var(--og-fg2);
        white-space: nowrap;
      }
      .noise {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
      }
      .noise i {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex: none;
      }
      .thetas {
        display: grid;
        gap: 3px;
        min-width: 120px;
      }
      .theta {
        display: grid;
        grid-template-columns: 8px minmax(0, 1fr);
        align-items: center;
        gap: 6px;
      }
      .theta .bar {
        height: 5px;
      }
      .flags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      tr.excluded td {
        opacity: 0.6;
      }
      tr.excluded td.act {
        opacity: 1;
      }
      td.act {
        white-space: nowrap;
        text-align: right;
      }
      .dir-cards {
        display: none;
        padding: 0 12px 12px;
        gap: 10px;
      }
      .a-dirs > section,
      .a-rooms > section {
        container-type: inline-size;
      }
      @container (max-width: 820px) {
        .dirs {
          display: none;
        }
        .dir-cards {
          display: grid;
        }
      }
      @container (max-width: 560px) {
        .rooms-table {
          display: none;
        }
        .room-cards {
          display: grid;
        }
      }
      .dirs td.sig {
        white-space: nowrap;
      }
      .dir-card {
        border: 1px solid var(--og-divider);
        border-radius: var(--og-radius-s);
        padding: 12px 14px;
        display: grid;
        gap: 10px;
      }
      .dir-card.excluded {
        background: var(--og-tint);
      }
      .dir-card .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 16px;
        font-size: 13px;
        color: var(--og-fg2);
        font-variant-numeric: tabular-nums;
      }
      .recs {
        list-style: none;
        margin: 0;
        padding: 0 12px 12px;
        display: grid;
        gap: 10px;
        counter-reset: rec;
      }
      .rec {
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr) auto;
        gap: 4px 12px;
        align-items: start;
        padding: 14px 8px 12px 14px;
        border-radius: var(--og-radius-s);
        background: var(--og-tint);
        border-left: 3px solid var(--og-info);
      }
      .rec.warning {
        background: color-mix(in srgb, var(--og-warning) 10%, transparent);
        border-left-color: var(--og-warning);
      }
      .rec .no {
        display: grid;
        place-items: center;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        font-size: 12px;
        font-weight: 600;
        background: var(--og-card);
        color: var(--og-fg);
        border: 1px solid var(--og-divider);
      }
      .rec p {
        font-size: 14px;
        line-height: 20px;
        padding-top: 2px;
      }
      .rec .note {
        display: flex;
        gap: 6px;
        align-items: center;
        margin-top: 4px;
        font-size: 12px;
        color: color-mix(in srgb, var(--og-warning) 65%, var(--og-fg));
      }
      .rec .buttons {
        grid-column: 2 / span 2;
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      .rec .dismiss {
        width: 36px;
        height: 36px;
        margin-top: -6px;
      }
      .recs-foot {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 16px 12px;
        font-size: 13px;
        color: var(--og-fg2);
      }
      .sheet-dir {
        display: grid;
        gap: 10px;
        padding: 14px 0;
        border-top: 1px solid var(--og-divider);
      }
      .sheet-dir:first-child {
        border-top: none;
        padding-top: 4px;
      }
      .kv {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }
      @media (max-width: 480px) {
        .kv {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
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
      .info-row {
        display: grid;
        grid-template-columns: 110px minmax(0, 1fr) 48px;
        align-items: center;
        gap: 10px;
        font-size: 13px;
      }
      .info-row .bar {
        height: 8px;
        border-radius: 4px;
      }
      .center {
        padding: 48px 16px;
        text-align: center;
        color: var(--og-fg2);
      }
      .flash {
        animation: flash 1.2s var(--og-ease);
      }
      @keyframes flash {
        0% {
          box-shadow: 0 0 0 0 color-mix(in srgb, var(--og-primary) 50%, transparent);
        }
        100% {
          box-shadow: 0 0 0 16px transparent;
        }
      }
    `,
  ];

  override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (this.hass && !this._requested) {
      this._requested = true;
      void this._load();
    }
  }

  private async _load(): Promise<void> {
    this._loading = true;
    this._error = null;
    try {
      const [report, settings] = await Promise.all([
        this.call("outglow/quality", { days: this._days }),
        this._settings ? Promise.resolve(this._settings) : this.call("outglow/settings/get", {}),
      ]);
      this._report = report;
      this._settings = settings;
    } catch (err) {
      this._error = String((err as { message?: string })?.message ?? err);
      this.fail(err);
    } finally {
      this._loading = false;
    }
  }

  private _setDays(days: number): void {
    if (days === this._days) return;
    this._days = days;
    void this._load();
  }

  private _names() {
    return { bulb: (ieee: string) => this.bulbName(ieee), room: (id: string) => this.roomName(id) };
  }

  private _segmented<T extends string | number>(label: string, values: readonly T[], current: T, text: (v: T) => string, pick: (v: T) => void) {
    return html`<div class="segmented" role="radiogroup" aria-label=${label}>
      ${values.map(
        (v) => html`<button role="radio" aria-checked=${v === current} @click=${() => pick(v)}>${text(v)}</button>`,
      )}
    </div>`;
  }

  private _summary(report: QualityReport | null) {
    const loc = this.loc;
    const hours = report?.empty_house_hours ?? null;
    const enough = hours !== null && hours >= 24;
    return html`<section class="card summary" aria-labelledby="q-title">
      <div class="heading">
        <h2 class="title" id="q-title">${tqv(loc, "title")}</h2>
        <span class="muted small">${tqv(loc, "last_days", { n: this._days })}</span>
      </div>
      <div class="stat">
        <span class="eyebrow">${tqv(loc, "empty_home")}</span>
        <b class="num">
          ${hours === null ? "—" : tqv(loc, "hours", { n: fmtNumber(loc, hours, 1) })}
          ${hours === null ? nothing : html`<span class=${enough ? "ok" : "warn"}>${icon(enough ? mdiCheckCircle : mdiAlert, 18)}</span>`}
        </b>
        <span class="small muted">${hours === null ? "" : tqv(loc, enough ? "enough" : "too_little")}</span>
      </div>
      <div class="stat">
        <span class="eyebrow">${tqv(loc, "traffic")}</span>
        <b class="num">${report ? tqv(loc, "per_s", { n: fmtNumber(loc, report.network_frames_per_s, 1) }) : "—"}</b>
      </div>
      <div class="row">
        ${this._segmented(tqv(loc, "period"), PERIODS, this._days as (typeof PERIODS)[number], (d) => tqv(loc, "days", { n: d }), (d) => this._setDays(d))}
        <button class="icon-btn" aria-label=${tqv(loc, "refresh")} @click=${() => void this._load()}>${icon(mdiRefresh, 20)}</button>
      </div>
    </section>`;
  }

  private _unknown() {
    return html`<span class="unknown">—<small>${tqv(this.loc, "not_known")}</small></span>`;
  }

  private _dots(room: RoomQuality) {
    const n = coverageDots(room.coverage, room.coverage_class);
    const loc = this.loc;
    return html`<span class="cov" title=${fmtNumber(loc, room.coverage, 1)}>
      <span class="dots ${room.coverage_class}" role="img" aria-label=${`${tqv(loc, "coverage")}: ${tqv(loc, `coverage_${room.coverage_class}`)}`}>
        ${[0, 1, 2, 3, 4].map((i) => html`<i class=${i < n ? "on" : ""}></i>`)}
      </span>
      <span class="small muted">${tqv(loc, `coverage_${room.coverage_class}`)}</span>
    </span>`;
  }

  private _falseAlarms(room: RoomQuality) {
    const loc = this.loc;
    if (room.false_alarms_per_day === null) return this._unknown();
    const budget = this._settings?.rooms[room.room]?.false_alarm_budget;
    const over = overBudget(room.false_alarms_per_day, budget);
    const value = fmtNumber(loc, room.false_alarms_per_day, 1);
    return over
      ? html`<span class="warn-text" title=${tqv(loc, "over_budget", { budget: fmtNumber(loc, budget ?? 0, 1) })}
          >${value} ${icon(mdiAlert, 16)}<span class="sr-only">${tqv(loc, "over_budget", { budget: fmtNumber(loc, budget ?? 0, 1) })}</span></span
        >`
      : html`${value}`;
  }

  private _detection(room: RoomQuality) {
    if (room.entry_detection === null) return this._unknown();
    const low = room.entry_detection < 0.8;
    const value = fmtPercent(this.loc, room.entry_detection);
    return low ? html`<span class="warn-text">${value} ${icon(mdiAlert, 16)}</span>` : html`${value}`;
  }

  private _latency(room: RoomQuality) {
    if (room.latency_median_s === null) return this._unknown();
    return html`${tqv(this.loc, "latency_value", {
      median: fmtNumber(this.loc, room.latency_median_s, 1),
      p90: fmtNumber(this.loc, room.latency_p90_s, 1),
    })}`;
  }

  private _orderedRooms(report: QualityReport): RoomQuality[] {
    const order = new Map((this.plan?.rooms ?? []).map((r, i) => [r.id, i]));
    return [...report.rooms].sort((a, b) => (order.get(a.room) ?? 99) - (order.get(b.room) ?? 99));
  }

  private _roomName(id: string) {
    return html`<span class="room-cell"><span class="swatch" style="background:${this.roomColour(id)}"></span>${this.roomName(id)}</span>`;
  }

  private _rooms(report: QualityReport) {
    const loc = this.loc;
    const rooms = this._orderedRooms(report);
    return html`<section class="card" aria-labelledby="q-rooms">
      <div class="card-head"><h3 class="headline" id="q-rooms">${tqv(loc, "rooms")}</h3></div>
      <div class="table-wrap rooms-table">
        <table>
          <thead>
            <tr>
              <th scope="col">${tqv(loc, "room")}</th>
              <th scope="col" class="num">${tqv(loc, "false_day")}</th>
              <th scope="col" class="num">${tqv(loc, "detection")}</th>
              <th scope="col" class="num">${tqv(loc, "latency")}</th>
              <th scope="col">${tqv(loc, "coverage")}</th>
              <th scope="col" class="num">${tqv(loc, "vetoes")}</th>
            </tr>
          </thead>
          <tbody>
            ${rooms.map(
              (room) => html`<tr>
                <th scope="row" style="font-size:14px;color:var(--og-fg)">${this._roomName(room.room)}</th>
                <td class="num">${this._falseAlarms(room)}</td>
                <td class="num">${this._detection(room)}</td>
                <td class="num">${this._latency(room)}</td>
                <td>${this._dots(room)}</td>
                <td class="num">${room.vetoes}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <div class="room-cards">
        ${rooms.map(
          (room) => html`<article class="room-card">
            ${this._roomName(room.room)}
            <dl>
              <div><dt>${tqv(loc, "false_day")}</dt><dd>${this._falseAlarms(room)}</dd></div>
              <div><dt>${tqv(loc, "detection")}</dt><dd>${this._detection(room)}</dd></div>
              <div><dt>${tqv(loc, "latency")}</dt><dd>${this._latency(room)}</dd></div>
              <div><dt>${tqv(loc, "coverage")}</dt><dd>${this._dots(room)}</dd></div>
            </dl>
          </article>`,
        )}
      </div>
    </section>`;
  }

  private _mapFrame(report: QualityReport): { frame: Frame; colours: Map<string, string> } {
    const info = pairInformation(report.pairs);
    const colours = new Map<string, string>();
    const known = new Set(this.plan?.bulbs.map((b) => b.ieee) ?? []);
    const pairs = report.pairs
      .filter((p) => known.has(p.a) && known.has(p.b))
      .map((p) => {
        const key = pairKey(p.a, p.b);
        const noise = pairNoise(report.directions, p.a, p.b);
        const excluded = this.isExcluded(p.a, p.b) && this.isExcluded(p.b, p.a);
        colours.set(key, excluded ? EXCLUDED_COLOUR : noiseColour(noise ?? 0));
        return { a: p.a, b: p.b, obs: null, weight: info.get(`${p.a}|${p.b}`) ?? 0 };
      });
    const frame: Frame = {
      t: report.t,
      status: "ready",
      model_version: 0,
      directions: [],
      pairs,
      rooms: {},
      veto: null,
      gates: {},
      trail: [],
      illustrative_xy: {},
    };
    return { frame, colours };
  }

  private _candidates(report: QualityReport): Point[] {
    return report.recommendations.filter((r) => !this._dismissed.has(r.id)).flatMap((r) => r.candidates);
  }

  private _directions(report: QualityReport) {
    const loc = this.loc;
    return html`<section class="card" id="directions" aria-labelledby="q-dirs">
      <div class="card-head"><h3 class="headline" id="q-dirs">${tqv(loc, "directions")}</h3></div>
      <div class="dir-tools">
        ${this._segmented(
          tqv(loc, "view"),
          ["map", "table"] as const,
          this._mode,
          (m) => tqv(loc, m),
          (m) => (this._mode = m),
        )}
        ${this._mode === "table"
          ? html`<span class="label">${tqv(loc, "sort")}</span>
              ${this._segmented(tqv(loc, "sort"), SORTS, this._sort, (s) => tqv(loc, `sort_${s}`), (s) => (this._sort = s))}`
          : nothing}
      </div>
      ${this._mode === "map" ? this._map(report) : this._table(report)}
    </section>`;
  }

  private _map(report: QualityReport) {
    const loc = this.loc;
    const { frame, colours } = this._mapFrame(report);
    const markers = this._highlight ?? this._candidates(report);
    return html`<div class="map-wrap">
        <outglow-plan-view
          class=${this._highlight ? "flash" : ""}
          .plan=${this.plan}
          .frame=${frame}
          .names=${this.names()}
          .loc=${loc}
          .layers=${MAP_LAYERS}
          .lineColours=${colours}
          .markers=${markers}
          .selected=${this._pair ? pairKey(this._pair.a, this._pair.b) : null}
          .dark=${this.dark}
          interactive
          max-height=${this.narrow ? "60vh" : "64vh"}
          @pair-select=${(e: CustomEvent<{ a: string; b: string }>) => (this._pair = e.detail)}
          @room-select=${(e: Event) => e.stopPropagation()}
        ></outglow-plan-view>
      </div>
      <div class="scale">
        <span class="ramp"
          >${tqv(loc, "quiet")} <span class="g" style="background:${noiseGradient()}" role="img" aria-label=${tqv(loc, "noise_scale")}></span>
          ${tqv(loc, "noisy")}</span
        >
        <span>${tqv(loc, "noise_scale")}: 0 · ${fmtNumber(loc, noiseAt(0.5), 0)} · ${fmtNumber(loc, NOISE_MAX_PER_H, 0)}+/h</span>
        <span class="x"><span style="color:${EXCLUDED_COLOUR}">━</span> ${tqv(loc, "skipped")}</span>
        ${markers.length ? html`<span class="x"><span style="color:var(--og-error)">✕</span> ${tqv(loc, "candidate")}</span>` : nothing}
      </div>`;
  }

  private _thetas(d: DirectionQuality) {
    const entries = Object.entries(d.theta).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!entries.length) return html`<span class="small muted">—</span>`;
    return html`<div class="thetas">
      ${entries.map(
        ([room, value]) => html`<div class="theta" title=${`${this.roomName(room)}: ${fmtNumber(this.loc, value, 2)}`}>
          <span class="swatch" style="background:${this.roomColour(room)};width:8px;height:8px"></span>
          <span class="bar"><span style="width:${Math.min(100, value * 100)}%;background:${this.roomColour(room)}"></span></span>
        </div>`,
      )}
    </div>`;
  }

  private _flags(d: DirectionQuality, excluded: boolean) {
    const flags = [...new Set([...d.flags, ...(excluded ? (["excluded"] as const) : [])])];
    if (!flags.length) return nothing;
    return html`<div class="flags">${flags.map((f) => html`<span class="badge ${f === "excluded" ? "warning" : ""}">${flagText(this.loc, f)}</span>`)}</div>`;
  }

  private _skipButton(d: DirectionQuality, compact = false) {
    const loc = this.loc;
    const excluded = this.isExcluded(d.rx, d.tx);
    const text = excluded ? tqv(loc, "unskip") : tqv(loc, "skip");
    const label = `${text}: ${this.bulbName(d.rx)} ← ${this.bulbName(d.tx)}`;
    const toggle = (): void => void this.setExcluded(d.rx, d.tx, !excluded, tqv(loc, "reason"));
    if (compact) {
      return html`<button class="icon-btn" data-skip=${`${d.rx}<${d.tx}`} aria-pressed=${excluded} aria-label=${label} title=${text} @click=${toggle}>
        ${icon(excluded ? mdiEyeOutline : mdiEyeOff, 20)}<span class="sr-only">${text}</span>
      </button>`;
    }
    return html`<button class="btn ${excluded ? "tonal" : ""} neutral" data-skip=${`${d.rx}<${d.tx}`} aria-label=${label} @click=${toggle}>
      ${icon(excluded ? mdiEyeOutline : mdiEyeOff, 18)} ${text}
    </button>`;
  }

  private _noise(d: DirectionQuality) {
    return html`<span class="noise"><i style="background:${noiseColour(d.exceed_per_h)}"></i>${tqv(this.loc, "per_h", { n: fmtNumber(this.loc, d.exceed_per_h, 0) })}</span>`;
  }

  private _table(report: QualityReport) {
    const loc = this.loc;
    const dirs = sortDirections(report.directions, this._sort);
    return html`<div class="table-wrap">
        <table class="dirs">
          <thead>
            <tr>
              <th scope="col">${tqv(loc, "direction")}</th>
              <th scope="col">${tqv(loc, "background")}</th>
              <th scope="col" class="num">${tqv(loc, "signal")}</th>
              <th scope="col" class="num">${tqv(loc, "asymmetry")}</th>
              <th scope="col" class="num">${tqv(loc, "gate")}</th>
              <th scope="col">${tqv(loc, "theta")}</th>
              <th scope="col">${tqv(loc, "flags")}</th>
              <th scope="col"><span class="sr-only">${tqv(loc, "details")}</span></th>
            </tr>
          </thead>
          <tbody>
            ${dirs.map((d) => {
              const excluded = this.isExcluded(d.rx, d.tx);
              return html`<tr class=${excluded ? "excluded" : ""}>
                <td><div class="dir-name" aria-label=${`${this.bulbName(d.rx)} ← ${this.bulbName(d.tx)}`}><b>${this.bulbName(d.rx)}</b><span>← ${this.bulbName(d.tx)}</span></div></td>
                <td>${this._noise(d)}</td>
                <td class="num sig">${d.signal_dbm === null ? "—" : tqv(loc, "dbm", { n: d.signal_dbm })}</td>
                <td class="num">${d.asymmetry === null ? "—" : tqv(loc, "times", { n: fmtNumber(loc, d.asymmetry, 1) })}</td>
                <td class="num">${fmtPercent(loc, d.gate_open_frac)}</td>
                <td>${this._thetas(d)}</td>
                <td>${this._flags(d, excluded)}</td>
                <td class="act">
                  ${this._skipButton(d, true)}
                  <button
                    class="icon-btn"
                    aria-label=${`${tqv(loc, "details")}: ${this.bulbName(d.rx)} ← ${this.bulbName(d.tx)}`}
                    title=${tqv(loc, "details")}
                    @click=${() => (this._pair = { a: d.rx, b: d.tx })}
                  >
                    ${icon(mdiChevronRight, 22)}
                  </button>
                </td>
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
      <div class="dir-cards">
        ${dirs.map((d) => {
          const excluded = this.isExcluded(d.rx, d.tx);
          return html`<article class="dir-card ${excluded ? "excluded" : ""}">
            <div class="row">
              <b class="grow">${this.bulbName(d.rx)} ← ${this.bulbName(d.tx)}</b>
              ${this._noise(d)}
            </div>
            <div class="meta">
              <span>${tqv(loc, "signal")}: ${d.signal_dbm === null ? "—" : tqv(loc, "dbm", { n: d.signal_dbm })}</span>
              <span>${tqv(loc, "asymmetry")}: ${d.asymmetry === null ? "—" : tqv(loc, "times", { n: fmtNumber(loc, d.asymmetry, 1) })}</span>
              <span>${tqv(loc, "gate")}: ${fmtPercent(loc, d.gate_open_frac)}</span>
            </div>
            ${this._flags(d, excluded)}
            <div class="row wrap">
              ${this._skipButton(d)}
              <button class="btn" @click=${() => (this._pair = { a: d.rx, b: d.tx })}>${tqv(loc, "details")}</button>
            </div>
          </article>`;
        })}
      </div>`;
  }

  private _act(rec: Recommendation, report: QualityReport): void {
    switch (rec.action) {
      case "skip_direction":
        if (rec.rx && rec.tx) void this.setExcluded(rec.rx, rec.tx, true, tqv(this.loc, "reason"));
        return;
      case "bulb_write": {
        const bulb = this.bulbs.find((b) => b.ieee === rec.bulb);
        if (bulb) this._write = { bulb, setting: "sensitivity", value: rec.numbers.suggested ?? null };
        return;
      }
      case "wizard":
        this.navigate("/learn");
        return;
      case "show_candidates":
        this._mode = "map";
        this._highlight = rec.candidates.length ? rec.candidates : this._candidates(report);
        void this.updateComplete.then(() => {
          this.renderRoot.querySelector("#directions")?.scrollIntoView({ behavior: "smooth", block: "start" });
          setTimeout(() => (this._highlight = null), 4000);
        });
        return;
      case "none":
        return;
    }
  }

  private _dismiss(id: string, on: boolean): void {
    const next = new Set(this._dismissed);
    if (on) next.add(id);
    else next.clear();
    this._dismissed = next;
    saveDismissed(next);
  }

  private _recommendations(report: QualityReport) {
    const loc = this.loc;
    const visible = report.recommendations.filter((r) => !this._dismissed.has(r.id));
    const hidden = report.recommendations.length - visible.length;
    const names = this._names();
    return html`<section class="card" aria-labelledby="q-recs">
      <div class="card-head">
        <h3 class="headline" id="q-recs">${tqv(loc, "recommendations")}</h3>
        ${visible.length ? html`<span class="badge">${visible.length}</span>` : nothing}
      </div>
      ${visible.length
        ? html`<ol class="recs">
            ${visible.map((rec, i) => {
              const action = actionText(loc, rec);
              const done = rec.action === "skip_direction" && rec.rx && rec.tx && this.isExcluded(rec.rx, rec.tx);
              return html`<li class="rec ${rec.severity}" data-rec=${rec.id}>
                <span class="no" aria-hidden="true">${i + 1}</span>
                <div>
                  <p>${recommendationText(loc, rec, names)}</p>
                  ${rec.kind === "raise_sensitivity"
                    ? html`<span class="note">${icon(mdiAlert, 14)}${tq(loc, "rec_note_raise")}</span>`
                    : nothing}
                </div>
                <button class="icon-btn dismiss" aria-label=${tqv(loc, "dismiss")} title=${tqv(loc, "dismiss")} @click=${() => this._dismiss(rec.id, true)}>
                  ${icon(mdiClose, 18)}
                </button>
                ${action
                  ? html`<div class="buttons">
                      <button class="btn ${rec.severity === "warning" ? "tonal" : "outlined"}" ?disabled=${Boolean(done)} @click=${() => this._act(rec, report)}>
                        ${done ? html`${icon(mdiCheckCircle, 18)} ${tqv(loc, "skipped")}` : action}
                      </button>
                    </div>`
                  : nothing}
              </li>`;
            })}
          </ol>`
        : html`<div class="empty-state" style="padding:24px">${icon(mdiCheckCircle, 36)}<span>${tqv(loc, "none")}</span></div>`}
      ${hidden
        ? html`<div class="recs-foot">
            ${icon(mdiInformation, 16)} ${tqv(loc, "dismissed", { n: hidden })}
            <button class="btn" @click=${() => this._dismiss("", false)}>${tqv(loc, "restore")}</button>
          </div>`
        : nothing}
    </section>`;
  }

  private _sheetDirection(report: QualityReport, rx: string, tx: string) {
    const loc = this.loc;
    const d = report.directions.find((x) => x.rx === rx && x.tx === tx);
    const excluded = this.isExcluded(rx, tx);
    return html`<div class="sheet-dir">
      <div class="row">
        <b class="grow">${tqv(loc, "hears", { rx: this.bulbName(rx), tx: this.bulbName(tx) })}</b>
        ${d ? this._noise(d) : nothing}
      </div>
      ${d
        ? html`<div class="kv">
              <div><span class="eyebrow">${tqv(loc, "background")}</span><b>${tqv(loc, "per_h", { n: fmtNumber(loc, d.exceed_per_h, 0) })}</b></div>
              <div><span class="eyebrow">${tqv(loc, "signal")}</span><b>${d.signal_dbm === null ? "—" : tqv(loc, "dbm", { n: d.signal_dbm })}</b></div>
              <div><span class="eyebrow">${tqv(loc, "asymmetry")}</span><b>${d.asymmetry === null ? "—" : tqv(loc, "times", { n: fmtNumber(loc, d.asymmetry, 1) })}</b></div>
              <div><span class="eyebrow">${tqv(loc, "gate")}</span><b>${fmtPercent(loc, d.gate_open_frac)}</b></div>
            </div>
            ${this._flags(d, excluded)}
            <div class="stack" style="gap:6px">
              <span class="eyebrow">${tqv(loc, "theta")}</span>
              ${Object.entries(d.theta).length
                ? Object.entries(d.theta)
                    .sort((a, b) => b[1] - a[1])
                    .map(
                      ([room, value]) => html`<div class="info-row">
                        <span>${this.roomName(room)}</span>
                        <span class="bar"><span style="width:${Math.min(100, value * 100)}%;background:${this.roomColour(room)}"></span></span>
                        <span class="num small">${fmtNumber(loc, value, 2, 2)}</span>
                      </div>`,
                    )
                : html`<span class="small muted">${tqv(loc, "no_data")}</span>`}
            </div>
            <div>${this._skipButton(d)}</div>`
        : html`<span class="small muted">${tqv(loc, "no_data")}</span>`}
    </div>`;
  }

  private _pairSheet(report: QualityReport | null) {
    const loc = this.loc;
    const sel = this._pair;
    const info = report?.pairs.find((p) => sel && pairKey(p.a, p.b) === pairKey(sel.a, sel.b));
    const entries = Object.entries(info?.information ?? {}).sort((a, b) => b[1] - a[1]);
    const max = Math.max(0.01, ...entries.map(([, v]) => v));
    return html`<og-sheet
      .open=${Boolean(sel && report)}
      heading=${sel ? tqv(loc, "pair_title", { a: this.bulbName(sel.a), b: this.bulbName(sel.b) }) : ""}
      close-label=${tc(loc, "close")}
      @closed=${() => (this._pair = null)}
    >
      ${sel && report
        ? html`${this._sheetDirection(report, sel.a, sel.b)} ${this._sheetDirection(report, sel.b, sel.a)}
            ${entries.length
              ? html`<div class="sheet-dir">
                  <span class="eyebrow">${tqv(loc, "information")}</span>
                  ${entries.map(
                    ([room, value]) => html`<div class="info-row">
                      <span>${this.roomName(room)}</span>
                      <span class="bar"><span style="width:${(value / max) * 100}%;background:${this.roomColour(room)}"></span></span>
                      <span class="num small">${fmtNumber(loc, value, 2, 2)}</span>
                    </div>`,
                  )}
                </div>`
              : nothing}`
        : nothing}
    </og-sheet>`;
  }

  override render() {
    const loc = this.loc;
    const report = this._report;
    return html`<div class="page">
      ${this._summary(report)}
      ${report
        ? html`<div class="two-col">
            <div class="a-rooms">${this._rooms(report)}</div>
            <div class="a-recs">${this._recommendations(report)}</div>
            <div class="a-dirs">${this._directions(report)}</div>
          </div>`
        : html`<div class="card center" aria-busy=${this._loading}>${this._loading ? tqv(loc, "loading") : this._error ?? tqv(loc, "no_data")}</div>`}
      ${this._pairSheet(report)}
      <og-bulb-write
        .hass=${this.hass}
        .loc=${loc}
        .bulb=${this._write?.bulb ?? null}
        .setting=${this._write?.setting ?? "sensitivity"}
        .value=${this._write?.value ?? null}
        @closed=${() => (this._write = null)}
      ></og-bulb-write>
    </div>`;
  }
}

if (!customElements.get("outglow-quality-view")) {
  customElements.define("outglow-quality-view", OutglowQualityView);
}

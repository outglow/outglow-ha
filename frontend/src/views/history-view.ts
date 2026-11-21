import {
  mdiAlertCircleOutline,
  mdiBrain,
  mdiChevronDoubleLeft,
  mdiChevronDoubleRight,
  mdiChevronLeft,
  mdiChevronRight,
  mdiCloseCircle,
  mdiHistory,
  mdiHomeExportOutline,
  mdiHomeImportOutline,
  mdiLightbulbOn,
  mdiLightningBolt,
  mdiPause,
  mdiPlay,
  mdiRestore,
  mdiRun,
  mdiSchool,
  mdiStepBackward,
  mdiStepForward,
  mdiCheckCircle,
  mdiMotionSensorOff,
  mdiTrashCanOutline,
} from "@mdi/js";
import { css, html, nothing, svg, type PropertyValues } from "lit";
import type { EventKind, FeedbackRequest, Frame, HistoryEvent, HistoryRangeResponse, RoomSample, Scalar } from "../api/types";
import { fmtClock, fmtDay } from "../format";
import { strings, type Loc } from "../i18n";
import { icon } from "../icons";
import type { Layers } from "../plan-view";
import { tc } from "../strings/common";
import { shared, tokens } from "../theme";
import {
  RAW_RETENTION_S,
  advance,
  areaPath,
  clamp,
  cluster,
  dayBounds,
  dayStart,
  defaultCursor,
  earliestDay,
  emptySpans,
  follow,
  frameAt,
  lastEventBefore,
  marked,
  mergeFrames,
  motionRuns,
  needsFrames,
  shiftDay,
  stepCursor,
  ticks,
  windowAround,
  type Cluster,
} from "../timeline";
import { ViewBase } from "./base";

const th = strings(
  {
    title: "History",
    previous_day: "Previous day",
    next_day: "Next day",
    today: "Today",
    zoom: "Time span",
    speed: "Playback speed",
    play: "Play",
    pause: "Pause",
    earlier: "Earlier",
    later: "Later",
    step_back: "Back {s}",
    step_forward: "Forward {s}",
    time: "Time on the timeline",
    rooms: "Rooms",
    events: "Events",
    show_motion: "Motion",
    no_events: "Nothing special happened on this day.",
    empty_day: "Nothing was recorded on this day",
    empty_day_hint: "History keeps room activity for 14 days.",
    replay: "Replay",
    no_frame: "No data at this moment",
    loading_frames: "Loading the replay…",
    truncated: "Replay needs raw data, which is kept for 48 hours. The room bands above still show this day.",
    legend_p: "probability",
    legend_motion: "motion",
    legend_empty: "empty house",
    legend_future: "not yet",
    more: { one: "+{n} more", other: "+{n} more" },
    count: { one: "{n} event", other: "{n} events" },
    fix_title: "Correct the detection at {time}",
    fix_false: "Nobody was in {room}",
    fix_correct: "{room} was right",
    fix_missed: "Someone was in {room}",
    fix_room: "Room",
    fix_hint: "Corrections are learnt in the background and used after you apply the model changes in Settings.",
    fix_done: "Thanks. The correction waits in the model proposal.",
    fix_stored: "Saved. Online learning is off, so the model does not use it.",
    kind_motion_on: "Motion in {room}",
    kind_motion_off: "Motion ended in {room}",
    kind_false_alarm: "False alarm in {room}",
    kind_missed: "Missed entry into {room}",
    kind_correct: "Confirmed in {room}",
    kind_label: "Learning: {room}, {activity}",
    kind_veto: "Interference ignored",
    kind_veto_receiver: "Interference at {bulb} ignored",
    kind_bulb_write: "{bulb}: {setting} {previous} → {value}",
    kind_model_apply: "Model changes applied",
    kind_model_discard: "Model changes discarded",
    kind_model_rollback: "Model rolled back",
    kind_session_start: "Learning session started",
    kind_session_stop: "Learning session ended",
    kind_house_empty: "Nobody home",
    kind_house_occupied: "Someone came home",
    source_feedback: "reported by you",
    source_night_calibration: "night calibration",
    activity_walk: "walking",
    activity_still: "standing still",
    activity_any: "any activity",
    setting_sensitivity: "sensitivity",
    setting_probes: "probes",
    setting_sensing: "sensing",
    setting_auto_calibration: "auto calibration",
    setting_self_tuning: "self tuning",
    setting_calibrate: "calibration",
    on: "on",
    off: "off",
    version: "version {n}",
    nowhere: "the house",
  },
  {
    title: "Historia",
    previous_day: "Poprzedni dzień",
    next_day: "Następny dzień",
    today: "Dziś",
    zoom: "Zakres czasu",
    speed: "Prędkość odtwarzania",
    play: "Odtwórz",
    pause: "Pauza",
    earlier: "Wcześniej",
    later: "Później",
    step_back: "Wstecz o {s}",
    step_forward: "Naprzód o {s}",
    time: "Czas na osi",
    rooms: "Pokoje",
    events: "Zdarzenia",
    show_motion: "Ruch",
    no_events: "Tego dnia nie wydarzyło się nic szczególnego.",
    empty_day: "Z tego dnia nie ma zapisów",
    empty_day_hint: "Historia przechowuje aktywność pokojów przez 14 dni.",
    replay: "Odtwarzanie",
    no_frame: "Brak danych w tej chwili",
    loading_frames: "Wczytywanie odtwarzania…",
    truncated: "Odtwarzanie wymaga surowych danych, które są trzymane 48 godzin. Pasy pokojów powyżej nadal pokazują ten dzień.",
    legend_p: "prawdopodobieństwo",
    legend_motion: "ruch",
    legend_empty: "pusty dom",
    legend_future: "jeszcze nie",
    more: { one: "i jeszcze {n}", few: "i jeszcze {n}", many: "i jeszcze {n}", other: "i jeszcze {n}" },
    count: { one: "{n} zdarzenie", few: "{n} zdarzenia", many: "{n} zdarzeń", other: "{n} zdarzenia" },
    fix_title: "Popraw wykrycie z {time}",
    fix_false: "Nikogo nie było: {room}",
    fix_correct: "Zgadza się: {room}",
    fix_missed: "Ktoś był: {room}",
    fix_room: "Pokój",
    fix_hint: "Poprawki uczą model w tle; działają po zastosowaniu zmian modelu w Ustawieniach.",
    fix_done: "Dzięki. Poprawka czeka w propozycji modelu.",
    fix_stored: "Zapisano. Uczenie w tle jest wyłączone, więc model jej nie użyje.",
    kind_motion_on: "Ruch: {room}",
    kind_motion_off: "Koniec ruchu: {room}",
    kind_false_alarm: "Pomyłka: {room}",
    kind_missed: "Przeoczone wejście: {room}",
    kind_correct: "Potwierdzone: {room}",
    kind_label: "Nauka: {room}, {activity}",
    kind_veto: "Pominięte zakłócenie",
    kind_veto_receiver: "Pominięte zakłócenie przy {bulb}",
    kind_bulb_write: "{bulb}: {setting} {previous} → {value}",
    kind_model_apply: "Zastosowano zmiany modelu",
    kind_model_discard: "Odrzucono zmiany modelu",
    kind_model_rollback: "Cofnięto model",
    kind_session_start: "Początek sesji nauki",
    kind_session_stop: "Koniec sesji nauki",
    kind_house_empty: "Nikogo nie ma w domu",
    kind_house_occupied: "Ktoś wrócił do domu",
    source_feedback: "zgłoszona przez ciebie",
    source_night_calibration: "kalibracja nocna",
    activity_walk: "chodzenie",
    activity_still: "stanie w miejscu",
    activity_any: "dowolna aktywność",
    setting_sensitivity: "czułość",
    setting_probes: "sondy",
    setting_sensing: "wykrywanie",
    setting_auto_calibration: "autokalibracja",
    setting_self_tuning: "samostrojenie",
    setting_calibrate: "kalibracja",
    on: "wł.",
    off: "wył.",
    version: "wersja {n}",
    nowhere: "dom",
  },
);

type Key = Parameters<typeof th>[1];

const ZOOMS = [
  { id: "24h", span: 86400, minor: 60, major: 180, narrowMajor: 360 },
  { id: "6h", span: 6 * 3600, minor: 15, major: 60, narrowMajor: 120 },
  { id: "1h", span: 3600, minor: 5, major: 10, narrowMajor: 20 },
] as const;

type ZoomId = (typeof ZOOMS)[number]["id"];

const SPEEDS = [1, 4, 16] as const;
const STEP_S = 60;
const AXIS_H = 24;
const BAND_H = 30;
const BAND_GAP = 8;
const LANE_H = 44;
const WINDOW_S = 120;
const LAYERS: Layers = { lines: true, trail: true, heat: true, bulbNames: false };

interface Style {
  path: string;
  tone: "error" | "warning" | "primary" | "info" | "fg" | "motion";
}

const STYLE: Record<EventKind, Style> = {
  motion_on: { path: mdiRun, tone: "motion" },
  motion_off: { path: mdiMotionSensorOff, tone: "fg" },
  false_alarm: { path: mdiCloseCircle, tone: "error" },
  missed: { path: mdiAlertCircleOutline, tone: "warning" },
  correct: { path: mdiCheckCircle, tone: "info" },
  label: { path: mdiSchool, tone: "primary" },
  session_start: { path: mdiSchool, tone: "primary" },
  session_stop: { path: mdiSchool, tone: "primary" },
  veto: { path: mdiLightningBolt, tone: "warning" },
  bulb_write: { path: mdiLightbulbOn, tone: "info" },
  model_apply: { path: mdiBrain, tone: "primary" },
  model_discard: { path: mdiTrashCanOutline, tone: "fg" },
  model_rollback: { path: mdiRestore, tone: "primary" },
  house_empty: { path: mdiHomeExportOutline, tone: "fg" },
  house_occupied: { path: mdiHomeImportOutline, tone: "fg" },
};

const LEGEND: { kinds: EventKind[]; key: Key }[] = [
  { kinds: ["false_alarm"], key: "kind_false_alarm" },
  { kinds: ["missed"], key: "kind_missed" },
  { kinds: ["label"], key: "kind_label" },
  { kinds: ["veto"], key: "kind_veto" },
  { kinds: ["bulb_write"], key: "kind_bulb_write" },
  { kinds: ["model_apply"], key: "kind_model_apply" },
];

const LEGEND_SHORT: Record<string, { en: string; pl: string }> = {
  false_alarm: { en: "false alarm", pl: "pomyłka" },
  missed: { en: "missed", pl: "przeoczenie" },
  label: { en: "learning", pl: "nauka" },
  veto: { en: "veto", pl: "weto" },
  bulb_write: { en: "bulb change", pl: "zmiana w żarówce" },
  model_apply: { en: "model", pl: "model" },
};

const formats = new Map<string, Intl.DateTimeFormat>();

function axisFormat(loc: Loc, minutes: boolean): Intl.DateTimeFormat {
  const key = `${loc.lang}|${loc.hour12}|${minutes}`;
  let found = formats.get(key);
  if (!found) {
    const options: Intl.DateTimeFormatOptions = minutes ? { hour: "2-digit", minute: "2-digit" } : { hour: "2-digit" };
    if (loc.hour12 !== undefined) options.hour12 = loc.hour12;
    found = new Intl.DateTimeFormat(loc.lang, options);
    formats.set(key, found);
  }
  return found;
}

function scalar(value: Scalar | undefined): string {
  if (value === undefined || value === null) return "—";
  return String(value);
}

export class OutglowHistoryView extends ViewBase {
  static override properties = {
    ...ViewBase.properties,
    _day: { state: true },
    _range: { state: true },
    _loading: { state: true },
    _failed: { state: true },
    _cursor: { state: true },
    _view: { state: true },
    _zoom: { state: true },
    _speed: { state: true },
    _playing: { state: true },
    _frames: { state: true },
    _framesLoading: { state: true },
    _truncated: { state: true },
    _width: { state: true },
    _withMotion: { state: true },
    _tip: { state: true },
    _fixRoom: { state: true },
    _fixing: { state: true },
  };

  declare _day: number;
  declare _range: HistoryRangeResponse | null;
  declare _loading: boolean;
  declare _failed: boolean;
  declare _cursor: number;
  declare _view: [number, number];
  declare _zoom: ZoomId;
  declare _speed: (typeof SPEEDS)[number];
  declare _playing: boolean;
  declare _frames: Frame[];
  declare _framesLoading: boolean;
  declare _truncated: boolean;
  declare _width: number;
  declare _withMotion: boolean;
  declare _tip: Cluster | null;
  declare _fixRoom: string;
  declare _fixing: boolean;

  private _framesWindow: [number, number] | null = null;
  private _rangeSeq = 0;
  private _framesSeq = 0;
  private _raf = 0;
  private _lastTick = 0;
  private _dragging = false;
  private _observer: ResizeObserver | null = null;
  private _pathCache = new Map<string, string>();
  private _now = Date.now() / 1000;

  constructor() {
    super();
    this._fixRoom = "";
    this._fixing = false;
    const now = Date.now() / 1000;
    this._day = dayStart(now);
    this._range = null;
    this._loading = false;
    this._failed = false;
    this._cursor = now;
    this._view = dayBounds(now);
    this._zoom = "24h";
    this._speed = 1;
    this._playing = false;
    this._frames = [];
    this._framesLoading = false;
    this._truncated = false;
    this._width = 0;
    this._withMotion = false;
    this._tip = null;
  }

  static override styles = [
    tokens,
    shared,
    css`
      :host {
        display: block;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px 16px;
        padding: 10px 12px 10px 8px;
        margin-bottom: 16px;
      }
      .daynav {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 1 1 auto;
        min-width: 0;
      }
      .date {
        display: grid;
        padding: 0 8px;
        min-width: 0;
      }
      .date .title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }
      .play {
        min-width: 120px;
      }
      .layout {
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(0, 1fr);
        align-items: start;
      }
      @media (min-width: 1024px) {
        .layout {
          grid-template-columns: minmax(0, 1fr) 340px;
        }
        .events-card {
          position: sticky;
          top: 72px;
          max-height: calc(100vh - 96px);
          display: flex;
          flex-direction: column;
        }
        .events-card .list {
          overflow: auto;
        }
      }
      .main {
        display: grid;
        gap: 16px;
        min-width: 0;
      }
      .tl-card {
        padding: 12px 16px 12px 0;
      }
      .tl {
        display: grid;
        grid-template-columns: 112px minmax(0, 1fr);
        position: relative;
      }
      .labels {
        display: grid;
        align-content: start;
        padding-top: ${AXIS_H}px;
      }
      .labels div {
        height: ${BAND_H}px;
        margin-bottom: ${BAND_GAP}px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 8px 0 16px;
        font-size: 13px;
        font-weight: 500;
        min-width: 0;
      }
      .labels div span:last-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .labels .lane {
        height: ${LANE_H}px;
        color: var(--og-fg2);
        font-weight: 400;
      }
      .track {
        position: relative;
        min-width: 0;
        touch-action: pan-y;
        cursor: ew-resize;
        border-radius: 6px;
      }
      .track:focus-visible {
        outline-offset: 4px;
      }
      .track svg {
        display: block;
        width: 100%;
        overflow: visible;
      }
      .axis-label {
        font-size: 11px;
        fill: var(--og-fg2);
        font-variant-numeric: tabular-nums;
      }
      .grid-line {
        stroke: var(--og-divider);
        stroke-width: 1;
      }
      .grid-line.major {
        stroke: color-mix(in srgb, var(--og-fg) 16%, transparent);
      }
      .band-bg {
        fill: var(--og-tint);
      }
      .future {
        fill: url(#hatch);
      }
      .hatch-line {
        stroke: color-mix(in srgb, var(--og-fg) 12%, transparent);
        stroke-width: 1;
      }
      .empty-span {
        fill: color-mix(in srgb, var(--og-fg) 7%, transparent);
      }
      .lane-bg {
        fill: none;
        stroke: var(--og-divider);
        stroke-dasharray: 2 4;
      }
      .cursor-line {
        stroke: var(--og-primary);
        stroke-width: 2;
      }
      .cursor-head {
        fill: var(--og-primary);
      }
      .cursor-label {
        font-size: 11px;
        font-weight: 600;
        fill: var(--og-on-primary);
        font-variant-numeric: tabular-nums;
      }
      .marker {
        cursor: pointer;
        outline: none;
      }
      .marker circle.ring {
        fill: var(--og-card);
        stroke: currentColor;
        stroke-width: 1.5;
        transition: r 150ms var(--og-ease);
      }
      .marker:hover circle.ring,
      .marker:focus-visible circle.ring {
        stroke-width: 2.5;
      }
      .marker circle.focus {
        fill: none;
        stroke: none;
      }
      .marker:focus-visible circle.focus {
        stroke: var(--og-primary);
        stroke-width: 2;
        fill: none;
      }
      .marker .count {
        font-size: 10px;
        font-weight: 700;
        fill: var(--og-on-primary);
      }
      .marker .count-bg {
        fill: var(--og-fg);
      }
      .tone-error {
        color: var(--og-error);
      }
      .tone-warning {
        color: var(--og-warning);
      }
      .tone-primary {
        color: var(--og-primary);
      }
      .tone-info {
        color: var(--og-info);
      }
      .tone-fg {
        color: var(--og-fg2);
      }
      .tone-motion {
        color: var(--og-motion);
      }
      .tip {
        position: absolute;
        z-index: 4;
        top: 0;
        transform: translate(-50%, 4px);
        min-width: 180px;
        max-width: 280px;
        padding: 8px 12px;
        border-radius: 8px;
        background: color-mix(in srgb, var(--og-fg) 92%, var(--og-bg));
        color: var(--og-bg);
        font-size: 12px;
        line-height: 18px;
        pointer-events: none;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
      }
      .tip div {
        display: flex;
        gap: 8px;
      }
      .tip time {
        opacity: 0.7;
        font-variant-numeric: tabular-nums;
      }
      .foot-row {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 8px 0 0 16px;
        margin-top: 6px;
        border-top: 1px solid var(--og-divider);
      }
      .foot {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 18px;
        flex: 1;
        min-height: 44px;
        font-size: 12px;
        color: var(--og-fg2);
      }
      .foot span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .key {
        display: inline-block;
        width: 18px;
        height: 10px;
        border-radius: 2px;
      }
      .key.p {
        background: color-mix(in srgb, var(--og-fg2) 35%, transparent);
      }
      .key.motion {
        background: var(--og-fg2);
      }
      .key.empty {
        background: color-mix(in srgb, var(--og-fg) 12%, transparent);
      }
      .key.future {
        background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--og-fg) 18%, transparent) 0 2px, transparent 2px 5px);
      }
      .replay-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 16px;
        padding: 16px 12px 4px 20px;
      }
      .clock {
        font-size: 40px;
        line-height: 44px;
        font-weight: 300;
        letter-spacing: -0.01em;
        font-variant-numeric: tabular-nums;
      }
      .clock-date {
        display: grid;
        gap: 2px;
        flex: 1;
        min-width: 0;
      }
      .steps {
        display: flex;
        gap: 4px;
      }
      .replay outglow-plan-view {
        padding: 4px 12px 12px;
      }
      .replay-wrap {
        position: relative;
      }
      .replay-wrap.dim outglow-plan-view {
        opacity: 0.45;
        filter: saturate(0.4);
        transition: opacity 200ms;
      }
      .replay-note {
        margin: 4px 16px 12px;
      }
      .events-card .card-head {
        padding-right: 8px;
      }
      .fixes {
        display: grid;
        gap: 8px;
        padding: 12px 16px 16px;
        border-top: 1px solid var(--og-divider);
      }
      .fixes .row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .fixes .wrap {
        flex-wrap: wrap;
      }
      .fixes select {
        min-height: 40px;
        border-radius: 8px;
        border: 1px solid var(--og-divider);
        background: var(--og-bg);
        color: inherit;
        padding: 0 8px;
        font: inherit;
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0 8px 8px;
      }
      .list li button {
        display: grid;
        grid-template-columns: 56px 28px minmax(0, 1fr);
        align-items: center;
        gap: 8px;
        width: 100%;
        min-height: 48px;
        padding: 6px 8px;
        border: none;
        border-radius: 10px;
        background: transparent;
        text-align: left;
        cursor: pointer;
        font-size: 14px;
        line-height: 19px;
      }
      .list li button:hover {
        background: var(--og-tint);
      }
      .list li button.current {
        background: var(--og-primary-tint);
      }
      .list time {
        color: var(--og-fg2);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }
      .list .sub {
        display: block;
        font-size: 12px;
        color: var(--og-fg2);
      }
      .list .what {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
      }
      .list .what .swatch {
        position: relative;
        top: 0;
      }
      .skeleton {
        border-radius: 6px;
        background: linear-gradient(90deg, var(--og-tint) 0%, var(--og-tint-strong) 50%, var(--og-tint) 100%);
        background-size: 200% 100%;
        animation: shimmer 1.4s linear infinite;
      }
      @keyframes shimmer {
        from {
          background-position: 200% 0;
        }
        to {
          background-position: -200% 0;
        }
      }
      .hint {
        padding: 8px 16px 12px;
        font-size: 12px;
        color: var(--og-fg2);
      }
      @media (max-width: 600px) {
        .toolbar {
          padding: 8px;
          gap: 8px;
        }
        .controls {
          width: 100%;
          justify-content: space-between;
        }
        .play {
          flex: 1 1 100%;
        }
        .replay-head {
          padding: 12px 4px 4px 16px;
          gap: 8px;
        }
        .tl {
          grid-template-columns: 76px minmax(0, 1fr);
        }
        .labels div {
          padding-left: 12px;
          font-size: 12px;
        }
        .clock {
          font-size: 32px;
          line-height: 36px;
        }
        .segmented button {
          min-width: 44px;
          padding: 0 10px;
        }
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    this._observer = new ResizeObserver(() => this._measure());
    void this.updateComplete.then(() => {
      const track = this.renderRoot.querySelector(".track");
      if (track) this._observer?.observe(track);
      this._measure();
    });
    window.addEventListener("keydown", this._globalKey);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._observer?.disconnect();
    this._observer = null;
    this._stop();
    window.removeEventListener("keydown", this._globalKey);
  }

  private _globalKey = (event: KeyboardEvent): void => {
    if (event.key === " " && event.target === document.body) {
      event.preventDefault();
      this._toggle();
    }
  };

  private _measure(): void {
    const track = this.renderRoot.querySelector<HTMLElement>(".track");
    const width = track?.clientWidth ?? 0;
    if (width && Math.abs(width - this._width) > 0.5) {
      this._width = width;
      this._pathCache.clear();
    }
  }

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("hass") && this.hass && !this._range && !this._loading) {
      const deep = Number(this.subpath);
      if (this.subpath && Number.isFinite(deep) && deep > 0) {
        this._day = dayStart(deep);
        this._cursor = deep;
      }
      void this._load(this.subpath && Number.isFinite(deep) && deep > 0 ? deep : null);
    }
  }

  override updated(): void {
    if (!this._observer) return;
    const track = this.renderRoot.querySelector(".track");
    if (track && !this._width) {
      this._observer.observe(track);
      requestAnimationFrame(() => this._measure());
    }
  }

  private get _bounds(): [number, number] {
    return [this._day, shiftDay(this._day, 1)];
  }

  private _limit(): number {
    return Math.min(this._bounds[1], Date.now() / 1000);
  }

  private async _load(cursor: number | null): Promise<void> {
    const [start, end] = this._bounds;
    const seq = ++this._rangeSeq;
    this._now = Date.now() / 1000;
    this._loading = true;
    this._failed = false;
    this._range = null;
    this._pathCache.clear();
    try {
      const range = await this.call("outglow/history/range", { start, end: Math.min(end, this._now), step_s: STEP_S });
      if (seq !== this._rangeSeq) return;
      this._range = range;
      const t = cursor ?? defaultCursor(range.events, start, end, this._now);
      this._setCursor(t, true);
    } catch (err) {
      if (seq !== this._rangeSeq) return;
      this._failed = true;
      this.fail(err);
    } finally {
      if (seq === this._rangeSeq) this._loading = false;
    }
  }

  private _zoomSpec() {
    return ZOOMS.find((z) => z.id === this._zoom)!;
  }

  private _setCursor(t: number, recentre = false): void {
    const [start] = this._bounds;
    const cursor = clamp(t, start, this._limit());
    this._cursor = cursor;
    const [s, e] = this._bounds;
    const span = this._zoomSpec().span;
    this._view = recentre ? windowAround(cursor, span, s, e) : follow(this._view, cursor, s, e);
    if (!this._dragging) {
      void this._ensureFrames(cursor);
    }
  }

  private async _ensureFrames(t: number): Promise<void> {
    const now = Date.now() / 1000;
    if (t < now - RAW_RETENTION_S) {
      this._truncated = true;
      this._frames = [];
      this._framesWindow = null;
      return;
    }
    if (!needsFrames(this._framesWindow, t) || this._framesLoading) {
      return;
    }
    const win = this._framesWindow;
    const append = win !== null && t >= win[0] && t <= win[1];
    const start = append ? win[1] : t - 4;
    const end = Math.min(start + WINDOW_S, now);
    if (end <= start) return;
    const seq = ++this._framesSeq;
    this._framesLoading = true;
    try {
      const result = await this.call("outglow/history/frames", { start, end });
      if (seq !== this._framesSeq) return;
      this._truncated = result.truncated && result.frames.length === 0;
      if (append && win) {
        const keep = this._frames.filter((f) => f.t >= t - 30);
        this._frames = mergeFrames(keep, result.frames);
        this._framesWindow = [Math.max(win[0], t - 30), end];
      } else {
        this._frames = result.frames;
        this._framesWindow = [start, end];
      }
    } catch (err) {
      if (seq === this._framesSeq) this.fail(err);
    } finally {
      if (seq === this._framesSeq) this._framesLoading = false;
    }
    if (needsFrames(this._framesWindow, this._cursor) && this._cursor >= now - RAW_RETENTION_S && !this._dragging) {
      if (!this._framesWindow || this._cursor < this._framesWindow[0] || this._cursor > this._framesWindow[1]) {
        this._framesWindow = null;
      }
      void this._ensureFrames(this._cursor);
    }
  }

  private _changeDay(days: number): void {
    const now = Date.now() / 1000;
    const next = clamp(shiftDay(this._day, days), earliestDay(now), dayStart(now));
    if (next === this._day) return;
    this._stop();
    this._day = next;
    this._frames = [];
    this._framesWindow = null;
    this._truncated = false;
    void this._load(null);
  }

  private _today(): void {
    const now = Date.now() / 1000;
    this._stop();
    if (this._day === dayStart(now)) {
      this._setCursor(now - 60, true);
      return;
    }
    this._day = dayStart(now);
    this._frames = [];
    this._framesWindow = null;
    void this._load(now - 60);
  }

  private _setZoom(id: ZoomId): void {
    this._zoom = id;
    const [s, e] = this._bounds;
    this._view = windowAround(this._cursor, this._zoomSpec().span, s, e);
    this._pathCache.clear();
  }

  private _pan(direction: number): void {
    const [s, e] = this._bounds;
    const span = this._view[1] - this._view[0];
    const v0 = clamp(this._view[0] + (direction * span) / 2, s, e - span);
    this._view = [v0, v0 + span];
    this._pathCache.clear();
  }

  private _toggle(): void {
    if (this._playing) {
      this._stop();
    } else {
      this._play();
    }
  }

  private _play(): void {
    if (this._cursor >= this._limit() - 1) {
      this._setCursor(this._bounds[0], true);
    }
    this._playing = true;
    this._lastTick = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  private _stop(): void {
    this._playing = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  private _tick = (now: number): void => {
    if (!this._playing) return;
    const ms = Math.min(250, now - this._lastTick);
    this._lastTick = now;
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let next = advance(this._cursor, ms, this._speed);
    if (still) {
      next = Math.floor(next * 2) / 2;
      if (next <= this._cursor) next = this._cursor + (ms / 1000) * this._speed;
    }
    if (next >= this._limit()) {
      this._setCursor(this._limit());
      this._stop();
      return;
    }
    this._setCursor(next);
    this._raf = requestAnimationFrame(this._tick);
  };

  private _x(t: number): number {
    const [v0, v1] = this._view;
    return ((t - v0) / (v1 - v0)) * this._width;
  }

  private _tAt(clientX: number): number {
    const track = this.renderRoot.querySelector<HTMLElement>(".track");
    if (!track) return this._cursor;
    const rect = track.getBoundingClientRect();
    const k = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const [v0, v1] = this._view;
    return v0 + k * (v1 - v0);
  }

  private _down(event: PointerEvent): void {
    if (event.button !== 0) return;
    const track = event.currentTarget as HTMLElement;
    track.setPointerCapture(event.pointerId);
    this._dragging = true;
    this._tip = null;
    this._setCursor(this._tAt(event.clientX));
  }

  private _move(event: PointerEvent): void {
    if (!this._dragging) return;
    this._setCursor(this._tAt(event.clientX));
  }

  private _up(): void {
    if (!this._dragging) return;
    this._dragging = false;
    this._framesWindow = needsFrames(this._framesWindow, this._cursor) ? null : this._framesWindow;
    void this._ensureFrames(this._cursor);
  }

  private _fine(): boolean {
    return this._playing || frameAt(this._frames, this._cursor) !== null;
  }

  private _key(event: KeyboardEvent): void {
    const [start] = this._bounds;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = stepCursor(this._cursor, 1, this._fine() && !event.shiftKey);
    else if (event.key === "ArrowLeft") next = stepCursor(this._cursor, -1, this._fine() && !event.shiftKey);
    else if (event.key === "PageUp") next = this._cursor - 900;
    else if (event.key === "PageDown") next = this._cursor + 900;
    else if (event.key === "Home") next = start;
    else if (event.key === "End") next = this._limit();
    else if (event.key === " " || event.key === "k") {
      event.preventDefault();
      this._toggle();
      return;
    }
    if (next !== null) {
      event.preventDefault();
      this._setCursor(next);
    }
  }

  private _jump(event: HistoryEvent): void {
    this._stop();
    this._tip = null;
    this._framesWindow = null;
    this._setCursor(event.t);
    const span = this._view[1] - this._view[0];
    if (span < 86400) {
      const [s, e] = this._bounds;
      this._view = windowAround(event.t, span, s, e);
    }
  }

  private _eventText(event: HistoryEvent): string {
    const loc = this.loc;
    const room = event.room ? this.roomName(event.room) : th(loc, "nowhere");
    const d = event.data;
    switch (event.kind) {
      case "veto":
        return d.rx ? th(loc, "kind_veto_receiver", { bulb: this.bulbName(String(d.rx)) }) : th(loc, "kind_veto");
      case "label": {
        const activity = String(d.activity ?? "any");
        const key = (["walk", "still", "any"].includes(activity) ? `activity_${activity}` : "activity_any") as Key;
        return th(loc, "kind_label", { room, activity: th(loc, key) });
      }
      case "bulb_write": {
        const setting = String(d.setting ?? "");
        const known = ["sensitivity", "probes", "sensing", "auto_calibration", "self_tuning", "calibrate"].includes(setting);
        const value = (v: Scalar | undefined): string => (v === true ? th(loc, "on") : v === false ? th(loc, "off") : scalar(v));
        return th(loc, "kind_bulb_write", {
          bulb: d.ieee ? this.bulbName(String(d.ieee)) : "—",
          setting: known ? th(loc, `setting_${setting}` as Key) : setting,
          previous: value(d.previous),
          value: value(d.value),
        });
      }
      default:
        return th(loc, `kind_${event.kind}` as Key, { room });
    }
  }

  private _eventSub(event: HistoryEvent): string {
    const loc = this.loc;
    const d = event.data;
    if (event.kind === "false_alarm" && d.source) {
      const source = String(d.source);
      return ["feedback", "night_calibration"].includes(source) ? th(loc, `source_${source}` as Key) : source;
    }
    if ((event.kind === "model_apply" || event.kind === "model_rollback") && typeof d.model_version === "number") {
      return th(loc, "version", { n: d.model_version });
    }
    if (event.kind === "session_start" && d.name) {
      return String(d.name);
    }
    return "";
  }

  private _cached(key: string, build: () => string): string {
    const full = `${key}|${this._view[0]}|${this._view[1]}|${this._width}`;
    let found = this._pathCache.get(full);
    if (found === undefined) {
      found = build();
      this._pathCache.set(full, found);
    }
    return found;
  }

  private _bands() {
    const plan = this.plan!;
    const range = this._range;
    const x = (t: number): number => this._x(t);
    return plan.rooms.map((room, i) => {
      const y = AXIS_H + i * (BAND_H + BAND_GAP);
      const samples = range?.rooms[room.id] ?? [];
      const all = this._cached(`all:${room.id}`, () => areaPath(samples, STEP_S, x, BAND_H));
      const motion = this._cached(`motion:${room.id}`, () => areaPath(samples, STEP_S, x, BAND_H, (s) => s[2]));
      const runs = motionRuns(samples, STEP_S);
      return svg`<g transform="translate(0 ${y})">
        <rect class="band-bg" x="0" y="0" width=${this._width} height=${BAND_H} rx="4"></rect>
        <path d=${all} fill=${room.colour} fill-opacity="0.28"></path>
        <path d=${motion} fill=${room.colour} fill-opacity="0.92"></path>
        ${runs.length > 400
          ? nothing
          : runs.map(([a, b]) => {
              const xa = this._x(a);
              const xb = this._x(b);
              if (xb < 0 || xa > this._width) return nothing;
              return svg`<rect x=${xa} y=${BAND_H - 3} width=${Math.max(1.5, xb - xa)} height="3" fill=${room.colour}></rect>`;
            })}
      </g>`;
    });
  }

  private _axis(height: number) {
    const loc = this.loc;
    const zoom = this._zoomSpec();
    const [v0, v1] = this._view;
    const narrow = this._width < 520;
    const major = narrow ? zoom.narrowMajor : zoom.major;
    const minorTicks = ticks(v0, v1, zoom.minor);
    const majorSet = new Set(ticks(v0, v1, major));
    const format = axisFormat(loc, zoom.id !== "24h");
    return svg`${minorTicks.map((t) => {
      const x = this._x(t);
      const isMajor = majorSet.has(t);
      return svg`<line class="grid-line ${isMajor ? "major" : ""}" x1=${x} x2=${x} y1=${isMajor ? AXIS_H - 6 : AXIS_H - 2} y2=${height}></line>
        ${isMajor && x > 8 && x < this._width - 8
          ? svg`<text class="axis-label" x=${x} y=${AXIS_H - 10} text-anchor="middle">${format.format(new Date(t * 1000))}</text>`
          : nothing}`;
    })}`;
  }

  private _markers(laneY: number) {
    const loc = this.loc;
    const events = marked(this._range?.events ?? [], this._withMotion || this._zoom === "1h");
    const [v0, v1] = this._view;
    const visible = events.filter((e) => e.t >= v0 && e.t <= v1);
    const clusters = cluster(visible, (t) => this._x(t), 26);
    const cy = laneY + LANE_H / 2;
    return clusters.map((c) => {
      const first = c.events[0]!;
      const style = STYLE[first.kind];
      const label =
        c.events.length === 1
          ? `${fmtClock(loc, first.t, false)} ${this._eventText(first)}`
          : `${th(loc, "count", { n: c.events.length })}, ${fmtClock(loc, first.t, false)}`;
      return svg`<g class="marker tone-${style.tone}" role="button" tabindex="0" aria-label=${label}
        transform="translate(${c.x} ${cy})"
        @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
          this._jump(first);
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            this._jump(first);
          }
        }}
        @pointerenter=${() => (this._tip = c)}
        @pointerleave=${() => (this._tip = null)}
        @focus=${() => (this._tip = c)}
        @blur=${() => (this._tip = null)}>
        <circle r="22" fill="transparent"></circle>
        <circle class="focus" r="17"></circle>
        <circle class="ring" r="13"></circle>
        <svg x="-9" y="-9" width="18" height="18" viewBox="0 0 24 24"><path d=${style.path} fill="currentColor"></path></svg>
        ${c.events.length > 1
          ? svg`<circle class="count-bg" cx="11" cy="-10" r="8"></circle>
            <text class="count" x="11" y="-6.5" text-anchor="middle">${c.events.length > 9 ? "9+" : c.events.length}</text>`
          : nothing}
      </g>`;
    });
  }

  private _timeline() {
    const loc = this.loc;
    const plan = this.plan!;
    const rooms = plan.rooms.length;
    const laneY = AXIS_H + rooms * (BAND_H + BAND_GAP);
    const height = laneY + LANE_H;
    const [start, end] = this._bounds;
    const limit = this._limit();
    const width = this._width;
    const ready = width > 0 && this._range && !this._loading;
    const cursorX = this._x(this._cursor);
    const spans = this._range ? emptySpans(this._range.events, start, Math.min(end, limit)) : [];
    const futureX = this._x(limit);
    const label = fmtClock(loc, this._cursor, this._zoom !== "24h" || this._fine());
    const labelW = label.length * 6.6 + 14;
    const labelX = clamp(cursorX, labelW / 2, Math.max(labelW / 2, width - labelW / 2));
    return html`<div class="tl">
      <div class="labels" aria-hidden="true">
        ${plan.rooms.map(
          (room) => html`<div><span class="swatch" style="background:${room.colour}"></span><span>${room.name}</span></div>`,
        )}
        <div class="lane"><span>${th(loc, "events")}</span></div>
      </div>
      <div
        class="track"
        role="slider"
        tabindex="0"
        aria-label=${th(loc, "time")}
        aria-valuemin=${Math.round(start)}
        aria-valuemax=${Math.round(limit)}
        aria-valuenow=${Math.round(this._cursor)}
        aria-valuetext=${fmtClock(loc, this._cursor)}
        @pointerdown=${this._down}
        @pointermove=${this._move}
        @pointerup=${this._up}
        @pointercancel=${this._up}
        @keydown=${this._key}
      >
        ${ready
          ? html`<svg height=${height} viewBox="0 0 ${width} ${height}" aria-hidden="true">
              <defs>
                <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line class="hatch-line" x1="0" y1="0" x2="0" y2="6"></line>
                </pattern>
                <clipPath id="tl-clip"><rect x="0" y="0" width=${width} height=${height}></rect></clipPath>
              </defs>
              <g clip-path="url(#tl-clip)">
                ${this._axis(height)}
                ${spans.map(([a, b]) => {
                  const xa = Math.max(0, this._x(a));
                  const xb = Math.min(width, this._x(b));
                  return xb > xa ? svg`<rect class="empty-span" x=${xa} y=${AXIS_H} width=${xb - xa} height=${laneY - AXIS_H - BAND_GAP}></rect>` : nothing;
                })}
                ${this._bands()}
                ${futureX < width
                  ? svg`<rect class="future" x=${Math.max(0, futureX)} y=${AXIS_H} width=${width - Math.max(0, futureX)} height=${height - AXIS_H}></rect>`
                  : nothing}
                <rect class="lane-bg" x="0.5" y=${laneY + 4} width=${width - 1} height=${LANE_H - 8} rx="8"></rect>
                ${this._markers(laneY)}
              </g>
              ${cursorX >= -1 && cursorX <= width + 1
                ? svg`<g pointer-events="none">
                    <line class="cursor-line" x1=${cursorX} x2=${cursorX} y1=${AXIS_H - 4} y2=${laneY - BAND_GAP / 2}></line>
                    <rect class="cursor-head" x=${labelX - labelW / 2} y="0" width=${labelW} height="18" rx="9"></rect>
                    <text class="cursor-label" x=${labelX} y="13" text-anchor="middle">${label}</text>
                  </g>`
                : nothing}
            </svg>`
          : html`<div style="display:grid;gap:${BAND_GAP}px;padding-top:${AXIS_H}px" aria-hidden="true">
              ${plan.rooms.map(() => html`<div class="skeleton" style="height:${BAND_H}px"></div>`)}
              <div class="skeleton" style="height:${LANE_H - 8}px;margin-top:4px"></div>
            </div>`}
        ${this._tip ? this._tooltip(this._tip) : nothing}
      </div>
    </div>`;
  }

  private _tooltip(c: Cluster) {
    const loc = this.loc;
    const shown = c.events.slice(0, 4);
    const x = clamp(c.x, 100, Math.max(100, this._width - 100));
    const top = AXIS_H + (this.plan?.rooms.length ?? 0) * (BAND_H + BAND_GAP) + LANE_H - 6;
    return html`<div class="tip" style="left:${x}px;top:${top}px" role="tooltip">
      ${shown.map((e) => html`<div><time>${fmtClock(loc, e.t, false)}</time><span>${this._eventText(e)}</span></div>`)}
      ${c.events.length > shown.length ? html`<div>${th(loc, "more", { n: c.events.length - shown.length })}</div>` : nothing}
    </div>`;
  }

  private _foot() {
    const loc = this.loc;
    const lang = loc.lang;
    return html`<div class="foot">
      <span><i class="key p"></i>${th(loc, "legend_p")}</span>
      <span><i class="key motion"></i>${th(loc, "legend_motion")}</span>
      <span><i class="key empty"></i>${th(loc, "legend_empty")}</span>
      <span><i class="key future"></i>${th(loc, "legend_future")}</span>
      ${LEGEND.map(({ kinds }) => {
        const kind = kinds[0]!;
        const style = STYLE[kind];
        return html`<span class="tone-${style.tone}">${icon(style.path, 16)}<span style="color:var(--og-fg2)">${LEGEND_SHORT[kind]![lang]}</span></span>`;
      })}
    </div>`;
  }

  private _replay() {
    const loc = this.loc;
    const frame = frameAt(this._frames, this._cursor);
    const fine = Boolean(frame);
    const note = this._truncated
      ? html`<div class="notice info replay-note">${icon(mdiHistory, 20)}<span>${th(loc, "truncated")}</span></div>`
      : !frame && this._framesLoading
        ? html`<div class="notice replay-note">${icon(mdiHistory, 20)}<span>${th(loc, "loading_frames")}</span></div>`
        : !frame
          ? html`<div class="notice replay-note">${icon(mdiHistory, 20)}<span>${th(loc, "no_frame")}</span></div>`
          : nothing;
    const step = fine ? "0,5 s" : "1 min";
    const stepText = loc.lang === "pl" ? step : step.replace(",", ".");
    return html`<section class="card replay" aria-label=${th(loc, "replay")}>
      <div class="replay-head">
        <div class="clock" aria-live="off">${fmtClock(loc, this._cursor)}</div>
        <div class="clock-date">
          <span class="eyebrow">${th(loc, "replay")}</span>
          <span class="small muted">${fmtDay(loc, this._cursor)}</span>
        </div>
        <div class="steps">
          <button class="icon-btn" aria-label=${th(loc, "step_back", { s: stepText })} @click=${() => this._setCursor(stepCursor(this._cursor, -1, this._fine()))}>
            ${icon(mdiStepBackward)}
          </button>
          <button class="icon-btn" aria-label=${th(loc, "step_forward", { s: stepText })} @click=${() => this._setCursor(stepCursor(this._cursor, 1, this._fine()))}>
            ${icon(mdiStepForward)}
          </button>
        </div>
      </div>
      ${note}
      <div class="replay-wrap ${frame ? "" : "dim"}">
        <outglow-plan-view
          .plan=${this.plan}
          .frame=${frame}
          .names=${this.names()}
          .loc=${loc}
          .layers=${LAYERS}
          .dark=${this.dark}
          max-height=${this.narrow ? "48vh" : "56vh"}
        ></outglow-plan-view>
      </div>
    </section>`;
  }

  private _events() {
    const loc = this.loc;
    const events = marked(this._range?.events ?? [], this._withMotion).concat(
      (this._range?.events ?? []).filter((e) => e.kind === "house_empty" || e.kind === "house_occupied"),
    );
    events.sort((a, b) => a.t - b.t);
    const current = lastEventBefore(events, this._cursor);
    return html`<section class="card events-card" aria-labelledby="events-h">
      <div class="card-head">
        <h2 class="headline" id="events-h">${th(loc, "events")}</h2>
        <button class="chip" aria-pressed=${this._withMotion} @click=${() => (this._withMotion = !this._withMotion)}>
          ${icon(mdiRun, 16)} ${th(loc, "show_motion")}
        </button>
      </div>
      ${this._loading
        ? html`<div style="display:grid;gap:10px;padding:8px 16px 16px">
            ${[0, 1, 2, 3, 4].map(() => html`<div class="skeleton" style="height:36px"></div>`)}
          </div>`
        : events.length === 0
          ? html`<p class="hint">${th(loc, "no_events")}</p>`
          : html`<ul class="list">
              ${events.map((event) => {
                const style = STYLE[event.kind];
                const sub = this._eventSub(event);
                return html`<li>
                  <button class=${event === current ? "current" : ""} @click=${() => this._jump(event)} aria-current=${event === current ? "true" : "false"}>
                    <time>${fmtClock(loc, event.t, false)}</time>
                    <span class="tone-${style.tone}">${icon(style.path, 20)}</span>
                    <span>
                      <span class="what">
                        ${event.room ? html`<span class="swatch" style="background:${this.roomColour(event.room)}"></span>` : nothing}
                        <span>${this._eventText(event)}</span>
                      </span>
                      ${sub ? html`<span class="sub">${sub}</span>` : nothing}
                    </span>
                  </button>
                </li>`;
              })}
            </ul>`}
      ${this._fixes()}
    </section>`;
  }

  private _motionAt(t: number): string[] {
    const rooms = this._range?.rooms ?? {};
    return Object.entries(rooms)
      .filter(([, samples]) => {
        let found: RoomSample | undefined;
        for (const sample of samples) {
          if (sample[0] > t) break;
          found = sample;
        }
        return found !== undefined && t - found[0] <= STEP_S * 2 && found[2];
      })
      .map(([room]) => room);
  }

  private _fixes() {
    const loc = this.loc;
    const plan = this.plan;
    const t = this._cursor;
    if (!plan || !this._range || this._loading || t > this._limit()) return nothing;
    const moving = this._motionAt(t);
    const others = plan.rooms.filter((r) => !moving.includes(r.id));
    const missed = others.some((r) => r.id === this._fixRoom) ? this._fixRoom : (others[0]?.id ?? "");
    return html`<div class="fixes" role="group" aria-labelledby="fix-h">
      <span class="small" id="fix-h">${th(loc, "fix_title", { time: fmtClock(loc, t, true) })}</span>
      ${moving.map(
        (room) => html`<div class="row wrap">
          <button class="btn outlined" ?disabled=${this._fixing} data-fix="false_alarm" @click=${() => void this._feedback(room, "false_alarm")}>
            ${th(loc, "fix_false", { room: this.roomName(room) })}
          </button>
          <button class="btn neutral" ?disabled=${this._fixing} data-fix="correct" @click=${() => void this._feedback(room, "correct")}>
            ${th(loc, "fix_correct", { room: this.roomName(room) })}
          </button>
        </div>`,
      )}
      ${others.length
        ? html`<div class="row wrap">
            <select aria-label=${th(loc, "fix_room")} .value=${missed} @change=${(e: Event) => (this._fixRoom = (e.target as HTMLSelectElement).value)}>
              ${others.map((r) => html`<option value=${r.id} ?selected=${r.id === missed}>${r.name}</option>`)}
            </select>
            <button class="btn outlined" ?disabled=${this._fixing || !missed} data-fix="missed" @click=${() => void this._feedback(missed, "missed")}>
              ${th(loc, "fix_missed", { room: this.roomName(missed) })}
            </button>
          </div>`
        : nothing}
      <span class="hint">${th(loc, "fix_hint")}</span>
    </div>`;
  }

  private async _feedback(room: string, kind: FeedbackRequest["kind"]): Promise<void> {
    this._fixing = true;
    try {
      const result = await this.call("outglow/feedback", { room, kind, when: this._cursor });
      this.toast(th(this.loc, result.pending_id ? "fix_done" : "fix_stored"));
      await this._load(this._cursor);
    } catch (err) {
      this.fail(err);
    } finally {
      this._fixing = false;
    }
  }

  private _toolbar() {
    const loc = this.loc;
    const now = Date.now() / 1000;
    const isToday = this._day === dayStart(now);
    const atEarliest = this._day <= earliestDay(now);
    return html`<section class="card toolbar" aria-label=${th(loc, "title")}>
      <div class="daynav">
        <button class="icon-btn" aria-label=${th(loc, "previous_day")} ?disabled=${atEarliest} @click=${() => this._changeDay(-1)}>
          ${icon(mdiChevronLeft)}
        </button>
        <div class="date" aria-live="polite">
          <span class="title">${fmtDay(loc, this._day + 3600 * 12)}</span>
        </div>
        <button class="icon-btn" aria-label=${th(loc, "next_day")} ?disabled=${isToday} @click=${() => this._changeDay(1)}>
          ${icon(mdiChevronRight)}
        </button>
        <button class="btn outlined neutral" ?disabled=${isToday && Math.abs(this._cursor - now) < 120} @click=${() => this._today()}>
          ${th(loc, "today")}
        </button>
      </div>
      <div class="controls">
        <div class="segmented" role="radiogroup" aria-label=${th(loc, "zoom")}>
          ${ZOOMS.map(
            (z) => html`<button role="radio" aria-checked=${z.id === this._zoom} @click=${() => this._setZoom(z.id)}>${z.id}</button>`,
          )}
        </div>
        <div class="segmented" role="radiogroup" aria-label=${th(loc, "speed")}>
          ${SPEEDS.map(
            (s) => html`<button role="radio" aria-checked=${s === this._speed} @click=${() => (this._speed = s)}>${s}×</button>`,
          )}
        </div>
        <button class="btn filled play" @click=${() => this._toggle()} aria-pressed=${this._playing}>
          ${icon(this._playing ? mdiPause : mdiPlay, 20)} ${th(loc, this._playing ? "pause" : "play")}
        </button>
      </div>
    </section>`;
  }

  override render() {
    const loc = this.loc;
    if (!this.plan || this.plan.rooms.length === 0) {
      return html`<div class="card"><div class="empty-state">${icon(mdiHistory, 48)}<div class="headline">${tc(loc, "no_plan")}</div>
        <button class="btn filled" @click=${() => this.navigate("/plan")}>${tc(loc, "open_plan")}</button></div></div>`;
    }
    const empty = this._range && !this._loading && Object.values(this._range.rooms).every((s) => s.length === 0);
    const zoomed = this._zoom !== "24h";
    return html`
      ${this._toolbar()}
      <div class="layout">
        <div class="main">
          <section class="card tl-card" aria-labelledby="tl-h">
            <h2 class="sr-only" id="tl-h">${th(loc, "rooms")}</h2>
            ${empty
              ? html`<div class="empty-state">${icon(mdiHistory, 40)}<div class="headline">${th(loc, "empty_day")}</div><div class="small">${th(loc, "empty_day_hint")}</div></div>`
              : this._timeline()}
            ${empty
              ? nothing
              : html`<div class="foot-row">
                  ${this._foot()}
                  ${zoomed
                    ? html`<button class="icon-btn" aria-label=${th(loc, "earlier")} @click=${() => this._pan(-1)}>${icon(mdiChevronDoubleLeft)}</button>
                        <button class="icon-btn" aria-label=${th(loc, "later")} @click=${() => this._pan(1)}>${icon(mdiChevronDoubleRight)}</button>`
                    : nothing}
                </div>`}
          </section>
          ${this._replay()}
        </div>
        ${this._events()}
      </div>
    `;
  }
}

if (!customElements.get("outglow-history-view")) {
  customElements.define("outglow-history-view", OutglowHistoryView);
}

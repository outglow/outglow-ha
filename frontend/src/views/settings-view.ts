import { css, html, nothing, type PropertyValues } from "lit";
import {
  mdiAlert,
  mdiArrowRight,
  mdiBackupRestore,
  mdiCheckCircle,
  mdiDelete,
  mdiDeleteSweep,
  mdiEyeOutline,
  mdiInformation,
  mdiLightbulb,
  mdiRestore,
  mdiSchool,
  mdiTrendingDown,
  mdiTrendingUp,
  mdiWifiOff,
} from "@mdi/js";
import type {
  Bulb,
  BulbSetting,
  GlobalSettings,
  ModelSummary,
  QualityReport,
  Reaction,
  RoomChange,
  RoomSettings,
  Settings,
  Snapshot,
} from "../api/types";
import "../components/bulb-write-dialog";
import { fmtDateTime, fmtNumber, fmtPercent } from "../format";
import { bulbRoom } from "../geometry";
import { strings } from "../i18n";
import { icon } from "../icons";
import { tc } from "../strings/common";
import { shared, tokens } from "../theme";
import { ViewBase } from "./base";

export const ts = strings(
  {
    title: "Settings",
    room_settings: "Room",
    rooms: "Rooms",
    budget: "False alarms per day",
    budget_hint: "How many false alarms a day the night calibration aims for.",
    per_day: "a day",
    estimate: "At this setting it detects ≈ {detection} of entries, with {false} false alarms a day.",
    estimate_changed: "Now ≈ {detection} of entries detected. The new budget takes effect after the next night calibration.",
    estimate_unknown: "Not known yet — do the Learning to find out.",
    learn: "Start Learning",
    reaction: "Reaction",
    reaction_fast: "fast",
    reaction_normal: "normal",
    reaction_calm: "calm",
    reaction_fast_hint: "≈ 1 s; a few more false alarms at the same budget.",
    reaction_normal_hint: "≈ 2 s; balanced.",
    reaction_calm_hint: "≈ 3–4 s; the fewest false alarms.",
    hold: "Hold",
    hold_hint: "How long the room stays occupied after the last motion.",
    seconds: "{n} s",
    minutes: "{m} min {s} s",
    minutes_even: "{m} min",
    auto_light: "Turn lights on",
    not_in_version: "Not in this version yet. Use an automation on the room's occupancy sensor.",
    off_delay: "Turn off after {time} without motion",
    advanced: "Advanced",
    skipped: "Skipped directions",
    skipped_none: "No directions of this room are skipped.",
    use_again: "Use again",
    bulbs: "Bulbs in this room",
    bulbs_none: "No bulb is placed in this room.",
    bulbs_hint: "Changes are written to the bulb's firmware only after you confirm their effects.",
    change: "Change…",
    sensitivity: "Sensitivity",
    probes: "Probes",
    auto_cal: "Auto-calibration",
    reports: "Activity reports",
    reports_off: "off",
    rate: "{n}/s",
    gate: "Gate, 24 h",
    offline: "offline",
    online: "online",
    on: "on",
    off: "off",
    model: "Model",
    version: "Version {n}",
    updated: "Updated {when}",
    never: "never",
    learning_on: "learning in the background",
    learning_off: "learning off",
    empty_hours: "{n} h of empty-home data",
    labels: "Applied labels",
    source_wizard: "Learning",
    source_recording: "recordings",
    source_service: "service",
    source_feedback: "corrections",
    source_empty_house: "empty home",
    source_manual_light: "manual lights",
    pending: "Waiting for your decision",
    pending_hint: "New labels are learnt in the background but used only after you apply them.",
    pending_created: "Prepared {when}",
    pending_labels: "New labels",
    no_pending: "No changes are waiting. Labels from Learning, corrections and the empty home appear here before they are used.",
    before_after: "Before → after",
    detection: "Entries detected",
    false_day: "False alarms / day",
    apply: "Apply",
    discard: "Discard",
    applied: "Model updated to version {n}",
    discarded: "Proposal discarded",
    snapshots: "Snapshots",
    snapshots_none: "No snapshots yet.",
    rollback: "Roll back",
    rollback_title: "Roll the model back?",
    rollback_text: "The model returns to version {n} from {when}. The current model is kept as a snapshot, so this can be undone.",
    rolled_back: "Model rolled back",
    delete_snapshot: "Delete",
    delete_snapshot_label: "Delete the snapshot from {when}",
    delete_all: "Delete all",
    delete_title: "Delete the snapshot?",
    delete_text: "The snapshot from {when} (version {n}) is removed for good; the model can no longer go back to it.",
    delete_all_title: "Delete all snapshots?",
    delete_all_text: "All {n} snapshots are removed for good. The current model stays as it is.",
    deleted: "Snapshot deleted",
    deleted_all: "Snapshots deleted",
    reset: "Reset learning…",
    reset_title: "Reset learning?",
    reset_scope: "What to forget",
    reset_home: "Whole home",
    reset_text_home: "The model forgets everything it learnt in the whole home and starts again from the plan.",
    reset_text_room: "The model forgets what it learnt for {room}; the other rooms stay.",
    reset_keeps: "The plan and the settings stay. A snapshot is taken first, so this can be rolled back.",
    reset_confirm: "Reset",
    reset_done: "Learning reset, model version {n}. The previous model is kept as a snapshot.",
    reason_daily: "daily",
    reason_before_session: "before Learning",
    reason_before_apply: "before apply",
    reason_before_reset: "before reset",
    reason_before_rollback: "before rollback",
    global: "Whole home",
    sensing: "Presence sensing",
    sensing_hint: "Off makes the room sensors unavailable.",
    learning: "Learn in the background",
    learning_hint: "Changes still wait for Apply.",
    mode: "Engine",
    mode_rules: "rules",
    mode_bayes: "model",
    tick: "Update every",
    use_persons: "Use people at home",
    use_persons_hint: "Treat the home as empty when everybody is away. Off by default.",
    others: "Others may be home",
    others_hint: "Guests or pets: never assume an empty home from people alone.",
    firmware_channel: "Use the bulbs' own motion bits",
    retention: "Keep data",
    raw_h: "Raw reports (hours)",
    empty_raw_d: "Empty-home reports (days)",
    ticks_d: "Room history (days)",
    events_d: "Events (days)",
    unsaved: "Unsaved changes",
    saved: "Settings saved",
    loading: "Loading settings…",
    no_rooms: "Draw rooms in the plan first.",
  },
  {
    title: "Ustawienia",
    room_settings: "Pokój",
    rooms: "Pokoje",
    budget: "Pomyłki na dobę",
    budget_hint: "Ile fałszywych zapaleń na dobę ma celować kalibracja nocna.",
    per_day: "na dobę",
    estimate: "Przy tym ustawieniu wykrywa ≈ {detection} wejść, z {false} pomyłki na dobę.",
    estimate_changed: "Teraz wykrywa ≈ {detection} wejść. Nowy budżet zadziała po najbliższej kalibracji nocnej.",
    estimate_unknown: "Jeszcze nie wiadomo — zrób Naukę, żeby się przekonać.",
    learn: "Zacznij Naukę",
    reaction: "Reakcja",
    reaction_fast: "szybko",
    reaction_normal: "normalnie",
    reaction_calm: "spokojnie",
    reaction_fast_hint: "≈ 1 s; trochę więcej pomyłek przy tym samym budżecie.",
    reaction_normal_hint: "≈ 2 s; w równowadze.",
    reaction_calm_hint: "≈ 3–4 s; najmniej pomyłek.",
    hold: "Podtrzymanie",
    hold_hint: "Jak długo pokój jest zajęty po ostatnim ruchu.",
    seconds: "{n} s",
    minutes: "{m} min {s} s",
    minutes_even: "{m} min",
    auto_light: "Zapalaj światła",
    not_in_version: "Jeszcze nie w tej wersji. Użyj automatyzacji na czujniku zajętości pokoju.",
    off_delay: "Gaś po {time} bez ruchu",
    advanced: "Zaawansowane",
    skipped: "Pomijane kierunki",
    skipped_none: "Żaden kierunek tego pokoju nie jest pomijany.",
    use_again: "Używaj znowu",
    bulbs: "Żarówki w tym pokoju",
    bulbs_none: "W tym pokoju nie ma żadnej żarówki.",
    bulbs_hint: "Zmiany trafiają do firmware żarówki dopiero po potwierdzeniu ich skutków.",
    change: "Zmień…",
    sensitivity: "Czułość",
    probes: "Sondy",
    auto_cal: "Autokalibracja",
    reports: "Raporty aktywności",
    reports_off: "wyłączone",
    rate: "{n}/s",
    gate: "Bramka, 24 h",
    offline: "offline",
    online: "online",
    on: "wł.",
    off: "wył.",
    model: "Model",
    version: "Wersja {n}",
    updated: "Zmieniony {when}",
    never: "nigdy",
    learning_on: "uczy się w tle",
    learning_off: "uczenie wyłączone",
    empty_hours: "{n} h danych pustego domu",
    labels: "Użyte etykiety",
    source_wizard: "Nauka",
    source_recording: "nagrania",
    source_service: "usługa",
    source_feedback: "poprawki",
    source_empty_house: "pusty dom",
    source_manual_light: "ręczne światło",
    pending: "Czeka na Twoją decyzję",
    pending_hint: "Nowe etykiety uczą model w tle, ale działają dopiero po zastosowaniu.",
    pending_created: "Przygotowane {when}",
    pending_labels: "Nowe etykiety",
    no_pending: "Nic nie czeka. Etykiety z Nauki, poprawek i pustego domu pojawią się tu, zanim zaczną działać.",
    before_after: "Przed → po",
    detection: "Wykryte wejścia",
    false_day: "Pomyłki / dobę",
    apply: "Zastosuj",
    discard: "Odrzuć",
    applied: "Model zaktualizowany do wersji {n}",
    discarded: "Propozycja odrzucona",
    snapshots: "Migawki",
    snapshots_none: "Jeszcze nie ma migawek.",
    rollback: "Cofnij",
    rollback_title: "Cofnąć model?",
    rollback_text: "Model wróci do wersji {n} z {when}. Obecny model zostanie zapisany jako migawka, więc da się to odwrócić.",
    rolled_back: "Model cofnięty",
    delete_snapshot: "Usuń",
    delete_snapshot_label: "Usuń migawkę z {when}",
    delete_all: "Usuń wszystkie",
    delete_title: "Usunąć migawkę?",
    delete_text: "Migawka z {when} (wersja {n}) zniknie na stałe; modelu nie da się już do niej cofnąć.",
    delete_all_title: "Usunąć wszystkie migawki?",
    delete_all_text: "Wszystkie migawki ({n}) znikną na stałe. Obecny model zostaje bez zmian.",
    deleted: "Usunięto migawkę",
    deleted_all: "Usunięto migawki",
    reset: "Zresetuj naukę…",
    reset_title: "Zresetować naukę?",
    reset_scope: "Co zapomnieć",
    reset_home: "Cały dom",
    reset_text_home: "Model zapomni wszystko, czego nauczył się w całym domu, i zacznie od nowa z planu.",
    reset_text_room: "Model zapomni, czego nauczył się dla pokoju {room}; pozostałe pokoje zostają.",
    reset_keeps: "Plan i ustawienia zostają. Najpierw powstaje migawka, więc da się to cofnąć.",
    reset_confirm: "Zresetuj",
    reset_done: "Nauka zresetowana, wersja modelu {n}. Poprzedni model zostaje jako migawka.",
    reason_daily: "dzienna",
    reason_before_session: "przed Nauką",
    reason_before_apply: "przed zastosowaniem",
    reason_before_reset: "przed resetem",
    reason_before_rollback: "przed cofnięciem",
    global: "Cały dom",
    sensing: "Wykrywanie obecności",
    sensing_hint: "Wyłączone czyni czujniki pokojów niedostępnymi.",
    learning: "Ucz się w tle",
    learning_hint: "Zmiany i tak czekają na „Zastosuj”.",
    mode: "Silnik",
    mode_rules: "reguły",
    mode_bayes: "model",
    tick: "Odświeżaj co",
    use_persons: "Uwzględniaj domowników",
    use_persons_hint: "Uznawaj dom za pusty, gdy wszyscy wyszli. Domyślnie wyłączone.",
    others: "W domu mogą być inni",
    others_hint: "Goście albo zwierzęta: nie zakładaj pustego domu tylko z obecności osób.",
    firmware_channel: "Używaj bitów ruchu z żarówek",
    retention: "Przechowuj dane",
    raw_h: "Surowe raporty (godziny)",
    empty_raw_d: "Raporty pustego domu (dni)",
    ticks_d: "Historia pokojów (dni)",
    events_d: "Zdarzenia (dni)",
    unsaved: "Niezapisane zmiany",
    saved: "Zapisano ustawienia",
    loading: "Wczytywanie ustawień…",
    no_rooms: "Najpierw narysuj pokoje na planie.",
  },
);

export const BUDGETS: RoomSettings["false_alarm_budget"][] = [0.1, 0.3, 1, 3, 10];
const REACTIONS: Reaction[] = ["fast", "normal", "calm"];
const TICKS: GlobalSettings["tick_s"][] = [0.25, 0.5, 1];
const RETENTION: (keyof GlobalSettings["retention"])[] = ["raw_h", "empty_raw_d", "ticks_d", "events_d"];

export const DEFAULT_ROOM: RoomSettings = {
  false_alarm_budget: 1,
  reaction: "normal",
  hold_time_s: 60,
  auto_light: false,
  light_off_delay_s: 300,
};

export type Trend = "better" | "worse" | "same" | "unknown";

export function trend(before: number | null, after: number | null, higherIsBetter: boolean): Trend {
  if (after === null) return "unknown";
  if (before === null) return "better";
  const d = after - before;
  if (Math.abs(d) < 1e-9) return "same";
  return d > 0 === higherIsBetter ? "better" : "worse";
}

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class OutglowSettingsView extends ViewBase {
  static override properties = {
    ...ViewBase.properties,
    _saved: { state: true },
    _draft: { state: true },
    _quality: { state: true },
    _model: { state: true },
    _snapshots: { state: true },
    _busy: { state: true },
    _write: { state: true },
    _rollback: { state: true },
    _delete: { state: true },
    _reset: { state: true },
    _resetRoom: { state: true },
  };

  declare _saved: Settings | null;
  declare _draft: Settings | null;
  declare _quality: QualityReport | null;
  declare _model: ModelSummary | null;
  declare _snapshots: Snapshot[];
  declare _busy: boolean;
  declare _write: { bulb: Bulb; setting: BulbSetting } | null;
  declare _rollback: Snapshot | null;
  declare _delete: Snapshot | "all" | null;
  declare _reset: boolean;
  declare _resetRoom: string;

  private _requested = false;

  constructor() {
    super();
    this._saved = null;
    this._draft = null;
    this._quality = null;
    this._model = null;
    this._snapshots = [];
    this._busy = false;
    this._write = null;
    this._rollback = null;
    this._delete = null;
    this._reset = false;
    this._resetRoom = "";
  }

  static override styles = [
    tokens,
    shared,
    css`
      :host {
        display: block;
        padding-bottom: 72px;
      }
      .layout {
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(0, 1fr);
        align-items: start;
      }
      @media (min-width: 1100px) {
        .layout {
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        }
      }
      .col {
        display: grid;
        gap: 16px;
        align-content: start;
        min-width: 0;
      }
      .chips {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        padding: 2px 2px 4px;
        scrollbar-width: none;
      }
      .chips::-webkit-scrollbar {
        display: none;
      }
      .chips .chip {
        min-height: 40px;
        border-radius: 20px;
        padding: 0 16px 0 12px;
        font-size: 14px;
      }
      .chips .swatch {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }
      .room-title {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 18px 20px 4px;
      }
      .room-title .swatch {
        width: 14px;
        height: 14px;
        border-radius: 4px;
      }
      .setting {
        display: grid;
        gap: 10px;
        padding: 16px 20px;
        border-top: 1px solid var(--og-divider);
      }
      .setting:first-of-type {
        border-top: none;
      }
      .setting-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }
      .setting-head label,
      .setting-head .label {
        font-size: 15px;
        font-weight: 500;
      }
      .setting > .segmented {
        justify-self: start;
      }
      input[type="range"] {
        -webkit-appearance: none;
        appearance: none;
        background: transparent;
        min-height: 36px;
        cursor: pointer;
      }
      input[type="range"]::-webkit-slider-runnable-track {
        height: 4px;
        border-radius: 2px;
        background: linear-gradient(90deg, var(--og-primary) var(--fill, 0%), var(--og-tint-strong) var(--fill, 0%));
      }
      input[type="range"]::-moz-range-track {
        height: 4px;
        border-radius: 2px;
        background: var(--og-tint-strong);
      }
      input[type="range"]::-moz-range-progress {
        height: 4px;
        border-radius: 2px;
        background: var(--og-primary);
      }
      input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 20px;
        height: 20px;
        margin-top: -8px;
        border-radius: 50%;
        background: var(--og-primary);
        border: none;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      }
      input[type="range"]::-moz-range-thumb {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: var(--og-primary);
        border: none;
      }
      input[type="range"]:focus-visible {
        outline: none;
      }
      input[type="range"]:focus-visible::-webkit-slider-thumb {
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--og-primary) 30%, transparent);
      }
      .value {
        font-size: 15px;
        font-variant-numeric: tabular-nums;
        color: var(--og-primary);
        font-weight: 500;
      }
      .hint {
        font-size: 13px;
        line-height: 18px;
        color: var(--og-fg2);
      }
      .budget {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px 12px;
      }
      .budget .segmented button {
        min-width: 52px;
      }
      .estimate {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        font-size: 14px;
        line-height: 20px;
      }
      .estimate .icon {
        color: var(--og-primary);
        margin-top: -1px;
      }
      .estimate.unknown .icon {
        color: var(--og-fg2);
      }
      .switch-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 44px;
      }
      .switch-row .text {
        display: grid;
        gap: 2px;
      }
      .switch-row .text span:first-child {
        font-size: 15px;
      }
      .disabled {
        opacity: 0.6;
      }
      details {
        border-top: 1px solid var(--og-divider);
      }
      summary {
        display: flex;
        align-items: center;
        min-height: 52px;
        padding: 0 20px;
        font-size: 15px;
        font-weight: 500;
        cursor: pointer;
        list-style: none;
      }
      summary::-webkit-details-marker {
        display: none;
      }
      summary::after {
        content: "";
        margin-left: auto;
        width: 8px;
        height: 8px;
        border-right: 2px solid var(--og-fg2);
        border-bottom: 2px solid var(--og-fg2);
        transform: rotate(45deg);
        transition: transform 200ms var(--og-ease);
      }
      details[open] summary::after {
        transform: rotate(-135deg);
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0 12px 12px;
        display: grid;
        gap: 6px;
      }
      .list li {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 48px;
        padding: 4px 4px 4px 12px;
        border-radius: var(--og-radius-s);
        background: var(--og-tint);
        font-size: 14px;
      }
      .bulb {
        display: grid;
        gap: 10px;
        padding: 14px 16px;
        border: 1px solid var(--og-divider);
        border-radius: var(--og-radius-s);
      }
      .bulb-head {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .bulb-head .icon {
        color: var(--og-fg2);
      }
      .bulb-head b {
        flex: 1;
        min-width: 0;
        font-weight: 500;
        font-size: 15px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 8px 16px;
        margin: 0;
      }
      .facts dt {
        font-size: 12px;
        color: var(--og-fg2);
      }
      .facts dd {
        margin: 2px 0 0;
        font-size: 15px;
        font-variant-numeric: tabular-nums;
      }
      .facts dd.warn {
        color: color-mix(in srgb, var(--og-warning) 70%, var(--og-fg));
      }
      .bulbs {
        display: grid;
        gap: 10px;
        padding: 0 16px 16px;
      }
      .model-top {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 0 20px 12px;
      }
      .model-top .version {
        font-size: 28px;
        line-height: 36px;
        font-weight: 400;
        margin-right: 8px;
      }
      .labels {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 0 20px 16px;
      }
      .pending {
        margin: 0 12px 12px;
        padding: 16px;
        border-radius: var(--og-radius-s);
        background: var(--og-primary-tint);
        display: grid;
        gap: 12px;
      }
      .pending h4 {
        font-size: 15px;
        font-weight: 500;
      }
      .changes {
        display: grid;
        gap: 8px;
      }
      .change {
        display: grid;
        grid-template-columns: minmax(90px, 1fr) minmax(0, 1.4fr) minmax(0, 1.4fr);
        gap: 8px 12px;
        align-items: center;
        padding: 10px 12px;
        border-radius: var(--og-radius-s);
        background: var(--og-card);
        font-size: 14px;
      }
      .change.head {
        background: transparent;
        padding: 0 12px;
        font-size: 12px;
        color: var(--og-fg2);
      }
      .delta {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .delta .from {
        color: var(--og-fg2);
      }
      .delta.better .icon,
      .delta.better .to {
        color: var(--og-success);
      }
      .delta.worse .icon,
      .delta.worse .to {
        color: var(--og-error);
      }
      .delta .to {
        font-weight: 500;
      }
      .delta-label {
        display: none;
        font-size: 12px;
        color: var(--og-fg2);
      }
      @media (max-width: 520px) {
        .change {
          grid-template-columns: 1fr 1fr;
        }
        .change .rn {
          grid-column: 1 / -1;
          font-weight: 500;
        }
        .change.head {
          display: none;
        }
        .delta-label {
          display: block;
        }
      }
      .pending .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }
      .snapshots {
        list-style: none;
        margin: 0;
        padding: 0 12px 12px;
      }
      .snapshots li {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 52px;
        padding: 4px 4px 4px 8px;
        border-top: 1px solid var(--og-divider);
        font-size: 14px;
      }
      .snapshots li:first-child {
        border-top: none;
      }
      .snapshots .when {
        display: grid;
        gap: 2px;
        flex: 1;
        min-width: 0;
      }
      .model-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
        padding: 0 12px 12px;
      }
      .snapshots .icon-btn.danger {
        color: var(--og-error);
      }
      .retention {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      @media (max-width: 480px) {
        .retention {
          grid-template-columns: 1fr;
        }
      }
      .savebar {
        position: fixed;
        left: 50%;
        bottom: calc(16px + env(safe-area-inset-bottom));
        transform: translateX(-50%);
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 8px;
        width: min(560px, calc(100vw - 24px));
        padding: 8px 8px 8px 20px;
        border-radius: 28px;
        background: var(--og-card);
        border: 1px solid var(--og-divider);
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
        animation: up 220ms var(--og-ease);
      }
      .savebar span {
        flex: 1;
        font-weight: 500;
        font-size: 14px;
      }
      @keyframes up {
        from {
          opacity: 0;
          transform: translate(-50%, 16px);
        }
      }
      .center {
        padding: 48px 16px;
        text-align: center;
        color: var(--og-fg2);
      }
      .muted-box {
        padding: 0 20px 16px;
        font-size: 14px;
        line-height: 20px;
        color: var(--og-fg2);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
        width: 100%;
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
    try {
      const [settings, model, snapshots] = await Promise.all([
        this.call("outglow/settings/get", {}),
        this.call("outglow/model/get", {}),
        this.call("outglow/model/snapshots", {}),
      ]);
      this._saved = settings;
      this._draft = structuredClone(settings);
      this._model = model;
      this._snapshots = snapshots.snapshots;
    } catch (err) {
      this.fail(err);
    }
    try {
      this._quality = await this.call("outglow/quality", { days: 7 });
    } catch {
      this._quality = null;
    }
  }

  private async _reloadModel(): Promise<void> {
    const [model, snapshots] = await Promise.all([this.call("outglow/model/get", {}), this.call("outglow/model/snapshots", {})]);
    this._model = model;
    this._snapshots = snapshots.snapshots;
  }

  private get _roomId(): string | null {
    const rooms = this.plan?.rooms ?? [];
    return rooms.find((r) => r.id === this.subpath)?.id ?? rooms[0]?.id ?? null;
  }

  private _room(id: string): RoomSettings {
    return this._draft?.rooms[id] ?? DEFAULT_ROOM;
  }

  private _patchRoom(id: string, patch: Partial<RoomSettings>): void {
    if (!this._draft) return;
    this._draft = { ...this._draft, rooms: { ...this._draft.rooms, [id]: { ...this._room(id), ...patch } } };
  }

  private _patchGlobal(patch: Partial<GlobalSettings>): void {
    if (!this._draft) return;
    this._draft = { ...this._draft, global: { ...this._draft.global, ...patch } };
  }

  private get _dirty(): boolean {
    return Boolean(this._draft && this._saved && !same(this._draft, this._saved));
  }

  private async _save(): Promise<void> {
    if (!this._draft) return;
    this._busy = true;
    try {
      const saved = await this.call("outglow/settings/set", this._draft);
      this._saved = saved;
      this._draft = structuredClone(saved);
      this.toast(ts(this.loc, "saved"));
    } catch (err) {
      this.fail(err);
    } finally {
      this._busy = false;
    }
  }

  private _holdText(s: number): string {
    const loc = this.loc;
    if (s < 120) return ts(loc, "seconds", { n: s });
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? ts(loc, "minutes", { m, s: rest }) : ts(loc, "minutes_even", { m });
  }

  private _radio<T extends string | number>(label: string, values: readonly T[], current: T, text: (v: T) => string, pick: (v: T) => void) {
    return html`<div class="segmented" role="radiogroup" aria-label=${label}>
      ${values.map((v) => html`<button role="radio" aria-checked=${v === current} @click=${() => pick(v)}>${text(v)}</button>`)}
    </div>`;
  }

  private _estimate(id: string) {
    const loc = this.loc;
    const q = this._quality?.rooms.find((r) => r.room === id);
    const changed = this._saved?.rooms[id]?.false_alarm_budget !== this._room(id).false_alarm_budget;
    if (!q || q.entry_detection === null) {
      return html`<div class="estimate unknown">
        ${icon(mdiInformation, 20)}
        <span>${ts(loc, "estimate_unknown")}
          <button class="btn" style="min-height:32px;padding:0 8px" @click=${() => this.navigate("/learn")}>${ts(loc, "learn")}</button></span
        >
      </div>`;
    }
    const detection = fmtPercent(loc, q.entry_detection);
    return html`<div class="estimate">
      ${icon(mdiCheckCircle, 20)}
      <span>${changed
        ? ts(loc, "estimate_changed", { detection })
        : ts(loc, "estimate", { detection, false: fmtNumber(loc, q.false_alarms_per_day ?? 0, 1) })}</span>
    </div>`;
  }

  private _roomCard(id: string) {
    const loc = this.loc;
    const room = this.plan!.rooms.find((r) => r.id === id)!;
    const s = this._room(id);
    return html`<section class="card" aria-labelledby="room-h">
      <div class="room-title">
        <span class="swatch" style="background:${room.colour}"></span>
        <h2 class="title" id="room-h">${room.name}</h2>
      </div>
      <div class="setting">
        <div class="setting-head"><span class="label" id="budget-l">${ts(loc, "budget")}</span></div>
        <div class="budget">
          ${this._radio(ts(loc, "budget"), BUDGETS, s.false_alarm_budget, (b) => fmtNumber(loc, b, 1), (b) => this._patchRoom(id, { false_alarm_budget: b }))}
          <span class="hint">${ts(loc, "per_day")}</span>
        </div>
        <span class="hint">${ts(loc, "budget_hint")}</span>
        ${this._estimate(id)}
      </div>
      <div class="setting">
        <div class="setting-head"><span class="label">${ts(loc, "reaction")}</span></div>
        ${this._radio(ts(loc, "reaction"), REACTIONS, s.reaction, (r) => ts(loc, `reaction_${r}`), (r) => this._patchRoom(id, { reaction: r }))}
        <span class="hint">${ts(loc, `reaction_${s.reaction}_hint`)}</span>
      </div>
      <div class="setting">
        <div class="setting-head">
          <label for="hold">${ts(loc, "hold")}</label>
          <span class="value">${this._holdText(s.hold_time_s)}</span>
        </div>
        <input
          id="hold"
          type="range"
          min="10"
          max="600"
          step="10"
          .value=${String(s.hold_time_s)}
          style="--fill:${((s.hold_time_s - 10) / 590) * 100}%"
          aria-valuetext=${this._holdText(s.hold_time_s)}
          @input=${(e: Event) => this._patchRoom(id, { hold_time_s: Number((e.target as HTMLInputElement).value) })}
        />
        <span class="hint">${ts(loc, "hold_hint")}</span>
      </div>
      <div class="setting">
        <div class="switch-row disabled">
          <span class="text">
            <span>${ts(loc, "auto_light")}</span>
            <span class="hint">${ts(loc, "off_delay", { time: this._holdText(s.light_off_delay_s) })}</span>
          </span>
          <span class="switch"><input type="checkbox" disabled .checked=${s.auto_light} aria-label=${ts(loc, "auto_light")} /><span></span></span>
        </div>
        <div class="notice">${icon(mdiInformation, 20)}<span>${ts(loc, "not_in_version")}</span></div>
      </div>
      ${this._advanced(id)}
    </section>`;
  }

  private _roomBulbs(id: string): Bulb[] {
    const plan = this.plan!;
    const ids = plan.bulbs.filter((b) => bulbRoom(plan, b) === id).map((b) => b.ieee);
    return ids.map((ieee) => this.bulbs.find((b) => b.ieee === ieee)).filter((b): b is Bulb => Boolean(b));
  }

  private _advanced(id: string) {
    const loc = this.loc;
    const plan = this.plan!;
    const mine = new Set(plan.bulbs.filter((b) => bulbRoom(plan, b) === id).map((b) => b.ieee));
    const skipped = plan.excluded_directions.filter((d) => mine.has(d.rx) || mine.has(d.tx));
    return html`<details ?open=${skipped.length > 0}>
      <summary>${ts(loc, "advanced")} · ${ts(loc, "skipped")} (${skipped.length})</summary>
      ${skipped.length
        ? html`<ul class="list">
            ${skipped.map(
              (d) => html`<li>
                <span class="grow">${this.bulbName(d.rx)} ← ${this.bulbName(d.tx)}${d.reason ? html`<br /><span class="hint">${d.reason}</span>` : nothing}</span>
                <button class="btn" @click=${() => void this.setExcluded(d.rx, d.tx, false)}>${icon(mdiEyeOutline, 18)} ${ts(loc, "use_again")}</button>
              </li>`,
            )}
          </ul>`
        : html`<p class="muted-box">${ts(loc, "skipped_none")}</p>`}
    </details>`;
  }

  private _bulbCard(bulb: Bulb) {
    const loc = this.loc;
    const onOff = (v: boolean | null): string => (v === null ? "—" : ts(loc, v ? "on" : "off"));
    const reportsOff = !bulb.activity_rate;
    return html`<article class="bulb">
      <div class="bulb-head">
        ${icon(bulb.available ? mdiLightbulb : mdiWifiOff, 20)}
        <b>${bulb.name}</b>
        <span class="badge ${bulb.available ? "success" : "error"}">${ts(loc, bulb.available ? "online" : "offline")}</span>
      </div>
      <dl class="facts">
        <div><dt>${ts(loc, "sensitivity")}</dt><dd>${bulb.sensitivity ?? "—"}</dd></div>
        <div><dt>${ts(loc, "probes")}</dt><dd>${bulb.probes ?? "—"}</dd></div>
        <div><dt>${ts(loc, "auto_cal")}</dt><dd>${onOff(bulb.auto_calibration)}</dd></div>
        <div>
          <dt>${ts(loc, "reports")}</dt>
          <dd class=${reportsOff ? "warn" : ""}>${reportsOff ? ts(loc, "reports_off") : ts(loc, "rate", { n: bulb.activity_rate ?? 0 })}</dd>
        </div>
        <div><dt>${ts(loc, "gate")}</dt><dd>${fmtPercent(loc, bulb.gate_duty_24h)}</dd></div>
      </dl>
      <div>
        <button class="btn outlined" ?disabled=${!bulb.available} data-change=${bulb.ieee} @click=${() => (this._write = { bulb, setting: "sensitivity" })}>
          ${ts(loc, "change")}
        </button>
      </div>
    </article>`;
  }

  private _bulbsCard(id: string) {
    const loc = this.loc;
    const bulbs = this._roomBulbs(id);
    return html`<section class="card" aria-labelledby="bulbs-h">
      <div class="card-head"><h3 class="headline" id="bulbs-h">${ts(loc, "bulbs")}</h3></div>
      <p class="muted-box" style="padding-bottom:12px">${ts(loc, "bulbs_hint")}</p>
      <div class="bulbs">${bulbs.length ? bulbs.map((b) => this._bulbCard(b)) : html`<p class="hint">${ts(loc, "bulbs_none")}</p>`}</div>
    </section>`;
  }

  private _delta(before: number | null, after: number | null, higher: boolean, format: (v: number | null) => string, label: string) {
    const kind = trend(before, after, higher);
    const arrow = kind === "better" ? (higher ? mdiTrendingUp : mdiTrendingDown) : kind === "worse" ? (higher ? mdiTrendingDown : mdiTrendingUp) : mdiArrowRight;
    return html`<span>
      <span class="delta-label">${label}</span>
      <span class="delta ${kind}">
        <span class="from">${format(before)}</span>${icon(arrow, 16)}<span class="to">${format(after)}</span>
      </span>
    </span>`;
  }

  private _change(c: RoomChange) {
    const loc = this.loc;
    return html`<div class="change">
      <span class="rn row"><span class="swatch" style="background:${this.roomColour(c.room)}"></span>${this.roomName(c.room)}</span>
      ${this._delta(c.detection_before, c.detection_after, true, (v) => fmtPercent(loc, v), ts(loc, "detection"))}
      ${this._delta(c.false_per_day_before, c.false_per_day_after, false, (v) => fmtNumber(loc, v, 1), ts(loc, "false_day"))}
    </div>`;
  }

  private async _apply(id: string, apply: boolean): Promise<void> {
    this._busy = true;
    try {
      const result = apply ? await this.call("outglow/model/apply", { pending_id: id }) : await this.call("outglow/model/discard", { pending_id: id });
      this.toast(apply ? ts(this.loc, "applied", { n: result.model_version }) : ts(this.loc, "discarded"));
      await this._reloadModel();
    } catch (err) {
      this.fail(err);
    } finally {
      this._busy = false;
    }
  }

  private async _doRollback(): Promise<void> {
    const snap = this._rollback;
    if (!snap) return;
    this._busy = true;
    try {
      await this.call("outglow/model/rollback", { snapshot_id: snap.snapshot_id });
      this.toast(ts(this.loc, "rolled_back"));
      this._rollback = null;
      await this._reloadModel();
    } catch (err) {
      this.fail(err);
    } finally {
      this._busy = false;
    }
  }

  private async _doDelete(): Promise<void> {
    const target = this._delete;
    if (!target) return;
    this._busy = true;
    try {
      const left = await this.call("outglow/model/snapshot/delete", target === "all" ? { all: true } : { snapshot_id: target.snapshot_id });
      this._snapshots = left.snapshots;
      this.toast(ts(this.loc, target === "all" ? "deleted_all" : "deleted"));
      this._delete = null;
    } catch (err) {
      this.fail(err);
    } finally {
      this._busy = false;
    }
  }

  private async _doReset(): Promise<void> {
    this._busy = true;
    try {
      const result = await this.call("outglow/model/reset", { room: this._resetRoom || null });
      this.toast(ts(this.loc, "reset_done", { n: result.model_version }));
      this._reset = false;
      await this._reloadModel();
    } catch (err) {
      this.fail(err);
    } finally {
      this._busy = false;
    }
  }

  private _openReset(): void {
    this._resetRoom = "";
    this._reset = true;
  }

  private _deleteSheet() {
    const loc = this.loc;
    const target = this._delete;
    const all = target === "all";
    return html`<og-sheet
      .open=${Boolean(target)}
      heading=${ts(loc, all ? "delete_all_title" : "delete_title")}
      close-label=${tc(loc, "close")}
      @closed=${() => (this._delete = null)}
    >
      ${target === null
        ? nothing
        : html`<p>
            ${target === "all"
              ? ts(loc, "delete_all_text", { n: this._snapshots.length })
              : ts(loc, "delete_text", { n: target.model_version, when: fmtDateTime(loc, target.t) })}
          </p>`}
      <div slot="actions" class="actions">
        <button class="btn neutral" @click=${() => (this._delete = null)}>${tc(loc, "cancel")}</button>
        <button class="btn danger filled" data-action="delete-snapshot" ?disabled=${this._busy} @click=${() => void this._doDelete()}>
          ${ts(loc, all ? "delete_all" : "delete_snapshot")}
        </button>
      </div>
    </og-sheet>`;
  }

  private _resetSheet() {
    const loc = this.loc;
    const rooms = this.plan?.rooms ?? [];
    const room = rooms.find((r) => r.id === this._resetRoom);
    return html`<og-sheet .open=${this._reset} heading=${ts(loc, "reset_title")} close-label=${tc(loc, "close")} @closed=${() => (this._reset = false)}>
      <label class="field">
        <span>${ts(loc, "reset_scope")}</span>
        <select
          data-field="reset-room"
          .value=${this._resetRoom}
          @change=${(e: Event) => (this._resetRoom = (e.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${!room}>${ts(loc, "reset_home")}</option>
          ${rooms.map((r) => html`<option value=${r.id} ?selected=${r.id === this._resetRoom}>${r.name}</option>`)}
        </select>
      </label>
      <p>${room ? ts(loc, "reset_text_room", { room: room.name }) : ts(loc, "reset_text_home")}</p>
      <p class="hint">${ts(loc, "reset_keeps")}</p>
      <div slot="actions" class="actions">
        <button class="btn neutral" @click=${() => (this._reset = false)}>${tc(loc, "cancel")}</button>
        <button class="btn danger filled" data-action="reset" ?disabled=${this._busy} @click=${() => void this._doReset()}>
          ${ts(loc, "reset_confirm")}
        </button>
      </div>
    </og-sheet>`;
  }

  private _labels(labels: Record<string, number>) {
    const loc = this.loc;
    const entries = Object.entries(labels).filter(([, n]) => n > 0);
    if (!entries.length) return html`<span class="hint">—</span>`;
    return entries.map(
      ([source, n]) =>
        html`<span class="badge"
          >${(["wizard", "recording", "service", "feedback", "empty_house", "manual_light"] as const).includes(source as "wizard")
            ? ts(loc, `source_${source as "wizard"}`)
            : source}
          · ${fmtNumber(loc, n, 0)}</span
        >`,
    );
  }

  private _modelCard() {
    const loc = this.loc;
    const model = this._model;
    if (!model) return nothing;
    const pending = model.pending;
    const rooms = pending ? [...pending.rooms].sort((a, b) => this._order(a.room) - this._order(b.room)) : [];
    return html`<section class="card" aria-labelledby="model-h">
      <div class="card-head"><h3 class="headline" id="model-h">${ts(loc, "model")}</h3></div>
      <div class="model-top">
        <span class="version">${ts(loc, "version", { n: model.model_version })}</span>
        <span class="badge ${model.learning ? "success" : ""}">${ts(loc, model.learning ? "learning_on" : "learning_off")}</span>
        <span class="hint" style="flex-basis:100%">
          ${ts(loc, "updated", { when: model.updated ? fmtDateTime(loc, model.updated) : ts(loc, "never") })} ·
          ${ts(loc, "empty_hours", { n: fmtNumber(loc, model.empty_house_hours, 1) })}
        </span>
      </div>
      <div class="labels"><span class="hint" style="margin-right:4px">${ts(loc, "labels")}:</span>${this._labels(model.labels)}</div>
      ${pending
        ? html`<div class="pending" role="region" aria-labelledby="pending-h">
            <div>
              <h4 id="pending-h">${ts(loc, "pending")}</h4>
              <span class="hint">${ts(loc, "pending_created", { when: fmtDateTime(loc, pending.created) })} · ${ts(loc, "pending_hint")}</span>
            </div>
            <div class="row wrap"><span class="hint">${ts(loc, "pending_labels")}:</span>${this._labels(pending.labels)}</div>
            <div class="changes">
              <div class="change head"><span></span><span>${ts(loc, "detection")}</span><span>${ts(loc, "false_day")}</span></div>
              ${rooms.map((c) => this._change(c))}
            </div>
            <div class="actions">
              <button class="btn neutral" ?disabled=${this._busy} data-action="discard" @click=${() => void this._apply(pending.pending_id, false)}>
                ${ts(loc, "discard")}
              </button>
              <button class="btn filled" ?disabled=${this._busy} data-action="apply" @click=${() => void this._apply(pending.pending_id, true)}>
                ${ts(loc, "apply")}
              </button>
            </div>
          </div>`
        : html`<p class="muted-box">${ts(loc, "no_pending")}</p>`}
      <details>
        <summary>${ts(loc, "snapshots")} (${this._snapshots.length})</summary>
        ${this._snapshots.length
          ? html`<ul class="snapshots">
              ${[...this._snapshots]
                .sort((a, b) => b.t - a.t)
                .map(
                  (snap) => html`<li>
                    <span class="when">
                      <span>${fmtDateTime(loc, snap.t)} · ${ts(loc, "version", { n: snap.model_version })}</span>
                      <span class="hint">${ts(loc, `reason_${snap.reason}`)}</span>
                    </span>
                    <button class="btn" @click=${() => (this._rollback = snap)}>${icon(mdiBackupRestore, 18)} ${ts(loc, "rollback")}</button>
                    <button
                      class="icon-btn danger"
                      data-delete=${snap.snapshot_id}
                      aria-label=${ts(loc, "delete_snapshot_label", { when: fmtDateTime(loc, snap.t) })}
                      title=${ts(loc, "delete_snapshot")}
                      @click=${() => (this._delete = snap)}
                    >
                      ${icon(mdiDelete, 18)}
                    </button>
                  </li>`,
                )}
            </ul>`
          : html`<p class="muted-box">${ts(loc, "snapshots_none")}</p>`}
        <div class="model-actions">
          ${this._snapshots.length
            ? html`<button class="btn danger" data-action="delete-all" @click=${() => (this._delete = "all")}>
                ${icon(mdiDeleteSweep, 18)} ${ts(loc, "delete_all")}
              </button>`
            : nothing}
          <button class="btn danger" data-action="open-reset" @click=${() => this._openReset()}>${icon(mdiRestore, 18)} ${ts(loc, "reset")}</button>
        </div>
      </details>
    </section>`;
  }

  private _order(room: string): number {
    const i = this.plan?.rooms.findIndex((r) => r.id === room) ?? -1;
    return i < 0 ? 99 : i;
  }

  private _switch(label: string, hint: string | null, checked: boolean, change: (on: boolean) => void) {
    return html`<label class="switch-row">
      <span class="text"><span>${label}</span>${hint ? html`<span class="hint">${hint}</span>` : nothing}</span>
      <span class="switch"><input type="checkbox" .checked=${checked} @change=${(e: Event) => change((e.target as HTMLInputElement).checked)} /><span></span></span>
    </label>`;
  }

  private _globalCard() {
    const loc = this.loc;
    const g = this._draft?.global;
    if (!g) return nothing;
    return html`<section class="card" aria-labelledby="global-h">
      <div class="card-head"><h3 class="headline" id="global-h">${ts(loc, "global")}</h3></div>
      <div class="setting">
        ${this._switch(ts(loc, "sensing"), ts(loc, "sensing_hint"), g.sensing, (on) => this._patchGlobal({ sensing: on }))}
        ${this._switch(ts(loc, "learning"), ts(loc, "learning_hint"), g.learning, (on) => this._patchGlobal({ learning: on }))}
      </div>
      <div class="setting">
        <div class="setting-head"><span class="label">${ts(loc, "mode")}</span></div>
        ${this._radio(ts(loc, "mode"), ["rules", "bayes"] as const, g.mode, (m) => ts(loc, `mode_${m}`), (m) => this._patchGlobal({ mode: m }))}
        <div class="setting-head" style="margin-top:6px"><span class="label">${ts(loc, "tick")}</span></div>
        ${this._radio(ts(loc, "tick"), TICKS, g.tick_s, (v) => ts(loc, "seconds", { n: v }), (v) => this._patchGlobal({ tick_s: v }))}
      </div>
      <div class="setting">
        ${this._switch(ts(loc, "use_persons"), ts(loc, "use_persons_hint"), g.use_persons, (on) => this._patchGlobal({ use_persons: on }))}
        ${this._switch(ts(loc, "others"), ts(loc, "others_hint"), g.others_may_be_home, (on) => this._patchGlobal({ others_may_be_home: on }))}
        ${this._switch(ts(loc, "firmware_channel"), null, g.firmware_channel, (on) => this._patchGlobal({ firmware_channel: on }))}
      </div>
      <div class="setting">
        <div class="setting-head"><span class="label">${ts(loc, "retention")}</span></div>
        <div class="retention">
          ${RETENTION.map(
            (key) => html`<label class="field">
              ${ts(loc, key)}
              <input
                type="number"
                inputmode="numeric"
                min="1"
                .value=${String(g.retention[key])}
                @change=${(e: Event) => {
                  const n = Math.max(1, Math.round(Number((e.target as HTMLInputElement).value) || 1));
                  this._patchGlobal({ retention: { ...g.retention, [key]: n } });
                }}
              />
            </label>`,
          )}
        </div>
      </div>
    </section>`;
  }

  override render() {
    const loc = this.loc;
    const plan = this.plan;
    const id = this._roomId;
    if (!this._draft) {
      return html`<div class="card center" aria-busy="true">${ts(loc, "loading")}</div>`;
    }
    return html`
      <div class="layout">
        <div class="col">
          ${plan && plan.rooms.length
            ? html`<nav class="chips" aria-label=${ts(loc, "rooms")}>
                ${plan.rooms.map(
                  (r) => html`<button class="chip" aria-pressed=${r.id === id} @click=${() => this.navigate(`/settings/${r.id}`)}>
                    <span class="swatch" style="background:${r.colour}"></span>${r.name}
                  </button>`,
                )}
              </nav>`
            : nothing}
          ${id
            ? html`${this._roomCard(id)} ${this._bulbsCard(id)}`
            : html`<div class="card empty-state">${icon(mdiSchool, 40)}<span>${ts(loc, "no_rooms")}</span>
                <button class="btn filled" @click=${() => this.navigate("/plan")}>${tc(loc, "open_plan")}</button></div>`}
        </div>
        <div class="col">${this._modelCard()} ${this._globalCard()}</div>
      </div>
      ${this._dirty
        ? html`<div class="savebar" role="region" aria-label=${ts(loc, "unsaved")}>
            <span>${icon(mdiAlert, 18)} ${ts(loc, "unsaved")}</span>
            <button class="btn neutral" @click=${() => (this._draft = structuredClone(this._saved))}>${tc(loc, "cancel")}</button>
            <button class="btn filled" data-action="save" ?disabled=${this._busy} @click=${() => void this._save()}>${tc(loc, "save")}</button>
          </div>`
        : nothing}
      <og-bulb-write
        .hass=${this.hass}
        .loc=${loc}
        .bulb=${this._write?.bulb ?? null}
        .setting=${this._write?.setting ?? "sensitivity"}
        .value=${null}
        @closed=${() => (this._write = null)}
      ></og-bulb-write>
      <og-sheet .open=${Boolean(this._rollback)} heading=${ts(loc, "rollback_title")} close-label=${tc(loc, "close")} @closed=${() => (this._rollback = null)}>
        ${this._rollback
          ? html`<p>${ts(loc, "rollback_text", { n: this._rollback.model_version, when: fmtDateTime(loc, this._rollback.t) })}</p>`
          : nothing}
        <div slot="actions" class="actions">
          <button class="btn neutral" @click=${() => (this._rollback = null)}>${tc(loc, "cancel")}</button>
          <button class="btn filled" data-action="rollback" ?disabled=${this._busy} @click=${() => void this._doRollback()}>${ts(loc, "rollback")}</button>
        </div>
      </og-sheet>
      ${this._deleteSheet()} ${this._resetSheet()}
    `;
  }
}

if (!customElements.get("outglow-settings-view")) {
  customElements.define("outglow-settings-view", OutglowSettingsView);
}

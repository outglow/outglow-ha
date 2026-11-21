import {
  mdiAlertCircleOutline,
  mdiArrowRight,
  mdiCheck,
  mdiCheckCircle,
  mdiChevronRight,
  mdiCircleSlice8,
  mdiClose,
  mdiDoorOpen,
  mdiFlagCheckered,
  mdiHomeExportOutline,
  mdiHumanHandsdown,
  mdiInformation,
  mdiLightningBolt,
  mdiPause,
  mdiPlay,
  mdiSchool,
  mdiSeat,
  mdiShieldCheck,
  mdiSkipNext,
  mdiVolumeHigh,
  mdiVectorSquare,
  mdiVolumeOff,
  mdiWalk,
} from "@mdi/js";
import { css, html, nothing, svg, type PropertyValues } from "lit";
import type { Frame, Mode, Room, Session, SessionLabelRequest, SessionSummary } from "../api/types";
import { fmtClock, fmtDateTime, fmtDuration, fmtPercent } from "../format";
import { bulbRoom } from "../geometry";
import { strings } from "../i18n";
import { icon } from "../icons";
import "../plan-view";
import type { Layers } from "../plan-view";
import { errorCode, tc } from "../strings/common";
import { shared, tokens } from "../theme";
import {
  EMPTY_MINUTES,
  buildSteps,
  current,
  done,
  entranceOf,
  initialState,
  isTimed,
  progress,
  reduce,
  remaining,
  roomOrder,
  totalSeconds,
  type RunEvent,
  type RunState,
  type WizardStep,
  liveFeedback,
} from "../wizard";
import { ViewBase } from "./base";

export const tw = strings(
  {
    title: "Teach Outglow your home",
    lead: "Walk through your rooms with this phone. Outglow notes what the bulbs see while you stand, walk and sit, and learns from it.",
    duration: "About {n} min",
    checks: "Before you start",
    check_rooms: { one: "{n} room on the plan", other: "{n} rooms on the plan" },
    check_rooms_none: "The plan has no rooms yet",
    check_bulbs: { one: "{n} bulb placed on the plan", other: "{n} bulbs placed on the plan" },
    check_bulbs_few: "Place at least two bulbs on the plan",
    check_sensing: "Motion sensing is on in every bulb",
    check_sensing_off: "Sensing is off in: {names}",
    check_rate: "Activity reports are on",
    check_rate_off: "No activity reports from: {names}",
    fix_plan: "Open plan",
    rooms: "Rooms, in walking order",
    rooms_hint: "The order follows the doors from the entrance. Switch off rooms you want to leave out.",
    entrance: "entrance",
    empty_title: "Start with an empty home",
    empty_hint: "Everyone leaves for a few minutes. This teaches Outglow what quiet looks like.",
    minutes: "{n} min",
    session: "Session",
    name: "Name",
    name_default: "Learning {when}",
    consent: "Raise activity reports to 4/s for this session",
    consent_hint:
      "Writes a Zigbee2MQTT device option on every bulb. It goes back to the previous value when the session ends, or after 30 minutes.",
    proposal: "What you teach is kept as a proposal. Detection does not change until you apply it at the end.",
    start: "Start learning",
    starting: "Starting…",
    nothing_to_do: "Choose at least one room or the empty home step.",
    resumed: "Resumed the running session",
    step_of: "Step {n} of {total}",
    learning: "Learning",
    stop: "Stop the session",
    stop_confirm: "Stop learning now? What you did so far stays as a proposal you can apply or discard.",
    voice_on: "Read steps aloud",
    voice_off: "Stop reading aloud",
    kind_empty: "Empty home",
    kind_still: "Stand still",
    kind_edge: "Along the walls",
    kind_walk: "Walk around",
    kind_sit: "Sit down",
    kind_leave: "Change room",
    kind_go: "Next room",
    do_empty: { one: "Leave home for {n} minute", other: "Leave home for {n} minutes" },
    do_empty_body: "Take your phone. It vibrates when you can come back.",
    do_empty_away: "You left at {time}",
    do_empty_away_body: "Stay out until the phone vibrates. Nobody else should be at home.",
    do_empty_back: "You can come back now",
    do_empty_back_body: "Tap “I'm back” once you are inside.",
    do_go: "Go to",
    do_go_body: "Tap the button when you are inside.",
    do_still: "Stand in the middle and don't move",
    do_still_body: "Still people are nearly invisible to radio. That is what this step teaches.",
    do_edge: "Walk along the walls and past the door",
    do_edge_body: "Go slowly round the room close to the walls and pass the doorway. Rooms get mixed up most near their edges.",
    do_walk: "Walk freely around the room",
    do_walk_body: "Look into the corners, cross the room a few times.",
    do_sit: "Sit where you usually sit",
    do_sit_body: "Stay put until the time is up.",
    do_leave: "Go to",
    do_leave_body: "Walk normally through the door.",
    do_leave_last: "Leave the room",
    do_leave_last_body: "That was the last room. Step out and finish.",
    paused: "Paused",
    left: "left",
    leaving: "I'm leaving",
    back: "I'm back",
    cant: "Can't now",
    cant_last: "Skip it",
    deferred: "to do",
    there: "I'm there",
    pause: "Pause",
    resume: "Resume",
    next: "Next",
    skip_room: "Skip this room",
    finish: "Finish",
    see_you: "I can see you",
    pairs: { one: "{n} pair", other: "{n} pairs" },
    interference: "Interference, hold on a moment",
    no_interference: "No interference",
    say_done: "Time is up.",
    say_back: "You can come back now.",
    stopping: "Finishing the session…",
    summary: "Summary",
    summary_title: "How well Outglow recognises your rooms",
    accuracy: "of your time recognised in the right room",
    before: "Before",
    after: "After",
    matrix: "Where you were → what Outglow would say",
    matrix_hint: "Rows are where you walked, columns what the model would answer. Shares of each row.",
    nowhere: "none",
    you_were: "You were in",
    weak: "Weakly covered: {rooms}",
    weak_hint: "Few pairs of bulbs see these rooms. Quality has suggestions.",
    recommendations: "Recommendations",
    apply: "Apply learning",
    applying: "Applying…",
    discard: "Discard this session",
    discard_confirm: "Discard everything from this session? The model stays as it is.",
    applied: "Learning applied",
    applied_body: "The model is now at version {n}. A snapshot of the previous one is kept in Settings.",
    discarded: "Session discarded",
    discarded_body: "The model did not change.",
    no_summary: "The session ended without a summary.",
    to_live: "Open Live",
    again: "New session",
    toast_applied: "Model updated to version {n}",
    toast_discarded: "Session discarded",
    steps: "Steps",
    upcoming: "Up next",
    done_step: "done",
    no_bulbs: "no bulbs",
    no_bulbs_step: "This room has no bulbs. Only lines crossing it can see you.",
    no_bulbs_rules: "Rules mode never lights it.",
    map: "Live map",
    map_hint: "Lines light up as they react: solid both ways, dashed one way. Your room is outlined.",
    rules_title: "Rules mode does not learn",
    rules_body: "Detection runs in rules mode, so applying this session changes nothing there. In bayes mode the same walks score {before} now and {after} after learning, checked within this same session, so optimistic.",
    rules_body_flat: "Detection runs in rules mode, so applying this session changes nothing there. Bayes mode would not do clearly better here: {before} now, {after} after learning, checked within this same session.",
    switch_apply: "Switch to bayes and apply",
    apply_rules: "Apply and stay in rules mode",
    cv_hint: "After learning is checked on the half of each walk the model did not learn from. It is still this same session, so the score is optimistic. Two rooms with the same answer count as no room.",
    rules_same: "Rules mode does not use the learned model, so before and after are the same. Two rooms lit at once count as no room.",
    empty_unknown: "False alarms in an empty home are unknown",
    empty_none: "Bayes has not seen your home empty yet. The score above only says whether it finds the room you are in, not how often it switches lights on when nobody is home. Before switching, run the wizard again with the empty home step, or leave learning on while everyone is out for at least {hours} h.",
    empty_some: "Bayes has seen your home empty for only {minutes} min. The score above only says whether it finds the room you are in, not how often it switches lights on when nobody is home. Before switching, run the wizard again with the empty home step, or leave learning on while everyone is out for at least {hours} h.",
    mode_rules: "Rules",
    mode_bayes: "Bayes",
    homeless: "No bulbs in: {rooms}",
    homeless_hint: "Only lines crossing these rooms can see them. Rules mode never lights them; a bulb inside helps most.",
    room_map: "Share recognised per room",
    room_map_none: "not walked",
    toast_switched: "Detection now runs in bayes mode",
    applied_bayes_body: "The model is now at version {n} and detection runs in bayes mode. A snapshot of the previous model is kept in Settings.",
  },
  {
    title: "Naucz Outglow swojego domu",
    lead: "Przejdź z tym telefonem po pokojach. Outglow zapisze, co widzą żarówki, kiedy stoisz, chodzisz i siedzisz, i nauczy się tego.",
    duration: "Około {n} min",
    checks: "Zanim zaczniesz",
    check_rooms: { one: "{n} pokój na planie", few: "{n} pokoje na planie", many: "{n} pokojów na planie", other: "{n} pokoju na planie" },
    check_rooms_none: "Plan nie ma jeszcze pokojów",
    check_bulbs: {
      one: "{n} żarówka na planie",
      few: "{n} żarówki na planie",
      many: "{n} żarówek na planie",
      other: "{n} żarówki na planie",
    },
    check_bulbs_few: "Umieść na planie co najmniej dwie żarówki",
    check_sensing: "Wykrywanie ruchu włączone we wszystkich żarówkach",
    check_sensing_off: "Wykrywanie wyłączone w: {names}",
    check_rate: "Raporty aktywności włączone",
    check_rate_off: "Brak raportów aktywności z: {names}",
    fix_plan: "Otwórz plan",
    rooms: "Pokoje w kolejności przejścia",
    rooms_hint: "Kolejność wynika z drzwi od wejścia. Wyłącz pokoje, które chcesz pominąć.",
    entrance: "wejście",
    empty_title: "Zacznij od pustego domu",
    empty_hint: "Wszyscy wychodzą na kilka minut. Dzięki temu Outglow wie, jak wygląda cisza.",
    minutes: "{n} min",
    session: "Sesja",
    name: "Nazwa",
    name_default: "Nauka {when}",
    consent: "Podnieś raporty aktywności do 4/s na czas sesji",
    consent_hint:
      "Zapisuje opcję urządzenia Zigbee2MQTT w każdej żarówce. Wróci do poprzedniej wartości po zakończeniu sesji albo po 30 minutach.",
    proposal: "To, czego nauczysz, zostaje propozycją. Wykrywanie zmieni się dopiero, gdy na końcu ją zastosujesz.",
    start: "Zacznij naukę",
    starting: "Uruchamianie…",
    nothing_to_do: "Wybierz co najmniej jeden pokój albo krok z pustym domem.",
    resumed: "Wznowiono trwającą sesję",
    step_of: "Krok {n} z {total}",
    learning: "Nauka",
    stop: "Zakończ sesję",
    stop_confirm: "Zakończyć naukę teraz? To, co już zrobione, zostanie propozycją do zastosowania albo odrzucenia.",
    voice_on: "Czytaj kroki na głos",
    voice_off: "Nie czytaj na głos",
    kind_empty: "Pusto",
    kind_still: "Stój",
    kind_edge: "Wzdłuż ścian",
    kind_walk: "Chodź",
    kind_sit: "Usiądź",
    kind_leave: "Zmiana pokoju",
    kind_go: "Następny pokój",
    do_empty: {
      one: "Wyjdź z domu na {n} minutę",
      few: "Wyjdź z domu na {n} minuty",
      many: "Wyjdź z domu na {n} minut",
      other: "Wyjdź z domu na {n} minuty",
    },
    do_empty_body: "Weź telefon. Zawibruje, kiedy można wracać.",
    do_empty_away: "Wyszedłeś o {time}",
    do_empty_away_body: "Zostań na zewnątrz, aż telefon zawibruje. W domu nie powinno być nikogo.",
    do_empty_back: "Możesz już wracać",
    do_empty_back_body: "Stuknij „Wróciłem”, kiedy będziesz w środku.",
    do_go: "Idź do pokoju",
    do_go_body: "Stuknij przycisk, kiedy będziesz w środku.",
    do_still: "Stań na środku i się nie ruszaj",
    do_still_body: "Nieruchomy człowiek jest dla radia prawie niewidoczny. Tego uczy ten krok.",
    do_edge: "Przejdź wzdłuż ścian i obok drzwi",
    do_edge_body: "Idź powoli dookoła pokoju przy ścianach i przejdź koło drzwi. Pokoje mylą się najczęściej przy swoich brzegach.",
    do_walk: "Chodź swobodnie po pokoju",
    do_walk_body: "Zajrzyj w kąty, przejdź kilka razy przez pokój.",
    do_sit: "Usiądź tam, gdzie zwykle siadasz",
    do_sit_body: "Posiedź spokojnie do końca odliczania.",
    do_leave: "Przejdź do pokoju",
    do_leave_body: "Idź normalnie, przez drzwi.",
    do_leave_last: "Wyjdź z pokoju",
    do_leave_last_body: "To był ostatni pokój. Wyjdź i zakończ.",
    paused: "Pauza",
    left: "zostało",
    leaving: "Wychodzę",
    back: "Wróciłem",
    cant: "Nie mogę teraz",
    cant_last: "Pomiń",
    deferred: "do zrobienia",
    there: "Jestem na miejscu",
    pause: "Pauza",
    resume: "Wznów",
    next: "Dalej",
    skip_room: "Pomiń ten pokój",
    finish: "Zakończ",
    see_you: "Widzę cię",
    pairs: { one: "{n} para", few: "{n} pary", many: "{n} par", other: "{n} pary" },
    interference: "Zakłócenia, chwilę poczekaj",
    no_interference: "Zakłócenia: brak",
    say_done: "Koniec czasu.",
    say_back: "Możesz już wracać.",
    stopping: "Kończenie sesji…",
    summary: "Podsumowanie",
    summary_title: "Jak dobrze Outglow rozpoznaje pokoje",
    accuracy: "czasu rozpoznane we właściwym pokoju",
    before: "Przed",
    after: "Po",
    matrix: "Gdzie byłeś → co powiedziałby Outglow",
    matrix_hint: "Wiersze to miejsca, po których chodziłeś, kolumny to odpowiedź modelu. Udziały w każdym wierszu.",
    nowhere: "brak",
    you_were: "Byłeś w",
    weak: "Słabo pokryte: {rooms}",
    weak_hint: "Te pokoje widzi niewiele par żarówek. W Jakości są podpowiedzi.",
    recommendations: "Rekomendacje",
    apply: "Zastosuj naukę",
    applying: "Stosowanie…",
    discard: "Odrzuć tę sesję",
    discard_confirm: "Odrzucić wszystko z tej sesji? Model zostanie bez zmian.",
    applied: "Nauka zastosowana",
    applied_body: "Model ma teraz wersję {n}. Migawka poprzedniej jest w Ustawieniach.",
    discarded: "Sesja odrzucona",
    discarded_body: "Model się nie zmienił.",
    no_summary: "Sesja skończyła się bez podsumowania.",
    to_live: "Otwórz Na żywo",
    again: "Nowa sesja",
    toast_applied: "Model zaktualizowany do wersji {n}",
    toast_discarded: "Sesja odrzucona",
    steps: "Kroki",
    upcoming: "Dalej",
    done_step: "zrobione",
    no_bulbs: "bez żarówek",
    no_bulbs_step: "Ten pokój nie ma żarówek. Widzą cię tylko linie przechodzące przez niego.",
    no_bulbs_rules: "Tryb reguł nigdy go nie zapala.",
    map: "Mapa na żywo",
    map_hint: "Linie świecą, gdy reagują: pełna w obie strony, przerywana w jedną. Twój pokój jest obrysowany.",
    rules_title: "Tryb reguł się nie uczy",
    rules_body: "Wykrywanie działa w trybie reguł, więc zastosowanie tej sesji nic w nim nie zmieni. W trybie bayes te same przejścia dają {before} teraz i {after} po nauce, sprawdzone w tej samej sesji, więc optymistycznie.",
    rules_body_flat: "Wykrywanie działa w trybie reguł, więc zastosowanie tej sesji nic w nim nie zmieni. Tryb bayes nie byłby tu wyraźnie lepszy: {before} teraz, {after} po nauce, sprawdzone w tej samej sesji.",
    switch_apply: "Przełącz na bayes i zastosuj",
    apply_rules: "Zastosuj i zostań przy regułach",
    cv_hint: "Wynik po nauce jest sprawdzany na tej połowie każdego chodzenia, z której model się nie uczył. To wciąż ta sama sesja, więc wynik jest optymistyczny. Dwa pokoje z tą samą odpowiedzią liczą się jako żaden.",
    rules_same: "Tryb reguł nie korzysta z nauczonego modelu, więc przed i po wychodzi to samo. Dwa pokoje zapalone naraz liczą się jako żaden.",
    empty_unknown: "Fałszywe alarmy w pustym domu są nieznane",
    empty_none: "Bayes nie widział jeszcze pustego domu. Wynik wyżej mówi tylko, czy rozpozna pokój, w którym jesteś, a nie jak często zapali światło, gdy nikogo nie ma. Przed przełączeniem przejdź kreator jeszcze raz z krokiem „Pusto” albo zostaw włączoną naukę, gdy wszyscy wyjdą, na co najmniej {hours} h.",
    empty_some: "Bayes widział pusty dom dopiero przez {minutes} min. Wynik wyżej mówi tylko, czy rozpozna pokój, w którym jesteś, a nie jak często zapali światło, gdy nikogo nie ma. Przed przełączeniem przejdź kreator jeszcze raz z krokiem „Pusto” albo zostaw włączoną naukę, gdy wszyscy wyjdą, na co najmniej {hours} h.",
    mode_rules: "Reguły",
    mode_bayes: "Bayes",
    homeless: "Bez żarówek: {rooms}",
    homeless_hint: "Te pokoje widzą tylko linie, które przez nie przechodzą. Tryb reguł nigdy ich nie zapala; najwięcej da żarówka w środku.",
    room_map: "Trafność w każdym pokoju",
    room_map_none: "bez chodzenia",
    toast_switched: "Wykrywanie działa teraz w trybie bayes",
    applied_bayes_body: "Model ma teraz wersję {n}, a wykrywanie działa w trybie bayes. Migawka poprzedniego modelu jest w Ustawieniach.",
  },
);

type Phase = "loading" | "check" | "run" | "stopping" | "summary" | "finished";

const VOICE_KEY = "outglow.learn.voice";
const EMPTY_KNOWN_H = 2;
const MAP_LAYERS: Layers = { lines: true, trail: false, heat: true, bulbNames: false };
const RUN_KEY = "outglow.learn.run.";
const POLL_MS = 1500;
const TICK_MS = 250;
const MAP_REFRESH_MS = 1000;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function vibrate(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    return;
  }
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const KIND_ICON: Record<WizardStep["kind"], string> = {
  empty: mdiHomeExportOutline,
  still: mdiHumanHandsdown,
  edge: mdiVectorSquare,
  walk: mdiWalk,
  sit: mdiSeat,
  leave: mdiDoorOpen,
};

interface Score {
  mode: Mode;
  matrix_before: number[][];
  matrix_after: number[][];
  accuracy_before: number | null;
  accuracy_after: number | null;
}

function pick(s: Omit<Score, "mode">): Omit<Score, "mode"> {
  return { matrix_before: s.matrix_before, matrix_after: s.matrix_after, accuracy_before: s.accuracy_before, accuracy_after: s.accuracy_after };
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export class OutglowLearnView extends ViewBase {
  static override properties = {
    ...ViewBase.properties,
    _phase: { state: true },
    _session: { state: true },
    _run: { state: true },
    _now: { state: true },
    _rooms: { state: true },
    _off: { state: true },
    _empty: { state: true },
    _minutes: { state: true },
    _name: { state: true },
    _consent: { state: true },
    _voice: { state: true },
    _busy: { state: true },
    _matrix: { state: true },
    _scored: { state: true },
    _mode: { state: true },
    _result: { state: true },
    _announce: { state: true },
  };

  declare _phase: Phase;
  declare _session: Session | null;
  declare _run: RunState | null;
  declare _now: number;
  declare _rooms: string[];
  declare _off: string[];
  declare _empty: boolean;
  declare _minutes: number;
  declare _name: string;
  declare _consent: boolean;
  declare _voice: boolean;
  declare _busy: boolean;
  declare _matrix: "before" | "after";
  declare _scored: Mode | null;
  declare _mode: Mode | null;
  declare _result: { kind: "applied"; version: number; mode: Mode | null } | { kind: "discarded" } | null;
  declare _announce: string;

  private _ticker: ReturnType<typeof setInterval> | undefined;
  private _poller: ReturnType<typeof setInterval> | undefined;
  private _wake: WakeLockSentinelLike | null = null;
  private _queue: Promise<void> = Promise.resolve();
  private _notifiedEmpty = false;
  private _mapFrame: Frame | null = null;
  private _mapAt = -Infinity;
  private _mapNames: { bulbs: unknown; names: Record<string, string> } | null = null;
  private _advancing = false;
  private _loaded = false;
  private _visible = (): void => {
    if (!document.hidden && this._phase === "run") void this._lock();
  };

  constructor() {
    super();
    this._phase = "loading";
    this._session = null;
    this._run = null;
    this._now = Date.now();
    this._rooms = [];
    this._off = [];
    this._empty = true;
    this._minutes = 10;
    this._name = "";
    this._consent = false;
    this._voice = storageGet(VOICE_KEY) === "1";
    this._busy = false;
    this._matrix = "after";
    this._scored = null;
    this._mode = null;
    this._result = null;
    this._announce = "";
  }

  static override styles = [
    tokens,
    shared,
    css`
      :host {
        display: block;
      }
      .wrap {
        max-width: 680px;
        margin: 0 auto;
        display: grid;
        gap: 16px;
      }
      .wrap > *,
      .cols > *,
      .col > * {
        min-width: 0;
      }
      .wrap.wide {
        max-width: 1000px;
      }
      .cols,
      .col {
        display: grid;
        gap: 16px;
        align-content: start;
      }
      @media (min-width: 1100px) {
        .wrap.setup {
          max-width: 1040px;
        }
        .cols {
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          align-items: start;
        }
        .cols > .col:last-child {
          position: sticky;
          top: 72px;
        }
      }
      @media (min-width: 1024px) {
        .run-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 300px;
          gap: 16px;
          align-items: start;
        }
      }
      .run-layout .steps-card {
        display: none;
      }
      @media (min-width: 1024px) {
        .run-layout .steps-card {
          display: block;
        }
      }
      .hero {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 16px;
        align-items: start;
        padding: 20px;
      }
      .hero-icon {
        display: grid;
        place-items: center;
        width: 56px;
        height: 56px;
        border-radius: 16px;
        background: var(--og-primary-tint);
        color: var(--og-primary);
      }
      .hero h2 {
        font-size: 22px;
        line-height: 28px;
        font-weight: 500;
        margin-bottom: 6px;
      }
      .hero p {
        color: var(--og-fg2);
        font-size: 15px;
        line-height: 22px;
      }
      .hero .badge {
        margin-top: 10px;
      }
      section.card > .headline {
        padding: 16px 16px 4px;
      }
      .section-hint {
        padding: 0 16px 8px;
        color: var(--og-fg2);
        font-size: 13px;
        line-height: 18px;
      }
      .checks {
        list-style: none;
        margin: 0;
        padding: 4px 16px 12px;
        display: grid;
        gap: 2px;
      }
      .checks li {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 40px;
        font-size: 15px;
      }
      .checks .ok {
        color: var(--og-success);
      }
      .checks .warn {
        color: var(--og-warning);
      }
      .checks .btn {
        margin-left: auto;
      }
      .room-list {
        list-style: none;
        margin: 0;
        padding: 0 8px 8px;
      }
      .room-list label {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 56px;
        padding: 0 8px;
        border-radius: 10px;
        cursor: pointer;
      }
      .room-list label:hover {
        background: var(--og-tint);
      }
      .order {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        flex: none;
        font-variant-numeric: tabular-nums;
        text-shadow: 0 0 2px rgba(0, 0, 0, 0.35);
      }
      .order.off {
        background: var(--og-tint-strong) !important;
        color: var(--og-fg2);
        text-shadow: none;
      }
      .room-list .name {
        flex: 1;
        min-width: 0;
        font-size: 15px;
        font-weight: 500;
      }
      .room-list .off-name {
        color: var(--og-fg2);
        text-decoration: line-through;
      }
      .option {
        display: flex;
        gap: 16px;
        align-items: flex-start;
        padding: 12px 16px;
      }
      .option .grow p {
        color: var(--og-fg2);
        font-size: 13px;
        line-height: 18px;
        margin-top: 2px;
      }
      .option .switch {
        margin-top: 2px;
      }
      .minutes {
        padding: 0 16px 16px;
      }
      .fields,
      .fields label.field {
        grid-template-columns: minmax(0, 1fr);
      }
      .fields {
        display: grid;
        gap: 8px;
        padding: 8px 16px 16px;
      }
      .check span small {
        display: block;
        color: var(--og-fg2);
        font-size: 13px;
        line-height: 18px;
        margin-top: 2px;
      }
      .start-bar {
        display: grid;
        gap: 12px;
        padding: 16px;
      }
      .start-bar .btn {
        width: 100%;
      }
      .run {
        display: flex;
        flex-direction: column;
        min-height: min(760px, calc(100vh - 160px));
        overflow: hidden;
      }
      .run-head {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 8px 4px 0 16px;
        min-height: 52px;
      }
      .run-head .eyebrow {
        flex: 1;
      }
      .progress {
        height: 4px;
        border-radius: 0;
        margin: 0 16px;
        border-radius: 2px;
      }
      .stage {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 10px;
        padding: 20px 20px 12px;
      }
      .kicker {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 14px 6px 10px;
        border-radius: 18px;
        background: var(--og-tint);
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--og-fg2);
      }
      .kicker.deferred {
        background: color-mix(in srgb, var(--og-warning) 16%, transparent);
      }
      .instruction {
        font-size: 22px;
        line-height: 28px;
        font-weight: 400;
        max-width: 22em;
        text-wrap: balance;
      }
      .room-name {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        font-size: clamp(32px, 9vw, 48px);
        line-height: 1.1;
        font-weight: 600;
        letter-spacing: -0.01em;
        overflow-wrap: anywhere;
      }
      .room-name .dot {
        width: 0.42em;
        height: 0.42em;
        border-radius: 50%;
        flex: none;
      }
      .body {
        color: var(--og-fg2);
        font-size: 15px;
        line-height: 22px;
        max-width: 26em;
        text-wrap: pretty;
      }
      .ring {
        position: relative;
        width: min(62vw, 240px);
        aspect-ratio: 1;
        margin: 8px 0 4px;
      }
      .ring svg {
        width: 100%;
        height: 100%;
        transform: rotate(-90deg);
      }
      .ring .track {
        fill: none;
        stroke: var(--og-tint-strong);
      }
      .ring .arc {
        fill: none;
        stroke-linecap: round;
        transition:
          stroke-dashoffset 260ms linear,
          stroke 300ms;
      }
      .ring .centre {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 2px;
      }
      .ring .time {
        font-size: clamp(44px, 14vw, 60px);
        line-height: 1;
        font-weight: 300;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
      }
      .ring .time.idle {
        color: var(--og-fg2);
      }
      .ring .sub {
        font-size: 13px;
        color: var(--og-fg2);
        text-transform: lowercase;
      }
      .ring .big-icon {
        color: var(--og-success);
      }
      .ring.idle .arc {
        stroke-opacity: 0.35;
      }
      .ring.paused .arc {
        stroke: var(--og-fg2) !important;
      }
      .go {
        display: grid;
        place-items: center;
        width: min(46vw, 176px);
        aspect-ratio: 1;
        border-radius: 50%;
        margin: 8px 0;
        color: var(--og-fg);
      }
      .go .icon {
        animation: nudge 1.6s var(--og-ease) infinite;
      }
      @keyframes nudge {
        0%,
        100% {
          transform: translateX(-6px);
        }
        50% {
          transform: translateX(6px);
        }
      }
      .feedback {
        display: grid;
        gap: 8px;
        justify-items: center;
        min-height: 64px;
      }
      .meter {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        font-size: 15px;
        font-weight: 500;
      }
      .cells {
        display: inline-flex;
        gap: 4px;
      }
      .cells span {
        width: 10px;
        height: 22px;
        border-radius: 3px;
        background: var(--og-tint-strong);
        transition:
          background-color 300ms,
          transform 300ms var(--og-ease);
      }
      .cells span.on {
        background: var(--og-motion);
        transform: scaleY(1.05);
      }
      .veto {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--og-fg2);
      }
      .veto.on {
        color: color-mix(in srgb, var(--og-warning) 70%, var(--og-fg));
      }
      .actions {
        display: grid;
        gap: 8px;
        padding: 8px 16px calc(16px + env(safe-area-inset-bottom));
      }
      .actions .pair {
        display: grid;
        grid-template-columns: 1fr 1.4fr;
        gap: 10px;
      }
      .actions .btn.big {
        width: 100%;
      }
      .actions .btn.text {
        justify-self: center;
        color: var(--og-fg2);
      }
      .steps-card ol {
        list-style: none;
        margin: 0;
        padding: 4px 8px 12px;
        display: grid;
        gap: 2px;
      }
      .steps-card li {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 36px;
        padding: 0 8px;
        border-radius: 8px;
        font-size: 14px;
        color: var(--og-fg2);
      }
      .steps-card li.current {
        background: var(--og-primary-tint);
        color: var(--og-fg);
        font-weight: 500;
      }
      .steps-card li.done {
        color: var(--og-fg2);
      }
      .steps-card li .icon {
        flex: none;
      }
      .steps-card li.done .icon {
        color: var(--og-success);
      }
      .steps-card li .swatch {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      .centre-state {
        display: grid;
        gap: 12px;
        justify-items: center;
        text-align: center;
        padding: 48px 24px;
      }
      .centre-state h2 {
        font-size: 22px;
        font-weight: 500;
      }
      .centre-state p {
        color: var(--og-fg2);
        max-width: 28em;
      }
      .centre-state .badge-icon {
        display: grid;
        place-items: center;
        width: 72px;
        height: 72px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--og-success) 16%, transparent);
        color: var(--og-success);
      }
      .centre-state .badge-icon.neutral {
        background: var(--og-tint);
        color: var(--og-fg2);
      }
      .centre-state .row {
        justify-content: center;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .spinner {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 3px solid var(--og-tint-strong);
        border-top-color: var(--og-primary);
        animation: spin 900ms linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .score {
        display: grid;
        grid-template-columns: auto auto auto;
        align-items: center;
        justify-content: center;
        gap: 6px 20px;
        padding: 8px 16px 4px;
        text-align: center;
      }
      .score .value {
        font-size: clamp(36px, 11vw, 52px);
        line-height: 1;
        font-weight: 300;
        font-variant-numeric: tabular-nums;
      }
      .score .value.after {
        font-weight: 500;
        color: var(--og-primary);
      }
      .score .label {
        font-size: 12px;
        color: var(--og-fg2);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .score .arrow {
        color: var(--og-fg2);
        grid-row: 1;
        grid-column: 2;
      }
      .score-caption {
        text-align: center;
        color: var(--og-fg2);
        font-size: 14px;
        padding: 0 16px 8px;
      }
      .matrix-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
        padding: 16px 16px 4px;
      }
      .matrix-head .headline {
        flex: 1 1 200px;
      }
      .matrix-wrap {
        overflow-x: auto;
        padding: 4px 16px 8px;
      }
      table.matrix {
        border-collapse: separate;
        border-spacing: 4px;
        width: 100%;
        table-layout: fixed;
        min-width: calc(96px + var(--cols) * 56px);
      }
      table.matrix th {
        padding: 4px 6px;
        font-size: 12px;
        font-weight: 500;
        color: var(--og-fg2);
        text-align: center;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      table.matrix th.corner {
        width: 96px;
        text-align: left;
      }
      table.matrix th.rowh {
        text-align: left;
        color: var(--og-fg);
        font-size: 14px;
      }
      table.matrix th.rowh > span {
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: 100%;
      }
      table.matrix th.rowh .label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      table.matrix td {
        border: none;
        height: 48px;
        padding: 0;
        border-radius: 8px;
        text-align: center;
        font-size: 14px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        background: var(--og-tint);
        transition: background-color 300ms;
      }
      table.matrix td.zero {
        color: var(--og-fg2);
        font-weight: 400;
      }
      .legend-line {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 16px;
        padding: 0 16px 16px;
        font-size: 12px;
        color: var(--og-fg2);
      }
      .legend-line span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .legend-line i {
        width: 12px;
        height: 12px;
        border-radius: 3px;
      }
      .summary-actions {
        display: grid;
        gap: 8px;
        padding: 16px;
      }
      .summary-actions .btn.big {
        width: 100%;
      }
      .summary-actions .row {
        justify-content: center;
        flex-wrap: wrap;
      }
      .notice .btn {
        margin-top: 4px;
        padding: 0;
        min-height: 32px;
      }
      .live-map,
      .room-map {
        margin: 0;
        width: 100%;
        display: grid;
        gap: 6px;
      }
      .live-map {
        max-width: 520px;
        padding: 6px;
        border-radius: var(--og-radius-s);
        background: var(--og-tint);
      }
      .live-map figcaption,
      .room-map figcaption {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 12px;
        line-height: 16px;
        color: var(--og-fg2);
        text-align: start;
      }
      .room-map {
        margin-bottom: 12px;
        padding: 0 16px;
        box-sizing: border-box;
      }
      .keys {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: none;
      }
      .key {
        display: inline-block;
        width: 18px;
        height: 0;
        border-top: 3px solid var(--og-motion);
      }
      .key.dashed {
        border-top: 2px dashed var(--og-motion);
      }
      .key.here {
        width: 14px;
        height: 10px;
        border: 2px dashed;
        border-radius: 2px;
      }
      .homeless {
        width: 100%;
        max-width: 520px;
        text-align: start;
      }
      .score-note {
        margin: 0 16px;
        padding-bottom: 14px;
        text-align: center;
        font-size: 13px;
        color: var(--og-fg2);
      }
      .mode-switch {
        display: flex;
        justify-content: center;
        padding: 4px 16px 8px;
      }
      @media (max-width: 600px) {
        .run {
          min-height: calc(100vh - 140px);
          min-height: calc(100dvh - 140px);
          border-radius: 20px;
        }
        .stage {
          padding: 12px 16px 8px;
          gap: 8px;
        }
        .instruction {
          font-size: 20px;
          line-height: 26px;
        }
        .stage.with-map .ring {
          width: min(38vw, 148px);
          margin: 0;
        }
        .stage.with-map .ring .time {
          font-size: 34px;
        }
        .stage.with-map .go {
          width: min(28vw, 108px);
          margin: 0;
        }
        .stage.with-map .go .icon {
          width: 56px;
          height: 56px;
        }
        .stage.with-map .room-name {
          font-size: clamp(26px, 8vw, 40px);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .ring .arc {
          transition: none;
        }
        .go .icon,
        .spinner {
          animation: none;
        }
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._visible);
    if (this.hass && !this._loaded) void this._load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._visible);
    this._stopTimers();
    void this._unlock();
  }

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("plan") && this.plan && this._rooms.length === 0) {
      this._rooms = roomOrder(this.plan);
    }
    if (!this._name) {
      this._name = tw(this.loc, "name_default", { when: fmtDateTime(this.loc, Date.now() / 1000) });
    }
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has("hass") && this.hass && !this._loaded) {
      void this._load();
    }
  }

  private async _load(): Promise<void> {
    this._loaded = true;
    void this._readMode();
    try {
      const { session } = await this.call("outglow/session/get", {});
      if (session?.state === "running") {
        this._resume(session);
        return;
      }
      if (session?.state === "stopped" && session.summary?.pending_id) {
        const model = await this.call("outglow/model/get", {});
        if (model.pending?.pending_id === session.summary.pending_id) {
          this._session = session;
          this._phase = "summary";
          return;
        }
      }
      this._phase = "check";
    } catch (err) {
      this.fail(err);
      this._phase = "check";
    }
  }

  private async _readMode(): Promise<void> {
    try {
      this._mode = (await this.call("outglow/settings/get", {})).global.mode;
    } catch {
      this._mode = null;
    }
  }

  private _homeless(): Set<string> {
    const plan = this.plan;
    if (!plan) return new Set();
    const lit = new Set(plan.bulbs.map((b) => bulbRoom(plan, b)));
    return new Set(plan.rooms.filter((r) => !lit.has(r.id)).map((r) => r.id));
  }

  private _resume(session: Session): void {
    this._session = session;
    const saved = storageGet(RUN_KEY + session.session_id);
    let run: RunState | null = null;
    if (saved) {
      try {
        run = JSON.parse(saved) as RunState;
      } catch {
        run = null;
      }
    }
    if (!run && this.plan) {
      const steps = buildSteps({ rooms: roomOrder(this.plan), empty: false, emptyMinutes: this._minutes });
      run = initialState(steps, entranceOf(this.plan), Date.now()).state;
    }
    this._run = run;
    this._phase = "run";
    this._startTimers();
    void this._lock();
    this.toast(tw(this.loc, "resumed"));
  }

  private _persist(): void {
    if (this._session && this._run) {
      storageSet(RUN_KEY + this._session.session_id, JSON.stringify(this._run));
    }
  }

  private _startTimers(): void {
    this._stopTimers();
    this._ticker = setInterval(() => this._tick(), TICK_MS);
    this._poller = setInterval(() => void this._poll(), POLL_MS);
  }

  private _stopTimers(): void {
    clearInterval(this._ticker);
    clearInterval(this._poller);
    this._ticker = undefined;
    this._poller = undefined;
  }

  private async _lock(): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } };
    if (!nav.wakeLock || this._wake) return;
    try {
      this._wake = await nav.wakeLock.request("screen");
      (this._wake as unknown as EventTarget).addEventListener?.("release", () => (this._wake = null));
    } catch {
      this._wake = null;
    }
  }

  private async _unlock(): Promise<void> {
    const wake = this._wake;
    this._wake = null;
    try {
      await wake?.release();
    } catch {
      return;
    }
  }

  private _speak(text: string): void {
    if (!this._voice) return;
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.loc.lang === "pl" ? "pl-PL" : "en-US";
      synth.speak(utterance);
    } catch {
      return;
    }
  }

  private _tick(): void {
    this._now = Date.now();
    const run = this._run;
    if (!run || this._phase !== "run" || this._advancing) return;
    const step = current(run);
    if (!step || !run.started || run.paused) return;
    const left = remaining(run, this._now);
    if (isTimed(step) && left !== null && left <= 0) {
      vibrate([120, 80, 120]);
      this._speak(tw(this.loc, "say_done"));
      void this._dispatch({ type: "next", now: this._now });
    } else if (step.kind === "empty" && left !== null && left <= 0 && !this._notifiedEmpty) {
      this._notifiedEmpty = true;
      vibrate([300, 150, 300, 150, 300]);
      this._speak(tw(this.loc, "say_back"));
      this._announce = tw(this.loc, "do_empty_back");
    }
  }

  private async _poll(): Promise<void> {
    if (this._phase !== "run") return;
    try {
      const { session } = await this.call("outglow/session/get", {});
      if (!session || session.state !== "running") {
        if (this._phase === "run" && !this._busy) {
          this._stopTimers();
          void this._unlock();
          this._session = session;
          this._phase = session?.summary ? "summary" : "check";
        }
        return;
      }
      this._session = session;
    } catch {
      return;
    }
  }

  private _send(labels: SessionLabelRequest[]): Promise<void> {
    const ts = Date.now() / 1000;
    this._queue = this._queue.then(async () => {
      for (const label of labels) {
        try {
          this._session = await this.call("outglow/session/label", { ...label, ts });
        } catch (err) {
          this.fail(err);
          if (errorCode(err) === "no_session") {
            this._stopTimers();
            this._phase = "check";
            return;
          }
        }
      }
    });
    return this._queue;
  }

  private async _dispatch(event: RunEvent): Promise<void> {
    const run = this._run;
    if (!run) return;
    const before = current(run)?.id;
    const result = reduce(run, event);
    this._run = result.state;
    this._persist();
    const after = current(result.state);
    if (after?.id !== before || event.type === "start") {
      this._notifiedEmpty = false;
      if (after && after.id !== before) {
        vibrate([60]);
        this._announceStep(result.state);
      }
    }
    this._advancing = true;
    try {
      await this._send(result.labels);
    } finally {
      this._advancing = false;
    }
    if (done(result.state)) {
      await this._finish();
    }
  }

  private _announceStep(run: RunState): void {
    const step = current(run);
    if (!step) return;
    const { title, room } = this._texts(step, run);
    const text = [title, room].filter(Boolean).join(" ");
    this._announce = text;
    this._speak(text);
  }

  private async _begin(): Promise<void> {
    const plan = this.plan;
    if (!plan) return;
    const rooms = this._rooms.filter((r) => !this._off.includes(r));
    const steps = buildSteps({ rooms, empty: this._empty, emptyMinutes: this._minutes });
    if (steps.length === 0) {
      this.toast(tw(this.loc, "nothing_to_do"), true);
      return;
    }
    this._busy = true;
    try {
      this._session = await this.call("outglow/session/start", {
        name: this._name.trim() || tw(this.loc, "learning"),
        raise_rate: this._consent,
      });
      const start = initialState(steps, entranceOf(plan), Date.now());
      this._run = start.state;
      this._result = null;
      this._phase = "run";
      this._persist();
      this._startTimers();
      void this._lock();
      this._announceStep(start.state);
      await this._send(start.labels);
    } catch (err) {
      this.fail(err);
      if (errorCode(err) === "busy") {
        await this._load();
      }
    } finally {
      this._busy = false;
    }
  }

  private async _finish(): Promise<void> {
    this._stopTimers();
    this._phase = "stopping";
    this._busy = true;
    await this._queue;
    try {
      this._session = await this.call("outglow/session/stop", {});
      storageSet(RUN_KEY + this._session.session_id, null);
      this._phase = "summary";
      this._matrix = "after";
      this._scored = null;
      vibrate([80, 60, 80, 60, 200]);
    } catch (err) {
      this.fail(err);
      this._phase = errorCode(err) === "no_session" ? "check" : "run";
      if (this._phase === "run") this._startTimers();
    } finally {
      this._busy = false;
      void this._unlock();
    }
  }

  private async _cancel(): Promise<void> {
    if (!window.confirm(tw(this.loc, "stop_confirm"))) return;
    await this._finish();
  }

  private async _apply(switchMode = false): Promise<void> {
    const id = this._session?.summary?.pending_id;
    if (!id) return;
    this._busy = true;
    try {
      const result = await this.call("outglow/model/apply", switchMode ? { pending_id: id, mode: "bayes" } : { pending_id: id });
      this._result = { kind: "applied", version: result.model_version, mode: switchMode ? "bayes" : null };
      this.toast(tw(this.loc, "toast_applied", { n: result.model_version }));
      if (switchMode) {
        this._mode = "bayes";
        this.toast(tw(this.loc, "toast_switched"));
      }
      this._phase = "finished";
    } catch (err) {
      this.fail(err);
      if (this._result) this._phase = "finished";
    } finally {
      this._busy = false;
    }
  }

  private async _discard(): Promise<void> {
    const id = this._session?.summary?.pending_id;
    if (!id || !window.confirm(tw(this.loc, "discard_confirm"))) return;
    this._busy = true;
    try {
      await this.call("outglow/model/discard", { pending_id: id });
      this._result = { kind: "discarded" };
      this._phase = "finished";
      this.toast(tw(this.loc, "toast_discarded"));
    } catch (err) {
      this.fail(err);
    } finally {
      this._busy = false;
    }
  }

  private _again(): void {
    this._session = null;
    this._run = null;
    this._result = null;
    this._name = tw(this.loc, "name_default", { when: fmtDateTime(this.loc, Date.now() / 1000) });
    this._phase = "check";
  }

  private _toggleVoice(): void {
    this._voice = !this._voice;
    storageSet(VOICE_KEY, this._voice ? "1" : "0");
    if (!this._voice) {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        return;
      }
    }
  }

  private _room(id: string | null | undefined): Room | undefined {
    return this.plan?.rooms.find((r) => r.id === id);
  }

  override render() {
    switch (this._phase) {
      case "loading":
        return html`<div class="wrap">
          <div class="card centre-state" aria-busy="true">
            <div class="spinner"></div>
            <p>${tc(this.loc, "loading")}</p>
          </div>
        </div>`;
      case "check":
        return this._check();
      case "run":
        return this._running();
      case "stopping":
        return html`<div class="wrap">
          <div class="card centre-state" aria-busy="true">
            <div class="spinner"></div>
            <p>${tw(this.loc, "stopping")}</p>
          </div>
        </div>`;
      case "summary":
        return this._summary();
      case "finished":
        return this._finished();
    }
  }

  private _checks() {
    const loc = this.loc;
    const plan = this.plan;
    const placed = new Set(plan?.bulbs.map((b) => b.ieee) ?? []);
    const bulbs = this.bulbs.filter((b) => placed.has(b.ieee));
    const offSensing = bulbs.filter((b) => !b.sensing).map((b) => b.name);
    const noRate = bulbs.filter((b) => b.sensing && !(b.activity_rate && b.activity_rate > 0)).map((b) => b.name);
    const rooms = plan?.rooms.length ?? 0;
    const rows: { ok: boolean; text: string; fix?: boolean }[] = [
      rooms ? { ok: true, text: tw(loc, "check_rooms", { n: rooms }) } : { ok: false, text: tw(loc, "check_rooms_none"), fix: true },
      placed.size >= 2
        ? { ok: true, text: tw(loc, "check_bulbs", { n: placed.size }) }
        : { ok: false, text: tw(loc, "check_bulbs_few"), fix: true },
      offSensing.length
        ? { ok: false, text: tw(loc, "check_sensing_off", { names: offSensing.join(", ") }) }
        : { ok: true, text: tw(loc, "check_sensing") },
      noRate.length
        ? { ok: false, text: tw(loc, "check_rate_off", { names: noRate.join(", ") }) }
        : { ok: true, text: tw(loc, "check_rate") },
    ];
    return html`<section class="card" aria-labelledby="checks-h">
      <h2 class="headline" id="checks-h">${tw(loc, "checks")}</h2>
      <ul class="checks">
        ${rows.map(
          (row) =>
            html`<li>
              <span class=${row.ok ? "ok" : "warn"}>${icon(row.ok ? mdiCheckCircle : mdiAlertCircleOutline, 22)}</span>
              <span>${row.text}</span>
              ${row.fix ? html`<button class="btn" @click=${() => this.navigate("/plan")}>${tw(loc, "fix_plan")}</button>` : nothing}
            </li>`,
        )}
      </ul>
    </section>`;
  }

  private _check() {
    const loc = this.loc;
    const plan = this.plan;
    const chosen = this._rooms.filter((r) => !this._off.includes(r));
    const steps = buildSteps({ rooms: chosen, empty: this._empty, emptyMinutes: this._minutes });
    const minutes = Math.max(1, Math.round(totalSeconds(steps) / 60));
    const canStart = Boolean(plan && plan.rooms.length && steps.length) && !this._busy;
    const entrance = plan ? entranceOf(plan) : null;
    const homeless = this._homeless();
    let order = 0;
    return html`<div class="wrap setup">
      <div class="card hero">
        <div class="hero-icon">${icon(mdiSchool, 30)}</div>
        <div>
          <h2>${tw(loc, "title")}</h2>
          <p>${tw(loc, "lead")}</p>
          <span class="badge">${tw(loc, "duration", { n: minutes })}</span>
        </div>
      </div>
      <div class="cols">
        <div class="col">
          ${this._checks()}
          ${
            plan && plan.rooms.length
              ? html`<section class="card" aria-labelledby="rooms-h">
                  <h2 class="headline" id="rooms-h">${tw(loc, "rooms")}</h2>
                  <p class="section-hint">${tw(loc, "rooms_hint")}</p>
                  <ul class="room-list">
                    ${this._rooms.map((id) => {
                      const room = this._room(id);
                      if (!room) return nothing;
                      const on = !this._off.includes(id);
                      if (on) order += 1;
                      return html`<li>
                        <label>
                          <span class="order ${on ? "" : "off"}" style="background:${room.colour}">${on ? order : "–"}</span>
                          <span class="name ${on ? "" : "off-name"}">${room.name}</span>
                          ${id === entrance ? html`<span class="badge">${tw(loc, "entrance")}</span>` : nothing}
                          ${homeless.has(id) ? html`<span class="badge warning">${tw(loc, "no_bulbs")}</span>` : nothing}
                          <span class="switch">
                            <input
                              type="checkbox"
                              .checked=${on}
                              aria-label=${room.name}
                              @change=${(e: Event) => {
                                const checked = (e.target as HTMLInputElement).checked;
                                this._off = checked ? this._off.filter((r) => r !== id) : [...this._off, id];
                              }}
                            /><span></span>
                          </span>
                        </label>
                      </li>`;
                    })}
                  </ul>
                </section>`
              : nothing
          }
        </div>
        <div class="col">
          <section class="card" aria-labelledby="empty-h">
            <label class="option">
              <span class="grow">
                <span class="headline" id="empty-h">${tw(loc, "empty_title")}</span>
                <p>${tw(loc, "empty_hint")}</p>
              </span>
              <span class="switch"
                ><input
                  type="checkbox"
                  .checked=${this._empty}
                  @change=${(e: Event) => (this._empty = (e.target as HTMLInputElement).checked)} /><span></span
              ></span>
            </label>
            ${
              this._empty
                ? html`<div class="minutes">
                    <div class="segmented" role="radiogroup" aria-labelledby="empty-h">
                      ${EMPTY_MINUTES.map(
                        (n) =>
                          html`<button role="radio" aria-checked=${this._minutes === n} @click=${() => (this._minutes = n)}>
                            ${tw(loc, "minutes", { n })}
                          </button>`,
                      )}
                    </div>
                  </div>`
                : nothing
            }
          </section>
          <section class="card" aria-labelledby="session-h">
            <h2 class="headline" id="session-h">${tw(loc, "session")}</h2>
            <div class="fields">
              <label class="field"
                >${tw(loc, "name")}
                <input
                  type="text"
                  .value=${this._name}
                  maxlength="60"
                  @input=${(e: Event) => (this._name = (e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  name="raise_rate"
                  .checked=${this._consent}
                  @change=${(e: Event) => (this._consent = (e.target as HTMLInputElement).checked)}
                />
                <span>${tw(loc, "consent")}<small>${tw(loc, "consent_hint")}</small></span>
              </label>
              <div class="notice info">${icon(mdiInformation, 20)}<span>${tw(loc, "proposal")}</span></div>
            </div>
            <div class="start-bar">
              <button class="btn filled big" ?disabled=${!canStart} @click=${() => void this._begin()}>
                ${icon(mdiPlay)} ${this._busy ? tw(loc, "starting") : tw(loc, "start")}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>`;
  }

  private _texts(step: WizardStep, run: RunState): { kind: string; title: string; room: string; body: string; colour: string | null } {
    const loc = this.loc;
    const room = this._room(step.room);
    const next = this._room(step.next);
    const left = remaining(run, this._now);
    switch (step.kind) {
      case "empty":
        if (!run.started) {
          return {
            kind: tw(loc, "kind_empty"),
            title: tw(loc, "do_empty", { n: Math.round(step.seconds / 60) }),
            room: "",
            body: tw(loc, "do_empty_body"),
            colour: null,
          };
        }
        if (left !== null && left <= 0) {
          return {
            kind: tw(loc, "kind_empty"),
            title: tw(loc, "do_empty_back"),
            room: "",
            body: tw(loc, "do_empty_back_body"),
            colour: null,
          };
        }
        return {
          kind: tw(loc, "kind_empty"),
          title: tw(loc, "do_empty_away", { time: fmtClock(loc, (run.startedAt ?? this._now) / 1000, false) }),
          room: "",
          body: tw(loc, "do_empty_away_body"),
          colour: null,
        };
      case "leave":
        return next
          ? {
              kind: tw(loc, "kind_leave"),
              title: tw(loc, "do_leave"),
              room: next.name,
              body: tw(loc, "do_leave_body"),
              colour: next.colour,
            }
          : { kind: tw(loc, "kind_leave"), title: tw(loc, "do_leave_last"), room: "", body: tw(loc, "do_leave_last_body"), colour: null };
      default:
        if (!run.started) {
          return {
            kind: tw(loc, "kind_go"),
            title: tw(loc, "do_go"),
            room: room?.name ?? "",
            body: tw(loc, "do_go_body"),
            colour: room?.colour ?? null,
          };
        }
        return {
          kind: tw(loc, `kind_${step.kind}`),
          title: tw(loc, `do_${step.kind}`),
          room: room?.name ?? "",
          body: tw(loc, `do_${step.kind}_body`),
          colour: room?.colour ?? null,
        };
    }
  }

  private _ring(step: WizardStep, run: RunState, colour: string | null) {
    const loc = this.loc;
    const left = remaining(run, this._now);
    const total = step.seconds;
    const r = 104;
    const c = 2 * Math.PI * r;
    const finished = step.kind === "empty" && run.started && left !== null && left <= 0;
    const fraction = !run.started || left === null ? 1 : Math.max(0, Math.min(1, left / total));
    const stroke = finished ? "var(--og-success)" : (colour ?? "var(--og-primary)");
    const shown = left === null ? total : Math.ceil(left);
    return html`<div class="ring ${run.paused ? "paused" : ""} ${run.started ? "" : "idle"}" aria-hidden="true">
      <svg viewBox="0 0 240 240">
        ${svg`<circle class="track" cx="120" cy="120" r=${r} stroke-width="14"></circle>
        <circle class="arc" cx="120" cy="120" r=${r} stroke-width="14" stroke=${stroke}
          stroke-dasharray=${c} stroke-dashoffset=${(c * (1 - (finished ? 1 : fraction))).toFixed(2)}></circle>`}
      </svg>
      <div class="centre">
        ${
          finished
            ? html`<span class="big-icon">${icon(mdiCheck, 72)}</span>`
            : html`<span class="time ${run.started ? "" : "idle"}">${fmtDuration(shown)}</span>
                <span class="sub">${run.paused ? tw(loc, "paused") : run.started ? tw(loc, "left") : ""}</span>`
        }
      </div>
    </div>`;
  }

  private _feedback() {
    const loc = this.loc;
    const { pairs: n, veto } = liveFeedback(this.frame, this._session?.live_feedback);
    return html`<div class="feedback">
      <div class="meter" role="status" aria-label=${`${tw(loc, "see_you")}: ${tw(loc, "pairs", { n })}`}>
        <span>${tw(loc, "see_you")}</span>
        <span class="cells" aria-hidden="true">${[0, 1, 2, 3, 4].map((i) => html`<span class=${i < n ? "on" : ""}></span>`)}</span>
        <span class="num">${tw(loc, "pairs", { n })}</span>
      </div>
      <span class="veto ${veto ? "on" : ""}"
        >${icon(veto ? mdiLightningBolt : mdiShieldCheck, 16)} ${veto ? tw(loc, "interference") : tw(loc, "no_interference")}</span
      >
    </div>`;
  }

  private _actions(step: WizardStep, run: RunState) {
    const loc = this.loc;
    const now = (): number => Date.now();
    const last = run.index >= run.steps.length - 1;
    if (step.kind === "empty") {
      if (!run.started) {
        return html`<button class="btn filled big" @click=${() => void this._dispatch({ type: "start", now: now() })}>
            ${icon(mdiHomeExportOutline)} ${tw(loc, "leaving")}
          </button>
          <button class="btn text" @click=${() => void this._dispatch({ type: "defer", now: now() })}>
            ${last ? tw(loc, "cant_last") : tw(loc, "cant")}
          </button>`;
      }
      return html`<button class="btn filled big" @click=${() => void this._dispatch({ type: "next", now: now() })}>
        ${icon(mdiCheck)} ${tw(loc, "back")}
      </button>`;
    }
    if (step.kind === "leave") {
      return html`<button class="btn filled big" @click=${() => void this._dispatch({ type: "next", now: now() })}>
        ${icon(step.next ? mdiCheck : mdiFlagCheckered)} ${step.next ? tw(loc, "there") : tw(loc, "finish")}
      </button>`;
    }
    if (!run.started) {
      return html`<button class="btn filled big" @click=${() => void this._dispatch({ type: "start", now: now() })}>
          ${icon(mdiCheck)} ${tw(loc, "there")}
        </button>
        <button class="btn text" @click=${() => void this._dispatch({ type: "skip_room", now: now() })}>${tw(loc, "skip_room")}</button>`;
    }
    return html`<div class="pair">
        <button class="btn tonal big" @click=${() => void this._dispatch({ type: run.paused ? "resume" : "pause", now: now() })}>
          ${icon(run.paused ? mdiPlay : mdiPause)} ${run.paused ? tw(loc, "resume") : tw(loc, "pause")}
        </button>
        <button class="btn filled big" ?disabled=${run.paused} @click=${() => void this._dispatch({ type: "next", now: now() })}>
          ${tw(loc, "next")} ${icon(mdiSkipNext)}
        </button>
      </div>
      <button class="btn text" @click=${() => void this._dispatch({ type: "skip_room", now: now() })}>${tw(loc, "skip_room")}</button>`;
  }

  private _running() {
    const loc = this.loc;
    const run = this._run;
    const step = run ? current(run) : undefined;
    if (!run || !step) {
      return html`<div class="wrap">
        <div class="card centre-state"><div class="spinner"></div></div>
      </div>`;
    }
    const p = progress(run);
    const texts = this._texts(step, run);
    const showRing = step.kind !== "leave";
    const here = step.kind === "leave" ? step.next : step.room;
    const showMap = step.kind !== "empty" && Boolean(this.plan?.rooms.length);
    return html`<div class="wrap wide">
      <div class="run-layout">
        <section class="card run" aria-labelledby="step-h">
          <div class="run-head">
            <span class="eyebrow">${tw(loc, "learning")} · ${tw(loc, "step_of", { n: p.step, total: p.total })}</span>
            <button
              class="icon-btn"
              aria-pressed=${this._voice}
              aria-label=${this._voice ? tw(loc, "voice_off") : tw(loc, "voice_on")}
              @click=${() => this._toggleVoice()}
            >
              ${icon(this._voice ? mdiVolumeHigh : mdiVolumeOff)}
            </button>
            <button class="icon-btn" aria-label=${tw(loc, "stop")} @click=${() => void this._cancel()}>${icon(mdiClose)}</button>
          </div>
          <div
            class="bar progress"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax=${p.total}
            aria-valuenow=${p.step}
            aria-label=${tw(loc, "step_of", { n: p.step, total: p.total })}
          >
            <span style="width:${(p.fraction * 100).toFixed(1)}%"></span>
          </div>
          <div class="stage ${showMap ? "with-map" : ""}">
            <span class="kicker ${step.deferred ? "deferred" : ""}"
              >${icon(!run.started && isTimed(step) ? mdiDoorOpen : KIND_ICON[step.kind], 18)}
              ${texts.kind}${step.deferred ? html` · ${tw(loc, "deferred")}` : nothing}</span
            >
            <h2 class="instruction" id="step-h">${texts.title}</h2>
            ${
              texts.room
                ? html`<div class="room-name">
                    ${texts.colour ? html`<span class="dot" style="background:${texts.colour}"></span>` : nothing}${texts.room}
                  </div>`
                : nothing
            }
            ${
              showRing
                ? this._ring(step, run, texts.colour)
                : html`<div class="go" style="background:color-mix(in srgb, ${texts.colour ?? "var(--og-fg)"} 16%, transparent)">
                    ${icon(step.next ? mdiArrowRight : mdiFlagCheckered, 80)}
                  </div>`
            }
            ${showMap ? this._liveMap(here) : nothing}
            ${here && this._homeless().has(here) ? this._homelessStep() : nothing}
            <p class="body">${texts.body}</p>
            ${step.kind === "walk" && run.started ? this._feedback() : nothing}
          </div>
          <div class="actions">${this._actions(step, run)}</div>
          <div class="sr-only" aria-live="polite">${this._announce}</div>
        </section>
        ${this._stepList(run)}
      </div>
    </div>`;
  }

  private _mapFrameNow(): Frame | null {
    const now = Date.now();
    if (this.frame !== this._mapFrame && now - this._mapAt >= MAP_REFRESH_MS) {
      this._mapFrame = this.frame;
      this._mapAt = now;
    }
    return this._mapFrame;
  }

  private _stableNames(): Record<string, string> {
    if (this._mapNames?.bulbs !== this.bulbs) this._mapNames = { bulbs: this.bulbs, names: this.names() };
    return this._mapNames.names;
  }

  private _liveMap(here: string | null) {
    const loc = this.loc;
    const room = this._room(here);
    return html`<figure class="live-map">
      <outglow-plan-view
        .plan=${this.plan}
        .frame=${this._mapFrameNow()}
        .names=${this._stableNames()}
        .loc=${loc}
        .layers=${MAP_LAYERS}
        .highlight=${here}
        .dark=${this.dark}
        hide-predictions
        calm
        aria-label=${tw(loc, "map")}
        max-height=${this.narrow ? "200px" : "240px"}
      ></outglow-plan-view>
      <figcaption>
        <span class="keys" aria-hidden="true">
          <span class="key solid"></span><span class="key dashed"></span>${room ? html`<span class="key here" style="border-color:${room.colour}"></span>` : nothing}
        </span>
        <span>${tw(loc, "map_hint")}</span>
      </figcaption>
    </figure>`;
  }

  private _homelessStep() {
    const loc = this.loc;
    const rules = this._mode === "rules" ? ` ${tw(loc, "no_bulbs_rules")}` : "";
    return html`<div class="notice warning homeless" role="note">
      ${icon(mdiAlertCircleOutline, 20)}<span>${tw(loc, "no_bulbs_step")}${rules}</span>
    </div>`;
  }

  private _stepList(run: RunState) {
    const loc = this.loc;
    return html`<aside class="card steps-card" aria-label=${tw(loc, "steps")}>
      <div class="card-head"><h2 class="headline">${tw(loc, "steps")}</h2></div>
      <ol>
        ${run.steps.map((step, i) => {
          const room = this._room(step.kind === "leave" ? step.next : step.room);
          const state = i < run.index ? "done" : i === run.index ? "current" : "";
          const label =
            step.kind === "empty"
              ? tw(loc, "kind_empty")
              : step.kind === "leave" && !step.next
                ? tw(loc, "do_leave_last")
                : `${tw(loc, `kind_${step.kind}`)} · ${room?.name ?? ""}`;
          return html`<li class=${state} aria-current=${i === run.index ? "step" : "false"}>
            ${state === "done" ? icon(mdiCheck, 18) : state === "current" ? icon(mdiCircleSlice8, 18) : icon(KIND_ICON[step.kind], 18)}
            <span class="grow">${label}</span>
            ${room && step.kind !== "empty" ? html`<span class="swatch" style="background:${room.colour}"></span>` : nothing}
            ${step.deferred ? html`<span class="badge warning">${tw(loc, "deferred")}</span>` : nothing}
          </li>`;
        })}
      </ol>
    </aside>`;
  }

  private _active(summary: SessionSummary): Mode {
    return summary.mode ?? this._mode ?? "rules";
  }

  private _score(summary: SessionSummary): Score {
    const active = this._active(summary);
    const mode = this._scored ?? active;
    const source = mode !== active && summary.bayes ? summary.bayes : summary;
    return { mode: source === summary ? active : "bayes", ...pick(source) };
  }

  private _roomMap(summary: SessionSummary, matrix: number[][]) {
    const loc = this.loc;
    const colours = new Map<string, string>();
    const notes = new Map<string, string>();
    summary.rooms.forEach((id, i) => {
      const row = matrix[i] ?? [];
      const sum = row.reduce((a, b) => a + b, 0);
      if (!sum) {
        notes.set(id, tw(loc, "room_map_none"));
        return;
      }
      const share = (row[i] ?? 0) / sum;
      colours.set(id, `color-mix(in srgb, var(--og-success) ${Math.round(share * 100)}%, var(--og-error))`);
      notes.set(id, fmtPercent(loc, share));
    });
    return html`<figure class="room-map">
      <outglow-plan-view
        .plan=${this.plan}
        .loc=${loc}
        .names=${this.names()}
        .layers=${{ lines: false, trail: false, heat: false, bulbNames: false }}
        .roomColours=${colours}
        .roomNotes=${notes}
        .dark=${this.dark}
        hide-predictions
        aria-label=${tw(loc, "room_map")}
        max-height=${this.narrow ? "220px" : "280px"}
      ></outglow-plan-view>
      <figcaption>${tw(loc, "room_map")}</figcaption>
    </figure>`;
  }

  private _matrixTable(summary: SessionSummary, score: Score) {
    const loc = this.loc;
    const matrix = this._matrix === "before" ? score.matrix_before : score.matrix_after;
    const columns = [...summary.rooms.map((id) => this._room(id)?.name ?? id), tw(loc, "nowhere")];
    return html`<div class="matrix-wrap">
      <table class="matrix" style="--cols:${columns.length}">
        <thead>
          <tr>
            <th class="corner" scope="col"><span class="sr-only">${tw(loc, "you_were")}</span></th>
            ${columns.map((name) => html`<th scope="col" title=${name}>${name}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${summary.rooms.map((id, i) => {
            const row = matrix[i] ?? [];
            const sum = row.reduce((a, b) => a + b, 0);
            const room = this._room(id);
            return html`<tr>
              <th class="rowh" scope="row">
                <span
                  ><span class="swatch" style="background:${room?.colour ?? "var(--og-fg2)"}"></span
                  ><span class="label" title=${room?.name ?? id}>${room?.name ?? id}</span></span
                >
              </th>
              ${columns.map((_, j) => {
                const value = row[j] ?? 0;
                const share = sum ? value / sum : 0;
                const hue = i === j ? "var(--og-success)" : "var(--og-warning)";
                const strength = Math.round(Math.min(1, share) * 62);
                const style = share > 0 ? `background:color-mix(in srgb, ${hue} ${strength}%, var(--og-tint))` : "";
                return html`<td class=${share > 0 ? "" : "zero"} style=${style}>${share > 0 ? fmtPercent(loc, share) : "·"}</td>`;
              })}
            </tr>`;
          })}
        </tbody>
      </table>
    </div>`;
  }

  private _summary() {
    const loc = this.loc;
    const summary = this._session?.summary;
    if (!summary) {
      return html`<div class="wrap">
        <div class="card centre-state">
          <div class="badge-icon neutral">${icon(mdiInformation, 36)}</div>
          <p>${tw(loc, "no_summary")}</p>
          <div class="row"><button class="btn filled" @click=${() => this._again()}>${tw(loc, "again")}</button></div>
        </div>
      </div>`;
    }
    const weak = summary.weak_rooms.map((id) => this.roomName(id));
    const homeless = (summary.rooms_without_bulbs ?? []).map((id) => this.roomName(id));
    const score = this._score(summary);
    const active = this._active(summary);
    const suggest = active === "rules" && summary.suggest_mode === "bayes";
    const bayes = active === "rules" ? (summary.bayes ?? null) : null;
    const emptyHours = summary.empty_house_hours ?? 0;
    const emptyKnown = emptyHours >= EMPTY_KNOWN_H;
    const matrix = this._matrix === "before" ? score.matrix_before : score.matrix_after;
    return html`<div class="wrap">
      <section class="card" aria-labelledby="sum-h">
        <div class="card-head">
          <span class="grow">
            <span class="eyebrow">${tw(loc, "summary")} · ${this._session?.name ?? ""}</span>
            <h2 class="headline" id="sum-h">${tw(loc, "summary_title")}</h2>
          </span>
        </div>
        ${
          bayes
            ? html`<div class="mode-switch">
                <div class="segmented" role="radiogroup" aria-label=${tw(loc, "summary_title")}>
                  ${(["rules", "bayes"] as const).map(
                    (mode) =>
                      html`<button role="radio" aria-checked=${score.mode === mode} @click=${() => (this._scored = mode)}>
                        ${tw(loc, `mode_${mode}`)}
                      </button>`,
                  )}
                </div>
              </div>`
            : nothing
        }
        <div
          class="score"
          role="group"
          aria-label=${`${tw(loc, "before")} ${fmtPercent(loc, score.accuracy_before)}, ${tw(loc, "after")} ${fmtPercent(loc, score.accuracy_after)}`}
        >
          <span class="value num">${fmtPercent(loc, score.accuracy_before)}</span>
          <span class="arrow">${icon(mdiArrowRight, 28)}</span>
          <span class="value after num">${fmtPercent(loc, score.accuracy_after)}</span>
          <span class="label">${tw(loc, "before")}</span>
          <span></span>
          <span class="label">${tw(loc, "after")}</span>
        </div>
        <p class="score-caption">${tw(loc, "accuracy")}</p>
        <p class="score-note">${score.mode === "rules" ? tw(loc, "rules_same") : tw(loc, "cv_hint")}</p>
      </section>
      ${
        bayes
          ? html`<div class="notice ${suggest ? "warning" : "info"} mode-notice" role="note">
              ${icon(suggest ? mdiAlertCircleOutline : mdiInformation, 20)}
              <span>
                <b>${tw(loc, "rules_title")}</b><br />${tw(loc, suggest ? "rules_body" : "rules_body_flat", {
                  before: fmtPercent(loc, bayes.accuracy_before),
                  after: fmtPercent(loc, bayes.accuracy_after),
                })}
              </span>
            </div>`
          : nothing
      }
      ${
        suggest && !emptyKnown
          ? html`<div class="notice warning empty-unknown" role="note">
              ${icon(mdiAlertCircleOutline, 20)}
              <span>
                <b>${tw(loc, "empty_unknown")}</b><br />${tw(loc, emptyHours > 0 ? "empty_some" : "empty_none", {
                  minutes: Math.round(emptyHours * 60),
                  hours: EMPTY_KNOWN_H,
                })}
              </span>
            </div>`
          : nothing
      }
      <section class="card" aria-labelledby="matrix-h">
        <div class="matrix-head">
          <h2 class="headline" id="matrix-h">${tw(loc, "matrix")}</h2>
          <div class="segmented" role="radiogroup" aria-labelledby="matrix-h">
            <button role="radio" aria-checked=${this._matrix === "before"} @click=${() => (this._matrix = "before")}>
              ${tw(loc, "before")}
            </button>
            <button role="radio" aria-checked=${this._matrix === "after"} @click=${() => (this._matrix = "after")}>
              ${tw(loc, "after")}
            </button>
          </div>
        </div>
        <p class="section-hint">${tw(loc, "matrix_hint")}</p>
        ${this.plan ? this._roomMap(summary, matrix) : nothing}
        ${this._matrixTable(summary, score)}
      </section>
      ${
        homeless.length
          ? html`<div class="notice warning homeless" role="note">
              ${icon(mdiAlertCircleOutline, 20)}
              <span><b>${tw(loc, "homeless", { rooms: homeless.join(", ") })}</b><br />${tw(loc, "homeless_hint")}</span>
            </div>`
          : nothing
      }
      ${
        weak.length
          ? html`<div class="notice warning">
              ${icon(mdiAlertCircleOutline, 20)}
              <span>
                <b>${tw(loc, "weak", { rooms: weak.join(", ") })}</b><br />${tw(loc, "weak_hint")}<br />
                <button class="btn" @click=${() => this.navigate("/quality")}>
                  ${tw(loc, "recommendations")} ${icon(mdiChevronRight, 18)}
                </button>
              </span>
            </div>`
          : nothing
      }
      <section class="card">
        <div class="summary-actions">
          <div class="notice info">${icon(mdiInformation, 20)}<span>${tw(loc, "proposal")}</span></div>
          ${
            suggest
              ? html`<button
                    class="btn ${emptyKnown ? "filled" : "tonal"} big"
                    ?disabled=${this._busy || !summary.pending_id}
                    @click=${() => void this._apply(true)}
                  >
                    ${emptyKnown ? icon(mdiCheck) : nothing} ${this._busy ? tw(loc, "applying") : tw(loc, "switch_apply")}
                  </button>
                  <button
                    class="btn ${emptyKnown ? "tonal" : "filled"} big"
                    ?disabled=${this._busy || !summary.pending_id}
                    @click=${() => void this._apply()}
                  >
                    ${emptyKnown ? nothing : icon(mdiCheck)} ${tw(loc, "apply_rules")}
                  </button>`
              : html`<button class="btn filled big" ?disabled=${this._busy || !summary.pending_id} @click=${() => void this._apply()}>
                  ${icon(mdiCheck)} ${this._busy ? tw(loc, "applying") : tw(loc, "apply")}
                </button>`
          }
          <div class="row">
            <button class="btn danger" ?disabled=${this._busy || !summary.pending_id} @click=${() => void this._discard()}>
              ${tw(loc, "discard")}
            </button>
          </div>
        </div>
      </section>
    </div>`;
  }

  private _finished() {
    const loc = this.loc;
    const result = this._result;
    const applied = result?.kind === "applied";
    return html`<div class="wrap">
      <div class="card centre-state" role="status">
        <div class="badge-icon ${applied ? "" : "neutral"}">${icon(applied ? mdiCheckCircle : mdiInformation, 40)}</div>
        <h2>${applied ? tw(loc, "applied") : tw(loc, "discarded")}</h2>
        <p>
          ${
            result?.kind === "applied"
              ? tw(loc, result.mode === "bayes" ? "applied_bayes_body" : "applied_body", { n: result.version })
              : tw(loc, "discarded_body")
          }
        </p>
        <div class="row">
          <button class="btn filled" @click=${() => this.navigate("/live")}>${tw(loc, "to_live")}</button>
          <button class="btn outlined" @click=${() => this._again()}>${tw(loc, "again")}</button>
        </div>
      </div>
    </div>`;
  }
}

if (!customElements.get("outglow-learn-view")) {
  customElements.define("outglow-learn-view", OutglowLearnView);
}

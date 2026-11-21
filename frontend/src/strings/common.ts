import type { ErrorCode, Status } from "../api/types";
import { strings, type Lang, type Loc } from "../i18n";

export const tc = strings(
  {
    app: "Outglow",
    live: "Live",
    plan: "Plan",
    learn: "Learning",
    quality: "Quality",
    settings: "Settings",
    history: "History",
    menu: "Menu",
    help: "Help",
    bulbs_online: { one: "{n}/{total} bulb", other: "{n}/{total} bulbs" },
    status_learning: "Learning",
    status_ready: "Ready",
    status_degraded: "Degraded",
    status_paused: "Paused",
    loading: "Loading…",
    retry: "Try again",
    save: "Save",
    saving: "Saving…",
    saved: "Saved",
    cancel: "Cancel",
    close: "Close",
    apply: "Apply",
    discard: "Discard",
    back: "Back",
    next: "Next",
    done: "Done",
    delete: "Delete",
    edit: "Edit",
    more: "More",
    unknown: "unknown",
    none: "none",
    unsaved: "You have unsaved changes in the plan. Leave without saving?",
    error: "Could not reach Outglow",
    error_rev_conflict: "The plan was changed in another window. Reload it and apply your changes again.",
    error_not_found: "Not found; it may have just changed.",
    error_invalid_format: "This file could not be read.",
    error_token_expired: "The confirmation expired. Confirm again.",
    error_token_mismatch: "The confirmation was for a different change.",
    error_unauthorized: "Only administrators can do this.",
    error_busy: "Something else is running right now.",
    error_unsupported: "Not supported yet.",
    error_no_session: "No learning session is running.",
    error_fetch_failed: "Could not reach the device.",
    error_other: "Something went wrong: {message}",
    ago: "{when}",
    no_plan: "No floor plan yet",
    no_plan_hint: "Draw your rooms and place the bulbs first.",
    open_plan: "Open the plan editor",
    rooms: "Rooms",
  },
  {
    app: "Outglow",
    live: "Na żywo",
    plan: "Plan",
    learn: "Nauka",
    quality: "Jakość",
    settings: "Ustawienia",
    history: "Historia",
    menu: "Menu",
    help: "Pomoc",
    bulbs_online: { one: "{n}/{total} żarówka", few: "{n}/{total} żarówki", many: "{n}/{total} żarówek", other: "{n}/{total} żarówki" },
    status_learning: "Uczy się",
    status_ready: "Gotowe",
    status_degraded: "Ograniczone",
    status_paused: "Wstrzymane",
    loading: "Ładowanie…",
    retry: "Spróbuj ponownie",
    save: "Zapisz",
    saving: "Zapisywanie…",
    saved: "Zapisano",
    cancel: "Anuluj",
    close: "Zamknij",
    apply: "Zastosuj",
    discard: "Odrzuć",
    back: "Wstecz",
    next: "Dalej",
    done: "Gotowe",
    delete: "Usuń",
    edit: "Edytuj",
    more: "Więcej",
    unknown: "nieznane",
    none: "brak",
    unsaved: "Plan ma niezapisane zmiany. Wyjść bez zapisu?",
    error: "Brak połączenia z Outglow",
    error_rev_conflict: "Plan zmieniono w innym oknie. Wczytaj go ponownie i nanieś zmiany jeszcze raz.",
    error_not_found: "Nie znaleziono; mogło się właśnie zmienić.",
    error_invalid_format: "Nie udało się odczytać tego pliku.",
    error_token_expired: "Potwierdzenie wygasło. Potwierdź jeszcze raz.",
    error_token_mismatch: "Potwierdzenie dotyczyło innej zmiany.",
    error_unauthorized: "To może zrobić tylko administrator.",
    error_busy: "Trwa teraz coś innego.",
    error_unsupported: "Jeszcze nieobsługiwane.",
    error_no_session: "Żadna sesja nauki nie trwa.",
    error_fetch_failed: "Nie udało się połączyć z urządzeniem.",
    error_other: "Coś poszło nie tak: {message}",
    ago: "{when}",
    no_plan: "Nie ma jeszcze planu",
    no_plan_hint: "Najpierw narysuj pokoje i rozmieść żarówki.",
    open_plan: "Otwórz edytor planu",
    rooms: "Pokoje",
  },
);

export type CommonKey = Parameters<typeof tc>[1];

export function statusText(loc: Loc | Lang, status: Status): string {
  return tc(loc, `status_${status}`);
}

const ERRORS: ErrorCode[] = ["rev_conflict", "not_found", "invalid_format", "token_expired", "token_mismatch", "unauthorized", "busy", "unsupported", "no_session"];

export function errorCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return null;
}

export function errorText(loc: Loc | Lang, err: unknown): string {
  const code = errorCode(err);
  if (code && (ERRORS as string[]).includes(code)) {
    return tc(loc, `error_${code as ErrorCode}`);
  }
  const message = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
  return tc(loc, "error_other", { message });
}

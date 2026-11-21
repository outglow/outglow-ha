import { asLoc, numberFormat, type Lang, type Loc } from "./i18n";

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

function dateFormat(loc: Loc, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${loc.lang}|${loc.hour12}|${JSON.stringify(options)}`;
  let found = dateFormats.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(loc.lang, loc.hour12 === undefined ? options : { ...options, hour12: loc.hour12 });
    dateFormats.set(key, found);
  }
  return found;
}

export function fmtNumber(where: Loc | Lang, value: number | null | undefined, digits = 1, min = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return numberFormat(asLoc(where).numbers, digits, min).format(value);
}

export function fmtPercent(where: Loc | Lang, value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${numberFormat(asLoc(where).numbers, digits, digits).format(value * 100)} %`;
}

export function fmtClock(where: Loc | Lang, t: number, seconds = true): string {
  const options: Intl.DateTimeFormatOptions = seconds
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
  return dateFormat(asLoc(where), options).format(new Date(t * 1000));
}

export function fmtDay(where: Loc | Lang, t: number): string {
  return dateFormat(asLoc(where), { weekday: "short", day: "numeric", month: "short" }).format(new Date(t * 1000));
}

export function fmtDateTime(where: Loc | Lang, t: number): string {
  return dateFormat(asLoc(where), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(
    new Date(t * 1000),
  );
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

export function fmtAgo(where: Loc | Lang, seconds: number): string {
  const loc = asLoc(where);
  let found = relativeFormats.get(loc.lang);
  if (!found) {
    found = new Intl.RelativeTimeFormat(loc.lang, { numeric: "auto", style: "short" });
    relativeFormats.set(loc.lang, found);
  }
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return found.format(-s, "second");
  if (s < 3600) return found.format(-Math.round(s / 60), "minute");
  if (s < 86400) return found.format(-Math.round(s / 3600), "hour");
  return found.format(-Math.round(s / 86400), "day");
}

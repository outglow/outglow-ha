import type { DirectionFlag, DirectionQuality, PairQuality, Recommendation } from "./api/types";
import { fmtNumber, fmtPercent } from "./format";
import { strings, type Lang, type Loc } from "./i18n";

export const tq = strings(
  {
    rec_skip_direction: "{rx} ← {tx} fires {per_h} times an hour in an empty home, mostly one way (×{asymmetry} against the reverse). Skip this direction.",
    rec_raise_sensitivity: "{bulb} opens its gate only {open} of the time, so Outglow barely hears it. Raise the bulb's sensitivity to {suggested}.",
    rec_weak_coverage: { one: "{room} is covered by only {n} pair. A bulb at the marked spot would add lines through the walls.", other: "{room} is covered by only {n} pairs. A bulb at the marked spot would add lines through the walls." },
    rec_more_empty_house: "Only {hours} h of empty-home data so far. Leave home during a Learning session so the quiet background can be calibrated.",
    rec_frozen_direction: "{rx} ← {tx} is frozen at {signal} dBm: the signal is too weak to change. It is ignored automatically.",
    rec_no_bulbs: { one: "{room} has no bulbs. Only lines crossing it can see motion there, now {n} line.", other: "{room} has no bulbs. Only lines crossing it can see motion there, now {n} lines." },
    rec_no_bulbs_none: "{room} has no bulbs and no line crosses it, so motion there stays invisible. Put a bulb in it or between its neighbours.",
    rec_no_bulbs_rules: "Rules mode never lights it; bayes mode uses the crossing lines.",
    rec_note_raise: "Writing to the bulb clears its calibration.",
    action_skip_direction: "Skip direction",
    action_bulb_write: "Change…",
    action_wizard: "Start Learning",
    action_show_candidates: "Show on map",
    flag_one_sided: "one-sided",
    flag_single_direction: "single direction",
    flag_frozen: "frozen",
    flag_weak: "weak signal",
    flag_excluded: "skipped",
    flag_asymmetric_noisy: "noisy, asymmetric",
    flag_blanked: "blanked after light change",
    flag_vetoed: "vetoed",
  },
  {
    rec_skip_direction: "{rx} ← {tx} zapala się {per_h} razy na godzinę w pustym domu, prawie zawsze w jedną stronę (×{asymmetry} względem odwrotnego). Pomiń ten kierunek.",
    rec_raise_sensitivity: "{bulb} otwiera bramkę tylko przez {open} czasu, więc Outglow prawie jej nie słyszy. Podnieś czułość w żarówce do {suggested}.",
    rec_weak_coverage: {
      one: "{room}: tylko {n} para obejmuje ten pokój. Żarówka w zaznaczonym miejscu dałaby linie przez ściany.",
      few: "{room}: tylko {n} pary obejmują ten pokój. Żarówka w zaznaczonym miejscu dałaby linie przez ściany.",
      many: "{room}: tylko {n} par obejmuje ten pokój. Żarówka w zaznaczonym miejscu dałaby linie przez ściany.",
      other: "{room}: tylko {n} pary obejmują ten pokój. Żarówka w zaznaczonym miejscu dałaby linie przez ściany.",
    },
    rec_more_empty_house: "Na razie tylko {hours} h danych z pustego domu. Wyjdź z domu w trakcie Nauki, żeby skalibrować ciszę w tle.",
    rec_frozen_direction: "{rx} ← {tx} jest zamrożony przy {signal} dBm: sygnał jest za słaby, żeby się zmieniał. Kierunek jest pomijany automatycznie.",
    rec_no_bulbs: {
      one: "{room} nie ma żarówek. Ruch widzą tam tylko linie przechodzące przez pokój, teraz {n} linia.",
      few: "{room} nie ma żarówek. Ruch widzą tam tylko linie przechodzące przez pokój, teraz {n} linie.",
      many: "{room} nie ma żarówek. Ruch widzą tam tylko linie przechodzące przez pokój, teraz {n} linii.",
      other: "{room} nie ma żarówek. Ruch widzą tam tylko linie przechodzące przez pokój, teraz {n} linii.",
    },
    rec_no_bulbs_none: "{room} nie ma żarówek i przez ten pokój nie przechodzi żadna linia, więc ruch jest tam niewidoczny. Postaw w nim żarówkę albo między sąsiednimi pokojami.",
    rec_no_bulbs_rules: "Tryb reguł nigdy nie zapala pokoju bez żarówek; tryb bayes korzysta z przechodzących linii.",
    rec_note_raise: "Zapis do żarówki kasuje jej kalibrację.",
    action_skip_direction: "Pomiń kierunek",
    action_bulb_write: "Zmień…",
    action_wizard: "Zacznij Naukę",
    action_show_candidates: "Pokaż na planie",
    flag_one_sided: "jednostronny",
    flag_single_direction: "jeden kierunek",
    flag_frozen: "zamrożony",
    flag_weak: "słaby sygnał",
    flag_excluded: "pomijany",
    flag_asymmetric_noisy: "zaszumiony, asymetryczny",
    flag_blanked: "wygaszony po zmianie światła",
    flag_vetoed: "zawetowany",
  },
);

export interface Names {
  bulb(ieee: string): string;
  room(id: string): string;
}

export function flagText(loc: Loc | Lang, flag: DirectionFlag): string {
  return tq(loc, `flag_${flag}`);
}

export function recommendationText(loc: Loc | Lang, rec: Recommendation, names: Names): string {
  const n = rec.numbers;
  const rx = rec.rx ? names.bulb(rec.rx) : "—";
  const tx = rec.tx ? names.bulb(rec.tx) : "—";
  switch (rec.kind) {
    case "skip_direction":
      return tq(loc, "rec_skip_direction", { rx, tx, per_h: fmtNumber(loc, n.per_h ?? 0, 0), asymmetry: fmtNumber(loc, n.asymmetry ?? 1, 1) });
    case "raise_sensitivity":
      return tq(loc, "rec_raise_sensitivity", {
        bulb: rec.bulb ? names.bulb(rec.bulb) : "—",
        open: fmtPercent(loc, n.open_frac ?? 0),
        suggested: fmtNumber(loc, n.suggested ?? 0, 0),
      });
    case "weak_coverage":
      return tq(loc, "rec_weak_coverage", { room: rec.room ? names.room(rec.room) : "—", n: Math.round(n.pairs ?? 0) });
    case "more_empty_house":
      return tq(loc, "rec_more_empty_house", { hours: fmtNumber(loc, n.hours ?? 0, 1) });
    case "frozen_direction":
      return tq(loc, "rec_frozen_direction", { rx, tx, signal: fmtNumber(loc, n.signal_dbm ?? 0, 0) });
    case "no_bulbs": {
      const room = rec.room ? names.room(rec.room) : "—";
      const crossing = Math.round(n.crossing ?? 0);
      const text = crossing ? tq(loc, "rec_no_bulbs", { room, n: crossing }) : tq(loc, "rec_no_bulbs_none", { room });
      return n.rules ? `${text} ${tq(loc, "rec_no_bulbs_rules")}` : text;
    }
  }
}

export function actionText(loc: Loc | Lang, rec: Recommendation): string | null {
  if (rec.action === "none") return null;
  return tq(loc, `action_${rec.action}`);
}

export const NOISE_STOPS: [number, [number, number, number]][] = [
  [0, [46, 160, 67]],
  [0.5, [232, 163, 23]],
  [1, [221, 51, 51]],
];

export const NOISE_MAX_PER_H = 300;

export function noiseAt(level: number): number {
  return Math.pow(10, Math.max(0, Math.min(1, level)) * Math.log10(1 + NOISE_MAX_PER_H)) - 1;
}

export function noiseLevel(perH: number): number {
  if (!Number.isFinite(perH) || perH <= 0) return 0;
  return Math.min(1, Math.log10(1 + perH) / Math.log10(1 + NOISE_MAX_PER_H));
}

export function noiseColour(perH: number): string {
  const v = noiseLevel(perH);
  for (let i = 1; i < NOISE_STOPS.length; i += 1) {
    const [t1, c1] = NOISE_STOPS[i]!;
    const [t0, c0] = NOISE_STOPS[i - 1]!;
    if (v <= t1) {
      const k = (v - t0) / (t1 - t0);
      const c = c0.map((x, j) => Math.round(x + (c1[j]! - x) * k));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  const last = NOISE_STOPS[NOISE_STOPS.length - 1]![1];
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`;
}

export function noiseGradient(): string {
  return `linear-gradient(90deg, ${NOISE_STOPS.map(([t, c]) => `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${t * 100}%`).join(", ")})`;
}

export type DirectionSort = "noise" | "signal" | "asymmetry";

export function sortDirections(list: DirectionQuality[], by: DirectionSort): DirectionQuality[] {
  const copy = [...list];
  const nullsLast = (a: number | null, b: number | null, cmp: (x: number, y: number) => number): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return cmp(a, b);
  };
  if (by === "noise") copy.sort((a, b) => b.exceed_per_h - a.exceed_per_h);
  if (by === "signal") copy.sort((a, b) => nullsLast(a.signal_dbm, b.signal_dbm, (x, y) => x - y));
  if (by === "asymmetry") copy.sort((a, b) => nullsLast(a.asymmetry, b.asymmetry, (x, y) => y - x));
  return copy;
}

export function coverageDots(coverage: number, cls: "good" | "weak" | "none"): number {
  if (cls === "none") return 0;
  const dots = Math.max(1, Math.min(5, Math.round(coverage * 1.8)));
  return cls === "weak" ? Math.min(dots, 2) : Math.max(dots, 3);
}

export function pairInformation(pairs: PairQuality[]): Map<string, number> {
  const sums = pairs.map((p) => Object.values(p.information).reduce((a, b) => a + b, 0));
  const max = Math.max(0, ...sums);
  return new Map(pairs.map((p, i) => [`${p.a}|${p.b}`, max > 0 ? sums[i]! / max : 0]));
}

export function pairNoise(directions: DirectionQuality[], a: string, b: string): number | null {
  const both = directions.filter((d) => (d.rx === a && d.tx === b) || (d.rx === b && d.tx === a));
  if (both.length === 0) return null;
  return Math.max(...both.map((d) => d.exceed_per_h));
}

export function overBudget(falsePerDay: number | null, budget: number | undefined): boolean {
  return falsePerDay !== null && budget !== undefined && falsePerDay > budget;
}

const DISMISSED_KEY = "outglow.quality.dismissed";

export function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    return;
  }
}

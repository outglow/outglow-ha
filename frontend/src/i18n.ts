import type { Hass } from "./hass";

export type Lang = "en" | "pl";

export interface Plural {
  one: string;
  few?: string;
  many?: string;
  other: string;
}

export type Entry = string | Plural;

export type Params = Record<string, string | number>;

export interface Loc {
  lang: Lang;
  numbers: string;
  hour12: boolean | undefined;
}

export type Translator<K extends string> = (loc: Loc | Lang, key: K, params?: Params) => string;

const NUMBER_TAGS: Record<string, string> = {
  comma_decimal: "en-US",
  decimal_point: "de-DE",
  space_comma: "fr-FR",
  quote_decimal: "de-CH",
};

export function langOf(hass: Hass | undefined): Lang {
  const tag = hass?.locale?.language ?? hass?.language ?? "en";
  return tag.toLowerCase().split("-")[0] === "pl" ? "pl" : "en";
}

export function locOf(hass: Hass | undefined): Loc {
  const lang = langOf(hass);
  const format = hass?.locale?.number_format;
  const numbers = format && NUMBER_TAGS[format] ? NUMBER_TAGS[format]! : (hass?.locale?.language ?? lang);
  const time = hass?.locale?.time_format;
  return { lang, numbers, hour12: time === "12" ? true : time === "24" ? false : undefined };
}

export function asLoc(loc: Loc | Lang): Loc {
  return typeof loc === "string" ? { lang: loc, numbers: loc, hour12: undefined } : loc;
}

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function rules(lang: Lang): Intl.PluralRules {
  let found = pluralRules.get(lang);
  if (!found) {
    found = new Intl.PluralRules(lang);
    pluralRules.set(lang, found);
  }
  return found;
}

export function numberFormat(tag: string, digits: number, min = 0): Intl.NumberFormat {
  const key = `${tag}|${digits}|${min}`;
  let found = numberFormats.get(key);
  if (!found) {
    found = new Intl.NumberFormat(tag, { maximumFractionDigits: digits, minimumFractionDigits: min });
    numberFormats.set(key, found);
  }
  return found;
}

export function pick(lang: Lang, entry: Entry, n: number | undefined): string {
  if (typeof entry === "string") {
    return entry;
  }
  const form = n === undefined ? "other" : rules(lang).select(n);
  if (form === "one") return entry.one;
  if (form === "few") return entry.few ?? entry.other;
  if (form === "many") return entry.many ?? entry.other;
  return entry.other;
}

export function interpolate(loc: Loc, text: string, params: Params | undefined): string {
  if (!params) {
    return text;
  }
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      return match;
    }
    return typeof value === "number" ? numberFormat(loc.numbers, 2).format(value) : value;
  });
}

export function strings<const K extends string>(en: Record<K, Entry>, pl: Record<K, Entry>): Translator<K> {
  return (where, key, params) => {
    const loc = asLoc(where);
    const entry = (loc.lang === "pl" ? pl : en)[key] ?? en[key] ?? key;
    const n = params?.n;
    return interpolate(loc, pick(loc.lang, entry, typeof n === "number" ? n : undefined), params);
  };
}

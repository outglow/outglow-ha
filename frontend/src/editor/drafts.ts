import type { BackgroundImage, Plan } from "../api/types";
import { emptyPlan } from "./ops";

export const DRAFT_FORMAT = 2;
export const DRAFT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const ALIVE_MS = 3 * 60 * 1000;
export const BEAT_MS = 30 * 1000;
export const DRAFT_PREFIX = "outglow.editor.draft.";
export const LEGACY_DRAFT = "outglow.editor.draft";
export const ALIVE_PREFIX = "outglow.editor.alive.";
export const TAB_KEY = "outglow.editor.tab";
const DB_NAME = "outglow-editor";
const STORE = "draft-images";

export interface Draft {
  key: string;
  tab: string;
  rev: number;
  at: number;
  plan: Plan;
  image: string | null;
  inline: BackgroundImage | null;
}

interface Stored {
  format: number;
  tab: string;
  rev: number;
  at: number;
  plan: Plan;
  image: string | null;
}

interface ImageRecord {
  image: string;
  data: BackgroundImage;
}

function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return local()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    const storage = local();
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    local()?.removeItem(key);
  } catch {
    return;
  }
}

function keys(): string[] {
  try {
    const storage = local();
    if (!storage) return [];
    return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => k !== null);
  } catch {
    return [];
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const instance = randomId();
let claimed: string | null = null;

function beatOf(tab: string): { at: number; owner: string } {
  const [at = "", owner = ""] = (read(`${ALIVE_PREFIX}${tab}`) ?? "").split(":");
  return { at: Number(at), owner };
}

function storedTab(): string | null {
  try {
    return session()?.getItem(TAB_KEY) ?? null;
  } catch {
    return null;
  }
}

function storeTab(id: string): void {
  try {
    session()?.setItem(TAB_KEY, id);
  } catch {
    return;
  }
}

export function tabId(): string {
  if (claimed) return claimed;
  const known = storedTab();
  claimed = known && !tabAlive(known) ? known : randomId();
  storeTab(claimed);
  return claimed;
}

export function draftKey(scope: string): string {
  return `${DRAFT_PREFIX}${scope}.${tabId()}.${randomId()}`;
}

let beat: ReturnType<typeof setInterval> | undefined;

function stamp(): void {
  write(`${ALIVE_PREFIX}${tabId()}`, `${Date.now()}:${instance}`);
}

function stop(): void {
  clearInterval(beat);
  beat = undefined;
  if (beatOf(tabId()).owner === instance) remove(`${ALIVE_PREFIX}${tabId()}`);
}

function start(): void {
  if (beat !== undefined) return;
  stamp();
  beat = setInterval(stamp, BEAT_MS);
}

let listening = false;

export function keepAlive(): void {
  start();
  if (listening) return;
  listening = true;
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", start);
}

export function tabAlive(tab: string, now = Date.now()): boolean {
  const { at } = beatOf(tab);
  return Number.isFinite(at) && at > 0 && now - at < ALIVE_MS;
}

const LISTS = ["rooms", "walls", "doors", "adjacent", "bulbs", "excluded_directions", "retired_rooms"] as const;

export function migratePlan(raw: unknown): Plan | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Plan).rooms)) return null;
  const plan: Plan = { ...emptyPlan(), ...(raw as Partial<Plan>) };
  for (const list of LISTS) {
    if (!Array.isArray(plan[list])) (plan as unknown as Record<string, unknown[]>)[list] = [];
  }
  return plan;
}

function parse(key: string, raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<Stored> & { images?: unknown };
    const plan = migratePlan(data.plan);
    if (!plan || typeof data.at !== "number") return null;
    const rev = typeof data.rev === "number" ? data.rev : 0;
    if (data.format === DRAFT_FORMAT) {
      return { key, tab: String(data.tab ?? ""), rev, at: data.at, plan, image: typeof data.image === "string" ? data.image : null, inline: null };
    }
    const first = Array.isArray(data.images) ? (data.images[0] as [string, BackgroundImage] | undefined) : undefined;
    const inline = first && typeof first[0] === "string" && first[1] && typeof first[1].data_base64 === "string" ? first : null;
    const image = inline ? (plan.background?.file ?? inline[0]) : null;
    return { key, tab: "", rev, at: data.at, plan, image, inline: inline ? inline[1] : null };
  } catch {
    return null;
  }
}

export function listDrafts(scope: string, except: string | null, now = Date.now()): Draft[] {
  const mine = tabId();
  const found: Draft[] = [];
  for (const key of keys()) {
    if (key !== LEGACY_DRAFT && !key.startsWith(DRAFT_PREFIX)) continue;
    const draft = parse(key, read(key));
    if (!draft || now - draft.at > DRAFT_MAX_AGE_MS) {
      dropDraft(key);
      continue;
    }
    if (key === except || (key !== LEGACY_DRAFT && !key.startsWith(`${DRAFT_PREFIX}${scope}.`))) continue;
    if (draft.tab !== "" && draft.tab !== mine && tabAlive(draft.tab, now)) continue;
    found.push(draft);
  }
  return found.sort((a, b) => b.at - a.at);
}

export function saveDraft(key: string, rev: number, plan: Plan, image: string | null): boolean {
  const stored: Stored = { format: DRAFT_FORMAT, tab: tabId(), rev, at: Date.now(), plan, image };
  return write(key, JSON.stringify(stored));
}

export function dropDraft(key: string): void {
  remove(key);
  void dropImage(key);
}

let opened: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  opened ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opened;
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await database();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result ?? null);
      tx.onabort = () => resolve(null);
      tx.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function putImage(key: string, image: string, data: BackgroundImage): Promise<boolean> {
  const record: ImageRecord = { image, data };
  return (await run("readwrite", (store) => store.put(record, key))) !== null;
}

export async function getImage(key: string, image: string): Promise<BackgroundImage | null> {
  const record = (await run("readonly", (store) => store.get(key) as IDBRequest<ImageRecord | undefined>)) as ImageRecord | null;
  return record && record.image === image ? record.data : null;
}

export async function dropImage(key: string): Promise<void> {
  await run("readwrite", (store) => store.delete(key));
}

export async function sweepImages(): Promise<void> {
  const stored = await run("readonly", (store) => store.getAllKeys());
  const known = new Set(keys());
  for (const key of stored ?? []) {
    if (typeof key === "string" && !known.has(key)) await dropImage(key);
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "../src/api/types";
import { ALIVE_MS, ALIVE_PREFIX, DRAFT_MAX_AGE_MS, DRAFT_PREFIX, LEGACY_DRAFT, TAB_KEY, draftKey, listDrafts, migratePlan, saveDraft, tabId } from "../src/editor/drafts";
import { MOCK_PLAN } from "../mock/backend";

function store(key: string, tab: string, at: number, plan: Plan = MOCK_PLAN): void {
  localStorage.setItem(key, JSON.stringify({ format: 2, tab, rev: 1, at, plan, image: null }));
}

describe("drafts", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("offer this tab's drafts and those of tabs that stopped beating, not of tabs still open", () => {
    const now = Date.now();
    const mine = tabId();
    store(`${DRAFT_PREFIX}entry.${mine}.a`, mine, now - 1000);
    store(`${DRAFT_PREFIX}entry.open.b`, "open", now - 2000);
    store(`${DRAFT_PREFIX}entry.gone.c`, "gone", now - 3000);
    store(`${DRAFT_PREFIX}entry.closed.d`, "closed", now - 4000);
    store(`${DRAFT_PREFIX}other.gone.e`, "gone", now - 500);
    localStorage.setItem(`${ALIVE_PREFIX}open`, String(now - 1000));
    localStorage.setItem(`${ALIVE_PREFIX}gone`, String(now - ALIVE_MS - 1));
    expect(listDrafts("entry", null, now).map((d) => d.key.split(".").pop())).toEqual(["a", "c", "d"]);
    expect(listDrafts("entry", `${DRAFT_PREFIX}entry.${mine}.a`, now).map((d) => d.key.split(".").pop())).toEqual(["c", "d"]);
  });

  it("drop drafts older than a week and ones that cannot be read", () => {
    const now = Date.now();
    store(`${DRAFT_PREFIX}entry.x.old`, "x", now - DRAFT_MAX_AGE_MS - 1);
    store(`${DRAFT_PREFIX}other.x.old`, "x", now - DRAFT_MAX_AGE_MS - 1);
    localStorage.setItem(`${DRAFT_PREFIX}entry.x.bad`, "{");
    localStorage.setItem(`${DRAFT_PREFIX}entry.x.empty`, JSON.stringify({ format: 2, at: now, plan: { rooms: "no" } }));
    expect(listDrafts("entry", null, now)).toEqual([]);
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it("read a draft of the first format with its background and fill in what the plan lacked", () => {
    const { retired_rooms: _r, excluded_directions: _e, ...old } = MOCK_PLAN;
    const image = { mime: "image/svg+xml", data_base64: "PHN2Zy8+" };
    localStorage.setItem(LEGACY_DRAFT, JSON.stringify({ rev: 3, at: Date.now(), plan: old, images: [["bg", image]] }));
    const [draft] = listDrafts("entry", null);
    expect(draft).toMatchObject({ key: LEGACY_DRAFT, tab: "", rev: 3, image: "bg", inline: image });
    expect(draft!.plan.retired_rooms).toEqual([]);
    expect(draft!.plan.excluded_directions).toEqual([]);
    const background = { file: "outglow/map.svg", x: 0, y: 0, m_per_px: 0.05 };
    const keyed = JSON.stringify([background.file, 0, 0, 0.05]);
    localStorage.setItem(LEGACY_DRAFT, JSON.stringify({ rev: 3, at: Date.now(), plan: { ...old, background }, images: [[keyed, image]] }));
    expect(listDrafts("entry", null)[0]).toMatchObject({ image: background.file, inline: image });
    expect(migratePlan(null)).toBeNull();
    expect(migratePlan({ ...MOCK_PLAN, walls: null })!.walls).toEqual([]);
  });

  it("are written under a key of their own for each editor in each tab", () => {
    const a = draftKey("entry");
    const b = draftKey("entry");
    expect(a).not.toEqual(b);
    expect(a.startsWith(`${DRAFT_PREFIX}entry.${tabId()}.`)).toBe(true);
    expect(saveDraft(a, 4, MOCK_PLAN, null)).toBe(true);
    expect(listDrafts("entry", null)).toMatchObject([{ key: a, tab: tabId(), rev: 4, image: null }]);
  });

  it("in a duplicated tab take an id of their own before reading drafts, and leave the open tab's to it", async () => {
    const now = Date.now();
    sessionStorage.setItem(TAB_KEY, "source");
    localStorage.setItem(`${ALIVE_PREFIX}source`, String(now - 1000));
    store(`${DRAFT_PREFIX}entry.source.a`, "source", now - 1000);
    vi.resetModules();
    const twin = await import("../src/editor/drafts");
    expect(twin.listDrafts("entry", null, now)).toEqual([]);
    expect(twin.tabId()).not.toEqual("source");
    expect(sessionStorage.getItem(TAB_KEY)).toEqual(twin.tabId());
    twin.keepAlive();
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(`${ALIVE_PREFIX}source`)).toEqual(String(now - 1000));
    expect(localStorage.getItem(`${ALIVE_PREFIX}${twin.tabId()}`)).toBeNull();
    expect(twin.listDrafts("entry", null, now)).toEqual([]);
  });

  it("keep the id of a reloaded tab whose page stopped beating", async () => {
    sessionStorage.setItem(TAB_KEY, "reloaded");
    store(`${DRAFT_PREFIX}entry.reloaded.a`, "reloaded", Date.now() - 1000);
    vi.resetModules();
    const again = await import("../src/editor/drafts");
    expect(again.tabId()).toEqual("reloaded");
    again.keepAlive();
    vi.resetModules();
    const twin = await import("../src/editor/drafts");
    expect(twin.tabId()).not.toEqual("reloaded");
    expect(again.tabId()).toEqual("reloaded");
    expect(again.listDrafts("entry", null).map((d) => d.key)).toEqual([`${DRAFT_PREFIX}entry.reloaded.a`]);
    window.dispatchEvent(new Event("pagehide"));
  });

  it("leave a tab's beat alone when closing a twin of it that beat earlier", async () => {
    sessionStorage.setItem(TAB_KEY, "shared");
    vi.resetModules();
    const twin = await import("../src/editor/drafts");
    expect(twin.tabId()).toEqual("shared");
    twin.keepAlive();
    const other = `${Date.now()}:other`;
    localStorage.setItem(`${ALIVE_PREFIX}shared`, other);
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(`${ALIVE_PREFIX}shared`)).toEqual(other);
    expect(twin.tabAlive("shared")).toBe(true);
  });
});

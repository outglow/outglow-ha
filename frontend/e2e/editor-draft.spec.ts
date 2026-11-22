import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { drag, open, screen, view } from "./helpers";

const VALETUDO = new URL("../../tests/fixtures/valetudo/flat.json", import.meta.url).pathname;
const DRAFT = "outglow.editor.draft.";

async function drawRoom(page: Page, name = "Kitchen", from: [number, number] = [7.02, 0.03], to: [number, number] = [9.98, 3.04]): Promise<void> {
  const editor = page.locator("outglow-plan-editor");
  await editor.locator("[data-tool=rect]").click();
  const v = await view(page);
  await drag(page, screen(v, ...from), screen(v, ...to));
  await expect(editor.locator("[data-field=room-name]")).toBeVisible();
  await editor.locator("[data-field=room-name]").fill(name);
  await expect(editor.locator("outglow-editor-canvas text.room-name", { hasText: name })).toBeVisible();
}

async function connection(page: Page, action: "drop" | "restore"): Promise<void> {
  await page.evaluate((name) => {
    const panel = document.querySelector("outglow-panel") as unknown as { hass: { connection: Record<string, () => void> } };
    panel.hass.connection[name]!();
  }, action);
}

async function reconnect(page: Page): Promise<void> {
  await page.evaluate(() => ((window as unknown as { ogPlan: unknown }).ogPlan = (document.querySelector("outglow-panel") as unknown as { _plan: unknown })._plan));
  await connection(page, "drop");
  await connection(page, "restore");
  await page.waitForFunction(
    () => (document.querySelector("outglow-panel") as unknown as { _plan: unknown })._plan !== (window as unknown as { ogPlan: unknown }).ogPlan,
  );
}

async function saveElsewhere(page: Page, name: string): Promise<void> {
  await page.evaluate(async (renamed) => {
    type Connection = { sendMessagePromise: (m: object) => Promise<Record<string, unknown>> };
    const panel = document.querySelector("outglow-panel") as unknown as { hass: { connection: Connection } };
    const send = panel.hass.connection.sendMessagePromise;
    const got = (await send({ type: "outglow/plan/get" })) as { rev: number; plan: { rooms: { id: string; name: string }[] } };
    const rooms = got.plan.rooms.map((r) => (r.id === "living" ? { ...r, name: renamed } : r));
    await send({ type: "outglow/plan/save", rev: got.rev, plan: { ...got.plan, rooms } });
  }, name);
}

async function serverPlan(page: Page): Promise<{ retired_rooms: string[] }> {
  return page.evaluate(async () => {
    type Connection = { sendMessagePromise: (m: object) => Promise<Record<string, unknown>> };
    const panel = document.querySelector("outglow-panel") as unknown as { hass: { connection: Connection } };
    return ((await panel.hass.connection.sendMessagePromise({ type: "outglow/plan/get" })) as { plan: { retired_rooms: string[] } }).plan;
  });
}

async function serverRooms(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    type Connection = { sendMessagePromise: (m: object) => Promise<Record<string, unknown>> };
    const panel = document.querySelector("outglow-panel") as unknown as { hass: { connection: Connection } };
    const got = (await panel.hass.connection.sendMessagePromise({ type: "outglow/plan/get" })) as { plan: { rooms: { name: string }[] } };
    return got.plan.rooms.map((r) => r.name);
  });
}

async function rebuildPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const old = document.querySelector("outglow-panel") as unknown as HTMLElement & Record<string, unknown>;
    const fresh = document.createElement("outglow-panel") as unknown as HTMLElement & Record<string, unknown>;
    fresh.hass = old.hass;
    fresh.route = old.route;
    fresh.narrow = old.narrow;
    old.replaceWith(fresh);
  });
  await page.waitForFunction(() => document.querySelector("outglow-panel")?.shadowRoot?.querySelector("outglow-plan-editor"));
}

async function stored(page: Page): Promise<string | null> {
  return page.evaluate((prefix) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith(prefix));
    return key ? localStorage.getItem(key) : null;
  }, DRAFT);
}

test("unsaved changes outlive the connection dropping and coming back", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  const names = editor.locator("outglow-editor-canvas text.room-name");
  await drawRoom(page);
  await expect(names).toHaveCount(4);
  await expect(editor.locator(".state")).toHaveText("Unsaved changes");

  await connection(page, "drop");
  await connection(page, "restore");
  await expect(page.locator("outglow-panel .toast")).toHaveText("The connection came back. Your unsaved changes are kept.");
  await expect(names).toHaveCount(4);
  await expect(editor.locator("[data-notice=conflict]")).toHaveCount(0);

  await saveElsewhere(page, "Lounge");
  await connection(page, "drop");
  await connection(page, "restore");
  const bar = editor.locator("[data-notice=conflict]");
  await expect(bar).toContainText("The connection came back and the plan on the server has changed meanwhile");
  await expect(names).toHaveCount(4);
  await expect(names.filter({ hasText: "Kitchen" })).toHaveCount(1);
  await expect(editor.locator(".state")).toHaveText("Unsaved changes");
  await bar.getByRole("button", { name: "Keep mine" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  await expect(bar).toHaveCount(0);
  expect(await serverRooms(page)).toContain("Kitchen");
  expect(await serverRooms(page)).not.toContain("Lounge");
  await expect(editor.getByRole("button", { name: "Undo" })).toBeEnabled();
  await reconnect(page);
  await expect(editor.getByRole("button", { name: "Undo" })).toBeEnabled();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  await expect(page.locator("outglow-panel .toast")).not.toHaveText(/connection came back/);

  await drawRoom(page, "Pantry", [-3.02, 0.03], [-0.52, 3.04]);
  await expect(editor.locator(".state")).toHaveText("Unsaved changes");
  await saveElsewhere(page, "Lounge");
  await connection(page, "drop");
  await connection(page, "restore");
  await bar.getByRole("button", { name: "Load theirs" }).click();
  await expect(bar).toHaveCount(0);
  await expect(names.filter({ hasText: "Lounge" })).toHaveCount(1);
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
});

test("an unsaved import comes back after Home Assistant rebuilds the panel", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  const names = editor.locator("outglow-editor-canvas text.room-name");
  await expect(names).toHaveCount(3);
  await editor.getByRole("button", { name: "Import" }).click();
  const sheet = editor.locator("og-sheet");
  const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await sheet.locator(".file").click();
  await (await chooser).setFiles({ name: "map.json", mimeType: "application/json", buffer: readFileSync(VALETUDO) });
  await sheet.getByRole("button", { name: "Use this plan" }).click();
  await expect(names).toHaveCount(4);
  await expect(editor.locator("outglow-editor-canvas image.backdrop")).toHaveCount(1);
  await expect.poll(() => stored(page)).not.toBeNull();

  await rebuildPanel(page);
  const fresh = page.locator("outglow-plan-editor");
  const bar = fresh.locator("[data-notice=draft]");
  await expect(bar).toContainText("Unsaved changes to the plan from");
  await expect(bar).not.toContainText("has changed since");
  await expect(fresh.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  await bar.getByRole("button", { name: "Restore" }).click();
  await expect(bar).toHaveCount(0);
  await expect(fresh.locator("outglow-editor-canvas text.room-name")).toHaveCount(4);
  await expect(fresh.locator("outglow-editor-canvas image.backdrop")).toHaveCount(1);
  await expect(fresh.locator(".state")).toHaveText("Unsaved changes");
  await fresh.getByRole("button", { name: "Undo" }).click();
  await expect(fresh.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  await fresh.getByRole("button", { name: "Redo" }).click();
  await fresh.getByRole("button", { name: "Save" }).click();
  await expect(fresh.getByRole("button", { name: "Saved" })).toBeVisible();
  await expect.poll(() => stored(page)).toBeNull();
  const file = await page.evaluate(async () => {
    type Connection = { sendMessagePromise: (m: object) => Promise<Record<string, unknown>> };
    const panel = document.querySelector("outglow-panel") as unknown as { hass: { connection: Connection } };
    const got = (await panel.hass.connection.sendMessagePromise({ type: "outglow/plan/get" })) as { plan: { background: { file: string } | null } };
    return got.plan.background?.file ?? null;
  });
  expect(file).toMatch(/^plan-[0-9a-f]{16}\.svg$/);

  await rebuildPanel(page);
  await expect(page.locator("outglow-plan-editor [data-notice=draft]")).toHaveCount(0);
});

test("a draft left by a closed page is offered once and can be discarded", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  await drawRoom(page);
  await expect.poll(() => stored(page)).not.toBeNull();
  await page.reload();
  await page.locator("outglow-panel main").waitFor();
  const editor = page.locator("outglow-plan-editor");
  const bar = editor.locator("[data-notice=draft]");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Discard" }).click();
  await expect(bar).toHaveCount(0);
  expect(await stored(page)).toBeNull();
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  await page.reload();
  await expect(page.locator("outglow-plan-editor outglow-editor-canvas text.room-name")).toHaveCount(3);
  await expect(page.locator("outglow-plan-editor [data-notice=draft]")).toHaveCount(0);
});

test("a draft from before a newer save on the server says that restoring replaces it", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  await drawRoom(page);
  await expect.poll(() => stored(page)).not.toBeNull();
  await saveElsewhere(page, "Lounge");
  await rebuildPanel(page);
  const bar = page.locator("outglow-plan-editor [data-notice=draft]");
  await expect(bar).toContainText("The plan on the server has changed since");
  await bar.getByRole("button", { name: "Restore" }).click();
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas text.room-name", { hasText: "Kitchen" })).toHaveCount(1);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  expect(await serverRooms(page)).toContain("Kitchen");
});

test("the editor still works when the browser refuses storage", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
  });
  await open(page, "/plan", { width: 1440 });
  await drawRoom(page);
  const editor = page.locator("outglow-plan-editor");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
});

async function loseSaveReply(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Connection = { sendMessagePromise: (m: { type: string }) => Promise<unknown>; drop(): void; restore(): void };
    const c = (document.querySelector("outglow-panel") as unknown as { hass: { connection: Connection } }).hass.connection;
    const send = c.sendMessagePromise.bind(c);
    c.sendMessagePromise = async (m) => {
      if (m.type !== "outglow/plan/save") return send(m);
      c.sendMessagePromise = send;
      await send(m);
      c.drop();
      setTimeout(() => c.restore(), 50);
      throw { code: "connection_lost", message: "Connection lost" };
    };
  });
}

test("a save whose reply is lost when the connection drops counts as saved once it comes back", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await drawRoom(page);
  await loseSaveReply(page);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("outglow-panel .toast")).toHaveText("The connection came back; the plan had been saved.");
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  await expect(editor.locator("[data-notice=conflict]")).toHaveCount(0);
  expect(await serverRooms(page)).toContain("Kitchen");
  await expect.poll(() => stored(page)).toBeNull();
});

test("a saved import is not a change on the server when the connection comes back", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await importMap(page);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  expect((await serverPlan(page)).retired_rooms.length).toBeGreaterThan(0);
  await editor.locator("outglow-editor-canvas text.room-name").first().click({ force: true });
  await editor.locator("[data-field=room-name]").fill("Renamed");
  await expect(editor.locator(".state")).toHaveText("Unsaved changes");
  await reconnect(page);
  await expect(page.locator("outglow-panel .toast")).toHaveText("The connection came back. Your unsaved changes are kept.");
  await expect(editor.locator("[data-notice=conflict]")).toHaveCount(0);
  await expect(editor.locator(".state")).toHaveText("Unsaved changes");
});

test("rooms removed in another order than the server keeps them are not a change on the server", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  for (const name of ["Office", "Hall"]) {
    await editor.locator("outglow-editor-canvas text.room-name", { hasText: name }).click({ force: true });
    await editor.getByRole("button", { name: "Delete room" }).click();
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  }
  await drawRoom(page);
  await reconnect(page);
  await expect(page.locator("outglow-panel .toast")).toHaveText("The connection came back. Your unsaved changes are kept.");
  await expect(editor.locator("[data-notice=conflict]")).toHaveCount(0);
  await expect(editor.locator(".state")).toHaveText("Unsaved changes");
});

async function drafts(page: Page): Promise<string[][]> {
  return page.evaluate((prefix) => {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(prefix))
      .map((k) => (JSON.parse(localStorage.getItem(k)!).plan.rooms as { name: string }[]).map((r) => r.name))
      .sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()));
  }, DRAFT);
}

async function importMap(page: Page, base64Length = 0): Promise<void> {
  if (base64Length > 0) {
    await page.evaluate((len) => {
      type Connection = { sendMessagePromise: (m: { type: string }) => Promise<Record<string, unknown>> };
      const c = (document.querySelector("outglow-panel") as unknown as { hass: { connection: Connection } }).hass.connection;
      const send = c.sendMessagePromise.bind(c);
      const body = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><path fill="#5f6368" d="${"M1 1h1v1h-1z".repeat(Math.ceil((len * 3) / 4 / 12))}"/></svg>`;
      const data = btoa(body);
      c.sendMessagePromise = async (m) => {
        const r = await send(m);
        if (m.type === "outglow/plan/import" && r.background_image) r.background_image = { mime: "image/svg+xml", data_base64: data };
        return r;
      };
    }, base64Length);
  }
  const editor = page.locator("outglow-plan-editor");
  await editor.getByRole("button", { name: "Import" }).click();
  const sheet = editor.locator("og-sheet");
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
  await sheet.locator(".file").click();
  await (await chooser).setFiles({ name: "map.json", mimeType: "application/json", buffer: readFileSync(VALETUDO) });
  await sheet.getByRole("button", { name: "Use this plan" }).click();
  await expect(editor.locator("outglow-editor-canvas image.backdrop")).toHaveCount(1);
}

async function sentBackground(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Connection = { sendMessagePromise: (m: { type: string; plan?: { background: unknown } }) => Promise<unknown> };
    const c = (document.querySelector("outglow-panel") as unknown as { hass: { connection: Connection } }).hass.connection;
    const send = c.sendMessagePromise.bind(c);
    c.sendMessagePromise = (m) => {
      if (m.type === "outglow/plan/save") (window as unknown as { ogSent: unknown }).ogSent = m.plan?.background ?? null;
      return send(m);
    };
  });
}

test("a save of an import whose reply is lost counts as saved, though the server retired the rooms it dropped", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await importMap(page);
  await loseSaveReply(page);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("outglow-panel .toast")).toHaveText("The connection came back; the plan had been saved.");
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  await expect(editor.locator("[data-notice=conflict]")).toHaveCount(0);
});

test("each tab keeps its own draft, and an open tab's draft is not offered in another", async ({ context }) => {
  const a = await context.newPage();
  await open(a, "/plan", { width: 1440 });
  await drawRoom(a, "Alpha");
  await expect.poll(() => drafts(a)).toHaveLength(1);
  const b = await context.newPage();
  await open(b, "/plan", { width: 1440 });
  await expect(b.locator("outglow-plan-editor outglow-editor-canvas text.room-name")).toHaveCount(3);
  await expect(b.locator("outglow-plan-editor [data-notice=draft]")).toHaveCount(0);
  await drawRoom(b, "Beta", [-3.02, 0.03], [-0.52, 3.04]);
  await expect.poll(() => drafts(a)).toHaveLength(2);
  const both = await drafts(a);
  expect(both.filter((names) => names.includes("Alpha") && !names.includes("Beta"))).toHaveLength(1);
  expect(both.filter((names) => names.includes("Beta") && !names.includes("Alpha"))).toHaveLength(1);

  await rebuildPanel(a);
  const bar = a.locator("outglow-plan-editor [data-notice=draft]");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "Restore" }).click();
  const names = a.locator("outglow-plan-editor outglow-editor-canvas text.room-name");
  await expect(names.filter({ hasText: "Alpha" })).toHaveCount(1);
  await expect(names.filter({ hasText: "Beta" })).toHaveCount(0);

  await b.locator("outglow-plan-editor").getByRole("button", { name: "Undo" }).click();
  await b.locator("outglow-plan-editor").getByRole("button", { name: "Undo" }).click();
  await expect(b.locator("outglow-plan-editor .state")).toHaveCount(0);
  await expect.poll(() => drafts(a)).toHaveLength(1);
  expect((await drafts(a))[0]).toContain("Alpha");
});

test("a duplicated tab takes an id of its own and leaves the open tab's draft alone", async ({ context }) => {
  const a = await context.newPage();
  await open(a, "/plan", { width: 1440 });
  await importMap(a);
  await expect.poll(() => drafts(a)).toHaveLength(1);
  const tab = await a.evaluate(() => sessionStorage.getItem("outglow.editor.tab"));
  const b = await context.newPage();
  await b.addInitScript((id) => {
    if (!sessionStorage.getItem("outglow.editor.tab")) sessionStorage.setItem("outglow.editor.tab", id!);
  }, tab);
  await open(b, "/plan", { width: 1440 });
  await expect(b.locator("outglow-plan-editor outglow-editor-canvas text.room-name")).toHaveCount(3);
  await expect(b.locator("outglow-plan-editor [data-notice=draft]")).toHaveCount(0);
  expect(await b.evaluate(() => sessionStorage.getItem("outglow.editor.tab"))).not.toEqual(tab);
  await b.close();
  const c = await context.newPage();
  await open(c, "/plan", { width: 1440 });
  await expect(c.locator("outglow-plan-editor outglow-editor-canvas text.room-name")).toHaveCount(3);
  await expect(c.locator("outglow-plan-editor [data-notice=draft]")).toHaveCount(0);

  await rebuildPanel(a);
  const bar = a.locator("outglow-plan-editor [data-notice=draft]");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "Restore" }).click();
  await expect(a.locator("outglow-plan-editor outglow-editor-canvas image.backdrop")).toHaveCount(1);
});

test("a draft left by a closed tab is offered in another tab", async ({ context }) => {
  const a = await context.newPage();
  await open(a, "/plan", { width: 1440 });
  await drawRoom(a, "Alpha");
  await expect.poll(() => drafts(a)).toHaveLength(1);
  await a.close();
  const b = await context.newPage();
  await open(b, "/plan", { width: 1440 });
  const bar = b.locator("outglow-plan-editor [data-notice=draft]");
  await expect(bar).toContainText("Unsaved changes to the plan from");
  await bar.getByRole("button", { name: "Restore" }).click();
  await expect(b.locator("outglow-plan-editor outglow-editor-canvas text.room-name", { hasText: "Alpha" })).toHaveCount(1);
});

test("editing while the draft bar is up keeps the older draft to restore", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  await drawRoom(page);
  await expect.poll(() => drafts(page)).toHaveLength(1);
  await rebuildPanel(page);
  const editor = page.locator("outglow-plan-editor");
  const bar = editor.locator("[data-notice=draft]");
  await expect(bar).toBeVisible();
  await drawRoom(page, "Pantry", [-3.02, 0.03], [-0.52, 3.04]);
  await expect(bar).toBeVisible();
  await expect.poll(() => drafts(page)).toHaveLength(2);
  await bar.getByRole("button", { name: "Restore" }).click();
  const names = editor.locator("outglow-editor-canvas text.room-name");
  await expect(names.filter({ hasText: "Kitchen" })).toHaveCount(1);
  await expect(names.filter({ hasText: "Pantry" })).toHaveCount(0);
  await editor.getByRole("button", { name: "Undo" }).click();
  await expect(names.filter({ hasText: "Pantry" })).toHaveCount(1);
});

test("a draft written before rooms could be retired is restored and imported over", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(page, "/plan", { width: 1440 });
  await page.evaluate(() => {
    const ed = document.querySelector("outglow-panel")!.shadowRoot!.querySelector("outglow-plan-editor") as unknown as { _plan: Record<string, unknown> & { rooms: unknown[] }; rev: number };
    const plan = structuredClone(ed._plan);
    delete plan.retired_rooms;
    delete plan.excluded_directions;
    plan.rooms = [...plan.rooms, { id: "old", name: "Old room", outline: [[7, 0], [9, 0], [9, 2], [7, 2]], colour: "#000000", area_id: null, entrance: false }];
    localStorage.setItem("outglow.editor.draft", JSON.stringify({ rev: ed.rev, at: Date.now(), plan, images: [] }));
  });
  await rebuildPanel(page);
  const editor = page.locator("outglow-plan-editor");
  await editor.locator("[data-notice=draft]").getByRole("button", { name: "Restore" }).click();
  await expect(editor.locator("outglow-editor-canvas text.room-name", { hasText: "Old room" })).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("outglow.editor.draft"))).toBeNull();
  await importMap(page);
  await expect(editor.locator(".state")).toHaveText("Unsaved changes");
  expect(errors).toEqual([]);
});

test("a draft older than a week is dropped instead of offered", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  await drawRoom(page);
  await expect.poll(() => drafts(page)).toHaveLength(1);
  await page.evaluate((prefix) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith(prefix))!;
    const draft = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...draft, at: Date.now() - 8 * 24 * 3600 * 1000 }));
  }, DRAFT);
  await rebuildPanel(page);
  await expect(page.locator("outglow-plan-editor outglow-editor-canvas text.room-name")).toHaveCount(3);
  await expect(page.locator("outglow-plan-editor [data-notice=draft]")).toHaveCount(0);
  expect(await drafts(page)).toEqual([]);
});

test("an imported background too big for local storage comes back with the draft", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  await importMap(page, 6 * 1024 * 1024);
  await expect.poll(() => drafts(page)).toHaveLength(1);
  await rebuildPanel(page);
  const editor = page.locator("outglow-plan-editor");
  const bar = editor.locator("[data-notice=draft]");
  await expect(bar).not.toContainText("import the map again");
  await bar.getByRole("button", { name: "Restore" }).click();
  await expect(editor.locator("outglow-editor-canvas image.backdrop")).toHaveCount(1);
  await expect(page.locator("outglow-panel .toast")).toHaveText("Unsaved changes restored. Review them and save.");
});

test("without IndexedDB a restored import says the background is gone and does not save a missing file", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
  });
  await open(page, "/plan", { width: 1440 });
  await importMap(page);
  await expect.poll(() => drafts(page)).toHaveLength(1);
  await rebuildPanel(page);
  const editor = page.locator("outglow-plan-editor");
  const bar = editor.locator("[data-notice=draft]");
  await expect(bar).toContainText("import the map again to get it back");
  await bar.getByRole("button", { name: "Restore" }).click();
  await expect(page.locator("outglow-panel .toast")).toHaveText("Unsaved changes restored without the imported background. Import the map again to get it back.");
  await expect(editor.locator("outglow-editor-canvas image.backdrop")).toHaveCount(0);
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(4);
  await sentBackground(page);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { ogSent: unknown }).ogSent)).toBeNull();
});

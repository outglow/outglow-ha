import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { drag, open, screen, view } from "./helpers";

const VALETUDO = new URL("../../tests/fixtures/valetudo/flat.json", import.meta.url).pathname;

test("draw a room, place a bulb, add a door, undo, redo and save", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas")).toBeVisible();

  await editor.locator("[data-tool=rect]").click();
  let v = await view(page);
  await drag(page, screen(v, 7.02, 0.03), screen(v, 9.98, 3.04));

  const name = editor.locator("[data-field=room-name]");
  await expect(name).toBeVisible();
  await name.fill("Kitchen");
  await expect(editor.locator("outglow-editor-canvas text.room-name", { hasText: "Kitchen" })).toBeVisible();

  const item = editor.locator(".bulb-item[data-ieee='0x0000000000000005']");
  await item.scrollIntoViewIfNeeded();
  v = await view(page);
  const box = (await item.boundingBox())!;
  await drag(page, [box.x + 20, box.y + box.height / 2], screen(v, 8.5, 1.5));
  await expect(editor.locator("outglow-editor-canvas circle.bulb[data-ieee='0x0000000000000005']")).toHaveCount(1);
  await expect(editor.locator(".bulb-item[data-ieee='0x0000000000000005']")).toHaveCount(0);

  await editor.locator("[data-tool=door]").click();
  v = await view(page);
  const doorsBefore = await editor.locator("outglow-editor-canvas .door").count();
  const wallPoint = screen(v, 7, 1.5);
  await page.mouse.move(wallPoint[0], wallPoint[1]);
  await page.mouse.click(wallPoint[0], wallPoint[1]);
  await expect(editor.locator("outglow-editor-canvas .door")).toHaveCount(doorsBefore + 1);
  await expect(editor.locator(".inspector h2.headline")).toHaveText("Door");

  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator("outglow-editor-canvas .door")).toHaveCount(doorsBefore);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editor.locator("outglow-editor-canvas .door")).toHaveCount(doorsBefore + 1);

  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  const rev = await page.evaluate(() => (document.querySelector("outglow-panel") as unknown as { _rev: number })._rev);
  expect(rev).toBe(1);

  await page.locator("outglow-panel .appbar [role=tab]", { hasText: "Live" }).click();
  await expect(page.locator("outglow-live-view .rooms .name", { hasText: "Kitchen" })).toBeVisible();
  await expect(page.locator("outglow-live-view circle.bulb")).toHaveCount(5);
});

test("draw a polygon with the keyboard and import a plan", async ({ page }) => {
  await open(page, "/plan", { width: 1440, lang: "pl" });
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas")).toBeVisible();
  await editor.locator("outglow-editor-canvas svg.plan").focus();
  await page.keyboard.press("p");
  await expect(editor.locator("[data-tool=poly]")).toHaveAttribute("aria-pressed", "true");
  const v = await view(page);
  for (const [x, y] of [
    [-3, 0],
    [-0.5, 0],
    [-0.5, 3],
    [-3, 3.02],
  ] as [number, number][]) {
    const [sx, sy] = screen(v, x, y);
    await page.mouse.click(sx, sy);
  }
  await page.keyboard.press("Enter");
  await expect(editor.locator("[data-field=room-name]")).toHaveValue("Pokój 4");
  await expect(editor.locator(".edges input")).toHaveCount(4);
  await expect(editor.locator(".kv-line").first()).toContainText("7,5 m²");
  await editor.locator(".edges input").nth(1).fill("2");
  await editor.locator(".edges input").nth(1).press("Tab");
  await expect(editor.locator(".kv-line").first()).toContainText("6,25 m²");

  await editor.getByRole("button", { name: "Import" }).click();
  await editor.locator("og-sheet textarea").fill("rooms:\n  living:\n    outline: [[0, 0], [5, 0], [5, 4], [0, 4]]\n");
  await editor.locator("og-sheet").getByRole("button", { name: "Podgląd" }).click();
  await expect(editor.locator("og-sheet [data-field=source]")).toHaveText("Rozpoznano: plan z wcześniejszego prototypu (YAML)");
  await expect(editor.locator("og-sheet .warnings li")).toHaveCount(2);
  await expect(editor.locator("og-sheet .warnings")).toContainText("Pominięto pole z2m");
  await editor.locator("og-sheet").getByRole("button", { name: "Użyj tego planu" }).click();
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(4);
});

test("a mouse click on the choose a file button opens the file picker", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await editor.getByRole("button", { name: "Import" }).click();
  const button = editor.locator("og-sheet .file");
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  const at = (fx: number, fy: number) => ({ position: { x: box.width * fx, y: box.height * fy } });
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.1, 0.2],
    [0.9, 0.8],
  ] as [number, number][]) {
    const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
    await button.click(at(fx, fy));
    await (await chooser).setFiles([]);
  }
  const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await button.click(at(0.5, 0.5));
  await (
    await chooser
  ).setFiles({
    name: "plan.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from("rooms:\n  living:\n    outline: [[0, 0], [5, 0], [5, 4], [0, 4]]\n"),
  });
  await expect(editor.locator("og-sheet textarea")).toHaveValue(/living/);
  await expect(editor.locator("og-sheet [data-field=source]")).toHaveText("Recognised: a plan of the earlier prototype (YAML)");
});

test("a Valetudo map chosen as a file is recognised, keeps the bulbs and brings its background", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await editor.getByRole("button", { name: "Import" }).click();
  const sheet = editor.locator("og-sheet");
  await expect(sheet.locator("[data-format]")).toHaveCount(0);
  await expect(sheet.locator("[data-field=keep-bulbs]")).toBeChecked();
  const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await sheet.locator(".file").click();
  await (await chooser).setFiles({ name: "map.json", mimeType: "application/json", buffer: readFileSync(VALETUDO) });
  await expect(sheet.locator("[data-field=source]")).toHaveText("Recognised: a Valetudo vacuum map");
  await expect(sheet.locator("[data-field=kept]")).toContainText("bulbs kept where they were");
  const preview = sheet.locator("outglow-plan-view");
  await expect(preview.locator("polygon.room")).toHaveCount(4);
  await expect(preview.locator("image.backdrop")).toHaveCount(1);
  await expect(preview.locator("circle.bulb")).toHaveCount(4);
  await sheet.locator("[data-field=keep-bulbs]").uncheck();
  await sheet.getByRole("button", { name: "Preview" }).click();
  await expect(sheet.locator("[data-field=kept]")).toHaveCount(0);
  await expect(preview.locator("circle.bulb")).toHaveCount(0);
  await sheet.locator("[data-field=keep-bulbs]").check();
  await sheet.getByRole("button", { name: "Preview" }).click();
  await expect(preview.locator("circle.bulb")).toHaveCount(4);
  await sheet.getByRole("button", { name: "Use this plan" }).click();
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(4);
  expect(await stored(page)).toEqual({ mime: null, file: null });
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  const saved = await stored(page);
  expect(saved.mime).toBe("image/svg+xml");
  expect(saved.file).toMatch(/^plan-[0-9a-f]{16}\.svg$/);
  await editor.getByRole("button", { name: "Undo" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  expect((await stored(page)).file).toBeNull();
  await editor.getByRole("button", { name: "Redo" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  expect((await stored(page)).file).toBe(saved.file);
});

async function stored(page: Page): Promise<{ mime: string | null; file: string | null }> {
  return page.evaluate(async () => {
    type Connection = { sendMessagePromise: (m: object) => Promise<Record<string, unknown>> };
    const panel = document.querySelector("outglow-panel") as unknown as { hass: { connection: Connection } };
    const send = (type: string) => panel.hass.connection.sendMessagePromise({ type });
    const image = (await send("outglow/plan/background/get")).image as { mime: string } | null;
    const plan = (await send("outglow/plan/get")).plan as { background: { file: string } | null };
    return { mime: image?.mime ?? null, file: plan.background?.file ?? null };
  });
}

async function useImport(page: Page, text: string): Promise<void> {
  const editor = page.locator("outglow-plan-editor");
  const sheet = editor.locator("og-sheet");
  await editor.getByRole("button", { name: "Import" }).click();
  await sheet.locator("textarea").fill(text);
  await sheet.getByRole("button", { name: "Preview" }).click();
  await sheet.getByRole("button", { name: "Use this plan" }).click();
}

async function save(page: Page): Promise<void> {
  const editor = page.locator("outglow-plan-editor");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
}

test("the background goes up once, comes back after undoing past two saves, and a lost one is reported", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  const uploads: boolean[] = [];
  await page.exposeFunction("ogSaved", (image: boolean) => uploads.push(image));
  await page.evaluate(() => {
    const panel = document.querySelector("outglow-panel") as unknown as { hass: { connection: { sendMessagePromise: (m: object) => Promise<unknown> } } };
    const connection = panel.hass.connection;
    const send = connection.sendMessagePromise.bind(connection);
    connection.sendMessagePromise = (m: object) => {
      const message = m as { type: string; background_image?: unknown };
      if (message.type === "outglow/plan/save") (window as unknown as { ogSaved: (i: boolean) => void }).ogSaved(Boolean(message.background_image));
      return send(m);
    };
  });
  const room = (name: string) => `rooms:\n  ${name}:\n    outline: [[0, 0], [5, 0], [5, 4], [0, 4]]\n`;
  await useImport(page, readFileSync(VALETUDO, "utf8"));
  await save(page);
  const map = (await stored(page)).file;
  expect(map).toMatch(/^plan-[0-9a-f]{16}\.svg$/);
  await editor.locator("outglow-editor-canvas polygon.room[data-room=kitchen]").click();
  await editor.locator("[data-field=room-name]").fill("Renamed");
  await save(page);
  expect(uploads).toEqual([true, false]);
  await useImport(page, room("attic"));
  await save(page);
  await useImport(page, room("cellar"));
  await save(page);
  expect(uploads).toEqual([true, false, false, false]);
  await editor.getByRole("button", { name: "Undo" }).click();
  await editor.getByRole("button", { name: "Undo" }).click();
  await save(page);
  expect(uploads).toEqual([true, false, false, false, true]);
  expect(await stored(page)).toEqual({ mime: "image/svg+xml", file: map });
  await page.evaluate(() => {
    const view = document.querySelector("outglow-panel")!.shadowRoot!.querySelector("outglow-plan-editor") as unknown as { _backgrounds: Map<string, unknown> };
    view._backgrounds.clear();
  });
  await useImport(page, room("attic"));
  await save(page);
  await useImport(page, room("cellar"));
  await save(page);
  await editor.getByRole("button", { name: "Undo" }).click();
  await editor.getByRole("button", { name: "Undo" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("outglow-panel .toast")).toContainText("The background of this version is no longer stored");
  expect(await stored(page)).toEqual({ mime: null, file: null });
  expect(uploads.slice(5)).toEqual([false, false, false]);
  await useImport(page, readFileSync(VALETUDO, "utf8"));
  await save(page);
  expect(await stored(page)).toEqual({ mime: "image/svg+xml", file: map });
  expect(uploads.slice(8)).toEqual([true]);
});

async function countUploads(page: Page): Promise<boolean[]> {
  const uploads: boolean[] = [];
  await page.exposeFunction("ogSaved", (image: boolean) => uploads.push(image));
  await page.evaluate(() => {
    const panel = document.querySelector("outglow-panel") as unknown as { hass: { connection: { sendMessagePromise: (m: object) => Promise<unknown> } } };
    const connection = panel.hass.connection;
    const send = connection.sendMessagePromise.bind(connection);
    connection.sendMessagePromise = (m: object) => {
      const message = m as { type: string; background_image?: unknown };
      if (message.type === "outglow/plan/save") (window as unknown as { ogSaved: (i: boolean) => void }).ogSaved(Boolean(message.background_image));
      return send(m);
    };
  });
  return uploads;
}

async function saveElsewhereWithoutBackground(page: Page, times: number): Promise<void> {
  await page.evaluate(async (times) => {
    const backend = (window as unknown as { outglowMock: { handle: (m: object) => Promise<Record<string, unknown>> } }).outglowMock;
    for (let i = 0; i < times; i++) {
      const got = (await backend.handle({ type: "outglow/plan/get" })) as { rev: number; plan: Record<string, unknown> };
      await backend.handle({ type: "outglow/plan/save", rev: got.rev, plan: { ...got.plan, background: null } });
    }
  }, times);
}

async function forgetBackgrounds(page: Page): Promise<void> {
  await page.evaluate(() => {
    const view = document.querySelector("outglow-panel")!.shadowRoot!.querySelector("outglow-plan-editor") as unknown as { _backgrounds: Map<string, unknown> };
    view._backgrounds.clear();
  });
}

async function rename(page: Page, name: string): Promise<void> {
  const editor = page.locator("outglow-plan-editor");
  await editor.locator("outglow-editor-canvas polygon.room[data-room=kitchen]").click();
  await editor.locator("[data-field=room-name]").fill(name);
}

test("keep mine after another window dropped the background sends it again, and a lost one comes back with the next import", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  const toast = page.locator("outglow-panel .toast");
  const uploads = await countUploads(page);
  const map = readFileSync(VALETUDO, "utf8");
  await useImport(page, map);
  await save(page);
  const file = (await stored(page)).file;
  expect(file).toMatch(/^plan-[0-9a-f]{16}\.svg$/);
  await rename(page, "Renamed");
  await saveElsewhereWithoutBackground(page, 2);
  await editor.getByRole("button", { name: "Save" }).click();
  await editor.getByRole("button", { name: "Keep mine" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  await expect(toast).toHaveText("Saved");
  expect(await stored(page)).toEqual({ mime: "image/svg+xml", file });
  expect(uploads).toEqual([true, false, true]);
  await forgetBackgrounds(page);
  await rename(page, "Again");
  await saveElsewhereWithoutBackground(page, 2);
  await editor.getByRole("button", { name: "Save" }).click();
  await editor.getByRole("button", { name: "Keep mine" }).click();
  await expect(toast).toContainText("The background of this version is no longer stored");
  expect(await stored(page)).toEqual({ mime: null, file: null });
  await useImport(page, map);
  await save(page);
  await expect(toast).toHaveText("Saved");
  expect(await stored(page)).toEqual({ mime: "image/svg+xml", file });
  expect(uploads).toEqual([true, false, true, false, false, true]);
});

test("a background whose file went missing on the server is sent again from the editor", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const toast = page.locator("outglow-panel .toast");
  const uploads = await countUploads(page);
  await useImport(page, readFileSync(VALETUDO, "utf8"));
  await save(page);
  const file = (await stored(page)).file;
  await page.evaluate(() => (window as unknown as { outglowMock: { files: Map<string, unknown> } }).outglowMock.files.clear());
  await rename(page, "Restored");
  await save(page);
  await expect(toast).toHaveText("Saved");
  expect(await stored(page)).toEqual({ mime: "image/svg+xml", file });
  expect(uploads).toEqual([true, false, true]);
  await page.evaluate(() => (window as unknown as { outglowMock: { files: Map<string, unknown> } }).outglowMock.files.clear());
  await forgetBackgrounds(page);
  await rename(page, "Lost");
  await save(page);
  await expect(toast).toContainText("The background of this version is no longer stored");
  await useImport(page, readFileSync(VALETUDO, "utf8"));
  await save(page);
  await expect(toast).toHaveText("Saved");
  expect(await stored(page)).toEqual({ mime: "image/svg+xml", file });
  expect(uploads).toEqual([true, false, true, false, true]);
});

test("an Outglow plan is taken as it is, without the switch to keep the bulbs", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await editor.getByRole("button", { name: "Import" }).click();
  const sheet = editor.locator("og-sheet");
  await expect(sheet.locator("[data-field=keep-bulbs]")).toBeEnabled();
  const exported = { rooms: [{ id: "a", name: "Attic", outline: [[0, 0], [4, 0], [4, 3], [0, 3]], colour: "#123456", area_id: null, entrance: false }] };
  await sheet.locator("textarea").fill(JSON.stringify(exported));
  await sheet.getByRole("button", { name: "Preview" }).click();
  await expect(sheet.locator("[data-field=source]")).toHaveText("Recognised: an Outglow plan");
  await expect(sheet.locator("[data-field=keep-bulbs]")).toBeDisabled();
  await expect(sheet.locator("[data-field=keep-bulbs]")).not.toBeChecked();
  await expect(sheet.locator("label.check")).toContainText("An Outglow plan is used as it is");
  await expect(sheet.locator("[data-field=kept]")).toHaveCount(0);
});

test("a large map is sent compressed and one too large even so is refused with the limit", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await editor.getByRole("button", { name: "Import" }).click();
  const sheet = editor.locator("og-sheet");
  const map = readFileSync(VALETUDO, "utf8").trim();
  const padded = `${map.slice(0, -1)},"padding":"${" ".repeat(6_000_000)}"}`;
  const messages: number[] = [];
  await page.exposeFunction("ogSent", (size: number) => messages.push(size));
  await page.evaluate(() => {
    const panel = document.querySelector("outglow-panel") as unknown as { hass: { connection: { sendMessagePromise: (m: object) => Promise<unknown> } } };
    const connection = panel.hass.connection;
    const send = connection.sendMessagePromise.bind(connection);
    connection.sendMessagePromise = (m: object) => {
      (window as unknown as { ogSent: (n: number) => void }).ogSent(JSON.stringify(m).length);
      return send(m);
    };
  });
  let chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await sheet.locator(".file").click();
  await (await chooser).setFiles({ name: "map.json", mimeType: "application/json", buffer: Buffer.from(padded) });
  await expect(sheet.locator("[data-field=source]")).toHaveText("Recognised: a Valetudo vacuum map");
  expect(Math.max(...messages)).toBeLessThan(4 * 1024 * 1024);
  const noise = randomBytes(4_500_000).toString("base64");
  chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await sheet.locator(".file").click();
  await (await chooser).setFiles({ name: "map.json", mimeType: "application/json", buffer: Buffer.from(`{"x":"${noise}"}`) });
  await expect(sheet.locator(".notice.error")).toContainText("MB even compressed, and Home Assistant takes at most 4.0 MB at once");
  await expect(sheet.locator(".notice.error")).not.toContainText("paste");
});

test("pasting a Valetudo map and fetching one from the robot", async ({ page }) => {
  await open(page, "/plan", { width: 1440, lang: "pl" });
  const editor = page.locator("outglow-plan-editor");
  await editor.getByRole("button", { name: "Import" }).click();
  const sheet = editor.locator("og-sheet");
  await sheet.locator("textarea").fill(readFileSync(VALETUDO, "utf8"));
  await sheet.getByRole("button", { name: "Podgląd" }).click();
  await expect(sheet.locator("[data-field=source]")).toHaveText("Rozpoznano: mapa z odkurzacza Valetudo");
  await expect(sheet.locator("outglow-plan-view polygon.room")).toHaveCount(4);
  await expect(sheet.locator(".warnings")).toContainText("Pominięto fragment mapy 9");
  await sheet.locator("textarea").fill("");
  await sheet.getByRole("button", { name: "Pobierz z odkurzacza" }).click();
  await expect(sheet.locator("[data-field=robot-url]")).toHaveValue("http://192.0.2.10");
  await expect(sheet.locator("[data-field=robot-url]")).toHaveAttribute("placeholder", "http://valetudo-robot1.local");
  await expect(sheet.locator("datalist#robot-urls option")).toHaveAttribute("value", "http://valetudo-robot1.local");
  await sheet.locator("[data-field=robot-url]").fill("http://unreachable.test");
  await sheet.getByRole("button", { name: "Pobierz", exact: true }).click();
  await expect(sheet.locator(".notice.error")).toContainText("Nie udało się pobrać mapy z robota");
  await sheet.locator("[data-robot=Robot1]").click();
  await expect(sheet.locator("[data-field=source]")).toHaveText("Rozpoznano: mapa z odkurzacza Valetudo");
  await expect(sheet.locator("outglow-plan-view polygon.room")).toHaveCount(4);
});

test("a room drawn after removing one never takes its id", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas")).toBeVisible();
  let v = await view(page);
  const inside = screen(v, 2.4, 6.6);
  await page.mouse.click(inside[0], inside[1]);
  await expect(editor.locator("[data-field=room-name]")).toHaveValue("Office");
  await editor.getByRole("button", { name: "Delete room" }).click();
  for (const _ of [1, 2]) {
    await editor.locator("[data-tool=rect]").click();
    v = await view(page);
    await drag(page, screen(v, 2.02, 4.03), screen(v, 4.98, 6.98));
    await expect(editor.locator("[data-field=room-name]")).toHaveValue("Room 3");
    if (_ === 1) await editor.getByRole("button", { name: "Delete room" }).click();
  }
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  const plan = await page.evaluate(
    () => (document.querySelector("outglow-panel") as unknown as { _plan: { rooms: { id: string }[]; retired_rooms: string[] } })._plan,
  );
  expect(plan.rooms.map((r) => r.id)).toEqual(["living", "hall", "room_3_2"]);
  expect(plan.retired_rooms).toEqual(["office", "room_3"]);
});

async function panelPlan(page: Page): Promise<{ rooms: { id: string; name: string }[]; retired_rooms: string[] }> {
  return page.evaluate(
    () => (document.querySelector("outglow-panel") as unknown as { _plan: { rooms: { id: string; name: string }[]; retired_rooms: string[] } })._plan,
  );
}

async function deleteOfficeAndSave(page: Page): Promise<void> {
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas")).toBeVisible();
  const v = await view(page);
  const inside = screen(v, 2.4, 6.6);
  await page.mouse.click(inside[0], inside[1]);
  await expect(editor.locator("[data-field=room-name]")).toHaveValue("Office");
  await editor.getByRole("button", { name: "Delete room" }).click();
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  expect((await panelPlan(page)).retired_rooms).toEqual(["office"]);
}

test("undoing a saved room removal brings the room back as a new room that saves", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await deleteOfficeAndSave(page);
  await editor.getByRole("button", { name: "Undo" }).click();
  await expect(editor.locator("outglow-editor-canvas text.room-name", { hasText: "Office" })).toBeVisible();
  await expect(page.locator("outglow-panel .toast")).toContainText("Office: a room with this id was removed and saved");
  const v = await view(page);
  const inside = screen(v, 2.4, 6.6);
  await page.mouse.click(inside[0], inside[1]);
  await expect(editor.locator("[data-field=room-name]")).toHaveValue("Office");
  await expect(editor.locator("[data-field=new-entities]")).toContainText("binary_sensor.outglow_room_office_2_occupancy");
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  await expect(page.locator("outglow-panel .toast.error")).toHaveCount(0);
  const plan = await panelPlan(page);
  expect(plan.rooms.map((r) => r.id)).toEqual(["living", "hall", "office_2"]);
  expect(plan.retired_rooms).toEqual(["office"]);
  await editor.getByRole("button", { name: "Redo" }).click();
  await expect(editor.locator("outglow-editor-canvas text.room-name", { hasText: "Office" })).toHaveCount(0);
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  await expect(page.locator("outglow-panel .toast.error")).toHaveCount(0);
  expect((await panelPlan(page)).retired_rooms).toEqual(["office", "office_2"]);
});

test("importing an older export with a removed room renames it and saves", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  const original = await panelPlan(page);
  await deleteOfficeAndSave(page);
  await editor.getByRole("button", { name: "Import" }).click();
  await editor.locator("og-sheet textarea").fill(JSON.stringify({ ...original, retired_rooms: [] }));
  await editor.locator("og-sheet").getByRole("button", { name: "Preview" }).click();
  await editor.locator("og-sheet").getByRole("button", { name: "Use this plan" }).click();
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  await expect(page.locator("outglow-panel .toast")).toContainText("Office: a room with this id was removed and saved");
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  await expect(page.locator("outglow-panel .toast.error")).toHaveCount(0);
  const plan = await panelPlan(page);
  expect(plan.rooms.map((r) => r.id)).toEqual(["living", "hall", "office_2"]);
  expect(plan.retired_rooms).toEqual(["office"]);
});

test("importing a plan without a room and undoing it saves", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  const original = await panelPlan(page);
  const smaller = { ...original, rooms: original.rooms.filter((r) => r.id !== "office"), adjacent: [["living", "hall"]], bulbs: [] };
  await editor.getByRole("button", { name: "Import" }).click();
  await editor.locator("og-sheet textarea").fill(JSON.stringify(smaller));
  await editor.locator("og-sheet").getByRole("button", { name: "Preview" }).click();
  await editor.locator("og-sheet").getByRole("button", { name: "Use this plan" }).click();
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(2);
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  expect((await panelPlan(page)).retired_rooms).toEqual(["office"]);
  await editor.getByRole("button", { name: "Undo" }).click();
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  await expect(page.locator("outglow-panel .toast.error")).toHaveCount(0);
  expect((await panelPlan(page)).rooms.map((r) => r.id)).toEqual(["living", "hall", "office_2"]);
});

test("a rejected save says the plan was not saved", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await page.evaluate(() => {
    const panel = document.querySelector("outglow-panel") as unknown as {
      hass: { connection: { sendMessagePromise: (m: { type: string }) => Promise<unknown> } };
    };
    const connection = panel.hass.connection;
    const real = connection.sendMessagePromise.bind(connection);
    connection.sendMessagePromise = (message) =>
      message.type === "outglow/plan/save" ? Promise.reject({ code: "invalid_format", message: "Room id office belonged to a removed room" }) : real(message);
  });
  const v = await view(page);
  const inside = screen(v, 2.4, 6.6);
  await page.mouse.click(inside[0], inside[1]);
  await editor.locator("[data-field=room-name]").fill("Study");
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(page.locator("outglow-panel .toast.error")).toHaveText("The plan was not saved: Room id office belonged to a removed room");
});

type ServerPlan = { rooms: { id: string; name: string; outline: [number, number][] }[]; retired_rooms: string[]; adjacent: [string, string][]; bulbs: { room: string | null }[] };

async function send<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    (m) =>
      (document.querySelector("outglow-panel") as unknown as { hass: { connection: { sendMessagePromise: (m: unknown) => Promise<unknown> } } }).hass.connection.sendMessagePromise(m),
    message,
  ) as Promise<T>;
}

async function otherClientSaves(page: Page, change: (plan: ServerPlan) => ServerPlan): Promise<void> {
  const got = await send<{ rev: number; plan: ServerPlan }>(page, { type: "outglow/plan/get" });
  await send(page, { type: "outglow/plan/save", rev: got.rev, plan: change(got.plan) });
}

async function serverPlan(page: Page): Promise<ServerPlan> {
  return (await send<{ plan: ServerPlan }>(page, { type: "outglow/plan/get" })).plan;
}

async function keepMine(page: Page): Promise<void> {
  const editor = page.locator("outglow-plan-editor");
  await editor.getByRole("button", { name: /^Save/ }).click();
  await editor.getByRole("button", { name: "Keep mine" }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  await expect(page.locator("outglow-panel .toast.error")).toHaveCount(0);
}

test("keeping my plan after another client removed a room saves it, and later saves work", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  await otherClientSaves(page, (plan) => ({
    ...plan,
    rooms: plan.rooms.filter((r) => r.id !== "office"),
    adjacent: plan.adjacent.filter((pair) => !pair.includes("office")),
    bulbs: plan.bulbs.map((b) => (b.room === "office" ? { ...b, room: null } : b)),
  }));
  let v = await view(page);
  const living = screen(v, 1, 1);
  await page.mouse.click(living[0], living[1]);
  await editor.locator("[data-field=room-name]").fill("Lounge");
  await keepMine(page);
  let server = await serverPlan(page);
  expect(server.rooms.map((r) => r.id)).toEqual(["living", "hall", "office_2"]);
  expect(server.retired_rooms).toEqual(["office"]);
  expect((await panelPlan(page)).retired_rooms).toEqual(["office"]);
  v = await view(page);
  const office = screen(v, 2.4, 6.6);
  await page.mouse.click(office[0], office[1]);
  await editor.locator("[data-field=room-name]").fill("Study");
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  await expect(page.locator("outglow-panel .toast.error")).toHaveCount(0);
  server = await serverPlan(page);
  expect(server.rooms.map((r) => [r.id, r.name])).toEqual([
    ["living", "Lounge"],
    ["hall", "Hall"],
    ["office_2", "Study"],
  ]);
});

test("keeping my plan when both clients drew a room with the same id gives mine a new id", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  await otherClientSaves(page, (plan) => ({
    ...plan,
    rooms: [...plan.rooms, { ...plan.rooms[0]!, id: "room_4", name: "Room 4", outline: [[8, 6], [10, 6], [10, 8], [8, 8]] }],
  }));
  await editor.locator("[data-tool=rect]").click();
  const v = await view(page);
  await drag(page, screen(v, 7.02, 0.03), screen(v, 9.98, 3.04));
  await expect(editor.locator("[data-field=room-name]")).toHaveValue("Room 4");
  await keepMine(page);
  const server = await serverPlan(page);
  expect(server.rooms.map((r) => r.id)).toEqual(["living", "hall", "office", "room_4_2"]);
  expect(server.retired_rooms).toEqual(["room_4"]);
  expect((await panelPlan(page)).retired_rooms).toEqual(["room_4"]);
});

test("a room that leaves the plan by any edit is retired before the save", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  const retired = await page.evaluate(() => {
    const panel = document.querySelector("outglow-panel")!;
    const ed = panel.shadowRoot!.querySelector("outglow-plan-editor") as unknown as {
      _commit(plan: unknown): void;
      _history: { present: { rooms: { id: string }[]; adjacent: string[][]; retired_rooms: string[] } };
    };
    const present = ed._history.present;
    ed._commit({ ...present, rooms: present.rooms.filter((r) => r.id !== "office"), adjacent: present.adjacent.filter((p) => !p.includes("office")) });
    return ed._history.present.retired_rooms;
  });
  expect(retired).toEqual(["office"]);
});

test("keep mine says before and after what it removes and which rooms get new ids", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  await otherClientSaves(page, (plan) => ({
    ...plan,
    rooms: [...plan.rooms, { ...plan.rooms[0]!, id: "room_4", name: "Kitchen", outline: [[8, 6], [10, 6], [10, 8], [8, 8]] }],
  }));
  await otherClientSaves(page, (plan) => ({
    ...plan,
    rooms: plan.rooms.filter((r) => r.id !== "office"),
    adjacent: plan.adjacent.filter((pair) => !pair.includes("office")),
    bulbs: plan.bulbs.map((b) => (b.room === "office" ? { ...b, room: null } : b)),
  }));
  const v = await view(page);
  const living = screen(v, 1, 1);
  await page.mouse.click(living[0], living[1]);
  await editor.locator("[data-field=room-name]").fill("Lounge");
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.locator(".keep-mine")).toHaveText(["Keep mine removes: Kitchen.", "Keep mine gives new ids and new entities (new entity_id) to: Office."]);
  await editor.getByRole("button", { name: "Keep mine" }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  await expect(page.locator("outglow-panel .toast")).toHaveText("Saved");
  await expect(editor.locator(".banner.renamed")).toContainText("Office: a room with this id was removed and saved");
  await page.waitForTimeout(3500);
  await expect(editor.locator(".banner.renamed")).toBeVisible();
  await editor.locator(".banner.renamed").getByRole("button", { name: "Got it" }).click();
  await expect(editor.locator(".banner.renamed")).toHaveCount(0);
});

test("importing the saved export after removing a room without saving brings the room back under its id", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  const original = await serverPlan(page);
  const v = await view(page);
  const inside = screen(v, 2.4, 6.6);
  await page.mouse.click(inside[0], inside[1]);
  await expect(editor.locator("[data-field=room-name]")).toHaveValue("Office");
  await editor.getByRole("button", { name: "Delete room" }).click();
  await editor.getByRole("button", { name: "Import" }).click();
  await editor.locator("og-sheet textarea").fill(JSON.stringify(original));
  await editor.locator("og-sheet").getByRole("button", { name: "Preview" }).click();
  await editor.locator("og-sheet").getByRole("button", { name: "Use this plan" }).click();
  await expect(page.locator("outglow-panel .toast")).toHaveText("Plan imported. Review it and save.");
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  const server = await serverPlan(page);
  expect(server.rooms.map((r) => r.id)).toEqual(["living", "hall", "office"]);
  expect(server.retired_rooms).toEqual([]);
});

test("a room drawn while the stored plan is unreadable never takes an old room's id", async ({ page }) => {
  await open(page, "/plan", { width: 1440, reserved: ["room_4"] });
  const editor = page.locator("outglow-plan-editor");
  await expect(editor.locator("outglow-editor-canvas text.room-name")).toHaveCount(3);
  await editor.locator("[data-tool=rect]").click();
  const v = await view(page);
  await drag(page, screen(v, 7.02, 0.03), screen(v, 9.98, 3.04));
  await expect(editor.locator("[data-field=room-name]")).toHaveValue("Room 4");
  await editor.getByRole("button", { name: /^Save/ }).click();
  await expect(editor.getByRole("button", { name: /Saved/ })).toBeDisabled();
  expect((await serverPlan(page)).rooms.map((r) => r.id)).toEqual(["living", "hall", "office", "room_4_2"]);
});

test("a plan file without an extension is read as Outglow JSON", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  const original = await serverPlan(page);
  await editor.getByRole("button", { name: "Import" }).click();
  const input = editor.locator("og-sheet input[type=file]");
  expect(await input.getAttribute("accept")).toBeNull();
  await input.setInputFiles({ name: "outglow.plan.corrupt-20261121T000000000000Z", mimeType: "application/octet-stream", buffer: Buffer.from(JSON.stringify(original)) });
  await expect(editor.locator("og-sheet").getByRole("button", { name: "Use this plan" })).toBeVisible();
  await expect(editor.locator("og-sheet [data-field=source]")).toHaveText("Recognised: an Outglow plan");
});

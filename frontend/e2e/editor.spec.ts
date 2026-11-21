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

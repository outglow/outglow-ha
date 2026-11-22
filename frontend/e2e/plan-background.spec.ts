import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { open } from "./helpers";

const VALETUDO = new URL("../../tests/fixtures/valetudo/flat.json", import.meta.url).pathname;

interface Saved {
  file: string;
  x: number;
  y: number;
  m_per_px: number;
  opacity: number;
  width: number;
  height: number;
}

async function saved(page: Page): Promise<Saved> {
  return page.evaluate(async () => {
    type Connection = { sendMessagePromise: (m: object) => Promise<Record<string, unknown>> };
    const panel = document.querySelector("outglow-panel") as unknown as { hass: { connection: Connection } };
    const send = (type: string) => panel.hass.connection.sendMessagePromise({ type });
    const plan = (await send("outglow/plan/get")).plan as { background: Omit<Saved, "width" | "height"> };
    const image = (await send("outglow/plan/background/get")).image as { data_base64: string };
    const text = atob(image.data_base64);
    const size = (name: string) => Number(new RegExp(`${name}="(\\d+)"`).exec(text)![1]);
    return { ...plan.background, width: size("width"), height: size("height") };
  });
}

async function expectPlaced(image: Locator, placed: Saved): Promise<void> {
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("href", /^data:image\/svg\+xml;base64,/);
  const attr = async (name: string) => Number(await image.getAttribute(name));
  expect(await attr("x")).toBeCloseTo(placed.x, 6);
  expect(await attr("y")).toBeCloseTo(placed.y, 6);
  expect(await attr("width")).toBeCloseTo(placed.width * placed.m_per_px, 6);
  expect(await attr("height")).toBeCloseTo(placed.height * placed.m_per_px, 6);
  expect(await attr("opacity")).toBeCloseTo(placed.opacity, 6);
}

async function coversRooms(image: Locator, rooms: Locator): Promise<void> {
  const box = (await image.boundingBox())!;
  expect(box.width).toBeGreaterThan(100);
  expect(box.height).toBeGreaterThan(100);
  for (const room of await rooms.all()) {
    const r = (await room.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(box.x - 2);
    expect(r.y).toBeGreaterThanOrEqual(box.y - 2);
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 2);
    expect(r.y + r.height).toBeLessThanOrEqual(box.y + box.height + 2);
  }
}

test("the saved background of a Valetudo map is drawn under the plan in the editor and on Live", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const editor = page.locator("outglow-plan-editor");
  const canvas = editor.locator("outglow-editor-canvas");
  await expect(canvas.locator("image.backdrop")).toHaveCount(0);
  await expect(editor.locator("[data-action=background]")).toHaveCount(0);
  await editor.getByRole("button", { name: "Import" }).click();
  const sheet = editor.locator("og-sheet");
  const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await sheet.locator(".file").click();
  await (await chooser).setFiles({ name: "map.json", mimeType: "application/json", buffer: readFileSync(VALETUDO) });
  await expect(sheet.locator("[data-field=source]")).toHaveText("Recognised: a Valetudo vacuum map");
  await sheet.getByRole("button", { name: "Use this plan" }).click();
  await expect(canvas.locator("image.backdrop")).toHaveCount(1);

  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("button", { name: "Saved" })).toBeVisible();
  const placed = await saved(page);
  expect(placed.file).toMatch(/^plan-[0-9a-f]{16}\.svg$/);
  await expectPlaced(canvas.locator("image.backdrop"), placed);
  await coversRooms(canvas.locator("image.backdrop"), canvas.locator("polygon.room"));
  await expect(canvas.locator("image.backdrop")).not.toHaveClass(/dark/);

  const toggle = editor.locator("[data-action=background]");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(canvas.locator("image.backdrop")).toHaveCount(0);
  await toggle.click();
  await expect(canvas.locator("image.backdrop")).toHaveCount(1);

  await page.locator("outglow-panel .appbar [role=tab]", { hasText: "Live" }).click();
  const live = page.locator("outglow-live-view outglow-plan-view");
  await expectPlaced(live.locator("image.backdrop"), placed);
  await coversRooms(live.locator("image.backdrop"), live.locator("polygon.room"));

  await page.locator("outglow-live-view").getByRole("button", { name: "Layers" }).click();
  const layer = page.locator("outglow-live-view .layers-pop label", { hasText: "Background" }).locator("input");
  await expect(layer).toBeChecked();
  await layer.uncheck();
  await expect(live.locator("image.backdrop")).toHaveCount(0);
  await layer.check();
  await expect(live.locator("image.backdrop")).toHaveCount(1);

  await page.locator("#theme").evaluate((button: HTMLButtonElement) => button.click());
  await expect(live.locator("image.backdrop")).toHaveClass(/dark/);
  expect(await live.locator("image.backdrop").evaluate((el) => getComputedStyle(el).filter)).toContain("invert");
  await page.locator("outglow-panel .appbar [role=tab]", { hasText: "Plan" }).click();
  await expect(canvas.locator("image.backdrop")).toHaveClass(/dark/);
  await expectPlaced(canvas.locator("image.backdrop"), placed);
});

test("a plan without a background shows neither the image nor its switches", async ({ page }) => {
  await open(page, "/live", { width: 1440 });
  await page.locator("outglow-live-view").getByRole("button", { name: "Layers" }).click();
  await expect(page.locator("outglow-live-view .layers-pop label")).toHaveCount(4);
  await expect(page.locator("outglow-live-view image.backdrop")).toHaveCount(0);
});

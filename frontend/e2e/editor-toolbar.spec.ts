import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { open, screen, view } from "./helpers";

function editor(page: Page): Locator {
  return page.locator("outglow-plan-editor");
}

async function makeDirty(page: Page): Promise<void> {
  const v = await view(page);
  await page.mouse.click(...screen(v, 1, 3));
  await page.keyboard.press("ArrowRight");
  await expect(editor(page).getByRole("button", { name: "Undo" }).or(editor(page).getByRole("button", { name: "Cofnij" }))).toBeEnabled();
}

for (const lang of ["en", "pl"] as const) {
  test(`the toolbar fits in two rows at 390 px with unsaved changes (${lang})`, async ({ page }) => {
    await open(page, "/plan", { width: 390, lang });
    await makeDirty(page);
    const toolbar = editor(page).locator(".toolbar");
    await expect(toolbar.locator(".state")).toBeHidden();
    const tools = (await toolbar.locator(".tools").boundingBox())!;
    const save = (await toolbar.locator("[data-action=save]").boundingBox())!;
    const box = (await toolbar.boundingBox())!;
    expect(save.y).toBeGreaterThan(tools.y + tools.height - 1);
    expect(box.height).toBeLessThan(120);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
}

test("at 390 px import and export sit in the more menu", async ({ page }) => {
  await open(page, "/plan", { width: 390 });
  const toolbar = editor(page).locator(".toolbar");
  await expect(toolbar.getByRole("button", { name: "Import" })).toBeHidden();
  const more = toolbar.getByRole("button", { name: "More" });
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const downloading = page.waitForEvent("download");
  await toolbar.getByRole("menuitem", { name: "Export" }).click();
  const download = await downloading;
  const saved = JSON.parse(await readFile((await download.path())!, "utf8")) as { rooms: unknown[] };
  expect(saved.rooms).toHaveLength(3);
  await expect(toolbar.getByRole("menu")).toHaveCount(0);
  await more.click();
  await page.keyboard.press("Escape");
  await expect(toolbar.getByRole("menu")).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await toolbar.getByRole("menuitem", { name: "Import" }).click();
  await expect(editor(page).locator("og-sheet[open]")).toHaveCount(1);
});

test("at 1440 px import and export are plain buttons", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const toolbar = editor(page).locator(".toolbar");
  await expect(toolbar.getByRole("button", { name: "Import" })).toBeVisible();
  await expect(toolbar.locator("[data-action=export]")).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "More" })).toBeHidden();
});

test.describe("export in the Home Assistant app", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { getExternalAuth: { postMessage() {} } } };
    });
  });

  test("hands the plan to the share sheet as a file", async ({ page }) => {
    await page.addInitScript(() => {
      const nav = navigator as unknown as Record<string, unknown>;
      nav.canShare = (data: { files?: File[] }) => Boolean(data.files?.length);
      nav.share = async (data: { files: File[] }) => {
        (window as unknown as { shared: unknown }).shared = { name: data.files[0]!.name, type: data.files[0]!.type, text: await data.files[0]!.text() };
      };
    });
    await open(page, "/plan", { width: 1440 });
    let downloaded = false;
    page.on("download", () => (downloaded = true));
    await editor(page).locator("[data-action=export]").click();
    await page.waitForFunction(() => Boolean((window as unknown as { shared?: unknown }).shared), undefined, { timeout: 5000 });
    const shared = await page.evaluate(() => (window as unknown as { shared: { name: string; type: string; text: string } }).shared);
    expect(shared.name).toMatch(/^outglow-plan-\d{4}-\d{2}-\d{2}\.json$/);
    expect(shared.type).toBe("application/json");
    expect((JSON.parse(shared.text) as { rooms: unknown[] }).rooms).toHaveLength(3);
    expect(downloaded).toBe(false);
  });

  test("shows the plan to copy when files cannot be shared", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => {
      (navigator as unknown as Record<string, unknown>).canShare = undefined;
    });
    await open(page, "/plan", { width: 1440 });
    await editor(page).locator("[data-action=export]").click();
    const sheet = editor(page).locator("og-sheet[open]");
    await expect(sheet).toHaveCount(1);
    const text = await sheet.locator("textarea").inputValue();
    expect((JSON.parse(text) as { rooms: unknown[] }).rooms).toHaveLength(3);
    await sheet.getByRole("button", { name: "Copy" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  });
});

test("export in a frame from another origin still downloads the plan", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route("http://outer.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><iframe src="http://inner.test/outglow/plan?theme=light&lang=en&shot=1&latency=20" style="width:1400px;height:860px;border:0"></iframe>`,
    }),
  );
  await page.route("http://inner.test/**", async (route) => {
    const response = await route.fetch({ url: route.request().url().replace("http://inner.test", baseURL!) });
    await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://outer.test/");
  const frame = page.frameLocator("iframe");
  const button = frame.locator("outglow-plan-editor [data-action=export]");
  await expect(button).toBeVisible();
  const downloading = page.waitForEvent("download", { timeout: 10_000 });
  await button.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^outglow-plan-\d{4}-\d{2}-\d{2}\.json$/);
  expect(errors).toEqual([]);
});

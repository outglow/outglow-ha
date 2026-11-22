import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { screen, view } from "./helpers";

const T0 = Date.UTC(2026, 10, 20, 17, 30, 0);
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const STEP_MS = 100;
const FRAMES = process.env.OUTGLOW_FRAMES ?? "test-results/docs-frames";
const VALETUDO = new URL("../../tests/fixtures/valetudo/flat.json", import.meta.url).pathname;
const SHOT = { animations: "disabled", caret: "hide", maxDiffPixels: 150, threshold: 0.2 } as const;

type Theme = "light" | "dark";
type Size = { width: number; height: number };

test.skip(!process.env.OUTGLOW_DOCS, "documentation images: npm run shots -- --docs or --check");
test.use({ timezoneId: "UTC", locale: "en-GB", deviceScaleFactor: 1 });
test.describe.configure({ mode: "parallel" });

async function run(page: Page, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= STEP_MS) {
    await page.clock.runFor(Math.min(STEP_MS, left));
  }
}

async function until(page: Page, target: Locator, limitMs = 30_000): Promise<void> {
  for (let spent = 0; spent <= limitMs; spent += STEP_MS) {
    if (await target.first().isVisible()) {
      return;
    }
    await page.clock.runFor(STEP_MS);
  }
  await expect(target.first()).toBeVisible({ timeout: 1 });
}

async function start(page: Page, url: string, size: Size): Promise<void> {
  await page.setViewportSize(size);
  await page.clock.install({ time: T0 - 10_000 });
  await page.clock.pauseAt(T0);
  await page.goto(url);
}

async function panel(page: Page, path: string, theme: Theme, size: Size): Promise<void> {
  await start(page, `/outglow${path}?theme=${theme}&lang=en&shot=1&latency=20`, size);
  await until(page, page.locator("outglow-panel main"));
  for (let spent = 0; spent < 10_000; spent += STEP_MS) {
    const busy = await page.evaluate(() => Boolean(document.querySelector("outglow-panel")?.shadowRoot?.querySelector("[aria-busy=true]")));
    if (!busy) break;
    await page.clock.runFor(STEP_MS);
  }
  await run(page, 1000);
}

async function settle(page: Page): Promise<void> {
  await run(page, 600);
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page);
  await expect(page).toHaveScreenshot(`${name}.png`, SHOT);
}

async function frames(name: string): Promise<string> {
  const dir = `${FRAMES}/${name}`;
  await mkdir(dir, { recursive: true });
  return dir;
}

function frameName(dir: string, i: number): string {
  return `${dir}/${String(i).padStart(4, "0")}.png`;
}

function button(page: Page, name: string): Locator {
  return page.getByRole("button", { name, exact: true });
}

async function press(page: Page, name: string): Promise<void> {
  const target = button(page, name);
  await until(page, target);
  await target.click();
  await run(page, 300);
}

for (const theme of ["dark"] as const) {
  test(`live desktop ${theme}`, async ({ page }) => {
    await panel(page, "/live", theme, DESKTOP);
    await run(page, 15_000);
    await expect(page.locator("outglow-live-view .badge.motion").first()).toBeVisible();
    await shoot(page, `live-desktop-${theme}`);
  });
}

test("live phone", async ({ page }) => {
  await panel(page, "/live", "dark", PHONE);
  await run(page, 15_000);
  await shoot(page, "live-phone-dark");
});

test("plan editor with a room selected", async ({ page }) => {
  await panel(page, "/plan", "dark", DESKTOP);
  const editor = page.locator("outglow-plan-editor");
  await until(page, editor.locator("outglow-editor-canvas"));
  const v = await view(page);
  const [x, y] = screen(v, 1, 3);
  await page.mouse.click(x, y);
  await until(page, editor.locator("outglow-editor-canvas g.grip"));
  await page.mouse.move(10, v.top + v.h - 10);
  await shoot(page, "plan-editor-desktop-dark");
});

test("import from a Valetudo vacuum map", async ({ page }) => {
  await panel(page, "/plan", "dark", { width: 1280, height: 900 });
  const editor = page.locator("outglow-plan-editor");
  await press(page, "Import");
  const sheet = editor.locator("og-sheet");
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
  await sheet.locator(".file").click();
  await (await chooser).setFiles({ name: "map.json", mimeType: "application/json", buffer: readFileSync(VALETUDO) });
  await until(page, sheet.locator("[data-field=source]"));
  await expect(sheet.locator("[data-field=source]")).toHaveText("Recognised: a Valetudo vacuum map");
  await sheet.locator("[data-field=keep-bulbs]").uncheck();
  await sheet.getByRole("button", { name: "Preview" }).click();
  await until(page, sheet.locator("outglow-plan-view polygon.room"));
  await settle(page);
  await sheet.locator("outglow-plan-view").scrollIntoViewIfNeeded();
  await shoot(page, "import-valetudo-desktop-dark");
});

async function wizardToWalk(page: Page): Promise<void> {
  await press(page, "Start learning");
  await press(page, "I'm leaving");
  await run(page, 4000);
  await press(page, "I'm back");
  await until(page, page.getByRole("heading", { name: "Walk along the walls and past the door" }));
  await press(page, "Next");
  await until(page, page.getByRole("heading", { name: "Walk freely around the room" }));
}

test("learning wizard step on a phone", async ({ page }) => {
  await panel(page, "/learn", "dark", PHONE);
  await wizardToWalk(page);
  await run(page, 12_000);
  await until(page, page.getByText("I can see you", { exact: true }));
  await shoot(page, "wizard-step-phone-dark");
});

test("learning wizard summary on a phone", async ({ page }) => {
  await panel(page, "/learn", "dark", PHONE);
  await wizardToWalk(page);
  for (let room = 0; room < 3; room += 1) {
    if (room > 0) {
      await until(page, page.getByRole("heading", { name: "Walk along the walls and past the door" }));
      await press(page, "Next");
    }
    await run(page, 8000);
    await press(page, "Next");
    await until(page, page.getByRole("heading", { name: "Sit where you usually sit" }));
    await run(page, 4000);
    await press(page, "Next");
    await press(page, room < 2 ? "I'm there" : "Finish");
  }
  await until(page, page.getByRole("heading", { name: "How well Outglow recognises your rooms" }));
  await page.getByRole("radio", { name: "Bayes", exact: true }).click();
  await settle(page);
  await expect(page).toHaveScreenshot("wizard-summary-phone-dark.png", { ...SHOT, fullPage: true });
});

test("quality", async ({ page }) => {
  await panel(page, "/quality", "dark", DESKTOP);
  await shoot(page, "quality-desktop-dark");
});

test("room settings", async ({ page }) => {
  await panel(page, "/settings/hall", "dark", DESKTOP);
  await shoot(page, "settings-desktop-dark");
});

test("history", async ({ page }) => {
  await panel(page, "/history", "dark", DESKTOP);
  await run(page, 3000);
  await shoot(page, "history-desktop-dark");
});

for (const [theme, size, label] of [
  ["dark", { width: 1280, height: 560 }, "desktop"],
  ["dark", PHONE, "phone"],
] as const) {
  test(`card ${label}`, async ({ page }) => {
    await start(page, `/card.html?theme=${theme}&lang=en&shot=1&latency=20`, size);
    await run(page, 15_000);
    await until(page, page.locator("outglow-map-card .room.on"));
    await shoot(page, `card-${label}-${theme}`);
  });
}

test("animation: live motion", async ({ page }) => {
  test.skip(process.env.OUTGLOW_DOCS !== "write", "animations are only written, not compared");
  await panel(page, "/live", "dark", DESKTOP);
  await run(page, 2500);
  const card = page.locator("outglow-live-view section.card.map");
  const box = (await card.boundingBox())!;
  const dir = await frames("live");
  for (let i = 0; i < 64; i += 1) {
    await run(page, 200);
    await page.screenshot({ path: frameName(dir, i), clip: box });
  }
});

test("animation: dragging a wall", async ({ page }) => {
  test.skip(process.env.OUTGLOW_DOCS !== "write", "animations are only written, not compared");
  await panel(page, "/plan", "dark", DESKTOP);
  const editor = page.locator("outglow-plan-editor");
  await until(page, editor.locator("outglow-editor-canvas"));
  const v = await view(page);
  const canvas = editor.locator("outglow-editor-canvas");
  const box = (await canvas.boundingBox())!;
  const dir = await frames("wall");
  let i = 0;
  const snap = async (): Promise<void> => {
    await settle(page);
    await page.screenshot({ path: frameName(dir, i), clip: box });
    i += 1;
  };
  const [cx, cy] = screen(v, 1, 3);
  await page.mouse.move(cx, cy);
  await snap();
  await page.mouse.click(cx, cy);
  await snap();
  await snap();
  const from = screen(v, 5, 1);
  await page.mouse.move(from[0], from[1], { steps: 6 });
  await snap();
  await page.mouse.down();
  const path: [number, number][] = [];
  for (let k = 1; k <= 12; k += 1) path.push([5 + (0.9 * k) / 12, 1]);
  for (let k = 11; k >= 0; k -= 1) path.push([5 - 0.6 + (0.6 * k) / 12, 1]);
  for (const [x, y] of path) {
    const [sx, sy] = screen(v, x, y);
    await page.mouse.move(sx, sy, { steps: 2 });
    await snap();
  }
  await page.mouse.up();
  for (let k = 0; k < 6; k += 1) await snap();
});

test("animation: learning wizard", async ({ page }) => {
  test.skip(process.env.OUTGLOW_DOCS !== "write", "animations are only written, not compared");
  await panel(page, "/learn", "dark", PHONE);
  const dir = await frames("wizard");
  let i = 0;
  const snap = async (): Promise<void> => {
    await page.screenshot({ path: frameName(dir, i) });
    i += 1;
  };
  await snap();
  await press(page, "Start learning");
  await snap();
  await press(page, "I'm leaving");
  for (let k = 0; k < 4; k += 1) {
    await run(page, 1000);
    await snap();
  }
  await press(page, "I'm back");
  await until(page, page.getByRole("heading", { name: "Walk along the walls and past the door" }));
  for (let k = 0; k < 6; k += 1) {
    await run(page, 1000);
    await snap();
  }
  await press(page, "Next");
  await until(page, page.getByRole("heading", { name: "Walk freely around the room" }));
  for (let k = 0; k < 12; k += 1) {
    await run(page, 1000);
    await snap();
  }
});

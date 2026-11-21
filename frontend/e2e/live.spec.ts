import { expect, test } from "@playwright/test";
import { open } from "./helpers";

test("live view shows motion, opens a pair and a room", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, "/live");
  const live = page.locator("outglow-live-view");
  await expect(live.locator(".badge.motion").first()).toBeVisible({ timeout: 20_000 });
  const pair = live.locator("outglow-plan-view .hit-line[tabindex='0']").first();
  await pair.focus();
  await page.keyboard.press("Enter");
  await expect(live.locator("og-sheet[open] dialog")).toBeVisible();
  const sheet = live.locator("og-sheet[open]");
  await expect(sheet).toContainText("hears");
  await expect(sheet).toContainText("Learnt sensitivity");
  await page.keyboard.press("Escape");
  await expect(live.locator("og-sheet[open]")).toHaveCount(0);
  await live.locator(".rooms button", { hasText: "Hall" }).click();
  await expect(live.locator("og-sheet[open]")).toContainText("Coverage");
  await live.locator("og-sheet[open] button", { hasText: "Room settings" }).click();
  await expect(page).toHaveURL(/\/outglow\/settings\/hall/);
  expect(errors).toEqual([]);
});

test("layers can be switched off and the legend follows", async ({ page }) => {
  await open(page, "/live");
  const live = page.locator("outglow-live-view");
  await expect(live.locator(".legend")).toContainText("heat");
  await live.getByRole("button", { name: "Layers" }).click();
  await live.locator(".layers-pop label", { hasText: "Heat" }).locator("input").uncheck();
  await expect(live.locator(".legend")).not.toContainText("heat");
  await live.locator(".layers-pop label", { hasText: "Heat" }).locator("input").check();
});

test("tabs follow the keyboard and the route", async ({ page }) => {
  await open(page, "/live", { lang: "pl" });
  const tab = page.locator("outglow-panel .appbar [role=tab][aria-selected=true]");
  await expect(tab).toHaveText(/Na żywo/);
  await tab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/\/outglow\/plan/);
  await expect(page.locator("outglow-panel .appbar [role=tab][aria-selected=true]")).toHaveText(/Plan/);
});

test("phone layout puts rooms above the plan without horizontal scroll", async ({ page }) => {
  await open(page, "/live", { width: 390, reducedMotion: true, theme: "dark" });
  await expect(page.locator("outglow-live-view .pills")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

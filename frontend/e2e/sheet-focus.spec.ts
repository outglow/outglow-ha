import { expect, test, type Locator, type Page } from "@playwright/test";
import { open } from "./helpers";

function editor(page: Page): Locator {
  return page.locator("outglow-plan-editor");
}

async function ringless(page: Page): Promise<void> {
  const sheet = editor(page).locator("og-sheet[open]");
  await expect(sheet.locator("dialog[open]")).toBeVisible();
  const state = await sheet.evaluate((el) => {
    const root = el.shadowRoot!;
    const active = root.activeElement as HTMLElement | null;
    const ringed = [...root.querySelectorAll<HTMLElement>("dialog, button")].filter((b) => b.matches(":focus-visible") || getComputedStyle(b).outlineStyle !== "none");
    return { active: active?.tagName ?? null, ringed: ringed.map((b) => b.getAttribute("aria-label") ?? b.tagName) };
  });
  expect(state.ringed).toEqual([]);
  expect(state.active).toBe("DIALOG");
}

test("a sheet opened with the mouse has no focus ring on its close button", async ({ page, browserName }) => {
  await open(page, "/plan", { width: 1440 });
  await editor(page).getByRole("button", { name: "Import" }).click();
  await ringless(page);
  if (browserName !== "webkit") {
    await page.keyboard.press("Tab");
    await expect(editor(page).locator("og-sheet[open]").getByRole("button", { name: "Close" })).toBeFocused();
  }
});

test.describe("by touch", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("a sheet opened by a tap has no focus ring on its close button", async ({ page }) => {
    await open(page, "/plan", { width: 390 });
    const more = editor(page).locator("[data-action=more]");
    let box = (await more.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    const item = editor(page).getByRole("menuitem", { name: "Import" });
    box = (await item.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await ringless(page);
  });
});

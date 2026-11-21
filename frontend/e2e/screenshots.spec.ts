import { expect, test } from "@playwright/test";
import { THEMES, WIDTHS, open } from "./helpers";

const TABS = ["live", "plan", "learn", "quality", "settings", "history"] as const;
const LANG = (process.env.SHOT_LANG ?? "pl") as "en" | "pl";

for (const tab of TABS) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`${tab} ${theme} ${width}`, async ({ page }) => {
        await open(page, `/${tab}`, { theme, width, lang: LANG });
        if (tab === "live") {
          await expect(page.locator("outglow-live-view").locator(".badge.motion, .pill.on").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
          await page.waitForTimeout(900);
        } else {
          await page.waitForTimeout(1800);
        }
        await page.screenshot({ path: `screenshots/${tab}-${theme}-${width}.png`, fullPage: true });
      });
    }
  }
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`card ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/card.html?theme=${theme}&lang=${LANG}&shot=1&latency=20`);
      await expect(page.locator("outglow-map-card .room.on").first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(900);
      await page.screenshot({ path: `screenshots/card-${theme}-${width}.png`, fullPage: true });
    });
  }
}

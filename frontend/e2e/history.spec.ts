import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

function view(page: Page) {
  return page.locator("outglow-history-view");
}

async function cursor(page: Page): Promise<number> {
  return Number(await view(page).locator(".track").getAttribute("aria-valuenow"));
}

test.describe("history", () => {
  test("draws a band for each room and an events lane", async ({ page }) => {
    await open(page, "/history", { width: 1440 });
    const history = view(page);
    await expect(history.locator(".labels div")).toHaveText(["Living room", "Hall", "Office", "Events"]);
    await expect(history.locator(".track svg rect.band-bg")).toHaveCount(3);
    await expect(history.locator(".track").first()).toHaveAttribute("role", "slider");
    await expect(history.locator(".foot")).toContainText("probability");
  });

  test("jumps to an event and replays the frame there", async ({ page }) => {
    await open(page, "/history", { width: 1440 });
    const history = view(page);
    await history.getByRole("button", { name: "Previous day" }).click();
    const item = history.locator(".list button", { hasText: "sensitivity 40 → 50" });
    await expect(item).toBeVisible();
    await item.click();
    await expect(item).toHaveAttribute("aria-current", "true");
    await expect(history.locator(".replay-wrap")).not.toHaveClass(/dim/);
    const text = (await history.locator(".clock").textContent()) ?? "";
    expect(text).toMatch(/11:12/);
    await expect(history.locator("outglow-plan-view")).toBeVisible();
  });

  test("a correction at the cursor goes to the model proposal", async ({ page }) => {
    await open(page, "/history", { width: 1440 });
    const history = view(page);
    await history.getByRole("button", { name: "Previous day" }).click();
    const item = history.locator(".list button", { hasText: "sensitivity 40 → 50" });
    await item.click();
    const fixes = history.locator(".fixes");
    await expect(fixes).toContainText("Correct the detection at");
    await expect(fixes.locator('[data-fix="false_alarm"]')).toHaveText(/Nobody was in Office/);
    await fixes.locator("select").selectOption("hall");
    await fixes.locator('[data-fix="missed"]').click();
    await expect(page.locator("outglow-panel")).toContainText("The correction waits in the model proposal");
    await expect(history.locator(".list button", { hasText: "Missed entry into Hall" }).first()).toBeVisible();
  });

  test("clicking a timeline marker moves the cursor", async ({ page }) => {
    await open(page, "/history", { width: 1440 });
    const history = view(page);
    await history.getByRole("button", { name: "Previous day" }).click();
    const marker = history.locator(".marker").first();
    await expect(marker).toBeVisible();
    const before = await cursor(page);
    await marker.click();
    await expect.poll(() => cursor(page)).not.toBe(before);
  });

  test("play advances the clock", async ({ page }) => {
    await open(page, "/history", { width: 1440 });
    const history = view(page);
    await history.getByRole("button", { name: "Previous day" }).click();
    await history.locator(".list button").first().click();
    await history.getByRole("radio", { name: "16×" }).click();
    const before = await cursor(page);
    await history.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => cursor(page), { timeout: 5000 }).toBeGreaterThan(before + 4);
    await history.getByRole("button", { name: "Pause" }).click();
  });

  test("keyboard moves the scrubber", async ({ page }) => {
    await open(page, "/history", { width: 1440 });
    const track = view(page).locator(".track");
    await track.focus();
    await page.keyboard.press("Home");
    const start = await cursor(page);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => cursor(page)).toBeGreaterThan(start);
    await expect(track).toHaveAttribute("aria-valuetext", /\d/);
  });

  test("goes back a day and not into the future", async ({ page }) => {
    await open(page, "/history", { width: 390, lang: "pl" });
    const history = view(page);
    const next = history.getByRole("button", { name: "Następny dzień" });
    await expect(next).toBeDisabled();
    const title = await history.locator(".date .title").textContent();
    await history.getByRole("button", { name: "Poprzedni dzień" }).click();
    await expect(history.locator(".date .title")).not.toHaveText(title ?? "");
    await expect(next).toBeEnabled();
    await expect(history.locator(".track svg rect.band-bg")).toHaveCount(3);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("frames older than 48 hours explain why there is no replay", async ({ page }) => {
    await open(page, "/history", { width: 1440 });
    const history = view(page);
    for (let i = 0; i < 3; i += 1) {
      await history.getByRole("button", { name: "Previous day" }).click();
    }
    await expect(history.locator(".replay-note")).toContainText("48 hours");
  });
});

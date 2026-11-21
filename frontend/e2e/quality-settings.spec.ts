import { expect, test } from "@playwright/test";
import { open } from "./helpers";

test.describe("quality", () => {
  test("switches periods and views, skips a direction", async ({ page }) => {
    await open(page, "/quality");
    const view = page.locator("outglow-quality-view");
    await expect(view.getByText("last 7 days")).toBeVisible();
    await view.getByRole("radio", { name: "30 days" }).click();
    await expect(view.getByText("last 30 days")).toBeVisible();
    await expect(view.locator("outglow-plan-view")).toBeVisible();
    await view.getByRole("radio", { name: "Table" }).click();
    await expect(view.locator("table.dirs")).toBeVisible();
    await view.getByRole("radio", { name: "signal" }).click();
    const first = view.locator("table.dirs tbody tr").first();
    await expect(first).toContainText("-89 dBm");
    const skip = first.locator("button[data-skip]");
    await expect(skip).toContainText("Skip");
    await skip.click();
    await expect(first.locator("button[data-skip]")).toContainText("Use again");
    await expect(first).toHaveClass(/excluded/);
  });

  test("writes to a bulb only through the confirm dialog", async ({ page }) => {
    await open(page, "/quality");
    const view = page.locator("outglow-quality-view");
    await view.locator("[data-rec='raise:0x0000000000000004']").getByRole("button", { name: "Change…" }).click();
    const dialog = view.locator("og-bulb-write og-sheet");
    await expect(view.locator("og-bulb-write dialog")).toBeVisible();
    await expect(dialog.locator("input[type=number]")).toHaveValue("50");
    await dialog.locator("[data-action=check]").click();
    await expect(dialog.getByText("Clears the bulb's calibration of the empty room.")).toBeVisible();
    await expect(dialog.getByText(/Confirmation valid for 0:(5|6)\d/)).toBeVisible();
    await dialog.locator("[data-action=write]").click();
    await expect(page.locator("outglow-panel .toast")).toContainText("Office desk: Sensitivity written");
    await expect(view.locator("og-bulb-write dialog")).toBeHidden();
  });

  test("shows candidates on the map", async ({ page }) => {
    await open(page, "/quality", { width: 390, theme: "dark" });
    const view = page.locator("outglow-quality-view");
    await view.getByRole("radio", { name: "Table" }).click();
    await view.getByRole("button", { name: "Show on map" }).click();
    await expect(view.locator("outglow-plan-view .marker-ring")).toHaveCount(1);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
});

test.describe("settings", () => {
  test("changes a room's budget and saves", async ({ page }) => {
    await open(page, "/settings/hall", { lang: "pl" });
    const view = page.locator("outglow-settings-view");
    await expect(view.locator("#room-h")).toHaveText("Hall");
    await expect(view.getByText(/wykrywa ≈ 88 % wejść/)).toBeVisible();
    await view.getByRole("radiogroup", { name: "Pomyłki na dobę" }).getByRole("radio", { name: "3", exact: true }).click();
    await expect(view.getByText("Nowy budżet zadziała", { exact: false })).toBeVisible();
    await view.locator("[data-action=save]").click();
    await expect(page.locator("outglow-panel .toast")).toContainText("Zapisano ustawienia");
    await expect(view.locator(".savebar")).toHaveCount(0);
    await view.getByRole("button", { name: "Office" }).click();
    await expect(page).toHaveURL(/\/outglow\/settings\/office/);
    await expect(view.locator("#room-h")).toHaveText("Office");
  });

  test("applies the pending model", async ({ page }) => {
    await open(page, "/settings");
    const view = page.locator("outglow-settings-view");
    await expect(view.getByText("Waiting for your decision")).toBeVisible();
    await view.locator("[data-action=apply]").click();
    await expect(page.locator("outglow-panel .toast")).toContainText("Model updated to version 7");
    await expect(view.getByText("Version 7")).toBeVisible();
    await expect(view.getByText("Waiting for your decision")).toHaveCount(0);
  });

  test("rolls the model back after confirming", async ({ page }) => {
    await open(page, "/settings", { width: 768 });
    const view = page.locator("outglow-settings-view");
    await view.getByText(/Snapshots/).click();
    await view.locator(".snapshots").getByRole("button", { name: "Roll back" }).last().click();
    await view.locator("[data-action=rollback]").click();
    await expect(page.locator("outglow-panel .toast")).toContainText("Model rolled back");
  });

  test("deletes one snapshot, then all, after confirming", async ({ page }) => {
    await open(page, "/settings", { width: 768 });
    const view = page.locator("outglow-settings-view");
    await view.getByText(/Snapshots/).click();
    const rows = view.locator(".snapshots li");
    await expect(rows).toHaveCount(2);
    await view.locator("[data-delete=m-0005]").click();
    await expect(view.getByText("Delete the snapshot?")).toBeVisible();
    await view.getByRole("button", { name: "Cancel" }).click();
    await expect(rows).toHaveCount(2);
    await view.locator("[data-delete=m-0005]").click();
    await view.locator("[data-action=delete-snapshot]").click();
    await expect(page.locator("outglow-panel .toast")).toContainText("Snapshot deleted");
    await expect(rows).toHaveCount(1);
    await expect(view.locator("[data-delete=m-0005]")).toHaveCount(0);
    await expect(view.getByText("Snapshots (1)")).toBeVisible();
    await view.locator("[data-action=delete-all]").click();
    await expect(view.getByText("All 1 snapshots are removed for good.", { exact: false })).toBeVisible();
    await view.locator("[data-action=delete-snapshot]").click();
    await expect(page.locator("outglow-panel .toast")).toContainText("Snapshots deleted");
    await expect(view.getByText("No snapshots yet.")).toBeVisible();
  });

  test("resets one room's learning after confirming and keeps a snapshot", async ({ page }) => {
    await open(page, "/settings", { lang: "pl", width: 390 });
    const view = page.locator("outglow-settings-view");
    await view.getByText(/Migawki/).click();
    await expect(view.locator(".snapshots li")).toHaveCount(2);
    await view.locator("[data-action=open-reset]").click();
    await expect(view.getByText("Model zapomni wszystko", { exact: false })).toBeVisible();
    await view.locator("[data-field=reset-room]").selectOption({ label: "Hall" });
    await expect(view.getByText("dla pokoju Hall", { exact: false })).toBeVisible();
    await expect(view.getByText("Plan i ustawienia zostają.", { exact: false })).toBeVisible();
    await view.locator("[data-action=reset]").click();
    await expect(page.locator("outglow-panel .toast")).toContainText("Nauka zresetowana, wersja modelu 7");
    await expect(view.locator(".snapshots li")).toHaveCount(3);
    await expect(view.locator(".snapshots li").first()).toContainText("przed resetem");
    await expect(view.getByText("Wersja 7")).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
});

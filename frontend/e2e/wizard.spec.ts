import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

const EN = {
  start: "Start learning",
  consent: /Raise activity reports to 4\/s/,
  leaving: "I'm leaving",
  back: "I'm back",
  there: "I'm there",
  next: "Next",
  finish: "Finish",
  summary: "How well Outglow recognises your rooms",
  apply: "Apply and stay in rules mode",
  applied: "Learning applied",
  toast: /Model updated to version 7/,
  stepOne: "Step 1 of 13",
  edge: "Walk along the walls and past the door",
  walk: "Walk freely around the room",
  sit: "Sit where you usually sit",
  seeYou: "I can see you",
};

const PL = {
  start: "Zacznij naukę",
  consent: /Podnieś raporty aktywności do 4\/s/,
  leaving: "Wychodzę",
  back: "Wróciłem",
  there: "Jestem na miejscu",
  next: "Dalej",
  finish: "Zakończ",
  summary: "Jak dobrze Outglow rozpoznaje pokoje",
  apply: "Zastosuj i zostań przy regułach",
  applied: "Nauka zastosowana",
  toast: /Model zaktualizowany do wersji 7/,
  stepOne: "Krok 1 z 13",
  edge: "Przejdź wzdłuż ścian i obok drzwi",
  walk: "Chodź swobodnie po pokoju",
  sit: "Usiądź tam, gdzie zwykle siadasz",
  seeYou: "Widzę cię",
};

async function walkThrough(page: Page, s: typeof EN): Promise<void> {
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const consent = page.getByRole("checkbox", { name: s.consent });
  await expect(consent).not.toBeChecked();
  await button(s.start).click();
  await expect(page.getByText(s.stepOne)).toBeVisible();
  await button(s.leaving).click();
  await button(s.back).click();
  for (let room = 0; room < 3; room += 1) {
    await expect(page.getByRole("heading", { name: s.edge })).toBeVisible();
    await button(s.next).click();
    await expect(page.getByRole("heading", { name: s.walk })).toBeVisible();
    await expect(page.getByText(s.seeYou, { exact: true })).toBeVisible();
    await button(s.next).click();
    await expect(page.getByRole("heading", { name: s.sit })).toBeVisible();
    await button(s.next).click();
    await button(room < 2 ? s.there : s.finish).click();
  }
  await expect(page.getByRole("heading", { name: s.summary })).toBeVisible();
  await expect(page.locator("outglow-learn-view table.matrix tbody tr")).toHaveCount(3);
  await button(s.apply).click();
  await expect(page.getByRole("heading", { name: s.applied })).toBeVisible();
  await expect(page.getByText(s.toast).first()).toBeVisible();
}

test("learning wizard from the check to applied learning", async ({ page }) => {
  await open(page, "/learn", { width: 1440 });
  await walkThrough(page, EN);
});

test("learning wizard on a phone in Polish, dark", async ({ page }) => {
  await open(page, "/learn", { width: 390, theme: "dark", lang: "pl" });
  await walkThrough(page, PL);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test("can't now moves the empty home step to the end", async ({ page }) => {
  await open(page, "/learn", { width: 768 });
  await page.getByRole("button", { name: EN.start, exact: true }).click();
  await page.getByRole("button", { name: "Can't now", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Go to" })).toBeVisible();
  await expect(page.getByText("Step 1 of 13")).toBeVisible();
  await page.getByRole("button", { name: EN.there, exact: true }).click();
  await expect(page.getByRole("heading", { name: EN.edge })).toBeVisible();
  await expect(page.locator("outglow-learn-view .steps-card li").last()).toContainText("to do");
});

test("stopping early asks first and shows the summary", async ({ page }) => {
  await open(page, "/learn", { width: 1440 });
  await page.getByRole("button", { name: EN.start, exact: true }).click();
  await page.getByRole("button", { name: EN.leaving, exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Stop the session" }).click();
  await expect(page.getByRole("heading", { name: EN.summary })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Discard this session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session discarded" })).toBeVisible();
});

const SHOTS = process.env.OUTGLOW_SHOTS_DIR;

async function activeLines(page: Page): Promise<string> {
  return page
    .locator("outglow-learn-view .live-map outglow-plan-view line.pair")
    .evaluateAll((lines) => lines.map((l) => `${l.getAttribute("class")}:${(l as SVGLineElement).style.strokeOpacity}`).join("|"));
}

for (const width of [390, 1440]) {
  test(`walk step shows a live map with the room to be in at ${width} px`, async ({ page }) => {
    await open(page, "/learn", { width, theme: width < 500 ? "dark" : "light" });
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    await button(EN.start).click();
    await button(EN.leaving).click();
    await expect(page.locator("outglow-learn-view .live-map")).toHaveCount(0);
    await button(EN.back).click();
    await expect(page.getByRole("heading", { name: EN.edge })).toBeVisible();
    await button(EN.next).click();
    await expect(page.getByRole("heading", { name: EN.walk })).toBeVisible();
    const map = page.locator("outglow-learn-view .live-map outglow-plan-view");
    await expect(map).toBeVisible();
    const room = await page.locator("outglow-learn-view div.room-name").innerText();
    const here = map.locator("polygon.here");
    await expect(here).toHaveCount(1);
    const id = await here.getAttribute("data-room");
    const name = await page.evaluate((roomId) => {
      type View = { plan: { rooms: { id: string; name: string }[] } | null };
      const view = document.querySelector("outglow-panel")?.shadowRoot?.querySelector("outglow-learn-view") as unknown as View | null;
      return view?.plan?.rooms.find((r) => r.id === roomId)?.name;
    }, id);
    expect(room.trim()).toBe(name);
    await expect(map.locator("text.room-state")).toHaveCount(0);
    const box = await map.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(width < 500 ? 200.5 : 240.5);
    const seen = new Set<string>();
    for (let i = 0; i < 12 && seen.size < 2; i += 1) {
      seen.add(await activeLines(page));
      await page.waitForTimeout(400);
    }
    expect(seen.size).toBeGreaterThan(1);
    const lit = await map.locator("line.pair.two, line.pair.one").count();
    expect(lit).toBeGreaterThan(0);
    const next = await button(EN.next).boundingBox();
    expect(next!.y + next!.height).toBeLessThanOrEqual(page.viewportSize()!.height * 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/wizard-walk-${width}.png`, fullPage: true });
  });
}

test("summary in rules mode offers bayes and switches with one tap", async ({ page }) => {
  await open(page, "/learn", { width: 390 });
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await button(EN.start).click();
  await button(EN.leaving).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Stop the session" }).click();
  await expect(page.getByRole("heading", { name: EN.summary })).toBeVisible();
  await expect(page.getByText("Rules mode does not learn")).toBeVisible();
  await expect(page.getByText("Rules mode does not use the learned model")).toBeVisible();
  const map = page.locator("outglow-learn-view .room-map outglow-plan-view");
  await expect(map).toBeVisible();
  await expect(map.locator("text.room-state").first()).toBeVisible();
  await page.getByRole("radio", { name: "Bayes", exact: true }).click();
  await expect(page.getByText(/checked on the half of each walk/)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wizard-summary-390.png`, fullPage: true });
  await button("Switch to bayes and apply").click();
  await expect(page.getByRole("heading", { name: EN.applied })).toBeVisible();
  await expect(page.getByText(/detection runs in bayes mode/)).toBeVisible();
});

test("the outline of the room to be in stands still with reduced motion", async ({ page }) => {
  await open(page, "/learn", { width: 390, reducedMotion: true });
  await page.getByRole("button", { name: EN.start, exact: true }).click();
  await page.getByRole("button", { name: EN.leaving, exact: true }).click();
  await page.getByRole("button", { name: EN.back, exact: true }).click();
  const here = page.locator("outglow-learn-view .live-map outglow-plan-view polygon.here");
  await expect(here).toHaveCount(1);
  expect(await here.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});

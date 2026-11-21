import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { drag, open, screen, view } from "./helpers";

type Point = [number, number];

function editor(page: Page): Locator {
  return page.locator("outglow-plan-editor");
}

async function currentPlan(page: Page): Promise<{ rev: number; rooms: { id: string; outline: Point[] }[]; bulbs: { ieee: string; x: number; y: number }[]; doors: unknown[] } & Record<string, unknown>> {
  return page.evaluate(() => {
    const panel = document.querySelector("outglow-panel")!;
    const ed = panel.shadowRoot!.querySelector("outglow-plan-editor") as unknown as { _plan: never };
    return structuredClone(ed._plan);
  });
}

async function outline(page: Page, id: string): Promise<Point[]> {
  const plan = await currentPlan(page);
  return plan.rooms.find((r) => r.id === id)!.outline;
}

function rect(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

async function centre(locator: Locator): Promise<Point> {
  const box = (await locator.boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2];
}

async function grip(page: Page, handle: string): Promise<Point> {
  const knob = editor(page).locator(`outglow-editor-canvas g.grip[data-handle=${handle}] rect.knob`);
  await expect(knob).toBeVisible();
  return centre(knob);
}

async function selectRoom(page: Page, at: Point): Promise<void> {
  const v = await view(page);
  const [x, y] = screen(v, at[0], at[1]);
  await page.mouse.click(x, y);
  await expect(editor(page).locator("outglow-editor-canvas g.grip")).not.toHaveCount(0);
}

async function dragBy(page: Page, from: Point, dx: number, dy: number): Promise<void> {
  const v = await view(page);
  await drag(page, from, [from[0] + dx * v.s, from[1] + dy * v.s]);
}

test.describe("resizing rooms with the mouse", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, "/plan", { width: 1440 });
    await expect(editor(page).locator("outglow-editor-canvas")).toBeVisible();
    await selectRoom(page, [1, 3]);
  });

  test("a corner handle resizes against the opposite corner and undoes in one step", async ({ page }) => {
    await expect(editor(page).locator("outglow-editor-canvas g.grip")).toHaveCount(8);
    await expect(editor(page).locator("outglow-editor-canvas g.grip[data-handle=se]")).toHaveCSS("cursor", "nwse-resize");
    await expect(editor(page).locator("outglow-editor-canvas g.grip[data-handle=e]")).toHaveCSS("cursor", "ew-resize");
    const before = await currentPlan(page);
    const from = await grip(page, "se");
    const v = await view(page);
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(from[0] + 0.5 * v.s, from[1] + 0.25 * v.s, { steps: 4 });
    await page.mouse.move(from[0] + 1.02 * v.s, from[1] + 0.49 * v.s, { steps: 4 });
    const tag = editor(page).locator("outglow-editor-canvas .size-tag text");
    await expect(tag).toHaveText("6.00 × 4.50 m · 27.0 m²");
    await expect(editor(page).locator("outglow-editor-canvas svg.plan")).toHaveCSS("cursor", "nwse-resize");
    await page.mouse.up();
    await expect(tag).toHaveCount(0);
    expect(await outline(page, "living")).toEqual(rect(0, 0, 6, 4.5));
    expect(await outline(page, "hall")).toEqual(before.rooms.find((r) => r.id === "hall")!.outline);
    const ceiling = (await currentPlan(page)).bulbs.find((b) => b.ieee.endsWith("1"))!;
    expect(ceiling.x).toBeCloseTo(1.8, 3);
    expect(ceiling.y).toBeCloseTo(1.6875, 2);
    await expect(editor(page).locator("ul.issues")).toContainText("Living room overlaps Hall");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await outline(page, "living")).toEqual(rect(0, 0, 5, 4));
    await page.keyboard.press("ControlOrMeta+Shift+z");
    expect(await outline(page, "living")).toEqual(rect(0, 0, 6, 4.5));
  });

  test("Shift keeps the proportions at a corner", async ({ page }) => {
    const from = await grip(page, "se");
    await page.keyboard.down("Shift");
    await dragBy(page, from, 2.5, 0.2);
    await page.keyboard.up("Shift");
    expect(await outline(page, "living")).toEqual(rect(0, 0, 7.5, 6));
  });

  test("Alt resizes from the centre", async ({ page }) => {
    const from = await grip(page, "e");
    await page.keyboard.down("Alt");
    await dragBy(page, from, 1, 0.3);
    await page.keyboard.up("Alt");
    expect(await outline(page, "living")).toEqual(rect(-1, 0, 6, 4));
  });

  test("Cmd or Ctrl turns snapping off", async ({ page }) => {
    const from = await grip(page, "nw");
    await page.keyboard.down("ControlOrMeta");
    await dragBy(page, from, -0.537, 0);
    await page.keyboard.up("ControlOrMeta");
    const x = (await outline(page, "living"))[0]![0];
    expect(x).toBeCloseTo(-0.537, 1);
    expect(Math.abs(x * 10 - Math.round(x * 10))).toBeGreaterThan(0.05);
  });

  test("a side handle snaps to the wall of another room", async ({ page }) => {
    const from = await grip(page, "e");
    await dragBy(page, from, 1.93, 0);
    expect(await outline(page, "living")).toEqual(rect(0, 0, 7, 4));
  });

  test("dragging a shared wall moves it in every room on it, with the door", async ({ page }) => {
    const v = await view(page);
    const doorBefore = await editor(page).locator("outglow-editor-canvas .door").count();
    await drag(page, screen(v, 5, 1), screen(v, 5.53, 1.4));
    expect(await outline(page, "living")).toEqual(rect(0, 0, 5.5, 4));
    expect(await outline(page, "hall")).toEqual(rect(5.5, 0, 7, 6));
    expect(await outline(page, "office")).toEqual(rect(2, 4, 5.5, 7));
    await expect(editor(page).locator("outglow-editor-canvas .door")).toHaveCount(doorBefore);
    await page.keyboard.press("ControlOrMeta+z");
    expect(await outline(page, "hall")).toEqual(rect(5, 0, 7, 6));
  });

  test("Alt detaches the wall from the neighbouring room", async ({ page }) => {
    const v = await view(page);
    await page.keyboard.down("Alt");
    await drag(page, screen(v, 5, 1), screen(v, 4.5, 1));
    await page.keyboard.up("Alt");
    expect(await outline(page, "living")).toEqual(rect(0, 0, 4.5, 4));
    expect(await outline(page, "hall")).toEqual(rect(5, 0, 7, 6));
  });

  test("a double click on a wall still adds a corner", async ({ page }) => {
    const v = await view(page);
    const [x, y] = screen(v, 2.5, 0);
    await page.mouse.dblclick(x, y);
    expect(await outline(page, "living")).toHaveLength(5);
  });

  test("dragging the inside moves the room with its bulbs, Shift keeps it in line", async ({ page }) => {
    const v = await view(page);
    await page.keyboard.down("Shift");
    await drag(page, screen(v, 1, 3), screen(v, 1 - 1.03, 3 + 0.31));
    await page.keyboard.up("Shift");
    expect(await outline(page, "living")).toEqual(rect(-1, 0, 4, 4));
    const ceiling = (await currentPlan(page)).bulbs.find((b) => b.ieee.endsWith("1"))!;
    expect([ceiling.x, ceiling.y]).toEqual([0.5, 1.5]);
  });

  test("arrow keys move the room and Alt with arrow keys resizes it", async ({ page }) => {
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    expect(await outline(page, "living")).toEqual(rect(0.1, 1, 5.1, 5));
    await page.keyboard.press("Alt+ArrowRight");
    await page.keyboard.press("Alt+Shift+ArrowUp");
    expect(await outline(page, "living")).toEqual(rect(0.1, 1, 5.2, 4));
    await page.keyboard.press("ControlOrMeta+z");
    expect(await outline(page, "living")).toEqual(rect(0.1, 1, 5.1, 5));
  });
});

test("the hint explains resizing in Polish", async ({ page }) => {
  await open(page, "/plan", { width: 1440, lang: "pl" });
  await selectRoom(page, [1, 3]);
  await expect(editor(page).locator(".hint")).toContainText("Kwadratowe uchwyty zmieniają rozmiar");
  await expect(editor(page).locator("[data-action=keep-ratio]")).toHaveAttribute("title", "Zachowuj proporcje przy zmianie rozmiaru");
});

test.describe("on a phone", () => {
  test.use({ hasTouch: true, isMobile: true });

  async function touchDrag(page: Page, from: Point, to: Point): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    const point = (p: Point) => [{ x: p[0], y: p[1], id: 1, radiusX: 6, radiusY: 6, force: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from) });
    for (let i = 1; i <= 8; i += 1) {
      const p: Point = [from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(p) });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  }

  test("large handles resize by touch and the toolbar lock keeps proportions", async ({ page }) => {
    await open(page, "/plan", { width: 390 });
    const canvas = editor(page).locator("outglow-editor-canvas");
    await canvas.scrollIntoViewIfNeeded();
    let v = await view(page);
    const [tx, ty] = screen(v, 1, 3);
    await page.touchscreen.tap(tx, ty);
    const knob = canvas.locator("g.grip[data-handle=se] rect.knob");
    await expect(knob).toBeVisible();
    expect((await knob.boundingBox())!.width).toBeGreaterThanOrEqual(15);
    await expect(editor(page).locator(".hint")).toContainText("proportions button");
    v = await view(page);
    let from = await centre(knob);
    await touchDrag(page, from, [from[0] + 1 * v.s, from[1] + 0.5 * v.s]);
    expect(await outline(page, "living")).toEqual(rect(0, 0, 6, 4.5));

    await editor(page).locator("[data-action=keep-ratio]").click();
    await expect(editor(page).locator("[data-action=keep-ratio]")).toHaveAttribute("aria-pressed", "true");
    v = await view(page);
    from = await centre(knob);
    await touchDrag(page, from, [from[0] + 1.5 * v.s, from[1]]);
    expect(await outline(page, "living")).toEqual(rect(0, 0, 7.5, 5.625));
  });
});

test("export downloads the current plan as Outglow JSON", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  await selectRoom(page, [1, 3]);
  await page.keyboard.press("ArrowRight");
  const plan = await currentPlan(page);
  const downloading = page.waitForEvent("download");
  await editor(page).locator("[data-action=export]").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^outglow-plan-\d{4}-\d{2}-\d{2}\.json$/);
  const saved = JSON.parse(await readFile((await download.path())!, "utf8")) as Record<string, unknown>;
  const { rev: _savedRev, ...savedRest } = saved;
  const { rev: _planRev, ...planRest } = plan;
  expect(savedRest).toEqual(planRest);
  expect((saved.rooms as { outline: Point[] }[])[0]!.outline).toEqual(rect(0.1, 0, 5.1, 4));
});

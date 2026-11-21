import { expect, test, type Locator, type Page } from "@playwright/test";
import { open } from "./helpers";

const LINE = "outglow-plan-view .hit-line[tabindex='0']";
const ROOM = "outglow-plan-view polygon.room.hit";
const TRANSPARENT = "rgba(0, 0, 0, 0)";

interface Look {
  focused: boolean;
  focusVisible: boolean;
  outline: string;
  tap: string;
  hostTap: string;
  stroke: string;
  strokeWidth: string;
}

function look(target: Locator): Promise<Look> {
  return target.first().evaluate((el) => {
    const style = getComputedStyle(el);
    const host = (el.getRootNode() as ShadowRoot).host;
    return {
      focused: (el.getRootNode() as ShadowRoot).activeElement === el,
      focusVisible: el.matches(":focus-visible"),
      outline: style.outlineStyle,
      tap: style.getPropertyValue("-webkit-tap-highlight-color"),
      hostTap: getComputedStyle(host).getPropertyValue("-webkit-tap-highlight-color"),
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
    };
  });
}

async function quiet(target: Locator): Promise<void> {
  const state = await look(target);
  expect(state.focusVisible).toBe(false);
  expect(state.outline).toBe("none");
  expect(state.stroke).toBe(TRANSPARENT);
  for (const tap of [state.tap, state.hostTap]) {
    if (tap) expect(tap).toBe(TRANSPARENT);
  }
}

async function press(page: Page, target: Locator, touch: boolean): Promise<void> {
  const box = (await target.first().boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  if (touch) {
    await page.touchscreen.tap(x, y);
  } else {
    await page.mouse.click(x, y);
  }
}

for (const [touch, width] of [
  [false, 1440],
  [true, 390],
] as const) {
  test.describe(`${touch ? "tap" : "click"} at ${width}px`, () => {
    test.use({ hasTouch: touch });

    test("leaves no focus ring, tap highlight or thick selection on the plan", async ({ page }) => {
      await open(page, "/live", { width, lang: "pl" });
      const live = page.locator("outglow-live-view");
      const line = page.locator(LINE);
      await expect(line.first()).toBeAttached({ timeout: 20_000 });
      await quiet(line);

      await press(page, line, touch);
      await expect(live.locator("og-sheet[open] dialog")).toBeVisible();
      await quiet(line);
      const halo = page.locator("outglow-plan-view .pair-halo");
      await expect(halo).toHaveCount(1);
      const pair = page.locator("outglow-plan-view line.pair.selected");
      const glow = await halo.evaluate((el) => {
        const line = el.nextElementSibling!;
        const width = (node: Element) => parseFloat((node as SVGElement).style.strokeWidth);
        return { extra: width(el) - width(line), opacity: Number(getComputedStyle(el).strokeOpacity), selected: line.matches(".pair.selected") };
      });
      expect(glow.selected).toBe(true);
      expect(glow.extra).toBeCloseTo(6, 5);
      expect(glow.opacity).toBeLessThan(0.3);

      const close = live.locator("og-sheet[open] header .icon-btn");
      if (touch) await close.tap();
      else await close.click();
      await expect(live.locator("og-sheet[open]")).toHaveCount(0);
      await expect(halo).toHaveCount(0);
      await expect(pair).toHaveCount(0);
      await quiet(line);

      await press(page, line, touch);
      await expect(live.locator("og-sheet[open] dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(live.locator("og-sheet[open]")).toHaveCount(0);
      await quiet(line);

      const room = page.locator(ROOM);
      const box = (await room.first().boundingBox())!;
      if (touch) await page.touchscreen.tap(box.x + 8, box.y + box.height - 8);
      else await page.mouse.click(box.x + 8, box.y + box.height - 8);
      await expect(live.locator("og-sheet[open] dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(live.locator("og-sheet[open]")).toHaveCount(0);
      const roomLook = await look(room);
      expect(roomLook.focusVisible).toBe(false);
      expect(roomLook.outline).toBe("none");
    });
  });
}

test("keyboard focus on a line stays visible", async ({ page }) => {
  await open(page, "/live", { lang: "pl" });
  const live = page.locator("outglow-live-view");
  const line = page.locator(LINE);
  await expect(line.first()).toBeAttached({ timeout: 20_000 });
  await live.locator(".map-head .icon-btn").focus();
  const onLine = () => line.first().evaluate((el) => (el.getRootNode() as ShadowRoot).activeElement === el);
  for (let i = 0; i < 30 && !(await onLine()); i++) {
    await page.keyboard.press("Tab");
  }
  const focused = await look(line);
  expect(focused.focused).toBe(true);
  expect(focused.focusVisible).toBe(true);
  expect(focused.stroke).not.toBe(TRANSPARENT);
  expect(focused.strokeWidth).toBe("6px");
  expect(focused.outline).toBe("none");

  await page.keyboard.press("Enter");
  await expect(live.locator("og-sheet[open] dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(live.locator("og-sheet[open]")).toHaveCount(0);
  const back = await look(line);
  expect(back.focused).toBe(true);
  expect(back.focusVisible).toBe(true);
  expect(back.stroke).not.toBe(TRANSPARENT);
});

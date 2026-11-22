import { expect, test, type Locator, type Page } from "@playwright/test";
import { drag, open, screen, view } from "./helpers";

type Point = [number, number];

interface PlanLike {
  rooms: { id: string; name: string; outline: Point[] }[];
  doors: { wall: number; at: number; width: number; kind: string }[];
  walls: { a: Point; b: Point; kind: string }[];
}

function editor(page: Page): Locator {
  return page.locator("outglow-plan-editor");
}

async function currentPlan(page: Page): Promise<PlanLike> {
  return page.evaluate(() => {
    const panel = document.querySelector("outglow-panel")!;
    const ed = panel.shadowRoot!.querySelector("outglow-plan-editor") as unknown as { _plan: never };
    return structuredClone(ed._plan);
  });
}

async function setRooms(page: Page, rooms: [string, string, number[][], string?][], walls: [number[], number[], string?][] = []): Promise<void> {
  await page.evaluate(async ([rooms, walls]) => {
    const panel = document.querySelector("outglow-panel")!;
    const ed = panel.shadowRoot!.querySelector("outglow-plan-editor") as unknown as {
      _plan: Record<string, unknown>;
      _history: { reset(plan: unknown): void };
      _saved: unknown;
      _version: number;
      updateComplete: Promise<unknown>;
      renderRoot: ShadowRoot;
    };
    const plan = {
      ...ed._plan,
      bulbs: [],
      doors: [],
      adjacent: [],
      walls: walls.map(([a, b, kind]) => ({ a, b, kind: kind ?? "partition" })),
      rooms: rooms.map(([id, name, outline, area]) => ({ id, name, outline, colour: "#4e9af1", area_id: area ?? null, entrance: false })),
    };
    ed._history.reset(plan);
    ed._saved = plan;
    ed._version += 1;
    await ed.updateComplete;
    (ed.renderRoot.querySelector("outglow-editor-canvas") as unknown as { fit(): void }).fit();
  }, [rooms, walls] as const);
  await page.waitForTimeout(50);
}

async function outline(page: Page, id: string): Promise<Point[] | undefined> {
  return (await currentPlan(page)).rooms.find((r) => r.id === id)?.outline;
}

const LIVING: Point[] = [
  [0, 0],
  [5, 0],
  [5, 4],
  [0, 4],
];

test.describe("removing corners and lines", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, "/plan", { width: 1440 });
  });

  test("a clicked corner is picked, and Delete or Backspace removes it", async ({ page }) => {
    const v = await view(page);
    const inspector = editor(page).locator(".inspector");
    await page.mouse.click(...screen(v, 1, 3));
    await page.mouse.click(...screen(v, 0, 0));
    await expect(inspector.locator("h2")).toHaveText("Corner");
    await expect(inspector).toContainText("Corner 1 of Living room");
    await expect(editor(page).locator("outglow-editor-canvas circle.handle.selected")).toHaveCount(1);
    await expect(editor(page).locator(".hint [role=status]")).toContainText("Delete, Backspace or a double-click removes it");
    await page.keyboard.press("Delete");
    expect(await outline(page, "living")).toEqual(LIVING.slice(1));
    await expect(inspector.locator("h2")).toHaveText("Room");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await outline(page, "living")).toEqual(LIVING);
    await page.mouse.click(...screen(v, 1, 3));
    await page.mouse.click(...screen(v, 0, 4));
    await page.keyboard.press("Backspace");
    expect(await outline(page, "living")).toEqual(LIVING.slice(0, 3));
  });

  test("a double click on a corner removes it, on an edge still adds one", async ({ page }) => {
    const v = await view(page);
    await page.mouse.click(...screen(v, 1, 3));
    await page.mouse.dblclick(...screen(v, 0, 0));
    expect(await outline(page, "living")).toEqual(LIVING.slice(1));
    await page.mouse.click(...screen(v, 4, 3.5));
    await page.mouse.dblclick(...screen(v, 2.5, 4));
    expect(await outline(page, "living")).toHaveLength(4);
  });

  test("a corner two rooms share on their wall goes in both, and the wall stays shared", async ({ page }) => {
    await page.evaluate(async () => {
      const panel = document.querySelector("outglow-panel")!;
      const ed = panel.shadowRoot!.querySelector("outglow-plan-editor") as unknown as {
        _plan: Record<string, unknown>;
        _history: { reset(plan: unknown): void };
        _saved: unknown;
        _version: number;
        updateComplete: Promise<unknown>;
        renderRoot: ShadowRoot;
      };
      const room = (id: string, name: string, outline: number[][]) => ({ id, name, outline, colour: "#4e9af1", area_id: null, entrance: false });
      const plan = {
        ...ed._plan,
        bulbs: [],
        doors: [],
        adjacent: [],
        rooms: [
          room("l", "Lounge", [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]]),
          room("n", "Nook", [[3, 3], [6, 3], [6, 6], [3, 6]]),
        ],
        walls: [
          { a: [3, 3], b: [6, 3], kind: "partition" },
          { a: [3, 3], b: [3, 6], kind: "partition" },
        ],
      };
      ed._history.reset(plan);
      ed._saved = plan;
      ed._version += 1;
      await ed.updateComplete;
      (ed.renderRoot.querySelector("outglow-editor-canvas") as unknown as { fit(): void }).fit();
    });
    await page.waitForTimeout(50);
    const v = await view(page);
    await page.mouse.click(...screen(v, 1, 1));
    await page.mouse.dblclick(...screen(v, 3, 3));
    expect(await outline(page, "l")).toEqual([[0, 0], [6, 0], [6, 3], [3, 6], [0, 6]]);
    expect(await outline(page, "n")).toEqual([[6, 3], [6, 6], [3, 6]]);
    expect((await currentPlan(page)).walls.map((w) => [w.a, w.b])).toEqual([[[6, 3], [3, 6]]]);
  });

  test("the last three corners stay, and the panel says why", async ({ page }) => {
    const v = await view(page);
    await page.mouse.click(...screen(v, 1, 3));
    await page.mouse.dblclick(...screen(v, 0, 0));
    await page.mouse.click(...screen(v, 4, 3.5));
    await page.mouse.click(...screen(v, 0, 4));
    await expect(editor(page).locator(".inspector [data-action=remove-corner]")).toBeDisabled();
    await page.keyboard.press("Delete");
    expect(await outline(page, "living")).toHaveLength(3);
    await expect(editor(page).locator(".hint [role=status]")).toHaveText("A room needs at least 3 corners.");
  });

  test("a corner whose outline would cross itself stays, and the note says so", async ({ page }) => {
    await setRooms(page, [["h", "House", [[0, 0], [6, 0], [6, 4], [3, 1], [0, 4]]]]);
    const v = await view(page);
    await page.mouse.click(...screen(v, 1, 0.5));
    await page.mouse.click(...screen(v, 6, 0));
    await page.keyboard.press("Delete");
    expect(await outline(page, "h")).toHaveLength(5);
    await expect(editor(page).locator(".hint [role=status]")).toHaveText("This corner stays: without it the room's outline would cross itself or fold flat.");
  });

  test("corners and walls of the selected room are picked with the keyboard", async ({ page }) => {
    const v = await view(page);
    const inspector = editor(page).locator(".inspector");
    const spoken = editor(page).locator(".hint [role=status]");
    await page.mouse.click(...screen(v, 1, 3));
    await expect(editor(page).locator(".hint [role=status]")).toContainText(", and . pick a corner, [ and ] a wall");
    await page.keyboard.press(".");
    await expect(inspector).toContainText("Corner 1 of Living room");
    await expect(spoken).toHaveText("Corner 1 of Living room, at 0 m, 0 m");
    await page.keyboard.press(".");
    await expect(inspector).toContainText("Corner 2 of Living room");
    await page.keyboard.press(",");
    await page.keyboard.press(",");
    await expect(inspector).toContainText("Corner 4 of Living room");
    await expect(editor(page).locator("outglow-editor-canvas circle.handle.selected")).toHaveCount(1);
    await expect(editor(page).locator("outglow-editor-canvas [aria-selected]")).toHaveCount(0);
    await page.keyboard.press("Delete");
    expect(await outline(page, "living")).toEqual(LIVING.slice(0, 3));
    await page.keyboard.press("ControlOrMeta+z");
    await page.mouse.click(...screen(v, 1, 3));
    await page.keyboard.press("]");
    await expect(inspector.locator("h2")).toHaveText("Wall");
    await expect(inspector).toContainText("Between Living room and Hall");
    await expect(spoken).toHaveText("Wall 1 of 2 of Living room: between Living room and Hall, 4 m");
    await page.keyboard.press("ArrowLeft");
    expect((await outline(page, "living"))![1]![0]).toBeCloseTo(4.9, 5);
  });

  test("the inner wall of a room inside another names the two rooms it is between", async ({ page }) => {
    await setRooms(page, [
      ["a", "Big", [[0, 0], [4, 0], [4, 4], [0, 4]]],
      ["b", "Right", [[4, 0], [8, 0], [8, 4], [4, 4]]],
      ["closet", "Closet", [[3, 0], [4, 0], [4, 1], [3, 1]]],
    ], [
      [[4, 1], [4, 4]],
      [[4, 0], [4, 1]],
      [[4, 1], [3, 1]],
      [[3, 1], [3, 0]],
    ]);
    await page.evaluate(async () => {
      const ed = document.querySelector("outglow-panel")!.shadowRoot!.querySelector("outglow-plan-editor") as unknown as {
        _plan: { walls: { a: Point; b: Point }[] };
        _selection: unknown;
        updateComplete: Promise<unknown>;
      };
      const wall = ed._plan.walls.find((w) => w.a[0] === 3 && w.b[0] === 3)!;
      ed._selection = { kind: "wall", pair: "a|closet", a: wall.a, b: wall.b };
      await ed.updateComplete;
    });
    const inspector = editor(page).locator(".inspector");
    await expect(inspector).toContainText("Between Big and Closet");
    await expect(inspector.getByRole("button", { name: "Merge into one room" })).toBeDisabled();
    await expect(inspector.locator(".merge-loses")).toHaveCount(0);
    await expect(inspector.locator(".merge-trouble")).toHaveText("These rooms cannot be merged: Closet lies inside Big. Move Closet so the two only meet at the wall.");
    expect((await currentPlan(page)).rooms.map((r) => r.id)).toEqual(["a", "b", "closet"]);
  });

  test("a merge says when the wall to a third room had two types and now has one", async ({ page }) => {
    await setRooms(page, [
      ["a", "Left", [[0, 0], [3, 0], [3, 3], [0, 3]]],
      ["b", "Right", [[3, 0], [5, 0], [5, 3], [3, 3]]],
      ["c", "Bottom", [[0, 3], [5, 3], [5, 6], [0, 6]]],
    ], [
      [[3, 0], [3, 3]],
      [[0, 3], [3, 3], "glass"],
      [[3, 3], [5, 3], "brick"],
    ]);
    const v = await view(page);
    await page.mouse.click(...screen(v, 3, 1.5));
    await editor(page).locator(".inspector").getByRole("button", { name: "Merge into one room" }).click();
    await expect(editor(page).locator(".hint [role=status]")).toHaveText(
      "Right is now part of Left. The wall between Left and Bottom had more than one type and is now Glass along its whole length.",
    );
  });

  test("the wall between two rooms says what Delete does and merges them into one room", async ({ page }) => {
    const v = await view(page);
    const inspector = editor(page).locator(".inspector");
    await page.mouse.click(...screen(v, 5, 1));
    await expect(inspector).toContainText("Between Living room and Hall");
    await expect(inspector).toContainText("Delete: No wall here, the rooms stay apart.");
    await expect(inspector).toContainText("Merging removes Hall: when you save, its settings, its entities in Home Assistant and what Outglow learnt for it go.");
    await expect(editor(page).locator(".hint [role=status]")).toContainText("Delete turns it into No wall");
    await inspector.getByRole("button", { name: "Merge into one room" }).click();
    const plan = await currentPlan(page);
    expect(plan.rooms.map((r) => r.id)).toEqual(["living", "office"]);
    expect(plan.rooms[0]!.outline).toEqual([
      [0, 0],
      [7, 0],
      [7, 6],
      [5, 6],
      [5, 4],
      [0, 4],
    ]);
    expect(plan.doors).toHaveLength(1);
    await expect(editor(page).locator(".hint [role=status]")).toHaveText("Hall is now part of Living room.");
    await expect(inspector.locator("h2")).toHaveText("Room");
    await page.keyboard.press("ControlOrMeta+z");
    expect((await currentPlan(page)).rooms.map((r) => r.id)).toEqual(["living", "hall", "office"]);
    expect((await currentPlan(page)).doors).toHaveLength(2);
  });
});

test.describe("on a phone", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("a tapped corner is removed with the button in the panel", async ({ page }) => {
    await open(page, "/plan", { width: 390 });
    const canvas = editor(page).locator("outglow-editor-canvas");
    await canvas.scrollIntoViewIfNeeded();
    let v = await view(page);
    await page.touchscreen.tap(...screen(v, 1, 3));
    await expect(canvas.locator("circle.handle")).toHaveCount(4);
    v = await view(page);
    await page.touchscreen.tap(...screen(v, 0, 0));
    await expect(canvas.locator("circle.handle.selected")).toHaveCount(1);
    await expect(editor(page).locator(".hint [role=status]")).toHaveText("Drag the corner to move it. Remove corner in the panel takes it away.");
    const button = editor(page).locator(".inspector").getByRole("button", { name: "Remove corner" });
    await button.scrollIntoViewIfNeeded();
    await button.tap();
    expect(await outline(page, "living")).toEqual(LIVING.slice(1));
  });

  test("a double tap on a corner picks it and leaves it in place", async ({ page }) => {
    await open(page, "/plan", { width: 390 });
    const canvas = editor(page).locator("outglow-editor-canvas");
    await canvas.scrollIntoViewIfNeeded();
    let v = await view(page);
    await page.touchscreen.tap(...screen(v, 1, 3));
    await expect(canvas.locator("circle.handle")).toHaveCount(4);
    v = await view(page);
    await page.touchscreen.tap(...screen(v, 0, 0));
    await page.waitForTimeout(60);
    await page.touchscreen.tap(...screen(v, 0, 0));
    await page.waitForTimeout(300);
    expect(await outline(page, "living")).toEqual(LIVING);
    await expect(editor(page).locator(".inspector h2")).toHaveText("Corner");
  });
});

async function selection(page: Page): Promise<unknown> {
  return page.evaluate(() => structuredClone((document.querySelector("outglow-panel")!.shadowRoot!.querySelector("outglow-plan-editor") as unknown as { _selection: unknown })._selection));
}

async function planRing(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector("outglow-panel")!.shadowRoot!.querySelector("outglow-plan-editor")!.shadowRoot!.querySelector("outglow-editor-canvas")!;
    const svg = canvas.shadowRoot!.querySelector("svg.plan")!;
    return canvas.shadowRoot!.activeElement === svg && svg.matches(":focus-visible");
  });
}

interface KeyInit {
  key: string;
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  modifierAltGraph?: boolean;
}

async function key(page: Page, init: KeyInit): Promise<void> {
  await page.evaluate((init) => {
    const ed = document.querySelector("outglow-panel")!.shadowRoot!.querySelector("outglow-plan-editor")!;
    ed.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, cancelable: true, ...init } as KeyboardEventInit));
  }, init);
}

test.describe("picking with the keyboard, and merging", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, "/plan", { width: 1440 });
  });

  test("a picked corner stays the same corner when a handle resizes the room", async ({ page }) => {
    await setRooms(page, [["l", "Ell", [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]]]);
    const v = await view(page);
    await page.mouse.click(...screen(v, 1, 1));
    for (let i = 0; i < 4; i += 1) await page.keyboard.press(".");
    expect(await selection(page)).toEqual({ kind: "vertex", id: "l", index: 3, at: [2, 2] });
    const knob = editor(page).locator("outglow-editor-canvas g.grip[data-handle=e] rect.knob");
    const box = (await knob.boundingBox())!;
    const from: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
    await drag(page, from, [from[0] - 2 * v.s, from[1]]);
    expect(await outline(page, "l")).toEqual([[0, 0], [2, 0], [2, 2], [1, 2], [1, 4], [0, 4]]);
    expect(await selection(page)).toEqual({ kind: "vertex", id: "l", index: 3, at: [1, 2] });
    await expect(editor(page).locator(".inspector")).toContainText("Corner 4 of Ell");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await selection(page)).toEqual({ kind: "vertex", id: "l", index: 3, at: [2, 2] });
    await page.keyboard.press("ControlOrMeta+Shift+z");
    expect(await selection(page)).toEqual({ kind: "vertex", id: "l", index: 3, at: [1, 2] });
  });

  test("a picked corner stays the same corner when a wall drag renumbers the corners", async ({ page }) => {
    await setRooms(page, [["r", "Room", [[2, 0], [4, 0], [4, 3], [0, 3], [0, 1], [0, 0]]]]);
    const v = await view(page);
    await page.mouse.click(...screen(v, 3, 2));
    for (let i = 0; i < 3; i += 1) await page.keyboard.press(".");
    expect(await selection(page)).toEqual({ kind: "vertex", id: "r", index: 2, at: [4, 3] });
    await drag(page, screen(v, 1, 0), screen(v, 1, 1));
    expect(await outline(page, "r")).toEqual([[2, 1], [2, 0], [4, 0], [4, 3], [0, 3], [0, 1]]);
    expect(await selection(page)).toEqual({ kind: "vertex", id: "r", index: 3, at: [4, 3] });
    await expect(editor(page).locator(".hint [role=status]")).toHaveText("Corner 4 of Room, at 4 m, 3 m");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await selection(page)).toEqual({ kind: "vertex", id: "r", index: 2, at: [4, 3] });
    await page.keyboard.press("ControlOrMeta+Shift+z");
    expect(await selection(page)).toEqual({ kind: "vertex", id: "r", index: 3, at: [4, 3] });
  });

  test("the second wall to the same room is read out apart from the first", async ({ page }) => {
    await setRooms(page, [["a", "Alpha", [[0, 0], [2, 0], [2, 2], [0, 2]]], ["b", "Beta", [[2, 0], [4, 0], [4, 4], [0, 4], [0, 2], [2, 2]]]], [[[2, 0], [2, 2]], [[2, 2], [0, 2]]]);
    const v = await view(page);
    const status = editor(page).locator(".hint [role=status]");
    await page.mouse.click(...screen(v, 1, 1));
    await page.keyboard.press("]");
    await expect(status).toHaveText("Wall 1 of 2 of Alpha: between Alpha and Beta, 2 m");
    await page.keyboard.press("]");
    await expect(status).toHaveText("Wall 2 of 2 of Alpha: between Alpha and Beta, 2 m");
    await page.keyboard.press("[");
    await expect(status).toHaveText("Wall 1 of 2 of Alpha: between Alpha and Beta, 2 m");
  });

  test("one live line says the pick, follows the corner and goes with Esc", async ({ page }) => {
    const v = await view(page);
    const live = editor(page).locator(".hint [role=status], .hint [aria-live]");
    await page.mouse.click(...screen(v, 1, 3));
    await expect(live).toHaveCount(1);
    await expect(live).toContainText(", and . pick a corner");
    await page.keyboard.press(".");
    await expect(live).toHaveText("Corner 1 of Living room, at 0 m, 0 m");
    await expect(editor(page).locator(".hint .hint-text")).toContainText(", and . pick the previous and next corner.");
    await page.keyboard.press("ArrowRight");
    await expect(live).toHaveText("Corner 1 of Living room, at 0.1 m, 0 m");
    await drag(page, screen(v, 0.1, 0), screen(v, 0.5, 0.5));
    await expect(live).toHaveText("Corner 1 of Living room, at 0.5 m, 0.5 m");
    await page.keyboard.press("Escape");
    await expect(live).toHaveText("Click a room to resize, move or reshape it, or a wall, door or bulb to edit it. Drag empty space to pan.");
  });

  test("the hints name the previous and next corner and wall, in Polish too", async ({ page }) => {
    const v = await view(page);
    const hint = editor(page).locator(".hint .hint-text");
    await page.mouse.click(...screen(v, 1, 3));
    await page.mouse.click(...screen(v, 0, 0));
    await expect(hint).toContainText(", and . pick the previous and next corner.");
    await page.keyboard.press("Escape");
    await page.mouse.click(...screen(v, 5, 1));
    await expect(hint).toContainText("[ and ] pick the previous and next wall.");
    await open(page, "/plan", { width: 1440, lang: "pl" });
    const w = await view(page);
    await page.mouse.click(...screen(w, 1, 3));
    await page.mouse.click(...screen(w, 0, 0));
    await expect(hint).toContainText(", i . wybierają poprzedni i następny narożnik.");
    await page.keyboard.press("Escape");
    await page.mouse.click(...screen(w, 5, 1));
    await expect(hint).toContainText("[ i ] wybierają poprzednią i następną ścianę.");
  });

  test("Delete on a picked corner with the focus on the panel puts the ring on the plan", async ({ page }) => {
    const v = await view(page);
    await page.mouse.click(...screen(v, 1, 3));
    await page.keyboard.press(".");
    const button = editor(page).locator(".inspector [data-action=remove-corner]");
    await button.focus();
    if (test.info().project.name === "chrome") {
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
    }
    await expect(button).toBeFocused();
    await page.keyboard.press("Delete");
    expect(await outline(page, "living")).toEqual(LIVING.slice(1));
    expect(await planRing(page)).toBe(true);
  });

  test("the merge note names the areas, and the bulbs that would lose their room", async ({ page }) => {
    await setRooms(page, [["a", "Big", [[0, 0], [4, 0], [4, 3], [0, 3]], "living"], ["b", "Small", [[4, 0], [6, 0], [6, 3], [4, 3]], "hall"]], [[[4, 0], [4, 3]]]);
    await page.evaluate(async () => {
      const ed = document.querySelector("outglow-panel")!.shadowRoot!.querySelector("outglow-plan-editor") as unknown as { bulbs: { ieee: string; area_id: string | null }[]; updateComplete: Promise<unknown> };
      ed.bulbs = ed.bulbs.map((b) => (b.ieee.endsWith("3") ? { ...b, area_id: "hall" } : b));
      await ed.updateComplete;
    });
    const v = await view(page);
    await page.mouse.click(...screen(v, 4, 1.5));
    const note = editor(page).locator(".inspector .merge-loses");
    await expect(note).toContainText("Big stays in the area Living room; the area Hall of Small is then no room's.");
    await expect(note).toContainText("Hall is not on the plan and belongs to Small through the area Hall: after the merge it belongs to no room.");
    await editor(page).locator(".inspector").getByRole("button", { name: "Merge into one room" }).click();
    expect((await currentPlan(page)).rooms).toMatchObject([{ id: "a", area_id: "living" }]);
    await expect(editor(page).locator(".hint [role=status]")).toContainText("Hall is not on the plan");
  });

  test("a merge takes the other room's area when the kept room's area is gone from Home Assistant", async ({ page }) => {
    await setRooms(page, [["a", "Big", [[0, 0], [4, 0], [4, 3], [0, 3]], "deleted_area"], ["b", "Small", [[4, 0], [6, 0], [6, 3], [4, 3]], "hall"]], [[[4, 0], [4, 3]]]);
    const v = await view(page);
    await page.mouse.click(...screen(v, 4, 1.5));
    await expect(editor(page).locator(".inspector .merge-loses")).toContainText("Big takes the area Hall from Small.");
    await editor(page).locator(".inspector").getByRole("button", { name: "Merge into one room" }).click();
    expect((await currentPlan(page)).rooms).toMatchObject([{ id: "a", area_id: "hall" }]);
  });

  test("corners and walls are picked with AltGr or Option and by the key's place, not with Ctrl or Cmd", async ({ page }) => {
    const v = await view(page);
    await page.mouse.click(...screen(v, 1, 3));
    await page.keyboard.press("Control+BracketRight");
    expect(await selection(page)).toEqual({ kind: "room", id: "living" });
    await page.keyboard.press("Meta+Period");
    expect(await selection(page)).toEqual({ kind: "room", id: "living" });
    await page.keyboard.press("Alt+BracketRight");
    expect(await selection(page)).toMatchObject({ kind: "wall", pair: "hall|living" });
    await page.mouse.click(...screen(v, 1, 3));
    await key(page, { key: "]", code: "Digit9", ctrlKey: true, altKey: true, modifierAltGraph: true });
    expect(await selection(page)).toMatchObject({ kind: "wall", pair: "hall|living" });
    await page.mouse.click(...screen(v, 1, 3));
    await key(page, { key: "ü", code: "BracketLeft" });
    expect(await selection(page)).toMatchObject({ kind: "wall", pair: "living|office" });
    await page.mouse.click(...screen(v, 1, 3));
    await key(page, { key: ";", code: "Comma" });
    expect(await selection(page)).toMatchObject({ kind: "vertex", id: "living", index: 3 });
    await page.mouse.click(...screen(v, 1, 3));
    await key(page, { key: "r", code: "Period" });
    expect(await selection(page)).toEqual({ kind: "room", id: "living" });
    expect(await page.evaluate(() => (document.querySelector("outglow-panel")!.shadowRoot!.querySelector("outglow-plan-editor") as unknown as { _tool: string })._tool)).toBe("rect");
  });
});

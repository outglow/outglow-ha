import { expect, test, type Locator, type Page } from "@playwright/test";
import { drag, open, screen, view } from "./helpers";

type Point = [number, number];

interface Room {
  id: string;
  name: string;
  outline: Point[];
  colour: string;
  area_id: null;
  entrance: boolean;
}

interface PlanLike {
  rooms: Room[];
  walls: { a: Point; b: Point; kind: string }[];
  doors: { wall: number; at: number; width: number; kind: string }[];
  bulbs: { ieee: string; x: number; y: number; room: string | null }[];
}

function editor(page: Page): Locator {
  return page.locator("outglow-plan-editor");
}

function rect(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

function room(id: string, name: string, outline: Point[], colour: string): Room {
  return { id, name, outline, colour, area_id: null, entrance: false };
}

async function currentPlan(page: Page): Promise<PlanLike> {
  return page.evaluate(() => {
    const panel = document.querySelector("outglow-panel")!;
    const ed = panel.shadowRoot!.querySelector("outglow-plan-editor") as unknown as { _plan: never };
    return structuredClone(ed._plan);
  });
}

async function load(page: Page, patch: Partial<PlanLike>): Promise<void> {
  await page.evaluate(async (patch) => {
    const panel = document.querySelector("outglow-panel")!;
    const ed = panel.shadowRoot!.querySelector("outglow-plan-editor") as unknown as {
      _plan: Record<string, unknown>;
      _history: { reset(plan: unknown): void };
      _saved: unknown;
      _version: number;
      updateComplete: Promise<unknown>;
      renderRoot: ShadowRoot;
    };
    const plan = { ...ed._plan, bulbs: [], doors: [], walls: [], adjacent: [], ...patch };
    ed._history.reset(plan);
    ed._saved = plan;
    ed._version += 1;
    await ed.updateComplete;
    (ed.renderRoot.querySelector("outglow-editor-canvas") as unknown as { fit(): void }).fit();
  }, patch);
  await page.waitForTimeout(50);
}

function threeRooms(): Partial<PlanLike> {
  return {
    rooms: [room("b", "Bedroom", rect(4, 0, 8, 3), "#4e9af1"), room("c", "Closet", rect(0, 3, 3, 6), "#f28b30"), room("a", "Attic", rect(0, 0, 4, 3), "#42b883")],
    walls: [
      { a: [4, 3], b: [4, 0], kind: "partition" },
      { a: [0, 3], b: [3, 3], kind: "glass" },
    ],
  };
}

test.describe("walls between two rooms", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, "/plan", { width: 1440 });
    await expect(editor(page).locator("outglow-editor-canvas")).toBeVisible();
  });

  test("a dragged wall stays selected and arrows keep moving it", async ({ page }) => {
    await load(page, threeRooms());
    const v = await view(page);
    await drag(page, screen(v, 4, 1.5), screen(v, 2.8, 1.5));
    const inspector = editor(page).locator(".inspector");
    await expect(inspector).toContainText("Between Bedroom and Attic");
    await expect(inspector).toContainText("Length 3 m");
    await expect(inspector.locator("[role=radio][aria-checked=true]")).toHaveText("Partition");
    const walls = (await currentPlan(page)).walls.map((w) => [[w.a, w.b].sort((p, q) => p[0] - q[0] || p[1] - q[1]), w.kind]);
    expect(walls).toContainEqual([[[2.8, 3], [3, 3]], "partition"]);
    expect(walls).toContainEqual([[[0, 3], [2.8, 3]], "glass"]);
    await page.keyboard.press("ArrowLeft");
    await expect(inspector).toContainText("Between Bedroom and Attic");
    const attic = (await currentPlan(page)).rooms.find((r) => r.id === "a")!.outline;
    expect(attic).toEqual(rect(0, 0, 2.7, 3));
    await page.keyboard.press("ControlOrMeta+z");
    expect((await currentPlan(page)).rooms.find((r) => r.id === "a")!.outline).toEqual(rect(0, 0, 2.8, 3));
    await page.keyboard.press("ControlOrMeta+z");
    expect((await currentPlan(page)).rooms.find((r) => r.id === "a")!.outline).toEqual(rect(0, 0, 4, 3));
  });

  test("a wall dragged far stays selected rather than another wall of the same two rooms", async ({ page }) => {
    await load(page, {
      rooms: [
        room("l", "Lounge", [[0, 0], [6, 0], [6, 4.5], [5, 4.5], [5, 6], [0, 6]], "#4e9af1"),
        room("n", "Nook", rect(5, 4.5, 6, 6), "#f28b30"),
      ],
      walls: [
        { a: [6, 4.5], b: [5, 4.5], kind: "partition" },
        { a: [5, 4.5], b: [5, 6], kind: "partition" },
      ],
    });
    const v = await view(page);
    const inspector = editor(page).locator(".inspector");
    await drag(page, screen(v, 5.5, 4.5), screen(v, 5.5, 3));
    await expect(inspector).toContainText("Between Lounge and Nook");
    await expect(inspector).toContainText("Length 1 m");
    await page.keyboard.press("ArrowUp");
    expect((await currentPlan(page)).rooms.find((r) => r.id === "n")!.outline).toEqual(rect(5, 2.9, 6, 6));
    await page.mouse.click(...screen(v, 5, 5));
    await expect(inspector).toContainText("Length 3.1 m");
    await page.keyboard.press("ArrowLeft");
    expect((await currentPlan(page)).rooms.find((r) => r.id === "n")!.outline).toEqual(rect(4.9, 2.9, 6, 6));
  });

  test("a door stays between its two rooms when the wall beside it moves, and goes with a note when they part", async ({ page }) => {
    await load(page, {
      rooms: [room("a", "Attic", rect(0, 0, 6, 2), "#4e9af1"), room("b", "Bedroom", rect(0, 2, 3, 5), "#f28b30"), room("c", "Closet", rect(3, 2, 6, 5), "#42b883")],
      walls: [
        { a: [3, 2], b: [0, 2], kind: "partition" },
        { a: [6, 2], b: [3, 2], kind: "partition" },
        { a: [3, 2], b: [3, 5], kind: "partition" },
      ],
      doors: [{ wall: 2, at: 0.25, width: 0.9, kind: "door" }],
      adjacent: [["b", "c"]],
    } as Partial<PlanLike>);
    const v = await view(page);
    await drag(page, screen(v, 1.5, 2), screen(v, 1.5, 2.8));
    let plan = await currentPlan(page);
    expect(plan.rooms.find((r) => r.id === "b")!.outline).toEqual(rect(0, 2.8, 3, 5));
    expect((plan as unknown as { adjacent: string[][] }).adjacent).toEqual([["b", "c"]]);
    await page.mouse.click(...screen(v, 3, 3.25));
    await expect(editor(page).locator(".inspector h2")).toHaveText("Door");
    await expect(editor(page).locator(".inspector")).toContainText("Between Bedroom and Closet");
    await drag(page, screen(v, 4.5, 4), screen(v, 5.5, 4));
    plan = await currentPlan(page);
    expect(plan.doors).toEqual([]);
    await expect(editor(page).locator(".hint [role=status]")).toHaveText("The door between Bedroom and Closet goes, as the rooms no longer share a wall.");
  });

  test("a slanted wall dragged there and back moves the same in both rooms and comes back exactly", async ({ page }) => {
    const rooms = [
      room("a", "Attic", [[0, -3], [8, -3], [8, 1.5], [4, 1], [0, 0]], "#4e9af1"),
      room("b", "Bedroom", [[0, 0], [4, 1], [4, 4], [0, 4]], "#f28b30"),
    ];
    await load(page, { rooms, walls: [{ a: [4, 1], b: [0, 0], kind: "partition" }] });
    const v = await view(page);
    const n: Point = [1 / Math.hypot(1, 4), -4 / Math.hypot(1, 4)];
    const at = (k: number): [number, number] => screen(v, 2 + n[0] * k, 0.5 + n[1] * k);
    for (let i = 0; i < 3; i += 1) {
      await drag(page, at(0), at(0.3));
      const plan = await currentPlan(page);
      const a = plan.rooms.find((r) => r.id === "a")!.outline;
      const b = plan.rooms.find((r) => r.id === "b")!.outline;
      expect(b).toEqual([[0, -0.309], [4, 0.691], [4, 4], [0, 4]]);
      expect(a).toEqual([[0, -3], [8, -3], [8, 1.5], [4, 1], [4, 0.691], [0, -0.309]]);
      await drag(page, at(0.3), at(0));
      expect((await currentPlan(page)).rooms.map((r) => r.outline)).toEqual(rooms.map((r) => r.outline));
    }
    await expect(editor(page).locator("ul.issues")).not.toContainText("overlaps");
  });

  test("dragging the wall moves only what the two rooms share and says which bulb changes room", async ({ page }) => {
    const v = await view(page);
    await page.mouse.click(...screen(v, 5, 1));
    await expect(editor(page).locator(".inspector")).toContainText("Between Living room and Hall");
    await drag(page, screen(v, 5, 1), screen(v, 3.5, 1));
    const plan = await currentPlan(page);
    const outline = (id: string) => plan.rooms.find((r) => r.id === id)!.outline;
    expect(outline("living")).toEqual(rect(0, 0, 3.5, 4));
    expect(outline("hall")).toEqual([
      [3.5, 0],
      [7, 0],
      [7, 6],
      [5, 6],
      [5, 4],
      [3.5, 4],
    ]);
    expect(outline("office")).toEqual(rect(2, 4, 5, 7));
    expect(plan.bulbs.every((b) => b.room === null)).toBe(true);
    await expect(editor(page).locator(".hint [role=status]")).toHaveText(
      "After this change Living window belongs to Hall (before: Living room). To keep it in Living room, choose that room under Room in the bulb's settings.",
    );
    await expect(editor(page).locator("outglow-editor-canvas g.pin")).toHaveCount(0);
  });

  test("a pinned bulb shows a pin, is flagged when a wall leaves it in another room, and unpins", async ({ page }) => {
    const v = await view(page);
    const inspector = editor(page).locator(".inspector");
    await page.mouse.click(...screen(v, 3.8, 2.5));
    await inspector.locator("select").selectOption("living");
    const pin = editor(page).locator("outglow-editor-canvas g.pin[data-pinned='0x0000000000000002']");
    await expect(pin).toHaveCount(1);
    await expect(inspector).toContainText("Pinned to Living room");
    await drag(page, screen(v, 5, 1), screen(v, 3.5, 1));
    await expect(editor(page).locator(".hint [role=status]")).not.toContainText("Living window");
    const issue = editor(page).locator("ul.issues li", { hasText: "Living window is pinned to Living room, though it stands in Hall" });
    await expect(issue).toHaveCount(1);
    await issue.getByRole("button", { name: "Unpin" }).click();
    await expect(issue).toHaveCount(0);
    await expect(pin).toHaveCount(0);
    expect((await currentPlan(page)).bulbs.find((b) => b.ieee.endsWith("2"))!.room).toBeNull();
  });

  test("a pinned bulb dragged into another room loses its pin", async ({ page }) => {
    const v = await view(page);
    const inspector = editor(page).locator(".inspector");
    await page.mouse.click(...screen(v, 3.8, 2.5));
    await inspector.locator("select").selectOption("living");
    await page.keyboard.press("ArrowRight");
    expect((await currentPlan(page)).bulbs.find((b) => b.ieee.endsWith("2"))!.room).toBe("living");
    await drag(page, screen(v, 3.9, 2.5), screen(v, 6, 2.5));
    const bulb = (await currentPlan(page)).bulbs.find((b) => b.ieee.endsWith("2"))!;
    expect([bulb.x, bulb.y, bulb.room]).toEqual([6, 2.5, null]);
    await expect(editor(page).locator("outglow-editor-canvas g.pin")).toHaveCount(0);
    await expect(inspector).not.toContainText("Pinned to");
  });

  test("an arrow along the selected wall or its own kind changes nothing and adds no undo step", async ({ page }) => {
    const v = await view(page);
    await page.mouse.click(...screen(v, 5, 1));
    await expect(editor(page).locator(".inspector")).toContainText("Between Living room and Hall");
    const before = await currentPlan(page);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Shift+ArrowDown");
    await editor(page).locator(".inspector [role=radio][aria-checked=true]").click();
    expect(await currentPlan(page)).toEqual(before);
    await expect(editor(page).locator(".toolbar .state")).toHaveCount(0);
    await expect(editor(page).getByRole("button", { name: "Undo" })).toBeDisabled();
  });
});

test("an arrow there and back leaves no undo step and no unsaved changes", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const v = await view(page);
  const before = await currentPlan(page);
  await page.mouse.click(...screen(v, 3.8, 2.5));
  await expect(editor(page).locator(".inspector h2")).toHaveText("Living window");
  await page.keyboard.press("ArrowRight");
  await expect(editor(page).locator(".toolbar .state")).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  expect(await currentPlan(page)).toEqual(before);
  await expect(editor(page).getByRole("button", { name: "Undo" })).toBeDisabled();
  await expect(editor(page).locator(".toolbar .state")).toHaveCount(0);
});

test("arrows that move a room away and back keep its doors and neighbours", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const v = await view(page);
  const before = await currentPlan(page);
  await page.mouse.click(...screen(v, 1, 3));
  await expect(editor(page).locator(".inspector h2")).toHaveText("Room");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const after = await currentPlan(page);
  expect(after.doors).toEqual(before.doors);
  expect((after as unknown as { adjacent: unknown }).adjacent).toEqual((before as unknown as { adjacent: unknown }).adjacent);
  expect(after).toEqual(before);
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowRight");
  expect(await currentPlan(page)).toEqual(before);
  await expect(editor(page).getByRole("button", { name: "Undo" })).toBeDisabled();
});

test("a selected door stays selected when undo brings back a door before it", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const v = await view(page);
  const inspector = editor(page).locator(".inspector");
  await page.mouse.click(...screen(v, 5, 2.4));
  await expect(inspector).toContainText("Between Living room and Hall");
  await page.keyboard.press("Delete");
  await page.mouse.click(...screen(v, 5, 5));
  await expect(inspector).toContainText("Between Hall and Office");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor(page).locator("outglow-editor-canvas .door")).toHaveCount(2);
  await expect(inspector.locator("h2")).toHaveText("Door");
  await expect(inspector).toContainText("Between Hall and Office");
});

test("a change put back by hand leaves no unsaved changes", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  const v = await view(page);
  await page.mouse.click(...screen(v, 5, 1));
  const kinds = editor(page).locator(".inspector [role=radiogroup]").first();
  await kinds.getByRole("radio", { name: "Glass" }).click();
  await expect(editor(page).locator(".toolbar .state")).toHaveCount(1);
  await kinds.getByRole("radio", { name: "Partition" }).click();
  await expect(editor(page).getByRole("button", { name: "Undo" })).toBeEnabled();
  await expect(editor(page).locator(".toolbar .state")).toHaveCount(0);
});

test("Alt with an arrow on a selected wall, door or bulb does not go back a page", async ({ page }) => {
  await open(page, "/plan", { width: 1440 });
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { seen: boolean[] }).seen = seen;
    window.addEventListener("keydown", (e) => {
      if (e.altKey && e.key.startsWith("Arrow")) seen.push(e.defaultPrevented);
    });
  });
  const v = await view(page);
  for (const [at, heading] of [
    [[5, 1], "Wall"],
    [[5, 2.4], "Door"],
    [[3.8, 2.5], "Living window"],
  ] as [Point, string][]) {
    await page.mouse.click(...screen(v, at[0], at[1]));
    await expect(editor(page).locator(".inspector h2")).toHaveText(heading);
    await page.keyboard.press("Alt+ArrowLeft");
  }
  expect(await page.evaluate(() => (window as unknown as { seen: boolean[] }).seen)).toEqual([true, true, true]);
  await expect(editor(page).getByRole("button", { name: "Undo" })).toBeDisabled();
});

test.describe("on a phone", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("a cancelled touch puts a dragged room back like Esc", async ({ page }) => {
    await open(page, "/plan", { width: 390 });
    const canvas = editor(page).locator("outglow-editor-canvas");
    await canvas.scrollIntoViewIfNeeded();
    const v = await view(page);
    const [tx, ty] = screen(v, 1, 3);
    await page.touchscreen.tap(tx, ty);
    await expect(canvas.locator("g.grip")).not.toHaveCount(0);
    const before = await currentPlan(page);
    const cdp = await page.context().newCDPSession(page);
    const point = (x: number, y: number) => [{ x, y, id: 1, radiusX: 6, radiusY: 6, force: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(tx, ty) });
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(tx + i * 0.25 * v.s, ty) });
    }
    expect((await currentPlan(page)).rooms[0]!.outline).not.toEqual(before.rooms[0]!.outline);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await cdp.detach();
    expect(await currentPlan(page)).toEqual(before);
    await expect(editor(page).getByRole("button", { name: "Undo" })).toBeDisabled();
  });
});

import type { Page } from "@playwright/test";

export const WIDTHS = [390, 768, 1440] as const;
export const THEMES = ["light", "dark"] as const;

export interface OpenOptions {
  theme?: "light" | "dark";
  lang?: "en" | "pl";
  width?: number;
  height?: number;
  latency?: number;
  reducedMotion?: boolean;
}

export async function open(page: Page, path: string, options: OpenOptions = {}): Promise<void> {
  const width = options.width ?? 1440;
  await page.setViewportSize({ width, height: options.height ?? (width < 500 ? 844 : width < 1000 ? 1024 : 900) });
  if (options.reducedMotion) {
    await page.emulateMedia({ reducedMotion: "reduce" });
  }
  const params = new URLSearchParams({
    theme: options.theme ?? "light",
    lang: options.lang ?? "en",
    shot: "1",
    latency: String(options.latency ?? 20),
  });
  await page.goto(`/outglow${path}?${params}`);
  await page.locator("outglow-panel main").waitFor();
  await page.waitForFunction(() => !document.querySelector("outglow-panel")?.shadowRoot?.querySelector("[aria-busy=true]"));
}

export interface CanvasView {
  left: number;
  top: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  s: number;
}

export async function view(page: Page): Promise<CanvasView> {
  return page.evaluate(() => {
    const panel = document.querySelector("outglow-panel")!;
    const editor = panel.shadowRoot!.querySelector("outglow-plan-editor")!;
    const canvas = editor.shadowRoot!.querySelector("outglow-editor-canvas") as unknown as {
      getBoundingClientRect(): DOMRect;
      _view: { cx: number; cy: number; s: number };
      _size: [number, number];
    };
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, w: canvas._size[0], h: canvas._size[1], ...canvas._view };
  });
}

export function screen(v: CanvasView, x: number, y: number): [number, number] {
  return [v.left + v.w / 2 + (x - v.cx) * v.s, v.top + v.h / 2 + (y - v.cy) * v.s];
}

export async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
  await page.mouse.up();
}

import { svg, nothing, type ReactiveControllerHost } from "lit";
import { call } from "./api/client";
import type { Background, BackgroundImage } from "./api/types";
import type { Hass } from "./hass";

const KEPT = 3;
const images = new Map<string, Promise<string | null>>();
const sizes = new Map<string, Promise<[number, number] | null>>();

function remember<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const made = make();
  cache.set(key, made);
  while (cache.size > KEPT) cache.delete(cache.keys().next().value!);
  return made;
}

export function imageUrl(image: BackgroundImage): string {
  return `data:${image.mime};base64,${image.data_base64}`;
}

export function savedBackground(hass: Hass, file: string): Promise<string | null> {
  return remember(images, file, () =>
    call(hass, "outglow/plan/background/get", {}).then(
      (result) => {
        if (result.image && result.file === file) return imageUrl(result.image);
        images.delete(file);
        return null;
      },
      () => {
        images.delete(file);
        return null;
      },
    ),
  );
}

export function imageSize(url: string): Promise<[number, number] | null> {
  return remember(
    sizes,
    url,
    () =>
      new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth && image.naturalHeight ? [image.naturalWidth, image.naturalHeight] : null);
        image.onerror = () => resolve(null);
        image.src = url;
      }),
  );
}

export class Backdrop {
  url: string | null = null;
  size: [number, number] | null = null;
  private _key: string | null = null;

  constructor(private readonly host: ReactiveControllerHost) {}

  show(source: { url: string } | { hass: Hass | undefined; file: string } | null): void {
    const key = source === null ? null : "url" in source ? `url:${source.url}` : source.hass ? `file:${source.file}` : null;
    if (key === this._key) return;
    this._key = key;
    this.url = null;
    this.size = null;
    if (source === null || key === null) return;
    const url = "url" in source ? Promise.resolve(source.url) : savedBackground(source.hass!, source.file);
    void url.then(async (found) => {
      const size = found ? await imageSize(found) : null;
      if (this._key !== key || !found || !size) return;
      this.url = found;
      this.size = size;
      this.host.requestUpdate();
    });
  }
}

export function backdrop(url: string | null, size: [number, number] | null, placed: Background | null | undefined, dark: boolean) {
  if (!url || !size || !placed) return nothing;
  const invert = dark && url.startsWith("data:image/svg+xml");
  return svg`<image class="backdrop ${invert ? "dark" : ""}" data-layer="background" href=${url} x=${placed.x} y=${placed.y}
    width=${size[0] * placed.m_per_px} height=${size[1] * placed.m_per_px} opacity=${placed.opacity} preserveAspectRatio="none"
    pointer-events="none"></image>`;
}

import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import type { DirectionFrame, Frame, Plan, Point, Room, WallKind } from "./api/types";
import { fmtPercent } from "./format";
import { boxOf, bulbRoom, contains, distanceToBoundary, labelPoint, planBox, trailPath, type Box } from "./geometry";
import { approach, blobSources, fillHeat, heatGrid, pairSources, type HeatGrid } from "./heat";
import { strings, type Loc } from "./i18n";
import { tokens } from "./theme";

const t = strings(
  {
    motion: "motion",
    occupied: "occupied",
    empty: "empty",
    room: "{name}: {state}, {p}",
    pair: "{a} and {b}: {obs}",
    both: "both directions",
    one: "one direction",
    plan: "Floor plan",
  },
  {
    motion: "ruch",
    occupied: "zajęty",
    empty: "pusto",
    room: "{name}: {state}, {p}",
    pair: "{a} i {b}: {obs}",
    both: "obie strony",
    one: "jedna strona",
    plan: "Plan mieszkania",
  },
);

export interface Layers {
  lines: boolean;
  trail: boolean;
  heat: boolean;
  bulbNames: boolean;
}

export const DEFAULT_LAYERS: Layers = { lines: true, trail: true, heat: true, bulbNames: false };

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

interface Pulse {
  from: Point;
  to: Point;
  born: number;
}

interface Colours {
  motion: string;
  card: string;
  fg: string;
  fg2: string;
  primary: string;
  divider: string;
  error: string;
}

const PULSE_MS = 950;
const WALL_PX: Record<WallKind, number> = { partition: 2.5, brick: 4.5, concrete: 6, glass: 2.5, none: 0 };

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function rgba(colour: string, alpha: number): string {
  const hex = colour.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(hex);
  let parts: number[] | null = null;
  if (short) parts = [1, 2, 3].map((i) => parseInt(short[i]! + short[i]!, 16));
  else if (long) parts = [1, 2, 3].map((i) => parseInt(long[i]!, 16));
  else if (rgb) parts = [1, 2, 3].map((i) => Number(rgb[i]));
  return parts ? `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})` : colour;
}

function channels(colour: string): [number, number, number] {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(rgba(colour, 1));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [255, 152, 0];
}

export class OutglowPlanView extends LitElement {
  static override properties = {
    plan: { attribute: false },
    frame: { attribute: false },
    names: { attribute: false },
    loc: { attribute: false },
    layers: { attribute: false },
    rooms: { attribute: false },
    selected: { attribute: false },
    lineColours: { attribute: false },
    markers: { attribute: false },
    highlight: { attribute: false },
    roomColours: { attribute: false },
    roomNotes: { attribute: false },
    hidePredictions: { type: Boolean, attribute: "hide-predictions" },
    calm: { type: Boolean },
    interactive: { type: Boolean },
    dark: { type: Boolean },
    maxHeight: { attribute: "max-height" },
    background: { attribute: false },
    _size: { state: true },
    _backgroundSize: { state: true },
  };

  declare plan: Plan | null;
  declare frame: Frame | null;
  declare names: Record<string, string>;
  declare loc: Loc;
  declare layers: Layers;
  declare rooms: string[] | null;
  declare selected: string | null;
  declare lineColours: Map<string, string> | null;
  declare markers: Point[];
  declare highlight: string | null;
  declare roomColours: Map<string, string> | null;
  declare roomNotes: Map<string, string> | null;
  declare hidePredictions: boolean;
  declare calm: boolean;
  declare interactive: boolean;
  declare dark: boolean;
  declare maxHeight: string;
  declare background: string | null;
  declare _size: [number, number];
  declare _backgroundSize: [number, number] | null;

  private _observer: ResizeObserver | null = null;
  private _raf = 0;
  private _last = 0;
  private _pulses: Pulse[] = [];
  private _glow = new Map<string, number>();
  private _glowTarget = new Map<string, { a: Point; b: Point; value: number; weight: number }>();
  private _heat: HeatGrid | null = null;
  private _heatTarget: HeatGrid | null = null;
  private _heatImage: HTMLCanvasElement | null = null;
  private _colours: Colours | null = null;
  private _prevStates = new Map<string, DirectionFrame["state"]>();
  private _box: Box = [0, 0, 1, 1];

  constructor() {
    super();
    this.plan = null;
    this.frame = null;
    this.names = {};
    this.loc = { lang: "en", numbers: "en", hour12: undefined };
    this.layers = DEFAULT_LAYERS;
    this.rooms = null;
    this.selected = null;
    this.lineColours = null;
    this.markers = [];
    this.highlight = null;
    this.roomColours = null;
    this.roomNotes = null;
    this.hidePredictions = false;
    this.calm = false;
    this.interactive = false;
    this.dark = false;
    this.maxHeight = "70vh";
    this.background = null;
    this._size = [0, 0];
    this._backgroundSize = null;
  }

  static override styles = [
    tokens,
    css`
      :host {
        display: block;
        position: relative;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .stage {
        position: relative;
        width: 100%;
        margin: 0 auto;
      }
      svg,
      canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
        overflow: visible;
      }
      canvas {
        pointer-events: none;
      }
      .outline {
        fill: none;
        stroke: color-mix(in srgb, var(--og-fg) 50%, transparent);
        stroke-width: 2.5;
        stroke-linejoin: miter;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .wall.erase {
        stroke: var(--og-card);
      }
      .room {
        stroke-width: 4;
        vector-effect: non-scaling-stroke;
        stroke-linejoin: round;
        transition: fill-opacity 300ms var(--og-ease), stroke-opacity 300ms var(--og-ease);
      }
      .room.hit {
        cursor: pointer;
      }
      .room.hit,
      .hit-line {
        outline: none;
        -webkit-tap-highlight-color: transparent;
      }
      .room:focus-visible {
        stroke: var(--og-primary);
        stroke-width: 3;
        stroke-opacity: 1;
      }
      .wall {
        stroke: color-mix(in srgb, var(--og-fg) 50%, transparent);
        stroke-linecap: butt;
        vector-effect: non-scaling-stroke;
      }
      .wall.glass {
        stroke: color-mix(in srgb, var(--og-info) 60%, transparent);
        stroke-dasharray: 6 3;
      }
      .door {
        stroke: var(--og-card);
        vector-effect: non-scaling-stroke;
        stroke-linecap: butt;
      }
      .jamb {
        stroke: color-mix(in srgb, var(--og-fg) 55%, transparent);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
      }
      .pair {
        fill: none;
        stroke: var(--og-motion);
        stroke-linecap: round;
        vector-effect: non-scaling-stroke;
        transition: stroke-opacity 450ms var(--og-ease), stroke-width 450ms var(--og-ease);
      }
      .pair.one {
        stroke-dasharray: 5 6;
      }
      .pair.quiet {
        stroke: color-mix(in srgb, var(--og-fg) 40%, transparent);
      }
      .pair-halo {
        fill: none;
        stroke: var(--og-primary);
        stroke-opacity: 0.22;
        stroke-linecap: round;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .pair.coloured {
        transition: stroke 300ms;
      }
      .hit-line {
        stroke: transparent;
        stroke-width: 16;
        vector-effect: non-scaling-stroke;
        cursor: pointer;
        fill: none;
      }
      .hit-line:focus-visible {
        stroke: var(--og-primary);
        stroke-opacity: 0.5;
        stroke-width: 6;
        stroke-linecap: round;
      }
      .trail {
        fill: none;
        stroke: var(--og-fg);
        stroke-linecap: round;
        stroke-linejoin: round;
        vector-effect: non-scaling-stroke;
        stroke-dasharray: 1 7;
        stroke-width: 3;
      }
      .trail-head {
        fill: var(--og-fg);
      }
      .bulb {
        fill: var(--og-card);
        stroke: color-mix(in srgb, var(--og-fg) 60%, transparent);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
        transition: fill 300ms, stroke 300ms;
      }
      .bulb.open {
        fill: var(--og-motion);
        stroke: var(--og-card);
      }
      .bulb.offline {
        fill: var(--og-card);
        stroke: var(--og-error);
        stroke-dasharray: 2 2;
      }
      .bulb-core {
        fill: color-mix(in srgb, var(--og-fg) 60%, transparent);
      }
      .bulb.open + .bulb-core {
        fill: var(--og-card);
      }
      text {
        font-family: var(--og-font);
        paint-order: stroke;
        stroke: var(--og-card);
        stroke-linejoin: round;
        fill: var(--og-fg);
      }
      .room-name {
        font-weight: 500;
      }
      .room-state {
        fill: var(--og-fg2);
        font-variant-numeric: tabular-nums;
      }
      .room-state.on {
        fill: color-mix(in srgb, var(--og-motion) 70%, var(--og-fg));
        font-weight: 600;
      }
      .bulb-name {
        fill: var(--og-fg2);
      }
      .here {
        fill: none;
        stroke-width: 5;
        stroke-dasharray: 10 6;
        stroke-linejoin: round;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
        animation: march 1.2s linear infinite;
      }
      @keyframes march {
        to {
          stroke-dashoffset: -16;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .here {
          animation: none;
        }
      }
      .marker {
        stroke: var(--og-error);
        stroke-width: 2.5;
        stroke-linecap: round;
        vector-effect: non-scaling-stroke;
      }
      .marker-ring {
        fill: color-mix(in srgb, var(--og-error) 14%, transparent);
        stroke: var(--og-error);
        stroke-width: 1.5;
        stroke-dasharray: 3 3;
        vector-effect: non-scaling-stroke;
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    this._observer = new ResizeObserver(() => this._measure());
    void this.updateComplete.then(() => {
      const stage = this.renderRoot.querySelector(".stage");
      if (stage && this._observer) {
        this._observer.observe(this);
      }
      this._measure();
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._observer?.disconnect();
    this._observer = null;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  private _measure(): void {
    const width = this.clientWidth;
    if (!width) return;
    const [, , bw, bh] = this._box;
    const limit = this._limitPx();
    const natural = (width * bh) / bw;
    const height = Math.min(natural, limit);
    if (Math.abs(width - this._size[0]) > 0.5 || Math.abs(height - this._size[1]) > 0.5) {
      this._size = [width, height];
    }
  }

  private _limitPx(): number {
    const value = this.maxHeight.trim();
    const n = parseFloat(value);
    if (value.endsWith("vh")) return (window.innerHeight * n) / 100;
    if (value.endsWith("px")) return n;
    return Number.isFinite(n) ? n : Infinity;
  }

  private _scale(): number {
    const [w, h] = this._size;
    const [, , bw, bh] = this._box;
    if (!w || !h) return 60;
    return Math.min(w / bw, h / bh);
  }

  private _px(n: number): number {
    return n / this._scale();
  }

  override willUpdate(changed: PropertyValues<this>): void {
    if ((changed.has("plan") || changed.has("rooms")) && this.plan) {
      this._box = planBox(this.plan, 0.4, this.rooms ?? undefined);
      this._heat = null;
      this._heatTarget = null;
      this._measure();
    }
    if (changed.has("frame") || changed.has("plan")) {
      this._ingest();
    }
    if (changed.has("dark")) {
      this._colours = null;
    }
    if (changed.has("background")) {
      this._backgroundSize = null;
      const url = this.background;
      if (url) {
        const image = new Image();
        image.onload = () => {
          if (this.background === url) this._backgroundSize = [image.naturalWidth, image.naturalHeight];
        };
        image.src = url;
      }
    }
  }

  private _backdrop() {
    const placed = this.plan?.background;
    const size = this._backgroundSize;
    if (!this.background || !placed || !size) return nothing;
    return svg`<image class="backdrop" href=${this.background} x=${placed.x} y=${placed.y} width=${size[0] * placed.m_per_px}
      height=${size[1] * placed.m_per_px} opacity=${placed.opacity} preserveAspectRatio="none"></image>`;
  }

  override updated(): void {
    this._kick();
  }

  private _ingest(): void {
    const plan = this.plan;
    if (!plan) return;
    const at = new Map(this._visibleBulbs(plan).map((b) => [b.ieee, [b.x, b.y] as Point]));
    const frame = this.frame;
    const now = performance.now();
    const motionOk = !reducedMotion() && !this.calm;
    const states = new Map<string, DirectionFrame["state"]>();
    for (const d of frame?.directions ?? []) {
      const key = `${d.rx}<${d.tx}`;
      states.set(key, d.state);
      const before = this._prevStates.get(key);
      if (motionOk && d.state === "exceed" && before !== undefined && before !== "exceed") {
        const from = at.get(d.tx);
        const to = at.get(d.rx);
        if (from && to && this.layers.lines) {
          this._pulses.push({ from, to, born: now });
        }
      }
    }
    this._prevStates = states;
    this._pulses = this._pulses.slice(-24);
    this._glowTarget.clear();
    for (const pair of frame?.pairs ?? []) {
      const a = at.get(pair.a);
      const b = at.get(pair.b);
      if (!a || !b) continue;
      const value = pair.obs === 2 ? 1 : pair.obs === 1 ? 0.3 : 0;
      this._glowTarget.set(pairKey(pair.a, pair.b), { a, b, value, weight: pair.weight });
    }
    if (this.layers.heat) {
      if (!this._heatTarget) {
        this._heatTarget = heatGrid(this._box);
        this._heat = heatGrid(this._box);
      }
      const visible = this.rooms ? { ...plan, bulbs: this._visibleBulbs(plan) } : plan;
      fillHeat(this._heatTarget, pairSources(visible, frame), this.hidePredictions ? [] : blobSources(frame));
    }
  }

  private _kick(): void {
    if (!this._raf && this.isConnected) {
      this._last = performance.now();
      this._raf = requestAnimationFrame((now) => this._tick(now));
    }
  }

  private _readColours(): Colours {
    const style = getComputedStyle(this);
    const get = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
    return {
      motion: get("--og-motion", "#ff9800"),
      card: get("--og-card", "#ffffff"),
      fg: get("--og-fg", "#212121"),
      fg2: get("--og-fg2", "#727272"),
      primary: get("--og-primary", "#03a9f4"),
      divider: get("--og-divider", "rgba(0,0,0,0.12)"),
      error: get("--og-error", "#db4437"),
    };
  }

  private _tick(now: number): void {
    this._raf = 0;
    const canvas = this.renderRoot.querySelector("canvas");
    const [w, h] = this._size;
    if (!canvas || !w || !h || !this.plan) {
      return;
    }
    const dt = Math.min(0.25, (now - this._last) / 1000);
    this._last = now;
    const still = reducedMotion() || this.calm;
    const factor = still ? 1 : 1 - Math.exp(-dt / 0.35);
    if (!this._colours) {
      this._colours = this._readColours();
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const s = this._scale();
    const [bx, by, bw, bh] = this._box;
    const ox = (w - bw * s) / 2;
    const oy = (h - bh * s) / 2;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (ox - bx * s), dpr * (oy - by * s));
    let busy = false;
    if (this.layers.heat && this._heat && this._heatTarget) {
      const change = approach(this._heat.values, this._heatTarget.values, factor);
      busy = busy || change > 0.004;
      this._drawHeat(ctx, this._heat);
    }
    if (this.layers.lines) {
      busy = this._drawGlow(ctx, factor, s) || busy;
      busy = this._drawPulses(ctx, now, s) || busy;
    }
    busy = this._drawBulbGlow(ctx, now, s, still) || busy;
    if (busy) {
      this._raf = requestAnimationFrame((next) => this._tick(next));
    }
  }

  private _roomsPath(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    for (const room of this._visibleRooms()) {
      room.outline.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
      ctx.closePath();
    }
  }

  private _drawHeat(ctx: CanvasRenderingContext2D, grid: HeatGrid): void {
    const colours = this._colours!;
    if (!this._heatImage) {
      this._heatImage = document.createElement("canvas");
    }
    const image = this._heatImage;
    if (image.width !== grid.cols || image.height !== grid.rows) {
      image.width = grid.cols;
      image.height = grid.rows;
    }
    const ictx = image.getContext("2d");
    if (!ictx) return;
    const data = ictx.createImageData(grid.cols, grid.rows);
    const [r, g, b] = channels(colours.motion);
    const hot: [number, number, number] = this.dark ? [255, 214, 120] : [255, 112, 0];
    for (let i = 0; i < grid.values.length; i += 1) {
      const v = grid.values[i]!;
      const core = Math.max(0, (v - 0.55) / 0.45);
      data.data[i * 4] = r + (hot[0] - r) * core;
      data.data[i * 4 + 1] = g + (hot[1] - g) * core;
      data.data[i * 4 + 2] = b + (hot[2] - b) * core;
      data.data[i * 4 + 3] = Math.min(255, Math.pow(v, 1.3) * (this.dark ? 190 : 150));
    }
    ictx.putImageData(data, 0, 0);
    ctx.save();
    this._roomsPath(ctx);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const [x, y] = grid.box;
    ctx.drawImage(image, x, y, grid.cols * grid.cell, grid.rows * grid.cell);
    ctx.restore();
  }

  private _drawGlow(ctx: CanvasRenderingContext2D, factor: number, s: number): boolean {
    const motion = this._colours!.motion;
    let busy = false;
    const keys = new Set([...this._glow.keys(), ...this._glowTarget.keys()]);
    ctx.lineCap = "round";
    for (const key of keys) {
      const target = this._glowTarget.get(key);
      const current = this._glow.get(key) ?? 0;
      const goal = target?.value ?? 0;
      const next = current + (goal - current) * factor;
      if (Math.abs(goal - next) > 0.01) busy = true;
      if (next < 0.01 && goal === 0) {
        this._glow.delete(key);
        continue;
      }
      this._glow.set(key, next);
      if (!target) continue;
      const width = (10 + 12 * target.weight) / s;
      ctx.strokeStyle = rgba(motion, 0.16 * next);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(target.a[0], target.a[1]);
      ctx.lineTo(target.b[0], target.b[1]);
      ctx.stroke();
      ctx.strokeStyle = rgba(motion, 0.22 * next);
      ctx.lineWidth = width * 0.45;
      ctx.stroke();
    }
    return busy;
  }

  private _drawPulses(ctx: CanvasRenderingContext2D, now: number, s: number): boolean {
    const motion = this._colours!.motion;
    this._pulses = this._pulses.filter((p) => now - p.born < PULSE_MS);
    for (const pulse of this._pulses) {
      const k = (now - pulse.born) / PULSE_MS;
      const ease = 1 - Math.pow(1 - k, 2);
      const x = pulse.from[0] + (pulse.to[0] - pulse.from[0]) * ease;
      const y = pulse.from[1] + (pulse.to[1] - pulse.from[1]) * ease;
      const radius = 9 / s;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      const alpha = Math.sin(Math.PI * Math.min(1, k * 1.15));
      gradient.addColorStop(0, rgba("#ffffff", 0.95 * alpha));
      gradient.addColorStop(0.35, rgba(motion, 0.9 * alpha));
      gradient.addColorStop(1, rgba(motion, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    return this._pulses.length > 0;
  }

  private _drawBulbGlow(ctx: CanvasRenderingContext2D, now: number, s: number, still: boolean): boolean {
    const plan = this.plan!;
    const motion = this._colours!.motion;
    let any = false;
    for (const bulb of this._visibleBulbs(plan)) {
      if (this.frame?.gates[bulb.ieee] !== "open") continue;
      any = true;
      const breath = still ? 0.6 : 0.5 + 0.25 * Math.sin(now / 420 + bulb.x * 3);
      const radius = (20 + 6 * breath) / s;
      const gradient = ctx.createRadialGradient(bulb.x, bulb.y, 0, bulb.x, bulb.y, radius);
      gradient.addColorStop(0, rgba(motion, 0.55 * breath));
      gradient.addColorStop(1, rgba(motion, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(bulb.x, bulb.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    return any && !still;
  }

  private _visibleRooms(): Room[] {
    const plan = this.plan;
    if (!plan) return [];
    return this.rooms ? plan.rooms.filter((r) => this.rooms!.includes(r.id)) : plan.rooms;
  }

  private _select(type: "pair-select" | "room-select", detail: Record<string, string>): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private _click(event: MouseEvent, type: "pair-select" | "room-select", detail: Record<string, string>): void {
    (event.currentTarget as SVGElement).blur();
    this._select(type, detail);
  }

  private _key(event: KeyboardEvent, type: "pair-select" | "room-select", detail: Record<string, string>): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this._select(type, detail);
    }
  }

  override render() {
    const plan = this.plan;
    if (!plan) {
      return nothing;
    }
    const [x, y, w, h] = this._box;
    const [pw, ph] = this._size;
    const style = pw ? `height:${ph}px` : `aspect-ratio:${w} / ${h}`;
    const viewBox = `${x} ${y} ${w} ${h}`;
    return html`<div class="stage" style=${style}>
      <svg viewBox=${viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">${this._base(plan)}</svg>
      <canvas></canvas>
      <svg viewBox=${viewBox} preserveAspectRatio="xMidYMid meet" role="group" aria-label=${t(this.loc, "plan")}>
        ${this._overlay(plan)}
      </svg>
    </div>`;
  }

  private _base(plan: Plan) {
    const rooms = this._visibleRooms();
    const doorWidth = (kind: WallKind): number => WALL_PX[kind] + 3;
    return svg`
      ${this._backdrop()}
      ${rooms.map((room) => {
        const state = this.hidePredictions ? undefined : this.frame?.rooms[room.id];
        const p = state?.p ?? 0;
        const points = room.outline.map((pt) => pt.join(",")).join(" ");
        const override = this.roomColours?.get(room.id);
        const fill = override ? `fill:${override};fill-opacity:0.5` : `fill-opacity:${(0.08 + 0.37 * p).toFixed(3)}`;
        return svg`<polygon class="room" data-room=${room.id} points=${points} fill=${room.colour} stroke=${room.colour}
          style="${fill};stroke-opacity:${state?.motion ? 0.9 : 0}"></polygon>`;
      })}
      ${rooms.map((room) => svg`<polygon class="outline" points=${room.outline.map((pt) => pt.join(",")).join(" ")}></polygon>`)}
      ${plan.walls.map((wall) => {
        const line = (cls: string, width: number) =>
          svg`<line class=${cls} x1=${wall.a[0]} y1=${wall.a[1]} x2=${wall.b[0]} y2=${wall.b[1]} style="stroke-width:${width}px"></line>`;
        if (wall.kind === "none") return line("wall erase", 4);
        if (wall.kind === "glass") return svg`${line("wall erase", 4)}${line("wall glass", 2.5)}`;
        return line(`wall ${wall.kind}`, WALL_PX[wall.kind]);
      })}
      ${plan.doors.map((door) => {
        const wall = plan.walls[door.wall];
        if (!wall) return nothing;
        const length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
        if (length <= 0) return nothing;
        const half = Math.min(door.width / 2, length / 2) / length;
        const t0 = Math.max(0, door.at - half);
        const t1 = Math.min(1, door.at + half);
        const p0: Point = [wall.a[0] + (wall.b[0] - wall.a[0]) * t0, wall.a[1] + (wall.b[1] - wall.a[1]) * t0];
        const p1: Point = [wall.a[0] + (wall.b[0] - wall.a[0]) * t1, wall.a[1] + (wall.b[1] - wall.a[1]) * t1];
        const nx = (-(wall.b[1] - wall.a[1]) / length) * this._px(5);
        const ny = ((wall.b[0] - wall.a[0]) / length) * this._px(5);
        return svg`<line class="door" x1=${p0[0]} y1=${p0[1]} x2=${p1[0]} y2=${p1[1]} style="stroke-width:${doorWidth(wall.kind)}px"></line>
          <line class="jamb" x1=${p0[0] - nx} y1=${p0[1] - ny} x2=${p0[0] + nx} y2=${p0[1] + ny}></line>
          <line class="jamb" x1=${p1[0] - nx} y1=${p1[1] - ny} x2=${p1[0] + nx} y2=${p1[1] + ny}></line>`;
      })}
    `;
  }

  private _visibleBulbs(plan: Plan): Plan["bulbs"] {
    if (!this.rooms) return plan.bulbs;
    const rooms = this.rooms;
    return plan.bulbs.filter((b) => {
      const room = bulbRoom(plan, b);
      return room !== null && rooms.includes(room);
    });
  }

  private _overlay(plan: Plan) {
    const frame = this.frame;
    const bulbs = this._visibleBulbs(plan);
    const at = new Map(bulbs.map((b) => [b.ieee, b]));
    const name = (ieee: string): string => this.names[ieee] ?? ieee.slice(-4);
    const pairs = this.layers.lines ? (frame?.pairs ?? []) : [];
    const colours = this.lineColours;
    const lines = pairs.map((pair) => {
      const a = at.get(pair.a);
      const b = at.get(pair.b);
      if (!a || !b) return nothing;
      const key = pairKey(pair.a, pair.b);
      const selected = this.selected === key;
      const colour = colours?.get(key);
      const active = pair.obs === 1 || pair.obs === 2;
      const cls = colour ? "coloured" : pair.obs === 2 ? "two" : pair.obs === 1 ? "one" : "quiet";
      const width = colour ? 2 + 3 * pair.weight : pair.obs === 2 ? 2.5 + 3.5 * pair.weight : pair.obs === 1 ? 1.6 : 1;
      const opacity = colour ? 0.9 : pair.obs === 2 ? 0.95 : pair.obs === 1 ? 0.8 : this.interactive ? 0.1 : 0;
      const label = t(this.loc, "pair", { a: name(pair.a), b: name(pair.b), obs: t(this.loc, pair.obs === 2 ? "both" : "one") });
      return svg`${selected
          ? svg`<line class="pair-halo" x1=${a.x} y1=${a.y} x2=${b.x} y2=${b.y} style="stroke-width:${width + 6}px"></line>`
          : nothing}<line class="pair ${cls} ${selected ? "selected" : ""}" x1=${a.x} y1=${a.y} x2=${b.x} y2=${b.y}
          style="stroke-width:${width}px;stroke-opacity:${selected ? 1 : opacity};${colour ? `stroke:${colour}` : ""}"></line>
        ${this.interactive
          ? svg`<line class="hit-line" x1=${a.x} y1=${a.y} x2=${b.x} y2=${b.y} tabindex=${active || colour ? 0 : -1}
              role="button" aria-label=${label}
              @click=${(e: MouseEvent) => this._click(e, "pair-select", { a: pair.a, b: pair.b })}
              @keydown=${(e: KeyboardEvent) => this._key(e, "pair-select", { a: pair.a, b: pair.b })}></line>`
          : nothing}`;
    });
    const here = this._visibleRooms().find((room) => room.id === this.highlight);
    return svg`
      ${this._visibleRooms().map((room) => this._roomHit(room))}
      ${here
        ? svg`<polygon class="here" data-room=${here.id} points=${here.outline.map((pt) => pt.join(",")).join(" ")} stroke=${here.colour}></polygon>`
        : nothing}
      ${this.layers.trail ? this._trail(plan) : nothing}
      ${lines}
      ${this.markers.map(
        (m) => svg`<circle class="marker-ring" cx=${m[0]} cy=${m[1]} r=${this._px(16)}></circle>
          <line class="marker" x1=${m[0] - this._px(6)} y1=${m[1] - this._px(6)} x2=${m[0] + this._px(6)} y2=${m[1] + this._px(6)}></line>
          <line class="marker" x1=${m[0] - this._px(6)} y1=${m[1] + this._px(6)} x2=${m[0] + this._px(6)} y2=${m[1] - this._px(6)}></line>`,
      )}
      ${bulbs.map((bulb) => {
        const gate = frame?.gates[bulb.ieee] ?? "closed";
        const r = this._px(gate === "open" ? 7 : 6);
        return svg`<circle class="bulb ${gate}" cx=${bulb.x} cy=${bulb.y} r=${r}><title>${name(bulb.ieee)}</title></circle>
          <circle class="bulb-core" cx=${bulb.x} cy=${bulb.y} r=${this._px(2.2)}></circle>
          ${this.layers.bulbNames
            ? svg`<text class="bulb-name" x=${bulb.x} y=${bulb.y + this._px(19)} text-anchor="middle"
                style="font-size:${this._px(11)}px;stroke-width:${this._px(3)}px">${name(bulb.ieee)}</text>`
            : nothing}`;
      })}
      ${this._visibleRooms().map((room) => this._roomLabel(room))}
    `;
  }

  private _roomHit(room: Room) {
    if (!this.interactive) return nothing;
    const points = room.outline.map((pt) => pt.join(",")).join(" ");
    const state = this.frame?.rooms[room.id];
    const label = t(this.loc, "room", {
      name: room.name,
      state: t(this.loc, state?.motion ? "motion" : state?.occupied ? "occupied" : "empty"),
      p: fmtPercent(this.loc, state?.p ?? 0),
    });
    return svg`<polygon class="room hit" points=${points} fill="transparent" stroke="transparent" tabindex="0" role="button"
      aria-label=${label}
      @click=${(e: MouseEvent) => this._click(e, "room-select", { room: room.id })}
      @keydown=${(e: KeyboardEvent) => this._key(e, "room-select", { room: room.id })}></polygon>`;
  }

  private _labelAnchor(room: Room, chars: number): { x: number; y: number; anchor: "start" | "middle" } {
    const [x, y, w] = boxOf(room.outline);
    const pad = this._px(12);
    const text = this._px(chars * 7.2);
    const top = y + pad + this._px(12);
    const candidates: { p: Point; anchor: "start" | "middle"; span: [number, number] }[] = [
      { p: [x + pad, top], anchor: "start", span: [x + pad, x + pad + text] },
      { p: [x + w / 2, top], anchor: "middle", span: [x + w / 2 - text / 2, x + w / 2 + text / 2] },
    ];
    for (const c of candidates) {
      const ends: Point[] = [
        [c.span[0], c.p[1]],
        [c.span[1], c.p[1]],
        [c.span[0], c.p[1] + this._px(16)],
        [c.span[1], c.p[1] + this._px(16)],
      ];
      if (ends.every((e) => contains(room.outline, e)) && distanceToBoundary(c.p, room.outline) >= pad * 0.9) {
        return { x: c.p[0], y: c.p[1], anchor: c.anchor };
      }
    }
    const [lx, ly] = labelPoint(room.outline);
    return { x: lx, y: ly, anchor: "middle" };
  }

  private _roomLabel(room: Room) {
    const state = this.hidePredictions ? undefined : this.frame?.rooms[room.id];
    const size = this._px(13);
    const on = Boolean(state?.motion);
    const note = this.roomNotes?.get(room.id);
    const stateText =
      note ?? (state ? (on ? `${t(this.loc, "motion")} · ${fmtPercent(this.loc, state.p)}` : fmtPercent(this.loc, state.p)) : "");
    const { x, y, anchor } = this._labelAnchor(room, Math.max(room.name.length, stateText.length * 0.9));
    return svg`<g pointer-events="none">
      <text class="room-name" x=${x} y=${y} text-anchor=${anchor} style="font-size:${size}px;stroke-width:${this._px(4)}px">${room.name}</text>
      ${stateText
        ? svg`<text class="room-state ${on ? "on" : ""}" x=${x} y=${y + size * 1.3} text-anchor=${anchor}
            style="font-size:${this._px(12)}px;stroke-width:${this._px(4)}px">${stateText}</text>`
        : nothing}
    </g>`;
  }

  private _trail(plan: Plan) {
    const steps = (this.frame?.trail ?? []).slice(-5);
    const parts = [];
    for (let i = 1; i < steps.length; i += 1) {
      const from = steps[i - 1]![0];
      const to = steps[i]![0];
      if (from === to) continue;
      const path = trailPath(plan, from, to);
      if (!path) continue;
      const age = steps.length - 1 - i;
      const opacity = Math.max(0.12, 0.7 - age * 0.16);
      const [p0, p1, p2] = path;
      const c: Point | null = p2 ? [2 * p1![0] - (p0![0] + p2[0]) / 2, 2 * p1![1] - (p0![1] + p2[1]) / 2] : null;
      const d = p2 && c ? `M ${p0![0]} ${p0![1]} Q ${c[0]} ${c[1]} ${p2[0]} ${p2[1]}` : `M ${p0![0]} ${p0![1]} L ${p1![0]} ${p1![1]}`;
      const end = p2 ?? p1!;
      parts.push(svg`<path class="trail" d=${d} style="stroke-opacity:${opacity}"></path>
        ${age === 0 ? svg`<circle class="trail-head" cx=${end[0]} cy=${end[1]} r=${this._px(3.5)} style="fill-opacity:${opacity}"></circle>` : nothing}`);
    }
    return parts;
  }
}

if (!customElements.get("outglow-plan-view")) {
  customElements.define("outglow-plan-view", OutglowPlanView);
}

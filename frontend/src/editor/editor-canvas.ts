import { mdiFitToScreen, mdiLightbulb, mdiMagnifyMinus, mdiMagnifyPlus, mdiPin } from "@mdi/js";
import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import type { Plan, Point, Room, WallKind } from "../api/types";
import { fmtNumber } from "../format";
import {
  HANDLES,
  area,
  boxOf,
  contains,
  dist,
  distanceToBoundary,
  edgeNormal,
  edges,
  handlePoint,
  handleSides,
  isRectangle,
  labelPoint,
  lerp,
  planBox,
  project,
  rectangle,
  resizeBox,
  snap,
  snapToGrid,
  snapValue,
  sub,
  type Box,
  type Handle,
  type Snap,
} from "../geometry";
import { strings, type Loc } from "../i18n";
import { icon } from "../icons";
import { Backdrop, backdrop } from "../background";
import { shared, tokens } from "../theme";
import {
  addDoor,
  addRoom,
  insertVertex,
  linkedVertices,
  moveVertex,
  moveWall,
  nearestWall,
  placeBulb,
  resizeRoom,
  translateRoom,
  moveSharedWall,
  shiftedWall,
  sharedWallOffset,
  wallGroup,
  wallIndex,
  wallOffset,
  wallSelection,
  vertexSelection,
  doorSelection,
  updateDoor,
  type Selection,
  type WallSelection,
} from "./ops";

export type Tool = "select" | "rect" | "poly" | "door" | "bulb";

const t = strings(
  {
    canvas: "Floor plan editor. Use the tools above; arrow keys move the selection, Alt with arrow keys resizes the selected room.",
    resize: "Resize",
    size_rect: "{w} × {h} m · {a} m²",
    zoom_in: "Zoom in",
    zoom_out: "Zoom out",
    fit: "Fit to screen",
    snap_vertex: "corner",
    snap_edge: "wall",
    snap_grid: "grid",
    snap_angle: "90°",
    snap_free: "free",
    new_room: "Room {n}",
    area: "{n} m²",
    pinned: "Pinned to {room}",
  },
  {
    canvas: "Edytor planu. Użyj narzędzi powyżej; strzałki przesuwają zaznaczenie, Alt ze strzałkami zmienia rozmiar zaznaczonego pokoju.",
    resize: "Zmień rozmiar",
    size_rect: "{w} × {h} m · {a} m²",
    zoom_in: "Powiększ",
    zoom_out: "Pomniejsz",
    fit: "Dopasuj do ekranu",
    snap_vertex: "narożnik",
    snap_edge: "ściana",
    snap_grid: "siatka",
    snap_angle: "90°",
    snap_free: "swobodnie",
    new_room: "Pokój {n}",
    area: "{n} m²",
    pinned: "Przypięta do pokoju {room}",
  },
);

interface View {
  cx: number;
  cy: number;
  s: number;
}

type Drag =
  | { kind: "pan"; x: number; y: number; view: View; moved: boolean }
  | { kind: "vertex"; room: string; index: number; base: Plan; moved: boolean }
  | { kind: "room"; room: string; start: Point; base: Plan; moved: boolean; x: number; y: number }
  | { kind: "resize"; room: string; handle: Handle; box: Box; grab: Point; base: Plan; moved: boolean; x: number; y: number }
  | { kind: "wall"; room: string; edge: number; start: Point; base: Plan; moved: boolean; x: number; y: number }
  | { kind: "shared"; selection: WallSelection; start: Point; base: Plan; moved: boolean; x: number; y: number }
  | { kind: "bulb"; ieee: string; start: Point; base: Plan; moved: boolean; x: number; y: number }
  | { kind: "door"; index: number; base: Plan; moved: boolean }
  | { kind: "rect"; a: Point; b: Point }
  | { kind: "pinch"; d0: number; mid: Point; view: View };

const WALL_PX: Record<WallKind, number> = { partition: 4, brick: 6, concrete: 7, glass: 3, none: 1.5 };
const RESIZE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};
const NORMAL_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
const MIN_SCALE = 8;

function edgeCursor(a: Point, b: Point): string {
  const [nx, ny] = edgeNormal(a, b);
  const angle = ((Math.atan2(ny, nx) * 180) / Math.PI + 180) % 180;
  return NORMAL_CURSORS[Math.round(angle / 45) % 4]!;
}

function noSnap(event: PointerEvent | MouseEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

function lockAxis(delta: Point): Point {
  return Math.abs(delta[0]) >= Math.abs(delta[1]) ? [delta[0], 0] : [0, delta[1]];
}
const MAX_SCALE = 600;

export class OutglowEditorCanvas extends LitElement {
  static override properties = {
    plan: { attribute: false },
    tool: {},
    grid: { type: Number },
    magnet: { type: Boolean },
    selection: { attribute: false },
    loc: { attribute: false },
    names: { attribute: false },
    ghost: { attribute: false },
    flagged: { attribute: false },
    keepRatio: { type: Boolean },
    reserved: { attribute: false },
    background: { attribute: false },
    dark: { type: Boolean },
    _size: { state: true },
    _view: { state: true },
    _poly: { state: true },
    _rect: { state: true },
    _cursor: { state: true },
    _snap: { state: true },
    _hover: { state: true },
    _guides: { state: true },
    _coarse: { state: true },
    _dragging: { state: true },
  };

  declare plan: Plan;
  declare tool: Tool;
  declare grid: number;
  declare magnet: boolean;
  declare selection: Selection;
  declare loc: Loc;
  declare names: Record<string, string>;
  declare ghost: { ieee: string; point: Point } | null;
  declare flagged: Set<string>;
  declare keepRatio: boolean;
  declare reserved: string[];
  declare background: string | null;
  declare dark: boolean;
  declare _size: [number, number];
  declare _view: View;
  declare _poly: Point[];
  declare _rect: [Point, Point] | null;
  declare _cursor: Point | null;
  declare _snap: Snap | null;
  declare _hover: { index: number; at: number } | null;
  declare _guides: { x: number | null; y: number | null };
  declare _coarse: boolean;
  declare _dragging: string | null;

  private _observer: ResizeObserver | null = null;
  private _drag: Drag | null = null;
  private _pointers = new Map<number, [number, number]>();
  private _fitted = false;
  private _downHit: DOMStringMap | null = null;
  private _backdrop = new Backdrop(this);

  constructor() {
    super();
    this.tool = "select";
    this.grid = 0.1;
    this.magnet = true;
    this.selection = null;
    this.loc = { lang: "en", numbers: "en", hour12: undefined };
    this.names = {};
    this.ghost = null;
    this.flagged = new Set();
    this.reserved = [];
    this._size = [0, 0];
    this._view = { cx: 3, cy: 3, s: 60 };
    this._poly = [];
    this._rect = null;
    this._cursor = null;
    this._snap = null;
    this._hover = null;
    this._guides = { x: null, y: null };
    this._coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    this._dragging = null;
    this.keepRatio = false;
    this.background = null;
    this.dark = false;
  }

  static override styles = [
    tokens,
    shared,
    css`
      :host {
        display: block;
        position: relative;
        height: 100%;
        min-height: 320px;
        overflow: hidden;
        border-radius: inherit;
        background: color-mix(in srgb, var(--og-fg) 2.5%, var(--og-card));
      }
      svg.plan {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
        outline: none;
      }
      svg.plan:focus-visible {
        box-shadow: inset 0 0 0 2px var(--og-primary);
      }
      svg.plan.draw {
        cursor: crosshair;
      }
      svg.plan.pan {
        cursor: grabbing;
      }
      svg.plan.dragging,
      svg.plan.dragging * {
        cursor: var(--og-drag-cursor, grabbing) !important;
      }
      .backdrop.dark {
        filter: invert(1) hue-rotate(180deg);
      }
      .grid-minor {
        stroke: color-mix(in srgb, var(--og-fg) 7%, transparent);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .grid-major {
        stroke: color-mix(in srgb, var(--og-fg) 14%, transparent);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .room {
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        stroke-linejoin: round;
        transition: fill-opacity 150ms;
      }
      .room.hit {
        cursor: move;
      }
      .room.flagged {
        stroke-dasharray: 6 4;
      }
      .wall {
        stroke: color-mix(in srgb, var(--og-fg) 62%, transparent);
        vector-effect: non-scaling-stroke;
        stroke-linecap: square;
      }
      .wall.glass {
        stroke: color-mix(in srgb, var(--og-info) 70%, transparent);
        stroke-dasharray: 7 4;
      }
      .wall.none {
        stroke: color-mix(in srgb, var(--og-fg) 30%, transparent);
        stroke-dasharray: 3 4;
      }
      .wall.selected {
        stroke: var(--og-primary);
      }
      .wall-hit {
        stroke: transparent;
        stroke-width: 16;
        vector-effect: non-scaling-stroke;
        cursor: pointer;
      }
      .wall-hit:hover {
        stroke: color-mix(in srgb, var(--og-primary) 22%, transparent);
      }
      .door-gap {
        stroke: color-mix(in srgb, var(--og-fg) 2.5%, var(--og-card));
        vector-effect: non-scaling-stroke;
      }
      .door-swing {
        fill: none;
        stroke: color-mix(in srgb, var(--og-fg) 45%, transparent);
        stroke-width: 1.2;
        vector-effect: non-scaling-stroke;
      }
      .door-leaf,
      .jamb {
        stroke: color-mix(in srgb, var(--og-fg) 62%, transparent);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
      }
      .door.selected .door-leaf,
      .door.selected .door-swing,
      .door.selected .jamb {
        stroke: var(--og-primary);
      }
      .door-hit {
        fill: transparent;
        cursor: grab;
      }
      .door-preview {
        stroke: var(--og-primary);
        stroke-opacity: 0.55;
        vector-effect: non-scaling-stroke;
        stroke-linecap: butt;
      }
      .handle {
        fill: var(--og-card);
        stroke: var(--og-primary);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        cursor: grab;
      }
      .handle:hover {
        fill: var(--og-primary);
      }
      .handle.selected {
        fill: var(--og-primary);
        stroke: var(--og-card);
        stroke-width: 3;
      }
      .handle-ring {
        fill: none;
        stroke: var(--og-primary);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .edge-hit {
        stroke: transparent;
        stroke-width: 12;
        vector-effect: non-scaling-stroke;
      }
      .edge-hit.coarse {
        stroke-width: 26;
      }
      .edge-hit:hover {
        stroke: color-mix(in srgb, var(--og-primary) 28%, transparent);
      }
      .frame {
        fill: none;
        stroke: var(--og-primary);
        stroke-opacity: 0.7;
        stroke-width: 1;
        stroke-dasharray: 4 3;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .grip .knob {
        fill: var(--og-card);
        stroke: var(--og-primary);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
        filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.25));
        transition: fill 120ms;
      }
      .grip .pad {
        fill: transparent;
      }
      .grip:hover .knob,
      .grip.active .knob {
        fill: var(--og-primary);
      }
      .size-tag rect {
        fill: var(--og-primary);
      }
      .size-tag text {
        fill: var(--og-on-primary, #fff);
        stroke: none;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }
      .align {
        stroke: var(--og-primary);
        stroke-width: 1;
        stroke-dasharray: 3 3;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .outline-sel {
        fill: none;
        stroke: var(--og-primary);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      text {
        font-family: var(--og-font);
        paint-order: stroke;
        stroke: var(--og-card);
        stroke-linejoin: round;
        fill: var(--og-fg);
        pointer-events: none;
      }
      .room-name {
        font-weight: 500;
      }
      .room-area,
      .dim,
      .bulb-name {
        fill: var(--og-fg2);
        font-variant-numeric: tabular-nums;
      }
      .dim.live {
        fill: var(--og-primary);
        font-weight: 500;
      }
      .bulb {
        fill: var(--og-card);
        stroke: color-mix(in srgb, var(--og-fg) 55%, transparent);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
        cursor: grab;
      }
      .bulb.selected {
        stroke: var(--og-primary);
        stroke-width: 2.5;
      }
      .bulb.flagged {
        stroke: var(--og-warning);
        stroke-width: 2;
      }
      .bulb-glyph {
        fill: var(--og-motion);
        pointer-events: none;
      }
      .pin {
        cursor: grab;
      }
      .pin.inert {
        pointer-events: none;
      }
      .pin circle {
        fill: var(--og-card);
        stroke: var(--og-primary);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
      }
      .pin path {
        fill: var(--og-primary);
      }
      .bulb-ring {
        fill: color-mix(in srgb, var(--og-primary) 16%, transparent);
        stroke: none;
        pointer-events: none;
      }
      .ghost {
        opacity: 0.75;
      }
      .ghost .bulb {
        stroke-dasharray: 3 3;
        stroke: var(--og-primary);
      }
      .draft {
        fill: color-mix(in srgb, var(--og-primary) 12%, transparent);
        stroke: var(--og-primary);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        stroke-linejoin: round;
      }
      .rubber {
        fill: none;
        stroke: var(--og-primary);
        stroke-width: 1.5;
        stroke-dasharray: 5 4;
        vector-effect: non-scaling-stroke;
      }
      .draft-dot {
        fill: var(--og-primary);
      }
      .draft-first {
        fill: var(--og-card);
        stroke: var(--og-primary);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
      }
      .draft-first.ready {
        fill: var(--og-primary);
      }
      .guide {
        stroke: var(--og-primary);
        stroke-opacity: 0.6;
        stroke-width: 1;
        stroke-dasharray: 2 3;
        vector-effect: non-scaling-stroke;
      }
      .snap {
        fill: none;
        stroke: var(--og-primary);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .snap.vertex {
        fill: var(--og-primary);
      }
      .zoom {
        position: absolute;
        right: 10px;
        top: 10px;
        display: grid;
        border-radius: 12px;
        background: var(--og-card);
        border: 1px solid var(--og-divider);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        overflow: hidden;
      }
      .zoom .icon-btn {
        border-radius: 0;
      }
      .coords {
        position: absolute;
        left: 10px;
        bottom: 10px;
        display: flex;
        gap: 10px;
        align-items: center;
        padding: 4px 10px;
        border-radius: 8px;
        background: color-mix(in srgb, var(--og-card) 88%, transparent);
        border: 1px solid var(--og-divider);
        font-size: 12px;
        color: var(--og-fg2);
        font-variant-numeric: tabular-nums;
        pointer-events: none;
      }
      .coords b {
        color: var(--og-primary);
        font-weight: 500;
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    this._observer = new ResizeObserver(() => this._measure());
    this._observer.observe(this);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._observer?.disconnect();
    this._observer = null;
  }

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("background")) {
      this._backdrop.show(this.background ? { url: this.background } : null);
    }
    if (changed.has("tool")) {
      this._poly = [];
      this._rect = null;
      this._snap = null;
      this._hover = null;
    }
  }

  private _measure(): void {
    const w = this.clientWidth;
    const h = this.clientHeight;
    if (!w || !h) return;
    this._size = [w, h];
    if (!this._fitted) {
      this._fitted = true;
      this.fit();
    }
  }

  fit(): void {
    const [w, h] = this._size;
    if (!w || !h) {
      this._fitted = false;
      return;
    }
    const [x, y, bw, bh] = planBox(this.plan, 0.8);
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(w / bw, h / bh)));
    this._view = { cx: x + bw / 2, cy: y + bh / 2, s };
  }

  zoomBy(factor: number, around?: [number, number]): void {
    const [w, h] = this._size;
    const v = this._view;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.s * factor));
    const [px, py] = around ?? [w / 2, h / 2];
    const before = this._toPlanLocal(px, py);
    const cx = before[0] - (px - w / 2) / s;
    const cy = before[1] - (py - h / 2) / s;
    this._view = { cx, cy, s };
  }

  focusPlan(visible: boolean): void {
    this.renderRoot.querySelector<SVGSVGElement>("svg.plan")?.focus({ preventScroll: true, focusVisible: visible } as FocusOptions);
  }

  cancel(): boolean {
    const busy = this._poly.length > 0 || this._rect !== null || this._drag !== null;
    this._revert();
    this._poly = [];
    this._rect = null;
    this._endDrag();
    this._snap = null;
    return busy;
  }

  private _revert(): void {
    const drag = this._drag;
    if (drag?.kind === "door" && drag.moved) this._edit(drag.base, false, doorSelection(drag.base, drag.index));
    else if (drag?.kind === "shared" && drag.moved) this._edit(drag.base, false, drag.selection);
    else if (drag && "base" in drag && drag.moved) this._edit(drag.base, false);
  }

  private _endDrag(): void {
    this._drag = null;
    this._dragging = null;
    this._guides = { x: null, y: null };
  }

  finish(): boolean {
    if (this.tool === "poly" && this._poly.length >= 3) {
      this._closePolygon();
      return true;
    }
    return false;
  }

  dropPoint(): boolean {
    if (this._poly.length > 0) {
      this._poly = this._poly.slice(0, -1);
      return true;
    }
    return false;
  }

  get drafting(): boolean {
    return this._poly.length > 0 || this._rect !== null;
  }

  toPlan(clientX: number, clientY: number): Point | null {
    const rect = this.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    return this._toPlanLocal(x, y);
  }

  snapBulb(point: Point): Point {
    return snapToGrid(point, this.grid);
  }

  private _toPlanLocal(x: number, y: number): Point {
    const [w, h] = this._size;
    const v = this._view;
    return [(x - w / 2) / v.s + v.cx, (y - h / 2) / v.s + v.cy];
  }

  private _px(n: number): number {
    return n / this._view.s;
  }

  private _local(event: PointerEvent | WheelEvent | MouseEvent): [number, number] {
    const rect = this.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  private _emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private _edit(plan: Plan, final: boolean, selection?: Selection): void {
    this._emit("edit", selection === undefined ? { plan, final } : { plan, final, selection });
  }

  private _select(selection: Selection): void {
    this._emit("select", { selection });
  }

  private _snapPoint(raw: Point, anchor: Point | null, exclude: Set<string> = new Set(), free = false): Snap {
    const outlines = this.plan.rooms.filter((r) => !exclude.has(r.id)).map((r) => r.outline);
    return snap(raw, {
      grid: free ? 0 : this.grid,
      outlines,
      threshold: this._px(10),
      anchor,
      magnet: this.magnet && !free,
    });
  }

  private _hit(event: Event): DOMStringMap | null {
    const target = event.composedPath()[0] as Element | undefined;
    const el = target?.closest?.("[data-hit]") as SVGElement | HTMLElement | null;
    return el ? el.dataset : null;
  }

  private _down(event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === "mouse") {
      if (event.button === 1) {
        event.preventDefault();
        this._drag = { kind: "pan", x: event.clientX, y: event.clientY, view: this._view, moved: false };
        (event.currentTarget as Element).setPointerCapture(event.pointerId);
      }
      return;
    }
    const svgEl = event.currentTarget as SVGSVGElement;
    svgEl.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    this._pointers.set(event.pointerId, this._local(event));
    if (this._pointers.size === 2) {
      const [a, b] = [...this._pointers.values()] as [[number, number], [number, number]];
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this._rect = null;
      this._revert();
      this._dragging = null;
      this._guides = { x: null, y: null };
      this._drag = { kind: "pinch", d0: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: this._toPlanLocal(mid[0], mid[1]), view: this._view };
      svgEl.setPointerCapture(event.pointerId);
      return;
    }
    if (this._pointers.size > 2) return;
    svgEl.setPointerCapture(event.pointerId);
    this._coarse = event.pointerType === "touch" || event.pointerType === "pen";
    const [lx, ly] = this._local(event);
    const raw = this._toPlanLocal(lx, ly);
    const free = event.altKey || noSnap(event);
    const hit = this._hit(event);
    this._downHit = hit;
    if (this.tool === "rect") {
      const s = this._snapPoint(raw, null, new Set(), free);
      this._snap = s;
      this._drag = { kind: "rect", a: s.point, b: s.point };
      this._rect = [s.point, s.point];
      return;
    }
    if (this.tool === "poly") {
      this._polyClick(raw, free);
      return;
    }
    if (this.tool === "door") {
      const wall = nearestWall(this.plan, raw, this._px(18));
      if (wall) {
        const result = addDoor(this.plan, wall.index, wall.at);
        this._edit(result.plan, true);
        this._select(doorSelection(result.plan, result.index));
        this._hover = null;
      }
      return;
    }
    if (this.tool === "bulb" && hit?.hit !== "bulb") {
      this._emit("place", { point: snapToGrid(raw, this.grid) });
      return;
    }
    const x = event.clientX;
    const y = event.clientY;
    if (hit?.hit === "vertex" && hit.room) {
      this._drag = { kind: "vertex", room: hit.room, index: Number(hit.index), base: this.plan, moved: false };
      return;
    }
    if (hit?.hit === "resize" && hit.room && hit.handle) {
      const room = this.plan.rooms.find((r) => r.id === hit.room);
      if (!room) return;
      const box = boxOf(room.outline);
      const handle = hit.handle as Handle;
      const grab = sub(handlePoint(box, handle), raw);
      this._drag = { kind: "resize", room: room.id, handle, box, grab, base: this.plan, moved: false, x, y };
      this._dragging = RESIZE_CURSOR[handle];
      return;
    }
    if (hit?.hit === "edge" && hit.room) {
      this._drag = { kind: "wall", room: hit.room, edge: Number(hit.index), start: raw, base: this.plan, moved: false, x, y };
      return;
    }
    if (hit?.hit === "bulb" && hit.ieee) {
      this._select({ kind: "bulb", ieee: hit.ieee });
      this._drag = { kind: "bulb", ieee: hit.ieee, start: raw, base: this.plan, moved: false, x, y };
      return;
    }
    if (hit?.hit === "door") {
      const index = Number(hit.index);
      this._select(doorSelection(this.plan, index));
      this._drag = { kind: "door", index, base: this.plan, moved: false };
      return;
    }
    if (hit?.hit === "wall") {
      const selection = wallSelection(this.plan, Number(hit.index));
      this._select(selection);
      if (selection?.kind === "wall") this._drag = { kind: "shared", selection, start: raw, base: this.plan, moved: false, x, y };
      return;
    }
    if (hit?.hit === "room" && hit.room) {
      this._select({ kind: "room", id: hit.room });
      this._drag = { kind: "room", room: hit.room, start: raw, base: this.plan, moved: false, x, y };
      return;
    }
    this._drag = { kind: "pan", x, y, view: this._view, moved: false };
  }

  private _polyClick(raw: Point, free: boolean): void {
    const first = this._poly[0];
    if (first && this._poly.length >= 3 && dist(raw, first) <= this._px(12)) {
      this._closePolygon();
      return;
    }
    const s = this._snapPoint(raw, this._poly.at(-1) ?? null, new Set(), free);
    const last = this._poly.at(-1);
    if (last && dist(last, s.point) < 1e-6) return;
    this._poly = [...this._poly, s.point];
    this._snap = s;
  }

  private _closePolygon(): void {
    const outline = this._poly;
    this._poly = [];
    this._snap = null;
    if (outline.length < 3 || area(outline) < 0.05) return;
    this._createRoom(outline);
  }

  private _createRoom(outline: Point[]): void {
    const name = t(this.loc, "new_room", { n: this.plan.rooms.length + 1 });
    const result = addRoom(this.plan, outline, name, this.reserved);
    this._edit(result.plan, true);
    this._select({ kind: "room", id: result.id });
    this._emit("tool", { tool: "select", created: result.id });
  }

  private _move(event: PointerEvent): void {
    const [lx, ly] = this._local(event);
    if (this._pointers.has(event.pointerId)) {
      this._pointers.set(event.pointerId, [lx, ly]);
    }
    const raw = this._toPlanLocal(lx, ly);
    this._cursor = raw;
    const free = event.altKey || noSnap(event);
    const drag = this._drag;
    if (!drag) {
      if (this.tool === "poly") {
        const first = this._poly[0];
        if (first && this._poly.length >= 3 && dist(raw, first) <= this._px(12)) {
          this._snap = { point: first, kind: "vertex", guide: null };
        } else {
          this._snap = this._snapPoint(raw, this._poly.at(-1) ?? null, new Set(), free);
        }
      } else if (this.tool === "rect") {
        this._snap = this._snapPoint(raw, null, new Set(), free);
      } else if (this.tool === "door") {
        this._hover = nearestWall(this.plan, raw, this._px(18));
      } else if (this._snap) {
        this._snap = null;
      }
      return;
    }
    switch (drag.kind) {
      case "pinch": {
        if (this._pointers.size < 2) return;
        const [a, b] = [...this._pointers.values()] as [[number, number], [number, number]];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const [w, h] = this._size;
        const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, drag.view.s * (d / Math.max(1, drag.d0))));
        const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        this._view = { cx: drag.mid[0] - (mid[0] - w / 2) / s, cy: drag.mid[1] - (mid[1] - h / 2) / s, s };
        return;
      }
      case "pan": {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        drag.moved = true;
        this._view = { ...drag.view, cx: drag.view.cx - dx / drag.view.s, cy: drag.view.cy - dy / drag.view.s };
        return;
      }
      case "rect": {
        const s = this._snapPoint(raw, null, new Set(), free);
        this._snap = s;
        drag.b = s.point;
        this._rect = [drag.a, drag.b];
        return;
      }
      case "vertex": {
        const room = drag.base.rooms.find((r) => r.id === drag.room);
        if (!room) return;
        const from = room.outline[drag.index]!;
        const linkedRooms = new Set(linkedVertices(drag.base, from).map(([r]) => drag.base.rooms[r]!.id));
        const n = room.outline.length;
        const linked = !event.altKey;
        const exclude = linked ? linkedRooms : new Set([drag.room]);
        let s: Snap;
        if (event.shiftKey) {
          const along = lockAxis(sub(raw, from));
          const target = snapToGrid([from[0] + along[0], from[1] + along[1]], noSnap(event) ? 0 : this.grid);
          const point: Point = along[0] !== 0 ? [target[0], from[1]] : [from[0], target[1]];
          s = { point, kind: "angle", guide: [from, point] };
        } else {
          s = this._snapPoint(raw, room.outline[(drag.index - 1 + n) % n]!, exclude, noSnap(event));
        }
        this._snap = s;
        drag.moved = true;
        this._dragging = "grabbing";
        this._edit(moveVertex(drag.base, drag.room, drag.index, s.point, linked), false);
        return;
      }
      case "room": {
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
        drag.moved = true;
        this._dragging = "move";
        const shift = event.shiftKey ? lockAxis(sub(raw, drag.start)) : sub(raw, drag.start);
        const delta = this._roomDelta(drag.base, drag.room, shift, free);
        const locked: Point = event.shiftKey ? [shift[0] === 0 ? 0 : delta[0], shift[1] === 0 ? 0 : delta[1]] : delta;
        this._edit(translateRoom(drag.base, drag.room, locked), false);
        return;
      }
      case "resize": {
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 2) return;
        drag.moved = true;
        const box = this._resizeTarget(drag.base, drag.room, drag.box, drag.handle, [raw[0] + drag.grab[0], raw[1] + drag.grab[1]], event);
        this._edit(resizeRoom(drag.base, drag.room, box), false);
        return;
      }
      case "wall": {
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
        const room = drag.base.rooms.find((r) => r.id === drag.room);
        const pair = room ? edges(room.outline)[drag.edge] : undefined;
        if (!room || !pair) return;
        drag.moved = true;
        this._dragging = edgeCursor(pair[0], pair[1]);
        const linked = !event.altKey;
        const exclude = new Set(wallGroup(drag.base, drag.room, drag.edge, linked).map(([r]) => drag.base.rooms[r]!.id));
        const offset = this._wallOffset(drag.base, pair, exclude, wallOffset(drag.base, drag.room, drag.edge, sub(raw, drag.start)), noSnap(event));
        const next = moveWall(drag.base, drag.room, drag.edge, offset, linked);
        if (next !== drag.base) this._edit(next, false);
        return;
      }
      case "shared": {
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
        const wall = drag.base.walls[wallIndex(drag.base, drag.selection)];
        if (!wall) return;
        drag.moved = true;
        this._dragging = edgeCursor(wall.a, wall.b);
        const exclude = new Set(drag.selection.pair.split("|"));
        const offset = this._wallOffset(drag.base, [wall.a, wall.b], exclude, sharedWallOffset(drag.base, drag.selection, sub(raw, drag.start)), noSnap(event));
        const next = moveSharedWall(drag.base, drag.selection, offset);
        if (next !== drag.base) this._edit(next, false, shiftedWall(drag.base, drag.selection, offset));
        return;
      }
      case "bulb": {
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
        drag.moved = true;
        const bulb = drag.base.bulbs.find((b) => b.ieee === drag.ieee);
        if (!bulb) return;
        const target: Point = [bulb.x + raw[0] - drag.start[0], bulb.y + raw[1] - drag.start[1]];
        this._edit(placeBulb(drag.base, drag.ieee, free ? target : snapToGrid(target, this.grid)), false);
        return;
      }
      case "door": {
        const door = drag.base.doors[drag.index];
        const wall = door ? drag.base.walls[door.wall] : undefined;
        if (!door || !wall) return;
        drag.moved = true;
        const next = updateDoor(drag.base, drag.index, { at: project(raw, wall.a, wall.b).t });
        this._edit(next, false, doorSelection(next, drag.index));
        return;
      }
    }
  }

  private _roomDelta(plan: Plan, id: string, raw: Point, free: boolean): Point {
    const delta = free ? raw : snapToGrid(raw, this.grid);
    const room = plan.rooms.find((r) => r.id === id);
    if (!room || free || !this.magnet) return delta;
    let best: Point | null = null;
    let bestD = Infinity;
    const others = plan.rooms.filter((r) => r.id !== id).map((r) => r.outline);
    for (const v of room.outline) {
      const moved: Point = [v[0] + raw[0], v[1] + raw[1]];
      const s = snap(moved, { grid: 0, outlines: others, threshold: this._px(10), magnet: true });
      if (s.kind !== "vertex" && s.kind !== "edge") continue;
      const d = dist(s.point, moved);
      if (d >= bestD) continue;
      bestD = d;
      if (s.kind === "vertex" || !s.guide) {
        best = [raw[0] + s.point[0] - moved[0], raw[1] + s.point[1] - moved[1]];
      } else {
        const n = edgeNormal(s.guide[0], s.guide[1]);
        const across = (s.point[0] - (v[0] + delta[0])) * n[0] + (s.point[1] - (v[1] + delta[1])) * n[1];
        best = [delta[0] + n[0] * across, delta[1] + n[1] * across];
      }
    }
    return best ?? delta;
  }

  private _candidates(plan: Plan, exclude: Set<string>): [number[], number[]] {
    const points = plan.rooms.filter((r) => !exclude.has(r.id)).flatMap((r) => r.outline);
    return [points.map((p) => p[0]), points.map((p) => p[1])];
  }

  private _resizeTarget(plan: Plan, id: string, box: Box, handle: Handle, to: Point, event: PointerEvent): Box {
    const [hx, hy] = handleSides(handle);
    const free = noSnap(event);
    const [xs, ys] = this.magnet && !free ? this._candidates(plan, new Set([id])) : [[], []];
    const threshold = this._px(10);
    const grid = free ? 0 : this.grid;
    const target: Point = [
      hx === 0 ? to[0] : snapValue(to[0], grid, xs, threshold).value,
      hy === 0 ? to[1] : snapValue(to[1], grid, ys, threshold).value,
    ];
    const next = resizeBox(box, handle, target, {
      keepRatio: event.shiftKey || this.keepRatio,
      fromCentre: event.altKey,
      min: Math.max(0.2, grid),
    });
    const edgeX = hx > 0 ? next[0] + next[2] : next[0];
    const edgeY = hy > 0 ? next[1] + next[3] : next[1];
    const hits = (list: number[], v: number): boolean => list.some((c) => Math.abs(c - v) < 1e-6);
    this._guides = { x: hx !== 0 && hits(xs, edgeX) ? edgeX : null, y: hy !== 0 && hits(ys, edgeY) ? edgeY : null };
    return next;
  }

  private _wallOffset(plan: Plan, pair: [Point, Point], exclude: Set<string>, raw: number, free: boolean): number {
    this._guides = { x: null, y: null };
    if (free) return raw;
    const [nx, ny] = edgeNormal(pair[0], pair[1]);
    if (Math.abs(ny) >= 1e-9 && Math.abs(nx) >= 1e-9) return this.grid > 0 ? Math.round(raw / this.grid) * this.grid : raw;
    const axis: 0 | 1 = Math.abs(ny) < 1e-9 ? 0 : 1;
    const sign = axis === 0 ? nx : ny;
    const candidates = this.magnet ? this._candidates(plan, exclude)[axis]! : [];
    const base = pair[0][axis]!;
    const hit = snapValue(base + raw * sign, this.grid, candidates, this._px(10));
    this._guides = axis === 0 ? { x: hit.guide, y: null } : { x: null, y: hit.guide };
    return (hit.value - base) * sign;
  }

  private _up(event: PointerEvent): void {
    this._pointers.delete(event.pointerId);
    const drag = this._drag;
    if (drag?.kind === "pinch") {
      if (this._pointers.size === 0) this._drag = null;
      return;
    }
    this._endDrag();
    if (!drag) return;
    switch (drag.kind) {
      case "pan":
        if (!drag.moved && this.tool === "select") this._select(null);
        return;
      case "rect": {
        this._rect = null;
        const [a, b] = [drag.a, drag.b];
        if (Math.abs(a[0] - b[0]) >= 0.3 && Math.abs(a[1] - b[1]) >= 0.3) {
          this._createRoom(rectangle(a, b));
        }
        return;
      }
      case "vertex":
        this._snap = null;
        if (drag.moved) this._edit(this.plan, true);
        else this._select(vertexSelection(this.plan, drag.room, drag.index));
        return;
      case "room":
      case "bulb":
      case "door":
      case "resize":
      case "wall":
      case "shared":
        this._snap = null;
        if (drag.moved) this._edit(this.plan, true);
        return;
    }
  }

  private _abort(event: PointerEvent): void {
    this._pointers.delete(event.pointerId);
    if (this._drag?.kind === "pinch") {
      if (this._pointers.size === 0) this._drag = null;
      return;
    }
    if (this._drag?.kind === "rect") this._rect = null;
    this._revert();
    this._endDrag();
    this._snap = null;
  }

  private _dblclick(event: MouseEvent): void {
    if (this.tool === "poly") {
      if (this._poly.length >= 4) {
        this._poly = this._poly.slice(0, -1);
        this._closePolygon();
      }
      return;
    }
    const hit = this._downHit?.hit === "edge" || this._downHit?.hit === "vertex" ? this._downHit : this._hit(event);
    if (hit?.hit === "vertex" && hit.room) {
      if (!this._coarse) this._emit("remove-corner", { id: hit.room, index: Number(hit.index) });
      return;
    }
    if (hit?.hit === "edge" && hit.room) {
      const room = this.plan.rooms.find((r) => r.id === hit.room);
      const edge = Number(hit.index);
      const pair = room ? edges(room.outline)[edge] : undefined;
      if (!pair) return;
      const [lx, ly] = this._local(event);
      const p = project(this._toPlanLocal(lx, ly), pair[0], pair[1]);
      this._edit(insertVertex(this.plan, hit.room, edge, snapToGrid(p.point, this.grid / 2) as Point), true);
    }
  }

  private _wheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      this.zoomBy(Math.exp(-event.deltaY * 0.01), this._local(event));
      return;
    }
    const v = this._view;
    const scale = event.deltaMode === 1 ? 16 : 1;
    this._view = { ...v, cx: v.cx + (event.deltaX * scale) / v.s, cy: v.cy + (event.deltaY * scale) / v.s };
  }

  private _leave(): void {
    if (!this._drag) {
      this._cursor = null;
      this._hover = null;
      if (this.tool !== "poly") this._snap = null;
    }
  }

  override render() {
    const [w, h] = this._size;
    const v = this._view;
    const vb = w && h ? `${v.cx - w / 2 / v.s} ${v.cy - h / 2 / v.s} ${w / v.s} ${h / v.s}` : "0 0 10 10";
    const drawing = this.tool !== "select";
    const cls = this._dragging ? "dragging" : this._drag?.kind === "pan" && this._drag.moved ? "pan" : drawing ? "draw" : "";
    const snapKind = this._snap?.kind;
    return html`<svg
        class="plan ${cls}"
        style=${this._dragging ? `--og-drag-cursor:${this._dragging}` : ""}
        viewBox=${vb}
        tabindex="0"
        role="application"
        aria-label=${t(this.loc, "canvas")}
        @pointerdown=${this._down}
        @pointermove=${this._move}
        @pointerup=${this._up}
        @pointercancel=${this._abort}
        @pointerleave=${this._leave}
        @dblclick=${this._dblclick}
        @wheel=${this._wheel}
        @contextmenu=${(e: Event) => e.preventDefault()}
      >
        ${backdrop(this._backdrop.url, this._backdrop.size, this.plan.background, this.dark)} ${this._grid(vb)} ${this.plan.rooms.map((r) => this._room(r))} ${this._walls()} ${this._doors()} ${this._selectedRoom()}
        ${this._doorPreview()} ${this.plan.rooms.map((r) => this._roomLabel(r))} ${this._bulbs()} ${this._ghost()} ${this._draft()}
        ${this._snapMark()} ${this._alignGuides(vb)}
      </svg>
      <div class="zoom">
        <button class="icon-btn" title=${t(this.loc, "zoom_in")} aria-label=${t(this.loc, "zoom_in")} @click=${() => this.zoomBy(1.25)}>
          ${icon(mdiMagnifyPlus, 20)}
        </button>
        <button class="icon-btn" title=${t(this.loc, "zoom_out")} aria-label=${t(this.loc, "zoom_out")} @click=${() => this.zoomBy(0.8)}>
          ${icon(mdiMagnifyMinus, 20)}
        </button>
        <button class="icon-btn" title=${t(this.loc, "fit")} aria-label=${t(this.loc, "fit")} @click=${() => this.fit()}>
          ${icon(mdiFitToScreen, 20)}
        </button>
      </div>
      ${this._cursor
        ? html`<div class="coords" aria-hidden="true">
            <span>x ${fmtNumber(this.loc, this._snap?.point[0] ?? this._cursor[0], 2, 2)} m</span>
            <span>y ${fmtNumber(this.loc, this._snap?.point[1] ?? this._cursor[1], 2, 2)} m</span>
            ${snapKind && drawing ? html`<b>${t(this.loc, `snap_${snapKind}`)}</b>` : nothing}
          </div>`
        : nothing}`;
  }

  private _grid(vb: string) {
    const [x, y, w, h] = vb.split(" ").map(Number) as [number, number, number, number];
    const s = this._view.s;
    let step = this.grid > 0 ? this.grid : 0.1;
    while (step * s < 12) step *= step < 0.5 ? 2 : 5;
    const major = step >= 1 ? step * 5 : 1;
    const x0 = Math.floor(x / step) * step;
    const y0 = Math.floor(y / step) * step;
    const minor: string[] = [];
    const majors: string[] = [];
    const isMajor = (value: number): boolean => Math.abs(value / major - Math.round(value / major)) < 1e-6;
    for (let gx = x0; gx <= x + w; gx += step) {
      (isMajor(gx) ? majors : minor).push(`M${gx} ${y}V${y + h}`);
    }
    for (let gy = y0; gy <= y + h; gy += step) {
      (isMajor(gy) ? majors : minor).push(`M${x} ${gy}H${x + w}`);
    }
    return svg`<path class="grid-minor" d=${minor.join("")}></path><path class="grid-major" d=${majors.join("")}></path>`;
  }

  private _isSelected(kind: "room" | "door" | "bulb", key: string | number): boolean {
    const sel = this.selection;
    if (!sel || (sel.kind !== kind && !(kind === "room" && sel.kind === "vertex"))) return false;
    if (sel.kind === "room") return sel.id === key;
    if (sel.kind === "vertex") return kind === "room" && sel.id === key;
    if (sel.kind === "bulb") return sel.ieee === key;
    return sel.kind === "door" && sel.index === key;
  }

  private _room(room: Room) {
    const points = room.outline.map((p) => p.join(",")).join(" ");
    const selected = this._isSelected("room", room.id);
    const flagged = this.flagged.has(room.id);
    return svg`<polygon class="room ${this.tool === "select" ? "hit" : ""} ${flagged ? "flagged" : ""}" data-hit="room" data-room=${room.id}
      points=${points} fill=${room.colour} stroke=${room.colour}
      style="fill-opacity:${selected ? 0.3 : 0.16}"></polygon>`;
  }

  private _walls() {
    const interactive = this.tool === "select" || this.tool === "door";
    const sel = this.selection;
    const chosen = sel?.kind === "wall" ? wallIndex(this.plan, sel) : -1;
    return this.plan.walls.map((wall, index) => {
      const selected = index === chosen;
      return svg`<line class="wall ${wall.kind} ${selected ? "selected" : ""}" x1=${wall.a[0]} y1=${wall.a[1]} x2=${wall.b[0]} y2=${wall.b[1]}
          style="stroke-width:${WALL_PX[wall.kind] + (selected ? 1 : 0)}px"></line>
        ${interactive && this.tool === "select"
          ? svg`<line class="wall-hit" data-hit="wall" data-index=${index} x1=${wall.a[0]} y1=${wall.a[1]} x2=${wall.b[0]} y2=${wall.b[1]}></line>`
          : nothing}`;
    });
  }

  private _doors() {
    return this.plan.doors.map((door, index) => {
      const wall = this.plan.walls[door.wall];
      if (!wall) return nothing;
      const length = dist(wall.a, wall.b);
      if (length <= 0) return nothing;
      const half = Math.min(door.width / 2, length / 2) / length;
      const p0 = lerp(wall.a, wall.b, Math.max(0, door.at - half));
      const p1 = lerp(wall.a, wall.b, Math.min(1, door.at + half));
      const ux = (wall.b[0] - wall.a[0]) / length;
      const uy = (wall.b[1] - wall.a[1]) / length;
      const nx = -uy;
      const ny = ux;
      const width = dist(p0, p1);
      const tip: Point = [p0[0] + nx * width, p0[1] + ny * width];
      const j = this._px(6);
      const selected = this._isSelected("door", index);
      const centre = lerp(p0, p1, 0.5);
      const gap = WALL_PX[wall.kind] + 4;
      return svg`<g class="door ${selected ? "selected" : ""}">
        <line class="door-gap" x1=${p0[0]} y1=${p0[1]} x2=${p1[0]} y2=${p1[1]} style="stroke-width:${gap}px"></line>
        <line class="jamb" x1=${p0[0] - nx * j} y1=${p0[1] - ny * j} x2=${p0[0] + nx * j} y2=${p0[1] + ny * j}></line>
        <line class="jamb" x1=${p1[0] - nx * j} y1=${p1[1] - ny * j} x2=${p1[0] + nx * j} y2=${p1[1] + ny * j}></line>
        ${door.kind === "door"
          ? svg`<line class="door-leaf" x1=${p0[0]} y1=${p0[1]} x2=${tip[0]} y2=${tip[1]}></line>
            <path class="door-swing" d="M ${tip[0]} ${tip[1]} A ${width} ${width} 0 0 ${ux * ny - uy * nx > 0 ? 1 : 0} ${p1[0]} ${p1[1]}"></path>`
          : nothing}
        ${this.tool === "select"
          ? svg`<circle class="door-hit" data-hit="door" data-index=${index} cx=${centre[0]} cy=${centre[1]} r=${Math.max(width / 2, this._px(14))}></circle>`
          : nothing}
      </g>`;
    });
  }

  private _doorPreview() {
    const hover = this._hover;
    if (this.tool !== "door" || !hover) return nothing;
    const wall = this.plan.walls[hover.index];
    if (!wall) return nothing;
    const length = dist(wall.a, wall.b);
    const half = Math.min(0.45, length / 2) / length;
    const at = Math.min(1 - half, Math.max(half, hover.at));
    const p0 = lerp(wall.a, wall.b, at - half);
    const p1 = lerp(wall.a, wall.b, at + half);
    return svg`<line class="door-preview" x1=${p0[0]} y1=${p0[1]} x2=${p1[0]} y2=${p1[1]} style="stroke-width:${WALL_PX[wall.kind] + 6}px"></line>`;
  }

  private _selectedRoom() {
    const sel = this.selection;
    if ((sel?.kind !== "room" && sel?.kind !== "vertex") || this.tool !== "select") return nothing;
    const room = this.plan.rooms.find((r) => r.id === sel.id);
    if (!room) return nothing;
    const points = room.outline.map((p) => p.join(",")).join(" ");
    const centre = labelPoint(room.outline);
    const ccw = room.outline.reduce((sum, p, i) => {
      const q = room.outline[(i + 1) % room.outline.length]!;
      return sum + (p[0] * q[1] - q[0] * p[1]);
    }, 0);
    const sign = ccw >= 0 ? 1 : -1;
    const dims = edges(room.outline).map(([a, b], i) => {
      const length = dist(a, b);
      if (length * this._view.s < 34) return nothing;
      const mid = lerp(a, b, 0.5);
      const label = `${fmtNumber(this.loc, length, 2)} m`;
      const nx = (-(b[1] - a[1]) / length) * sign * -1;
      const ny = ((b[0] - a[0]) / length) * sign * -1;
      const off = this._framePad() + this._px(9 + Math.abs(nx) * label.length * 3.2 + Math.abs(ny) * 4);
      let x = mid[0] + nx * off;
      let y = mid[1] + ny * off;
      if (Math.hypot(x - centre[0], y - centre[1]) < Math.hypot(mid[0] - centre[0], mid[1] - centre[1])) {
        x = mid[0] - nx * off;
        y = mid[1] - ny * off;
      }
      return svg`<text class="dim" x=${x} y=${y + this._px(4)} text-anchor="middle" data-edge=${i}
        style="font-size:${this._px(11)}px;stroke-width:${this._px(3.5)}px">${label}</text>`;
    });
    const coarse = this._coarse;
    const r = this._px(coarse ? 9 : 6);
    return svg`<polygon class="outline-sel" points=${points}></polygon>
      ${this._frame(room)}
      ${edges(room.outline).map(
        ([a, b], i) => svg`<line class="edge-hit ${coarse ? "coarse" : ""}" data-hit="edge" data-room=${room.id} data-index=${i}
          x1=${a[0]} y1=${a[1]} x2=${b[0]} y2=${b[1]} style="cursor:${edgeCursor(a, b)}"></line>`,
      )}
      ${dims}
      ${this._grips(room)}
      ${room.outline.map(
        (p, i) => {
          const picked = sel.kind === "vertex" && sel.index === i;
          return svg`${picked ? svg`<circle class="handle-ring" cx=${p[0]} cy=${p[1]} r=${r * 1.9}></circle>` : nothing}
            <circle class="handle ${picked ? "selected" : ""}" data-hit="vertex" data-room=${room.id} data-index=${i} cx=${p[0]} cy=${p[1]} r=${r}></circle>`;
        },
      )}
      ${this._sizeTag(room)}`;
  }

  private _framePad(): number {
    return this._px(this._coarse ? 20 : 11);
  }

  private _frame(room: Room) {
    const [x, y, w, h] = boxOf(room.outline);
    const pad = this._framePad();
    return svg`<rect class="frame" x=${x - pad} y=${y - pad} width=${w + 2 * pad} height=${h + 2 * pad}></rect>`;
  }

  private _grips(room: Room) {
    const box = boxOf(room.outline);
    const pad = this._framePad();
    const coarse = this._coarse;
    const half = this._px(coarse ? 8 : 4.5);
    const reach = this._px(coarse ? 22 : 9);
    const sides = Math.min(box[2], box[3]) * this._view.s >= (coarse ? 90 : 48);
    const active = this._drag?.kind === "resize" ? this._drag.handle : null;
    return HANDLES.filter((h) => sides || h.length === 2).map((handle) => {
      const [x, y] = handlePoint(box, handle, pad);
      return svg`<g class="grip ${active === handle ? "active" : ""}" data-hit="resize" data-room=${room.id} data-handle=${handle}
          style="cursor:${RESIZE_CURSOR[handle]}" role="presentation">
        <rect class="pad" x=${x - reach} y=${y - reach} width=${2 * reach} height=${2 * reach}></rect>
        <rect class="knob" x=${x - half} y=${y - half} width=${2 * half} height=${2 * half} rx=${this._px(coarse ? 3 : 1.5)}></rect>
      </g>`;
    });
  }

  private _sizeTag(room: Room) {
    const drag = this._drag;
    if (!drag || !("room" in drag) || drag.room !== room.id || !drag.moved) return nothing;
    const loc = this.loc;
    const [x, y, w, h] = boxOf(room.outline);
    const a = fmtNumber(loc, area(room.outline), 1, 1);
    const text = isRectangle(room.outline)
      ? t(loc, "size_rect", { w: fmtNumber(loc, w, 2, 2), h: fmtNumber(loc, h, 2, 2), a })
      : t(loc, "area", { n: a });
    const fs = this._px(12);
    const width = this._px(text.length * 7 + 16);
    const height = this._px(22);
    const cx = x + w / 2;
    const gap = this._framePad() + this._px(28);
    const below = y + h + gap;
    const top = below + height > this._view.cy + this._size[1] / 2 / this._view.s - this._px(44) ? y - gap - height : below;
    return svg`<g class="size-tag" data-size aria-hidden="true">
      <rect x=${cx - width / 2} y=${top} width=${width} height=${height} rx=${height / 2}></rect>
      <text x=${cx} y=${top + height / 2 + fs * 0.36} text-anchor="middle" style="font-size:${fs}px">${text}</text>
    </g>`;
  }

  private _alignGuides(vb: string) {
    const { x, y } = this._guides;
    if (x === null && y === null) return nothing;
    const [vx, vy, vw, vh] = vb.split(" ").map(Number) as [number, number, number, number];
    return svg`${x !== null ? svg`<line class="align" x1=${x} y1=${vy} x2=${x} y2=${vy + vh}></line>` : nothing}
      ${y !== null ? svg`<line class="align" x1=${vx} y1=${y} x2=${vx + vw} y2=${y}></line>` : nothing}`;
  }

  private _roomLabel(room: Room) {
    if (room.outline.length < 3) return nothing;
    const [bx, by, bw, bh] = boxOf(room.outline);
    const pad = this._px(10);
    const corner: Point = [bx + pad, by + pad + this._px(12)];
    const roomy = bw * this._view.s > 110 && bh * this._view.s > 70;
    const useCorner = roomy && contains(room.outline, corner) && distanceToBoundary(corner, room.outline) >= pad * 0.9;
    const top: Point = [bx + bw / 2, by + pad + this._px(12)];
    const useTop = !useCorner && bh * this._view.s > 90 && contains(room.outline, top) && distanceToBoundary(top, room.outline) >= pad * 0.9;
    const [x, y] = useCorner ? corner : useTop ? top : labelPoint(room.outline);
    const anchor = useCorner ? "start" : "middle";
    const size = this._px(13);
    return svg`<text class="room-name" x=${x} y=${y} text-anchor=${anchor} style="font-size:${size}px;stroke-width:${this._px(4)}px">${room.name}</text>
      <text class="room-area" x=${x} y=${y + this._px(15)} text-anchor=${anchor} style="font-size:${this._px(11)}px;stroke-width:${this._px(4)}px">${t(this.loc, "area", {
        n: fmtNumber(this.loc, area(room.outline), 1),
      })}</text>`;
  }

  private _bulbGlyph(x: number, y: number, selected: boolean, flagged: boolean, data: boolean, ieee: string) {
    const k = this._px(1);
    return svg`${selected ? svg`<circle class="bulb-ring" cx=${x} cy=${y} r=${this._px(17)}></circle>` : nothing}
      <circle class="bulb ${selected ? "selected" : ""} ${flagged ? "flagged" : ""}" cx=${x} cy=${y} r=${this._px(11)}
        data-hit=${data ? "bulb" : "none"} data-ieee=${ieee}></circle>
      <g transform="translate(${x} ${y}) scale(${k}) translate(-7.5 -7.5) scale(0.625)"><path class="bulb-glyph" d=${mdiLightbulb}></path></g>`;
  }

  private _bulbs() {
    const flaggedBulbs = this.flagged;
    return this.plan.bulbs.map((bulb) => {
      const selected = this._isSelected("bulb", bulb.ieee);
      const name = this.names[bulb.ieee] ?? bulb.ieee.slice(-4);
      const hit = this.tool === "select" || this.tool === "bulb";
      return svg`<g>
        ${this._bulbGlyph(bulb.x, bulb.y, selected, flaggedBulbs.has(bulb.ieee), hit, bulb.ieee)}
        ${bulb.room !== null
          ? svg`<g class="pin ${hit ? "" : "inert"}" data-pinned=${bulb.ieee} data-hit="bulb" data-ieee=${bulb.ieee} transform="translate(${bulb.x + this._px(6)} ${bulb.y - this._px(24)}) scale(${this._px(18) / 24})">
              <title>${t(this.loc, "pinned", { room: this.plan.rooms.find((r) => r.id === bulb.room)?.name ?? bulb.room })}</title>
              <circle cx="12" cy="12" r="12"></circle><path transform="translate(4 4) scale(0.667)" d=${mdiPin}></path></g>`
          : nothing}
        <text class="bulb-name" x=${bulb.x} y=${bulb.y + this._px(25)} text-anchor="middle"
          style="font-size:${this._px(11)}px;stroke-width:${this._px(3.5)}px">${name}</text>
      </g>`;
    });
  }

  private _ghost() {
    const ghost = this.ghost;
    if (!ghost) return nothing;
    return svg`<g class="ghost">${this._bulbGlyph(ghost.point[0], ghost.point[1], false, false, false, ghost.ieee)}</g>`;
  }

  private _draft() {
    const loc = this.loc;
    if (this._rect) {
      const [a, b] = this._rect;
      const outline = rectangle(a, b);
      const w = Math.abs(a[0] - b[0]);
      const h = Math.abs(a[1] - b[1]);
      const cx = (a[0] + b[0]) / 2;
      const top = Math.min(a[1], b[1]);
      const right = Math.max(a[0], b[0]);
      const cy = (a[1] + b[1]) / 2;
      const fs = this._px(11.5);
      return svg`<polygon class="draft" points=${outline.map((p) => p.join(",")).join(" ")}></polygon>
        <text class="dim live" x=${cx} y=${top - this._px(8)} text-anchor="middle" style="font-size:${fs}px;stroke-width:${this._px(4)}px">${fmtNumber(loc, w, 2)} m</text>
        <text class="dim live" x=${right + this._px(8)} y=${cy + this._px(4)} text-anchor="start" style="font-size:${fs}px;stroke-width:${this._px(4)}px">${fmtNumber(loc, h, 2)} m</text>`;
    }
    if (this.tool === "poly" && this._poly.length > 0) {
      const pts = this._poly;
      const cursor = this._snap?.point ?? this._cursor;
      const last = pts.at(-1)!;
      const first = pts[0]!;
      const ready = pts.length >= 3 && cursor !== null && dist(cursor, first) < 1e-6;
      const segment = cursor ? dist(last, cursor) : 0;
      const fs = this._px(11.5);
      return svg`${pts.length >= 2 ? svg`<polygon class="draft" style="stroke:none" points=${[...pts, cursor ?? last].map((p) => p.join(",")).join(" ")}></polygon>` : nothing}
        <polyline class="draft" style="fill:none" points=${pts.map((p) => p.join(",")).join(" ")}></polyline>
        ${cursor ? svg`<line class="rubber" x1=${last[0]} y1=${last[1]} x2=${cursor[0]} y2=${cursor[1]}></line>` : nothing}
        ${pts.slice(1).map((p) => svg`<circle class="draft-dot" cx=${p[0]} cy=${p[1]} r=${this._px(3.5)}></circle>`)}
        <circle class="draft-first ${ready ? "ready" : ""}" cx=${first[0]} cy=${first[1]} r=${this._px(ready ? 8 : 6)}></circle>
        ${cursor && segment > 0.05
          ? svg`<text class="dim live" x=${(last[0] + cursor[0]) / 2} y=${(last[1] + cursor[1]) / 2 - this._px(8)} text-anchor="middle"
              style="font-size:${fs}px;stroke-width:${this._px(4)}px">${fmtNumber(loc, segment, 2)} m</text>`
          : nothing}`;
    }
    return nothing;
  }

  private _snapMark() {
    const s = this._snap;
    const drawing = this.tool === "rect" || this.tool === "poly" || this._drag?.kind === "vertex";
    if (!s || !drawing) return nothing;
    const [x, y] = s.point;
    const r = this._px(5);
    const guide = s.guide
      ? svg`<line class="guide" x1=${s.guide[0][0]} y1=${s.guide[0][1]} x2=${s.guide[1][0]} y2=${s.guide[1][1]}></line>`
      : nothing;
    if (s.kind === "vertex") {
      return svg`${guide}<rect class="snap vertex" x=${x - r} y=${y - r} width=${2 * r} height=${2 * r} transform="rotate(45 ${x} ${y})"></rect>`;
    }
    if (s.kind === "edge" || s.kind === "angle") {
      return svg`${guide}<circle class="snap" cx=${x} cy=${y} r=${r * 1.3}></circle>`;
    }
    return svg`<path class="snap" d="M ${x - r} ${y} H ${x + r} M ${x} ${y - r} V ${y + r}"></path>`;
  }
}

if (!customElements.get("outglow-editor-canvas")) {
  customElements.define("outglow-editor-canvas", OutglowEditorCanvas);
}

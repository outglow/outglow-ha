import type { EventKind, Frame, HistoryEvent, RoomSample } from "./api/types";

export const RAW_RETENTION_S = 48 * 3600;
export const TICKS_RETENTION_DAYS = 14;
export const FINE_STEP_S = 0.5;
export const COARSE_STEP_S = 60;

export function dayStart(t: number): number {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

export function shiftDay(start: number, days: number): number {
  const d = new Date(start * 1000);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

export function dayBounds(t: number): [number, number] {
  const start = dayStart(t);
  return [start, shiftDay(start, 1)];
}

export function earliestDay(now: number): number {
  return shiftDay(dayStart(now), -(TICKS_RETENTION_DAYS - 1));
}

export function ticks(start: number, end: number, minutes: number): number[] {
  const step = minutes >= 60 ? 60 : minutes;
  const d = new Date(start * 1000);
  const local = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const aligned = Math.ceil(local / step - 1e-9) * step;
  const first = start + (aligned - local) * 60;
  const out: number[] = [];
  for (let t = first; t <= end + 1e-6; t += step * 60) {
    const at = Math.round(t);
    const date = new Date(at * 1000);
    if (minutes < 60 || (date.getHours() * 60) % minutes === 0) {
      out.push(at);
    }
  }
  return out;
}

export function motionRuns(samples: RoomSample[], step: number): [number, number][] {
  const runs: [number, number][] = [];
  for (const [t, , motion] of samples) {
    if (!motion) continue;
    const last = runs[runs.length - 1];
    if (last && t - last[1] <= step * 0.5 + 1e-6) {
      last[1] = t + step;
    } else {
      runs.push([t, t + step]);
    }
  }
  return runs;
}

export function areaPath(
  samples: RoomSample[],
  step: number,
  x: (t: number) => number,
  height: number,
  keep: (sample: RoomSample) => boolean = () => true,
): string {
  const parts: string[] = [];
  let open = false;
  let lastEnd = -Infinity;
  let lastX = 0;
  const f = (n: number): string => n.toFixed(1);
  for (const sample of samples) {
    const [t, p] = sample;
    const ok = keep(sample) && p > 0;
    if (open && (!ok || t - lastEnd > step * 0.5 + 1e-6)) {
      parts.push(`L${f(lastX)} ${f(height)}Z`);
      open = false;
    }
    if (!ok) continue;
    const x0 = x(t);
    const x1 = x(t + step);
    const y = height - Math.max(0, Math.min(1, p)) * height;
    if (!open) {
      parts.push(`M${f(x0)} ${f(height)}`);
      open = true;
    }
    parts.push(`L${f(x0)} ${f(y)}L${f(x1)} ${f(y)}`);
    lastEnd = t + step;
    lastX = x1;
  }
  if (open) {
    parts.push(`L${f(lastX)} ${f(height)}Z`);
  }
  return parts.join("");
}

export interface Cluster {
  x: number;
  t: number;
  events: HistoryEvent[];
}

export function cluster(events: HistoryEvent[], x: (t: number) => number, gap: number): Cluster[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const out: (Cluster & { xs: number[] })[] = [];
  for (const event of sorted) {
    const ex = x(event.t);
    const last = out[out.length - 1];
    if (last && ex - last.xs[last.xs.length - 1]! < gap) {
      last.events.push(event);
      last.xs.push(ex);
      last.x = last.xs.reduce((a, b) => a + b, 0) / last.xs.length;
    } else {
      out.push({ x: ex, t: event.t, events: [event], xs: [ex] });
    }
  }
  return out.map(({ x: cx, t, events: list }) => ({ x: cx, t, events: list }));
}

export function emptySpans(events: HistoryEvent[], start: number, end: number): [number, number][] {
  const spans: [number, number][] = [];
  let open: number | null = null;
  let seen = false;
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    if (event.kind === "house_empty") {
      if (open === null) open = event.t;
      seen = true;
    } else if (event.kind === "house_occupied") {
      if (open !== null) {
        spans.push([open, event.t]);
      } else if (!seen) {
        spans.push([start, event.t]);
      }
      open = null;
      seen = true;
    }
  }
  if (open !== null) {
    spans.push([open, end]);
  }
  return spans.filter(([a, b]) => b > a).map(([a, b]) => [Math.max(a, start), Math.min(b, end)]);
}

export function frameIndex(frames: Frame[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function frameAt(frames: Frame[], t: number, tolerance = 2): Frame | null {
  const i = frameIndex(frames, t);
  if (i < 0) {
    const first = frames[0];
    return first && first.t - t <= tolerance ? first : null;
  }
  const frame = frames[i]!;
  return t - frame.t <= tolerance ? frame : null;
}

export function mergeFrames(a: Frame[], b: Frame[]): Frame[] {
  const byT = new Map<number, Frame>();
  for (const frame of [...a, ...b]) {
    byT.set(Math.round(frame.t * 1000), frame);
  }
  return [...byT.values()].sort((x, y) => x.t - y.t);
}

export function clamp(t: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, t));
}

export function stepCursor(t: number, direction: number, fine: boolean): number {
  if (!fine) {
    return t + direction * COARSE_STEP_S;
  }
  const k = direction > 0 ? Math.floor(t / FINE_STEP_S + 1e-9) + 1 : Math.ceil(t / FINE_STEP_S - 1e-9) - 1;
  return k * FINE_STEP_S;
}

export function advance(t: number, ms: number, speed: number): number {
  return t + (ms / 1000) * speed;
}

export function windowAround(cursor: number, span: number, start: number, end: number, at = 0.5): [number, number] {
  if (span >= end - start) {
    return [start, end];
  }
  const v0 = clamp(cursor - span * at, start, end - span);
  return [v0, v0 + span];
}

export function follow(view: [number, number], cursor: number, start: number, end: number): [number, number] {
  const span = view[1] - view[0];
  if (cursor >= view[0] && cursor <= view[1]) {
    return view;
  }
  return windowAround(cursor, span, start, end, cursor > view[1] ? 0.2 : 0.8);
}

export function lastEventBefore(events: HistoryEvent[], t: number): HistoryEvent | null {
  let found: HistoryEvent | null = null;
  for (const event of events) {
    if (event.t <= t + 1e-6 && (!found || event.t >= found.t)) {
      found = event;
    }
  }
  return found;
}

export const MARKED: EventKind[] = [
  "false_alarm",
  "missed",
  "correct",
  "label",
  "session_start",
  "session_stop",
  "veto",
  "bulb_write",
  "model_apply",
  "model_discard",
  "model_rollback",
];

export function marked(events: HistoryEvent[], withMotion: boolean): HistoryEvent[] {
  return events.filter((e) => MARKED.includes(e.kind) || (withMotion && (e.kind === "motion_on" || e.kind === "motion_off")));
}

export function defaultCursor(events: HistoryEvent[], start: number, end: number, now: number): number {
  const last = [...events].reverse().find((e) => e.kind === "motion_on" && e.t >= start && e.t <= end);
  if (last) {
    return last.t;
  }
  if (now >= start && now < end) {
    return Math.max(start, now - 60);
  }
  return start + (end - start) / 2;
}

export function needsFrames(window: [number, number] | null, t: number, margin = 20): boolean {
  return !window || t < window[0] || t > window[1] - margin;
}

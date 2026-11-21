import type { Frame, LiveFeedback, Plan, RoomId, SessionLabelRequest } from "./api/types";

export type StepKind = "empty" | "still" | "edge" | "walk" | "sit" | "leave";

export interface WizardStep {
  id: string;
  kind: StepKind;
  room: RoomId | null;
  next: RoomId | null;
  seconds: number;
  deferred: boolean;
}

export interface WizardOptions {
  rooms: RoomId[];
  empty: boolean;
  emptyMinutes: number;
}

export const EDGE_S = 20;
export const WALK_S = 60;
export const SIT_S = 20;
export const EMPTY_MINUTES = [5, 10, 15] as const;

export type Location = RoomId | "outside" | null;

export interface RunState {
  steps: WizardStep[];
  index: number;
  location: Location;
  entrance: RoomId | null;
  started: boolean;
  paused: boolean;
  startedAt: number | null;
  elapsed: number;
}

export type RunEvent =
  | { type: "start"; now: number }
  | { type: "next"; now: number }
  | { type: "defer"; now: number }
  | { type: "skip_room"; now: number }
  | { type: "pause"; now: number }
  | { type: "resume"; now: number };

export interface Transition {
  state: RunState;
  labels: SessionLabelRequest[];
}

export const TRANSITION: SessionLabelRequest = { kind: "transition", activity: "any" };

export function roomOrder(plan: Plan): RoomId[] {
  const ids = plan.rooms.map((r) => r.id);
  const neighbours = new Map<RoomId, RoomId[]>(ids.map((id) => [id, []]));
  for (const [a, b] of plan.adjacent) {
    if (!neighbours.has(a) || !neighbours.has(b)) continue;
    neighbours.get(a)!.push(b);
    neighbours.get(b)!.push(a);
  }
  const rank = new Map(ids.map((id, i) => [id, i]));
  for (const list of neighbours.values()) {
    list.sort((x, y) => rank.get(x)! - rank.get(y)!);
  }
  const order: RoomId[] = [];
  const seen = new Set<RoomId>();
  const starts = [...plan.rooms.filter((r) => r.entrance).map((r) => r.id), ...ids];
  for (const start of starts) {
    if (seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const room = queue.shift()!;
      order.push(room);
      for (const next of neighbours.get(room) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return order;
}

export function entranceOf(plan: Plan): RoomId | null {
  return plan.rooms.find((r) => r.entrance)?.id ?? null;
}

export function buildSteps(options: WizardOptions): WizardStep[] {
  const steps: WizardStep[] = [];
  if (options.empty) {
    steps.push({ id: "empty", kind: "empty", room: null, next: null, seconds: options.emptyMinutes * 60, deferred: false });
  }
  options.rooms.forEach((room, i) => {
    const next = options.rooms[i + 1] ?? null;
    steps.push({ id: `${room}:edge`, kind: "edge", room, next: null, seconds: EDGE_S, deferred: false });
    steps.push({ id: `${room}:walk`, kind: "walk", room, next: null, seconds: WALK_S, deferred: false });
    steps.push({ id: `${room}:sit`, kind: "sit", room, next: null, seconds: SIT_S, deferred: false });
    steps.push({ id: `${room}:leave`, kind: "leave", room, next, seconds: 0, deferred: false });
  });
  return steps;
}

export function totalSeconds(steps: WizardStep[]): number {
  return steps.reduce((sum, s) => sum + (s.kind === "leave" ? 15 : s.seconds), 0);
}

export function labelFor(step: WizardStep): SessionLabelRequest {
  switch (step.kind) {
    case "empty":
      return { kind: "empty", activity: "any" };
    case "edge":
    case "walk":
      return { kind: "room", room: step.room!, activity: "walk" };
    case "still":
    case "sit":
      return { kind: "room", room: step.room!, activity: "still" };
    case "leave":
      return TRANSITION;
  }
}

export function isTimed(step: WizardStep | undefined): boolean {
  return Boolean(step && (step.kind === "still" || step.kind === "edge" || step.kind === "walk" || step.kind === "sit"));
}

export function initialState(steps: WizardStep[], entrance: RoomId | null, now: number): Transition {
  const state: RunState = {
    steps,
    index: 0,
    location: null,
    entrance,
    started: false,
    paused: false,
    startedAt: null,
    elapsed: 0,
  };
  return enter(state, 0, now);
}

export function current(state: RunState): WizardStep | undefined {
  return state.steps[state.index];
}

export function done(state: RunState): boolean {
  return state.index >= state.steps.length;
}

export function progress(state: RunState): { step: number; total: number; fraction: number } {
  const total = state.steps.length;
  const step = Math.min(total, state.index + 1);
  const finished = state.index + (state.started && !isTimed(current(state)) ? 0.5 : 0);
  return { step, total, fraction: total ? Math.min(1, finished / total) : 1 };
}

export function autoStarts(step: WizardStep | undefined, location: Location): boolean {
  if (!step) return false;
  if (step.kind === "leave") return true;
  if (step.kind === "empty") return false;
  return step.room === location;
}

export function enter(state: RunState, index: number, now: number): Transition {
  const step = state.steps[index];
  const next: RunState = { ...state, index, started: false, paused: false, startedAt: null, elapsed: 0 };
  if (step && autoStarts(step, state.location)) {
    return {
      state: { ...next, started: true, startedAt: now, location: step.kind === "leave" ? state.location : step.room },
      labels: [labelFor(step)],
    };
  }
  return { state: next, labels: [] };
}

export function elapsedMs(state: RunState, now: number): number {
  return state.elapsed + (state.startedAt !== null && !state.paused ? now - state.startedAt : 0);
}

export function remaining(state: RunState, now: number): number | null {
  const step = current(state);
  if (!step || step.seconds <= 0 || !state.started) return step && step.seconds > 0 ? step.seconds : null;
  return Math.max(0, step.seconds - elapsedMs(state, now) / 1000);
}

function locationAfter(state: RunState, step: WizardStep): Location {
  switch (step.kind) {
    case "empty":
      return state.entrance;
    case "leave":
      return step.next ?? state.location;
    default:
      return step.room;
  }
}

export function reduce(state: RunState, event: RunEvent): Transition {
  const step = current(state);
  if (!step) {
    return { state, labels: [] };
  }
  switch (event.type) {
    case "start": {
      if (state.started) return { state, labels: [] };
      const location: Location = step.kind === "empty" ? "outside" : step.kind === "leave" ? state.location : step.room;
      return { state: { ...state, started: true, paused: false, startedAt: event.now, elapsed: 0, location }, labels: [labelFor(step)] };
    }
    case "next": {
      if (!state.started) {
        return reduce(state, { type: "start", now: event.now });
      }
      const labels: SessionLabelRequest[] = step.kind === "empty" ? [TRANSITION] : [];
      const moved = enter({ ...state, location: locationAfter(state, step) }, state.index + 1, event.now);
      const tail = done(moved.state) || moved.labels.length || labels.length || step.kind === "leave" ? [] : [TRANSITION];
      return { state: moved.state, labels: [...labels, ...tail, ...moved.labels] };
    }
    case "defer": {
      if (state.started) return { state, labels: [] };
      const rest = state.steps.filter((_, i) => i !== state.index);
      const last = state.index >= state.steps.length - 1;
      const steps = last ? rest : [...rest, { ...step, deferred: true }];
      return enter({ ...state, steps }, state.index, event.now);
    }
    case "skip_room": {
      const room = step.room;
      if (!room) return { state, labels: [] };
      const steps = state.steps.filter((s, i) => i < state.index || s.room !== room);
      const closing = state.started && step.kind !== "leave" && step.kind !== "empty" ? [TRANSITION] : [];
      const moved = enter({ ...state, steps }, state.index, event.now);
      return { state: moved.state, labels: [...closing, ...moved.labels] };
    }
    case "pause": {
      if (!state.started || state.paused) return { state, labels: [] };
      return {
        state: { ...state, paused: true, elapsed: elapsedMs(state, event.now), startedAt: null },
        labels: step.kind === "leave" ? [] : [TRANSITION],
      };
    }
    case "resume": {
      if (!state.paused) return { state, labels: [] };
      return { state: { ...state, paused: false, startedAt: event.now }, labels: step.kind === "leave" ? [] : [labelFor(step)] };
    }
  }
}

export function liveFeedback(frame: Frame | null, stored: LiveFeedback | undefined): { pairs: number; veto: boolean } {
  if (frame) return { pairs: frame.pairs.filter((p) => p.obs === 1 || p.obs === 2).length, veto: frame.veto !== null };
  return { pairs: stored?.pairs_reacting ?? 0, veto: stored?.veto ?? false };
}

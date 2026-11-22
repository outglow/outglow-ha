import { fromBase64, inflate, toBase64 } from "../src/api/deflate";
import type {
  BackgroundUpload,
  Bulb,
  BulbWritePreview,
  DirectionQuality,
  Frame,
  HistoryEvent,
  HistoryRangeResponse,
  Mode,
  ModelSummary,
  OutglowCommand,
  OutglowCommands,
  PairQuality,
  PairSeries,
  Plan,
  PlanImportResponse,
  QualityReport,
  RoomSample,
  Session,
  SessionSummary,
  Settings,
  Snapshot,
} from "../src/api/types";
import { bulbRoom, roomAt } from "../src/geometry";
import type { HassMessage } from "../src/hass";
import session from "./data/flat3.json";

interface Fixture {
  command: string;
  response: unknown;
}

const fixtures = import.meta.glob<Fixture>("../../tests/fixtures/ws/*.json", { eager: true, import: "default" });

export const MOCK_PLAN = session.plan as unknown as Plan;
export const MOCK_FRAMES = session.frames as unknown as Frame[];
export const FRAME_PERIOD_S = 0.4;
export const LOOP_S = MOCK_FRAMES.length * FRAME_PERIOD_S;

export function fixtureResponses(): Map<string, unknown> {
  const responses = new Map(Object.values(fixtures).map((f) => [f.command, f.response]));
  responses.set("outglow/plan/get", { rev: MOCK_PLAN.rev, plan: MOCK_PLAN, reserved_rooms: [] });
  return responses;
}

export const MOCK_NAMES: Record<string, string> = {
  "0x0000000000000001": "Living ceiling",
  "0x0000000000000002": "Living window",
  "0x0000000000000003": "Hall",
  "0x0000000000000004": "Office desk",
  "0x0000000000000005": "Bedroom",
  "0x0000000000000006": "Kitchen",
};

const SIGNAL: Record<string, number> = {
  "1<2": -58,
  "2<1": -60,
  "1<3": -71,
  "3<1": -72,
  "1<4": -83,
  "4<1": -84,
  "2<3": -66,
  "3<2": -65,
  "2<4": -77,
  "4<2": -79,
  "3<4": -89,
  "4<3": -88,
};

export class MockError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function retime(frame: Frame, shift: number): Frame {
  return {
    ...frame,
    t: frame.t + shift,
    rooms: Object.fromEntries(
      Object.entries(frame.rooms).map(([id, room]) => [id, { ...room, since: room.since === null ? null : room.since + shift }]),
    ),
    trail: frame.trail.map(([room, t]) => [room, t + shift]),
  };
}

function short(ieee: string): string {
  return String(parseInt(ieee.slice(-4), 16));
}

const SCHEDULE: [number, number, string | null][] = [
  [0, 6.8, null],
  [6.8, 7.4, "hall"],
  [7.4, 8.2, "living"],
  [8.2, 8.5, "hall"],
  [8.5, 9.0, null],
  [9.0, 12.6, "office"],
  [12.6, 13.1, "living"],
  [13.1, 13.3, "hall"],
  [13.3, 16.9, "office"],
  [16.9, 17.2, "hall"],
  [17.2, 17.8, null],
  [17.8, 18.2, "hall"],
  [18.2, 21.7, "living"],
  [21.7, 22.0, "hall"],
  [22.0, 23.2, "living"],
  [23.2, 24, null],
];

export function scheduledRoom(t: number): string | null {
  const date = new Date(t * 1000);
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const slot = SCHEDULE.find(([a, b]) => hour >= a && hour < b);
  if (!slot) return null;
  const room = slot[2];
  if (room === null) return null;
  const minute = Math.floor(t / 60);
  const wander = hash(minute);
  if (room === "living" && wander < 0.12) return "hall";
  if (room === "office" && wander < 0.04) return "hall";
  return room;
}

function hex16(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(i), 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export async function inflated(message: HassMessage): Promise<HassMessage> {
  const body = message as unknown as Record<string, unknown>;
  if (typeof body.deflated_base64 === "string") {
    const { deflated_base64, ...rest } = body;
    return { ...rest, text: new TextDecoder().decode(await inflate(fromBase64(deflated_base64))) } as unknown as HassMessage;
  }
  const image = body.background_image as BackgroundUpload | null | undefined;
  if (image?.deflated) {
    const data = toBase64(await inflate(fromBase64(image.data_base64)));
    return { ...body, background_image: { mime: image.mime, data_base64: data, deflated: false } } as unknown as HassMessage;
  }
  return message;
}

export class MockBackend {
  plan: Plan;
  rev: number;
  bulbs: Bulb[];
  settings: Settings;
  model: ModelSummary;
  snapshots: Snapshot[];
  quality: QualityReport;
  session: Session | null = null;
  files = new Map<string, { mime: string; data_base64: string }>();
  tokens = new Map<string, { ieee: string; setting: string; value: unknown; expires: number }>();
  current: Frame | null = null;
  latency = 120;
  reserved: string[] = [];
  private tokenSeq = 0;
  private sessionSeq = 0;
  private pendingSeq = 7;
  private corrections: HistoryEvent[] = [];

  constructor(readonly clock: () => number = () => Date.now() / 1000) {
    const responses = fixtureResponses();
    const clone = <T>(command: string): T => structuredClone(responses.get(command)) as T;
    this.plan = structuredClone(MOCK_PLAN);
    this.rev = this.plan.rev;
    this.settings = clone<Settings>("outglow/settings/get");
    this.model = clone<ModelSummary>("outglow/model/get");
    this.snapshots = clone<{ snapshots: Snapshot[] }>("outglow/model/snapshots").snapshots;
    this.quality = this.buildQuality(clone<QualityReport>("outglow/quality"));
    this.bulbs = this.buildBulbs(clone<{ bulbs: Bulb[] }>("outglow/bulbs").bulbs);
    const now = this.clock();
    this.model.updated = now - 86400 * 1.2;
    if (this.model.pending) this.model.pending.created = now - 3600 * 5;
    this.snapshots = this.snapshots.map((s, i) => ({ ...s, t: now - 86400 * (2 - i) }));
  }

  private buildBulbs(template: Bulb[]): Bulb[] {
    const base = template[0]!;
    const ids = Object.keys(MOCK_NAMES);
    return ids.map((ieee, i) => {
      const placed = this.plan.bulbs.some((b) => b.ieee === ieee);
      const lines = placed
        ? this.plan.bulbs
            .filter((b) => b.ieee !== ieee)
            .map((b) => {
              const signal = SIGNAL[`${short(ieee)}<${short(b.ieee)}`] ?? -80;
              return { tx: b.ieee, signal, frozen: signal <= -88, weak: signal <= -86 };
            })
        : [];
      const offline = ieee === "0x0000000000000006";
      return {
        ...base,
        ieee,
        name: MOCK_NAMES[ieee]!,
        model: i % 2 === 0 ? "outglow-tw" : "outglow-dimm",
        available: !offline,
        sensing: !offline,
        detector: ieee === "0x0000000000000003" ? "cfar" : "rule",
        probes: offline ? null : 5,
        activity_rate: offline ? null : ieee === "0x0000000000000005" ? 0 : 2,
        sensitivity: offline ? null : ieee === "0x0000000000000004" ? 40 : 45,
        auto_calibration: offline ? null : false,
        light_entity: `light.${MOCK_NAMES[ieee]!.toLowerCase().replace(/\s+/g, "_")}`,
        area_id: null,
        gate_duty_24h: offline ? null : [0.31, 0.22, 0.45, 0.02, 0.0, 0][i] ?? null,
        lines,
      };
    });
  }

  private buildQuality(fixture: QualityReport): QualityReport {
    const counts = new Map<string, number>();
    for (const frame of MOCK_FRAMES) {
      for (const d of frame.directions) {
        if (d.state === "exceed") counts.set(`${d.rx}<${d.tx}`, (counts.get(`${d.rx}<${d.tx}`) ?? 0) + 1);
      }
    }
    const given = new Map(fixture.directions.map((d) => [`${d.rx}<${d.tx}`, d]));
    const directions: DirectionQuality[] = [];
    for (const rx of this.plan.bulbs) {
      for (const tx of this.plan.bulbs) {
        if (rx.ieee === tx.ieee) continue;
        const key = `${rx.ieee}<${tx.ieee}`;
        const known = given.get(key);
        if (known) {
          directions.push(known);
          continue;
        }
        const seed = parseInt(short(rx.ieee)) * 7 + parseInt(short(tx.ieee));
        const perH = Math.round((4 + 60 * hash(seed)) * 10) / 10;
        const theta = Object.fromEntries(
          this.plan.rooms.map((r) => [r.id, Math.round(((counts.get(key) ?? 0) / 60) * hash(seed + r.id.length) * 100) / 100]),
        );
        directions.push({
          rx: rx.ieee,
          tx: tx.ieee,
          exceed_per_h: perH,
          exceed_per_day: Math.round(perH * 24),
          asymmetry: Math.round((0.7 + hash(seed + 3)) * 10) / 10,
          frozen_frac: 0,
          signal_dbm: SIGNAL[`${short(rx.ieee)}<${short(tx.ieee)}`] ?? -80,
          gate_open_frac: Math.round(hash(seed + 5) * 50) / 100,
          theta,
          flags: perH > 50 ? ["asymmetric_noisy"] : [],
        });
      }
    }
    const pairs: PairQuality[] = [];
    const given2 = new Map(fixture.pairs.map((p) => [`${p.a}|${p.b}`, p]));
    this.plan.bulbs.forEach((a, i) => {
      this.plan.bulbs.slice(i + 1).forEach((b) => {
        const key = `${a.ieee}|${b.ieee}`;
        const known = given2.get(key);
        const seed = parseInt(short(a.ieee)) * 11 + parseInt(short(b.ieee));
        pairs.push(
          known ?? {
            a: a.ieee,
            b: b.ieee,
            information: Object.fromEntries(this.plan.rooms.map((r) => [r.id, Math.round(hash(seed + r.id.length * 13) * 60) / 100])),
          },
        );
      });
    });
    return { ...fixture, directions, pairs };
  }

  liveFrame(index: number, loopStart: number): Frame {
    const n = MOCK_FRAMES.length;
    const loop = Math.floor(index / n);
    const frame = MOCK_FRAMES[index % n]!;
    const shift = loopStart + loop * LOOP_S - MOCK_FRAMES[0]!.t;
    return retime(frame, shift);
  }

  async handle(message: HassMessage): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, this.latency));
    const result = this.dispatch(await inflated(message));
    return structuredClone(result);
  }

  dispatch(message: HassMessage): unknown {
    const type = message.type as OutglowCommand;
    const req = message as unknown as Record<string, unknown>;
    const now = this.clock();
    switch (type) {
      case "outglow/info":
        return fixtureResponses().get(type);
      case "outglow/bulbs":
        return { bulbs: this.bulbs };
      case "outglow/plan/get":
        return { rev: this.rev, plan: { ...this.plan, rev: this.rev }, reserved_rooms: this.reserved };
      case "outglow/plan/save": {
        const request = req as unknown as OutglowCommands["outglow/plan/save"]["request"];
        if (request.rev !== this.rev) {
          throw new MockError("rev_conflict", "The plan was changed elsewhere");
        }
        const kept = new Set(request.plan.rooms.map((r) => r.id));
        if (request.plan.rooms.some((r) => this.plan.retired_rooms.includes(r.id))) {
          throw new MockError("invalid_format", "A room id belonged to a removed room");
        }
        const removed = this.plan.rooms.map((r) => r.id).filter((id) => !kept.has(id));
        const retired = [...new Set([...this.plan.retired_rooms, ...(request.plan.retired_rooms ?? []), ...removed])].sort();
        let background = request.plan.background;
        const upload = request.background_image;
        if (upload && background) {
          if (upload.deflated) throw new MockError("invalid_format", "The mock takes inflated images only");
          const ext = upload.mime === "image/jpeg" ? "jpg" : upload.mime.split("/")[1]!.replace("svg+xml", "svg");
          const file = /^plan-[0-9a-f]{16}\./.test(background.file) ? background.file : `plan-${hex16(upload.data_base64)}.${ext}`;
          this.files.set(file, { mime: upload.mime, data_base64: upload.data_base64 });
          background = { ...background, file };
        } else if (background && !this.files.has(background.file)) {
          background = null;
        }
        const previous = this.plan.background?.file;
        for (const file of [...this.files.keys()]) if (file !== previous && file !== background?.file) this.files.delete(file);
        this.rev += 1;
        this.plan = { ...structuredClone(request.plan), background, rev: this.rev, retired_rooms: retired };
        const warnings = this.plan.bulbs.flatMap((b) => {
          const at = roomAt(this.plan, [b.x, b.y]);
          return b.room !== null && b.room !== at ? [{ code: "bulb_pinned_elsewhere" as const, params: { ieee: b.ieee, room: b.room, at } }] : [];
        });
        return { rev: this.rev, warnings, background, retired_rooms: retired };
      }
      case "outglow/plan/import":
        return this.importPlan(req as unknown as OutglowCommands["outglow/plan/import"]["request"]);
      case "outglow/plan/valetudo/robots":
        return fixtureResponses().get(type);
      case "outglow/plan/valetudo/fetch": {
        const request = req as unknown as OutglowCommands["outglow/plan/valetudo/fetch"]["request"];
        if (request.url && /unreachable/.test(request.url)) throw new MockError("fetch_failed", "Cannot reach the robot: ClientConnectorError");
        if (!request.url && !request.robot) throw new MockError("invalid_format", "Give a robot or its address");
        return this.valetudo(request.current ?? null);
      }
      case "outglow/plan/background/get":
        {
          const file = this.plan.background?.file ?? null;
          const image = (file !== null && this.files.get(file)) || null;
          return { image, file: image ? file : null };
        }
      case "outglow/plan/background/set": {
        const request = req as unknown as OutglowCommands["outglow/plan/background/set"]["request"];
        const ext = request.mime === "image/jpeg" ? "jpg" : request.mime.split("/")[1]!.replace("svg+xml", "svg");
        return { file: `plan-${hex16(request.data_base64)}.${ext}` };
      }
      case "outglow/history/range":
        return this.historyRange(req as unknown as OutglowCommands["outglow/history/range"]["request"]);
      case "outglow/history/frames":
        return this.historyFrames(req as unknown as OutglowCommands["outglow/history/frames"]["request"]);
      case "outglow/feedback":
        return this.feedback(req as unknown as OutglowCommands["outglow/feedback"]["request"], now);
      case "outglow/session/start":
        return this.startSession(req as unknown as OutglowCommands["outglow/session/start"]["request"], now);
      case "outglow/session/label":
        return this.label(req as unknown as OutglowCommands["outglow/session/label"]["request"], now);
      case "outglow/session/stop":
        return this.stopSession(now);
      case "outglow/session/get":
        return { session: this.session ? this.withFeedback(this.session) : null };
      case "outglow/quality":
        return { ...this.quality, t: now, days: Number(req.days ?? 7) };
      case "outglow/settings/get":
        return this.settings;
      case "outglow/settings/set":
        this.settings = structuredClone(req as unknown as Settings);
        delete (this.settings as unknown as Record<string, unknown>).type;
        return this.settings;
      case "outglow/model/get":
        return this.model;
      case "outglow/model/snapshots":
        return { snapshots: this.snapshots };
      case "outglow/model/apply":
        return this.applyModel(String(req.pending_id), now, req.mode === "bayes" || req.mode === "rules" ? req.mode : null);
      case "outglow/model/discard": {
        if (!this.model.pending || this.model.pending.pending_id !== req.pending_id) {
          throw new MockError("not_found", "No such proposal");
        }
        this.model = { ...this.model, pending: null };
        return { model_version: this.model.model_version, snapshot_id: null };
      }
      case "outglow/model/rollback": {
        const target = this.snapshots.find((s) => s.snapshot_id === req.snapshot_id);
        if (!target) throw new MockError("not_found", "No such snapshot");
        const id = `m-${String(this.model.model_version + 1).padStart(4, "0")}`;
        const current = this.settings.global.mode;
        const mode = target.mode && target.mode !== current ? target.mode : null;
        this.snapshots.push({
          snapshot_id: id,
          t: now,
          reason: "before_rollback",
          model_version: this.model.model_version,
          ...(mode ? { mode: current } : {}),
        });
        this.model = { ...this.model, model_version: this.model.model_version + 1, updated: now, pending: null };
        if (mode) this.settings = { ...this.settings, global: { ...this.settings.global, mode } };
        return { model_version: this.model.model_version, snapshot_id: id };
      }
      case "outglow/model/snapshot/delete": {
        if (req.all === true) {
          this.snapshots = [];
        } else {
          if (!this.snapshots.some((s) => s.snapshot_id === req.snapshot_id)) throw new MockError("not_found", "No such snapshot");
          this.snapshots = this.snapshots.filter((s) => s.snapshot_id !== req.snapshot_id);
        }
        return { snapshots: this.snapshots };
      }
      case "outglow/model/reset": {
        const id = `m-r${this.model.model_version + 1}`;
        this.snapshots.push({ snapshot_id: id, t: now, reason: "before_reset", model_version: this.model.model_version });
        this.model = { ...this.model, model_version: this.model.model_version + 1, updated: now, pending: req.room ? this.model.pending : null };
        return { model_version: this.model.model_version, snapshot_id: id };
      }
      case "outglow/bulb/write_preview":
        return this.preview(req as unknown as OutglowCommands["outglow/bulb/write_preview"]["request"], now);
      case "outglow/bulb/write":
        return this.write(req as unknown as OutglowCommands["outglow/bulb/write"]["request"], now);
      default:
        throw new MockError("unknown_command", message.type);
    }
  }

  private importPlan(request: OutglowCommands["outglow/plan/import"]["request"]): PlanImportResponse {
    if (request.text === undefined) throw new MockError("invalid_format", "Give either text or deflated_base64");
    const text = request.text;
    const json = request.format === "auto" ? /^\s*[[{]/.test(text) : request.format !== "mieszkanie_yaml";
    if (json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new MockError("invalid_format", "Not JSON");
      }
      const map = parsed as { __class?: unknown; pixelSize?: unknown; layers?: unknown };
      if (map.__class === "ValetudoMap" || (map.pixelSize !== undefined && Array.isArray(map.layers))) {
        return this.valetudo(request.current ?? null);
      }
      if (request.format === "valetudo_json") throw new MockError("invalid_format", "Not a Valetudo map");
      const candidate = (parsed as { plan?: unknown }).plan ?? parsed;
      const plan = candidate as Partial<Plan>;
      if (!Array.isArray(plan.rooms)) {
        throw new MockError("invalid_format", "No rooms");
      }
      const known = new Set(Object.keys(MOCK_NAMES));
      const full: Plan = {
        version: 1,
        rev: 0,
        floor_id: null,
        north_deg: 0,
        view_rotation_deg: 0,
        background: null,
        walls: [],
        doors: [],
        adjacent: [],
        bulbs: [],
        excluded_directions: [],
        retired_rooms: [],
        ...plan,
        rooms: plan.rooms,
      } as Plan;
      return {
        plan: full,
        warnings: full.bulbs.filter((b) => !known.has(b.ieee)).map((b) => ({ code: "unknown_bulb", params: { ieee: b.ieee } })),
        source: "outglow_plan",
        background_image: null,
        kept: null,
      };
    }
    if (!/rooms\s*:/.test(text)) {
      throw new MockError("invalid_format", "No rooms section");
    }
    return structuredClone(fixtureResponses().get("outglow/plan/import")) as PlanImportResponse;
  }

  private valetudo(current: Plan | null): PlanImportResponse {
    const result = structuredClone(fixtureResponses().get("outglow/plan/valetudo/fetch")) as PlanImportResponse;
    if (!current?.bulbs.length) return result;
    return {
      ...result,
      plan: { ...result.plan, bulbs: structuredClone(current.bulbs) },
      warnings: [...result.warnings, { code: "bulbs_not_aligned", params: { rooms: 0 } }],
      kept: {
        bulbs: current.bulbs.length,
        rooms: 0,
        aligned: false,
        rotation_deg: 0,
        mirrored: false,
        rms_m: null,
      },
    };
  }

  private withFeedback(s: Session): Session {
    const frame = this.current;
    const reacting = frame ? frame.pairs.filter((p) => p.obs === 1 || p.obs === 2).length : 0;
    return { ...s, live_feedback: { pairs_reacting: s.state === "running" ? reacting : s.live_feedback.pairs_reacting, veto: frame?.veto !== null && frame?.veto !== undefined } };
  }

  private startSession(request: OutglowCommands["outglow/session/start"]["request"], now: number): Session {
    if (this.session?.state === "running") {
      throw new MockError("busy", "A session is already running");
    }
    this.sessionSeq += 1;
    this.snapshots.push({
      snapshot_id: `m-b${this.sessionSeq}`,
      t: now,
      reason: "before_session",
      model_version: this.model.model_version,
    });
    this.session = {
      session_id: `s-${String(this.sessionSeq).padStart(4, "0")}`,
      name: request.name,
      started: now,
      state: "running",
      raised_rate: Boolean(request.raise_rate),
      steps: [],
      live_feedback: { pairs_reacting: 0, veto: false },
      summary: null,
    };
    return this.withFeedback(this.session);
  }

  private label(request: OutglowCommands["outglow/session/label"]["request"], now: number): Session {
    const s = this.session;
    if (!s || s.state !== "running") {
      throw new MockError("no_session", "No session is running");
    }
    const steps = s.steps.map((step) => (step.t1 === null ? { ...step, t1: now } : step));
    steps.push({ index: steps.length, kind: request.kind, room: request.room ?? null, activity: request.activity, t0: now, t1: null });
    this.session = { ...s, steps };
    return this.withFeedback(this.session);
  }

  private stopSession(now: number): Session {
    const s = this.session;
    if (!s || s.state !== "running") {
      throw new MockError("no_session", "No session is running");
    }
    const steps = s.steps.map((step) => (step.t1 === null ? { ...step, t1: now } : step));
    const rooms = this.plan.rooms.map((r) => r.id);
    const seconds = rooms.map((room) =>
      steps.filter((st) => st.room === room && st.kind === "room").reduce((sum, st) => sum + ((st.t1 ?? now) - st.t0), 0),
    );
    const matrix = (good: number): number[][] =>
      rooms.map((_, i) => {
        const total = Math.max(4, Math.round(seconds[i]! / 2));
        const hit = Math.round(total * (i === 2 ? good - 0.2 : good));
        const rest = total - hit;
        return rooms.map((_r, j) => (j === i ? hit : Math.round((rest * (j === (i + 1) % rooms.length ? 0.6 : 0.15)) || 0))).concat([Math.max(0, Math.round(rest * 0.25))]);
      });
    const rules = this.settings.global.mode === "rules";
    const before = matrix(rules ? 0.32 : 0.58);
    const bayesBefore = matrix(0.58);
    const bayesAfter = matrix(0.86);
    const after = rules ? before : bayesAfter;
    const accuracy = (m: number[][]): number => {
      const diag = m.reduce((sum, row, i) => sum + (row[i] ?? 0), 0);
      const all = m.flat().reduce((a, b) => a + b, 0);
      return all ? Math.round((diag / all) * 100) / 100 : 0;
    };
    this.pendingSeq += 1;
    const pendingId = `p-${String(this.pendingSeq).padStart(4, "0")}`;
    const summary: SessionSummary = {
      rooms,
      matrix_before: before,
      matrix_after: after,
      accuracy_before: accuracy(before),
      accuracy_after: accuracy(after),
      weak_rooms: ["office"],
      pending_id: pendingId,
      mode: this.settings.global.mode,
      bayes: rules
        ? {
            matrix_before: bayesBefore,
            matrix_after: bayesAfter,
            accuracy_before: accuracy(bayesBefore),
            accuracy_after: accuracy(bayesAfter),
          }
        : null,
      suggest_mode: rules ? "bayes" : null,
      rooms_without_bulbs: rooms.filter((room) => !this.plan.bulbs.some((b) => bulbRoom(this.plan, b) === room)),
      empty_house_hours: Math.round(steps.filter((st) => st.kind === "empty").reduce((sum, st) => sum + ((st.t1 ?? now) - st.t0), 0) / 3.6) / 1000,
      empty_setup: emptySetup(this.settings.global),
      empty_needed_h: this.settings.global.others_may_be_home ? 6.7 : 2,
    };
    this.model = {
      ...this.model,
      pending: {
        pending_id: pendingId,
        created: now,
        labels: { wizard: Math.round(steps.reduce((sum, st) => sum + ((st.t1 ?? now) - st.t0), 0) * 2), feedback: 0 },
        rooms: this.plan.rooms.map((r, i) => ({
          room: r.id,
          a_on_before: 0.9,
          a_on_after: [0.86, 0.84, 0.9][i] ?? 0.88,
          detection_before: [0.74, 0.71, null][i] ?? 0.7,
          detection_after: [0.9, 0.86, 0.63][i] ?? 0.8,
          false_per_day_before: [1.4, 0.6, null][i] ?? 0.5,
          false_per_day_after: [0.8, 0.7, 0.3][i] ?? 0.5,
        })),
      },
    };
    this.session = { ...s, state: "stopped", steps, summary, raised_rate: s.raised_rate };
    const done = this.withFeedback(this.session);
    return done;
  }

  private feedback(request: OutglowCommands["outglow/feedback"]["request"], now: number): { pending_id: string | null } {
    if (!this.plan.rooms.some((r) => r.id === request.room)) throw new MockError("not_found", "No such room");
    this.corrections.push({ t: request.when ?? now, kind: request.kind, room: request.room, data: { source: "feedback" } });
    if (!this.settings.global.learning) return { pending_id: null };
    if (!this.model.pending) {
      this.pendingSeq += 1;
      const rooms = this.plan.rooms.map((r) => ({
        room: r.id,
        a_on_before: 0.9,
        a_on_after: 0.9,
        detection_before: null,
        detection_after: null,
        false_per_day_before: null,
        false_per_day_after: null,
      }));
      this.model = { ...this.model, pending: { pending_id: `p-${String(this.pendingSeq).padStart(4, "0")}`, created: now, labels: {}, rooms } };
    }
    const pending = this.model.pending!;
    pending.labels = { ...pending.labels, feedback: (pending.labels.feedback ?? 0) + 30 };
    return { pending_id: pending.pending_id };
  }

  private applyModel(id: string, now: number, mode: Mode | null): { model_version: number; snapshot_id: string } {
    if (!this.model.pending || this.model.pending.pending_id !== id) {
      throw new MockError("not_found", "No such proposal");
    }
    const snapshot = `m-${String(this.model.model_version).padStart(4, "0")}a`;
    const before = this.settings.global.mode;
    this.snapshots.push({
      snapshot_id: snapshot,
      t: now,
      reason: "before_apply",
      model_version: this.model.model_version,
      ...(mode && mode !== before ? { mode: before } : {}),
    });
    const labels = { ...this.model.labels };
    for (const [k, v] of Object.entries(this.model.pending.labels)) labels[k] = (labels[k] ?? 0) + v;
    this.model = { ...this.model, model_version: this.model.model_version + 1, updated: now, labels, pending: null };
    if (mode) this.settings = { ...this.settings, global: { ...this.settings.global, mode } };
    return { model_version: this.model.model_version, snapshot_id: snapshot };
  }

  private preview(request: OutglowCommands["outglow/bulb/write_preview"]["request"], now: number): BulbWritePreview {
    const bulb = this.bulbs.find((b) => b.ieee === request.ieee);
    if (!bulb) throw new MockError("not_found", "No such bulb");
    this.tokenSeq += 1;
    const token = `c-${this.tokenSeq.toString(16).padStart(4, "0")}`;
    this.tokens.set(token, { ieee: request.ieee, setting: request.setting, value: request.value, expires: now + 60 });
    const effects: BulbWritePreview["effects"] = [];
    if (request.setting === "sensitivity") {
      effects.push({ code: "overwrites_all_lines", params: { lines: bulb.lines.length } });
      effects.push({ code: "clears_calibration", params: {} });
      if (bulb.auto_calibration) effects.push({ code: "disables_auto_calibration", params: {} });
    } else if (request.setting === "probes") {
      effects.push({ code: "more_radio_traffic", params: { probes: Number(request.value) } });
    } else if (request.setting === "sensing" && request.value === false) {
      effects.push({ code: "stops_sensing", params: {} });
    } else if (request.setting === "calibrate") {
      effects.push({ code: "starts_calibration", params: { seconds: bulb.detector === "cfar" ? 900 : 60 } });
    }
    const previous = (bulb as unknown as Record<string, unknown>)[request.setting];
    return {
      confirm_token: token,
      expires: now + 60,
      previous: previous === undefined ? null : (previous as BulbWritePreview["previous"]),
      effects,
    };
  }

  private write(request: OutglowCommands["outglow/bulb/write"]["request"], now: number): { written: boolean; t: number } {
    const token = this.tokens.get(request.confirm_token);
    if (!token || token.expires < now) throw new MockError("token_expired", "Confirm again");
    if (token.ieee !== request.ieee || token.setting !== request.setting || token.value !== request.value) {
      throw new MockError("token_mismatch", "The token was for another change");
    }
    this.tokens.delete(request.confirm_token);
    this.bulbs = this.bulbs.map((b) =>
      b.ieee === request.ieee && request.setting in b ? ({ ...b, [request.setting]: request.value } as Bulb) : b,
    );
    return { written: true, t: now };
  }

  historyRange(request: OutglowCommands["outglow/history/range"]["request"]): HistoryRangeResponse {
    const step = Math.max(1, request.step_s);
    const rooms: Record<string, RoomSample[]> = Object.fromEntries(this.plan.rooms.map((r) => [r.id, [] as RoomSample[]]));
    const events: HistoryEvent[] = [];
    const now = this.clock();
    const end = Math.min(request.end, now);
    let previous: string | null = null;
    for (let t = Math.ceil(request.start / step) * step; t <= end; t += step) {
      const here = scheduledRoom(t);
      for (const room of this.plan.rooms) {
        const on = here === room.id;
        const noise = hash(Math.floor(t / step) * 31 + room.id.length);
        const p = on ? 0.82 + 0.17 * noise : noise > 0.985 ? 0.4 + 0.3 * noise : 0.01 + 0.04 * noise;
        rooms[room.id]!.push([t, Math.round(p * 100) / 100, on]);
      }
      if (here !== previous) {
        if (previous) events.push({ t, kind: "motion_off", room: previous, data: {} });
        if (here) events.push({ t, kind: "motion_on", room: here, data: {} });
        if (previous === null && here !== null && events.length > 1) events.push({ t: t - step, kind: "house_occupied", room: null, data: {} });
        if (here === null && previous !== null) events.push({ t: t + step, kind: "house_empty", room: null, data: {} });
        previous = here;
      }
    }
    const day = new Date(request.start * 1000);
    day.setHours(0, 0, 0, 0);
    const base = day.getTime() / 1000;
    const extra: HistoryEvent[] = [
      { t: base + 3600 * 3.2, kind: "false_alarm", room: "hall", data: { source: "feedback" } },
      { t: base + 3600 * 10.4, kind: "veto", room: null, data: { kind: "common" } },
      { t: base + 3600 * 14.1, kind: "false_alarm", room: "living", data: { source: "night_calibration" } },
      { t: base + 3600 * 19.5, kind: "session_start", room: null, data: { name: "Evening" } },
      { t: base + 3600 * 19.5 + 60, kind: "label", room: "living", data: { activity: "walk" } },
      { t: base + 3600 * 19.5 + 260, kind: "label", room: "hall", data: { activity: "walk" } },
      { t: base + 3600 * 19.5 + 600, kind: "session_stop", room: null, data: {} },
      { t: base + 3600 * 19.5 + 700, kind: "model_apply", room: null, data: { model_version: 6 } },
      { t: base + 3600 * 11.2, kind: "bulb_write", room: null, data: { ieee: "0x0000000000000004", setting: "sensitivity", value: 50, previous: 40 } },
      { t: base + 3600 * 15.8, kind: "missed", room: "office", data: {} },
    ];
    for (const e of [...extra, ...this.corrections]) {
      if (e.t >= request.start && e.t <= end) events.push(e);
    }
    events.sort((a, b) => a.t - b.t);
    let pairs: PairSeries[] | null = null;
    if (request.pairs) {
      pairs = MOCK_FRAMES[0]!.pairs.map((p) => ({
        a: p.a,
        b: p.b,
        samples: (rooms[this.plan.rooms[0]!.id] ?? []).map(([t]) => [t, hash(Math.floor(t) + p.a.length) > 0.8 ? 2 : 0] as [number, 0 | 2]),
      }));
    }
    return { rooms, events, pairs };
  }

  historyFrames(request: OutglowCommands["outglow/history/frames"]["request"]): { frames: Frame[]; truncated: boolean } {
    const now = this.clock();
    const oldest = now - 48 * 3600;
    const start = Math.max(request.start, oldest);
    const end = Math.min(request.end, now, start + 600);
    const frames: Frame[] = [];
    const first = Math.ceil(start / FRAME_PERIOD_S);
    for (let k = first; k * FRAME_PERIOD_S <= end; k += 1) {
      const n = MOCK_FRAMES.length;
      const index = ((k % n) + n) % n;
      const loop = Math.floor(k / n);
      frames.push(retime(MOCK_FRAMES[index]!, loop * LOOP_S - MOCK_FRAMES[0]!.t));
    }
    return { frames, truncated: request.start < oldest };
  }
}

function emptySetup(g: Settings["global"]): NonNullable<SessionSummary["empty_setup"]> {
  const persons = g.use_persons && g.persons.length > 0;
  if (persons) return g.learning ? "none" : "learning";
  return g.learning ? "persons" : "both";
}

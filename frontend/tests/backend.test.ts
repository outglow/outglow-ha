import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plan, PlanImportResponse, Session } from "../src/api/types";
import { deflate, fits, fromBase64, MESSAGE_MAX, MESSAGE_ROOM, megabytes, toBase64, utf8Length } from "../src/api/deflate";
import { inflated, LOOP_S, MockBackend } from "../mock/backend";

const VALETUDO = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/valetudo/flat.json"), "utf8");

function backend(now = 1_800_000_100): MockBackend {
  const b = new MockBackend(() => now);
  b.latency = 0;
  return b;
}

describe("deflate", () => {
  it("packs bytes for a message and says what fits", async () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 7);
    expect(fromBase64(toBase64(big))).toEqual(big);
    const packed = await deflate(big);
    expect(packed.length).toBeLessThan(big.length / 10);
    expect(fits(MESSAGE_MAX - MESSAGE_ROOM)).toBe(true);
    expect(fits(MESSAGE_MAX - MESSAGE_ROOM, 1)).toBe(false);
    expect(megabytes(3 * 1024 * 1024)).toBe("3.0");
    expect(utf8Length("żółw")).toBe(7);
  });
});

describe("mock backend", () => {
  it("recognises what is imported and fetches a vacuum map", () => {
    const b = backend();
    const { plan } = b.dispatch({ type: "outglow/plan/get" }) as { plan: Plan };
    const map = b.dispatch({ type: "outglow/plan/import", format: "auto", text: VALETUDO, current: plan }) as PlanImportResponse;
    expect(map.source).toBe("valetudo_map");
    expect(map.plan.rooms.map((r) => r.name)).toEqual(["Living room", "Kitchen", "Hall", "Room 7"]);
    expect(map.plan.bulbs).toHaveLength(plan.bulbs.length);
    expect(map.kept?.aligned).toBe(false);
    expect(map.background_image?.mime).toBe("image/svg+xml");
    const bare = b.dispatch({ type: "outglow/plan/import", format: "auto", text: VALETUDO }) as PlanImportResponse;
    expect(bare.plan.bulbs).toEqual([]);
    expect((b.dispatch({ type: "outglow/plan/import", format: "auto", text: JSON.stringify(plan) }) as PlanImportResponse).source).toBe("outglow_plan");
    expect((b.dispatch({ type: "outglow/plan/import", format: "auto", text: "rooms:\n  a: {}\n" }) as PlanImportResponse).source).toBe("prototype_yaml");
    expect(() => b.dispatch({ type: "outglow/plan/import", format: "auto", text: "{nope" })).toThrow(/Not JSON/);
    expect(() => b.dispatch({ type: "outglow/plan/import", format: "valetudo_json", text: "{}" })).toThrow(/Not a Valetudo map/);
    expect((b.dispatch({ type: "outglow/plan/valetudo/robots" }) as { robots: unknown[] }).robots).toHaveLength(1);
    expect((b.dispatch({ type: "outglow/plan/valetudo/fetch", robot: "Robot1" }) as PlanImportResponse).plan.rooms).toHaveLength(4);
    expect(() => b.dispatch({ type: "outglow/plan/valetudo/fetch", url: "http://unreachable" })).toThrow(/Cannot reach/);
    expect(() => b.dispatch({ type: "outglow/plan/valetudo/fetch" })).toThrow(/Give a robot/);
  });

  it("raises the plan revision and rejects stale saves", () => {
    const b = backend();
    const { rev, plan } = b.dispatch({ type: "outglow/plan/get" }) as { rev: number; plan: Plan };
    expect(b.dispatch({ type: "outglow/plan/save", rev, plan })).toEqual({ rev: rev + 1, warnings: [], background: plan.background, retired_rooms: plan.retired_rooms });
    expect(() => b.dispatch({ type: "outglow/plan/save", rev, plan })).toThrow(/changed elsewhere/);
    const pinned = { ...plan, bulbs: plan.bulbs.map((x, i) => (i === 0 ? { ...x, room: "hall" } : x)) };
    expect(b.dispatch({ type: "outglow/plan/save", rev: rev + 1, plan: pinned })).toEqual({
      rev: rev + 2,
      warnings: [{ code: "bulb_pinned_elsewhere", params: { ieee: plan.bulbs[0]!.ieee, room: "hall", at: "living" } }],
      background: plan.background,
      retired_rooms: plan.retired_rooms,
    });
  });

  it("stores a background with the plan and reads deflated messages", async () => {
    const b = backend();
    const { rev, plan } = b.dispatch({ type: "outglow/plan/get" }) as { rev: number; plan: Plan };
    const svg = new TextEncoder().encode("<svg>map</svg>");
    const background = { file: "plan.svg", x: 0, y: 0, m_per_px: 0.05, opacity: 0.6 };
    const message = await inflated({
      type: "outglow/plan/save",
      rev,
      plan: { ...plan, background },
      background_image: { mime: "image/svg+xml", data_base64: toBase64(await deflate(svg)), deflated: true },
    });
    const saved = b.dispatch(message) as { background: { file: string } };
    expect(saved.background.file).toMatch(/^plan-[0-9a-f]{16}\.svg$/);
    const image = (b.dispatch({ type: "outglow/plan/background/get" }) as { image: { data_base64: string } }).image;
    expect(fromBase64(image.data_base64)).toEqual(svg);
    const packed = toBase64(await deflate(new TextEncoder().encode(VALETUDO)));
    const imported = b.dispatch(await inflated({ type: "outglow/plan/import", format: "auto", deflated_base64: packed })) as PlanImportResponse;
    expect(imported.source).toBe("valetudo_map");
    expect(() => b.dispatch({ type: "outglow/plan/import", format: "auto" })).toThrow(/Give either/);
    expect(await inflated({ type: "outglow/plan/get" })).toEqual({ type: "outglow/plan/get" });
  });

  it("runs a learning session to a pending model", () => {
    const b = backend();
    b.dispatch({ type: "outglow/session/start", name: "Test", raise_rate: false });
    b.dispatch({ type: "outglow/session/label", kind: "room", room: "hall", activity: "walk" });
    const stopped = b.dispatch({ type: "outglow/session/stop" }) as Session;
    expect(stopped.state).toBe("stopped");
    expect(stopped.summary?.matrix_after.length).toBe(3);
    const pending = stopped.summary!.pending_id!;
    expect(b.dispatch({ type: "outglow/model/apply", pending_id: pending })).toMatchObject({ model_version: 7 });
    expect(() => b.dispatch({ type: "outglow/session/label", kind: "empty", activity: "any" })).toThrow();
  });

  it("takes a correction from the history into the model proposal", () => {
    const b = backend();
    b.dispatch({ type: "outglow/model/discard", pending_id: "p-0007" });
    const first = b.dispatch({ type: "outglow/feedback", room: "hall", kind: "false_alarm", when: 1_800_000_050 }) as {
      pending_id: string;
    };
    expect(first.pending_id).toBe("p-0008");
    expect(b.dispatch({ type: "outglow/feedback", room: "office", kind: "missed" })).toEqual({ pending_id: "p-0008" });
    expect(() => b.dispatch({ type: "outglow/feedback", room: "attic", kind: "missed" })).toThrow(/No such room/);
    const range = b.historyRange({ start: 1_800_000_000, end: 1_800_000_100, step_s: 60 });
    expect(range.events.filter((e) => e.data.source === "feedback").map((e) => e.kind)).toEqual(["false_alarm", "missed"]);
    b.settings = { ...b.settings, global: { ...b.settings.global, learning: false } };
    expect(b.dispatch({ type: "outglow/feedback", room: "hall", kind: "correct" })).toEqual({ pending_id: null });
  });

  it("asks for a fresh token before writing to a bulb", () => {
    const b = backend();
    const preview = b.dispatch({ type: "outglow/bulb/write_preview", ieee: "0x0000000000000004", setting: "sensitivity", value: 50 }) as {
      confirm_token: string;
      effects: { code: string }[];
    };
    expect(preview.effects.map((e) => e.code)).toContain("clears_calibration");
    expect(() =>
      b.dispatch({ type: "outglow/bulb/write", ieee: "0x0000000000000004", setting: "sensitivity", value: 60, confirm_token: preview.confirm_token }),
    ).toThrow(/another change/);
    expect(
      b.dispatch({ type: "outglow/bulb/write", ieee: "0x0000000000000004", setting: "sensitivity", value: 50, confirm_token: preview.confirm_token }),
    ).toMatchObject({ written: true });
  });

  it("replays history frames on a steady clock", () => {
    const now = 1_800_100_000;
    const b = backend(now);
    const { frames, truncated } = b.historyFrames({ start: now - 3600, end: now - 3600 + LOOP_S * 2 });
    expect(truncated).toBe(false);
    const gaps = frames.slice(1).map((f, i) => Math.round((f.t - frames[i]!.t) * 10) / 10);
    expect(new Set(gaps)).toEqual(new Set([0.4]));
    expect(b.historyFrames({ start: now - 50 * 3600, end: now - 49 * 3600 }).truncated).toBe(true);
  });
});

import type { Frame, LiveMessage } from "../src/api/types";
import type { ConnectionEvent, Hass, HassConnection, HassMessage, Unsubscribe } from "../src/hass";
import { FRAME_PERIOD_S, MOCK_FRAMES, MOCK_PLAN, MockBackend, MockError, fixtureResponses } from "./backend";
import { diffFrames } from "./delta";

export { MOCK_FRAMES, MOCK_PLAN, MockBackend, fixtureResponses };

export function liveMessages(frames: Frame[]): LiveMessage[] {
  return frames.map((frame, i) => {
    const prev = i === 0 ? null : frames[i - 1];
    const delta = prev ? diffFrames(prev, frame) : null;
    return delta ? { kind: "delta", delta } : { kind: "full", frame };
  });
}

export interface MockOptions {
  backend?: MockBackend;
  speed?: number;
  frames?: Frame[];
}

export interface MockConnection extends HassConnection {
  drop(): void;
  restore(): void;
}

export function mockConnection(options: MockOptions | Frame[] = {}): MockConnection {
  const opts: MockOptions = Array.isArray(options) ? { frames: options } : options;
  const backend = opts.backend ?? new MockBackend();
  const speed = opts.speed ?? 1;
  const listeners = new Map<ConnectionEvent, Set<() => void>>();
  let offline = false;
  const fire = (event: ConnectionEvent): void => listeners.get(event)?.forEach((listener) => listener());
  return {
    addEventListener(event: ConnectionEvent, listener: () => void): void {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    },
    removeEventListener(event: ConnectionEvent, listener: () => void): void {
      listeners.get(event)?.delete(listener);
    },
    drop(): void {
      offline = true;
      fire("disconnected");
    },
    restore(): void {
      offline = false;
      fire("ready");
    },
    sendMessagePromise<T>(message: HassMessage): Promise<T> {
      if (offline) return Promise.reject({ code: "connection_lost", message: "Connection lost" });
      return backend.handle(message).then(
        (result) => result as T,
        (err: unknown) => {
          const e = err instanceof MockError ? err : new MockError("unknown_error", String(err));
          return Promise.reject({ code: e.code, message: e.message });
        },
      );
    },
    subscribeMessage<T>(callback: (event: T) => void, message: HassMessage): Promise<Unsubscribe> {
      if (message.type !== "outglow/live/subscribe") {
        return Promise.reject({ code: "unknown_command", message: message.type });
      }
      const fixed = opts.frames;
      const loopStart = backend.clock();
      let index = 0;
      let previous: Frame | null = null;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const send = (): void => {
        if (stopped) return;
        if (offline) {
          timer = setTimeout(send, (FRAME_PERIOD_S * 1000) / speed);
          return;
        }
        const frame = fixed ? fixed[index % fixed.length]! : backend.liveFrame(index, loopStart);
        const wrapped = fixed && index % fixed.length === 0;
        const delta = previous && !wrapped ? diffFrames(previous, frame) : null;
        const event: LiveMessage = delta ? { kind: "delta", delta } : { kind: "full", frame };
        previous = frame;
        backend.current = frame;
        callback(structuredClone(event) as T);
        index += 1;
        timer = setTimeout(send, (FRAME_PERIOD_S * 1000) / speed);
      };
      send();
      return Promise.resolve(async () => {
        stopped = true;
        clearTimeout(timer);
      });
    },
  };
}

export function mockHass(dark: boolean, language = navigator.language || "en", backend?: MockBackend): Hass {
  return {
    connection: mockConnection({ backend: backend ?? new MockBackend() }),
    language,
    locale: { language, number_format: "language", time_format: "language" },
    themes: { darkMode: dark },
    user: { name: "Mock admin", is_admin: true },
    areas: {
      living: { area_id: "living", name: "Living room" },
      hall: { area_id: "hall", name: "Hall" },
      office: { area_id: "office", name: "Office" },
      bedroom: { area_id: "bedroom", name: "Bedroom" },
    },
  };
}

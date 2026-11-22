export interface HassMessage {
  type: string;
  [key: string]: unknown;
}

export type Unsubscribe = () => Promise<void>;

export type ConnectionEvent = "ready" | "disconnected";

export interface HassConnection {
  sendMessagePromise<T>(message: HassMessage): Promise<T>;
  subscribeMessage<T>(callback: (event: T) => void, message: HassMessage): Promise<Unsubscribe>;
  addEventListener?(event: ConnectionEvent, listener: () => void): void;
  removeEventListener?(event: ConnectionEvent, listener: () => void): void;
}

export interface HassArea {
  area_id: string;
  name: string;
}

export interface HassLocale {
  language: string;
  number_format?: string;
  time_format?: string;
}

export interface Hass {
  connection: HassConnection;
  language: string;
  locale?: HassLocale;
  themes?: { darkMode?: boolean };
  user?: { name: string; is_admin: boolean };
  areas?: Record<string, HassArea>;
}

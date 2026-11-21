import type { Hass, Unsubscribe } from "../hass";
import type { OutglowCommand, OutglowCommands } from "./types";

export type Request<C extends OutglowCommand> = OutglowCommands[C]["request"];
export type Response<C extends OutglowCommand> = OutglowCommands[C]["response"];
export type Event<C extends OutglowCommand> = OutglowCommands[C]["event"];

export function call<C extends OutglowCommand>(hass: Hass, type: C, request: Request<C>): Promise<Response<C>> {
  return hass.connection.sendMessagePromise<Response<C>>({ ...request, type });
}

export function subscribe<C extends OutglowCommand>(
  hass: Hass,
  type: C,
  request: Request<C>,
  onEvent: (event: Event<C>) => void,
): Promise<Unsubscribe> {
  return hass.connection.subscribeMessage<Event<C>>(onEvent, { ...request, type });
}

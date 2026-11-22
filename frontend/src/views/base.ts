import { LitElement } from "lit";
import { call, type Request, type Response } from "../api/client";
import type { Bulb, Frame, Info, OutglowCommand, Plan } from "../api/types";
import type { Hass } from "../hass";
import type { Loc } from "../i18n";
import { errorText } from "../strings/common";

export interface Toast {
  text: string;
  error?: boolean;
}

export class ViewBase extends LitElement {
  static override properties = {
    hass: { attribute: false },
    loc: { attribute: false },
    plan: { attribute: false },
    rev: { attribute: false },
    frame: { attribute: false },
    bulbs: { attribute: false },
    info: { attribute: false },
    narrow: { type: Boolean },
    dark: { type: Boolean },
    subpath: { attribute: false },
  };

  declare hass: Hass | undefined;
  declare loc: Loc;
  declare plan: Plan | null;
  declare rev: number;
  declare frame: Frame | null;
  declare bulbs: Bulb[];
  declare info: Info | null;
  declare narrow: boolean;
  declare dark: boolean;
  declare subpath: string;

  constructor() {
    super();
    this.loc = { lang: "en", numbers: "en", hour12: undefined };
    this.plan = null;
    this.rev = 0;
    this.frame = null;
    this.bulbs = [];
    this.info = null;
    this.narrow = false;
    this.dark = false;
    this.subpath = "";
  }

  protected names(): Record<string, string> {
    return Object.fromEntries(this.bulbs.map((b) => [b.ieee, b.name]));
  }

  protected bulbName(ieee: string): string {
    return this.bulbs.find((b) => b.ieee === ieee)?.name ?? ieee.slice(-4);
  }

  protected roomName(id: string | null | undefined): string {
    if (!id) return "—";
    return this.plan?.rooms.find((r) => r.id === id)?.name ?? id;
  }

  protected roomColour(id: string | null | undefined): string {
    return this.plan?.rooms.find((r) => r.id === id)?.colour ?? "var(--og-fg2)";
  }

  protected async call<C extends OutglowCommand>(type: C, request: Request<C>): Promise<Response<C>> {
    if (!this.hass) {
      throw new Error("no hass");
    }
    return call(this.hass, type, request);
  }

  protected emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  protected navigate(path: string): void {
    this.emit("og-navigate", { path });
  }

  protected toast(text: string, error = false): void {
    this.emit<Toast>("og-toast", { text, error });
  }

  protected fail(err: unknown): void {
    this.toast(errorText(this.loc, err), true);
  }

  protected planSaved(plan: Plan, rev: number): void {
    this.emit("og-plan", { plan, rev });
  }

  protected isExcluded(rx: string, tx: string): boolean {
    return Boolean(this.plan?.excluded_directions.some((d) => d.rx === rx && d.tx === tx));
  }

  protected async setExcluded(rx: string, tx: string, excluded: boolean, reason = ""): Promise<boolean> {
    const plan = this.plan;
    if (!plan) return false;
    const rest = plan.excluded_directions.filter((d) => !(d.rx === rx && d.tx === tx));
    const next: Plan = { ...plan, excluded_directions: excluded ? [...rest, { rx, tx, reason }] : rest };
    try {
      const result = await this.call("outglow/plan/save", { rev: this.rev, plan: next });
      this.planSaved({ ...next, rev: result.rev, retired_rooms: result.retired_rooms }, result.rev);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }
}

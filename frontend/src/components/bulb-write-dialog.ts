import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { mdiAlert, mdiInformation, mdiShieldCheck } from "@mdi/js";
import { call } from "../api/client";
import type { Bulb, BulbEffect, BulbSetting, BulbValue, BulbWritePreview } from "../api/types";
import { fmtDuration } from "../format";
import type { Hass } from "../hass";
import { strings, type Lang, type Loc } from "../i18n";
import { icon } from "../icons";
import { errorCode, errorText, tc } from "../strings/common";
import { shared, tokens } from "../theme";
import "./og-sheet";

export const tw = strings(
  {
    title: "Change bulb · {bulb}",
    setting: "Setting",
    value: "New value",
    setting_sensitivity: "Sensitivity",
    setting_probes: "Probes per line",
    setting_sensing: "Motion sensing",
    setting_auto_calibration: "Automatic calibration",
    setting_self_tuning: "Daily self-tuning",
    setting_calibrate: "Calibrate now",
    calibrate_hint: "The bulb records the empty room for a minute. Leave the room after confirming.",
    on: "On",
    off: "Off",
    promise: "Nothing is written until you confirm. Outglow never writes to bulbs on its own.",
    check: "Check effects",
    checking: "Checking…",
    now: "Now",
    after: "After",
    effects: "What happens",
    no_effects: "No side effects.",
    valid: "Confirmation valid for {time}",
    expired: "The confirmation expired. Check the effects again.",
    write: "Write to bulb",
    writing: "Writing…",
    written: "{bulb}: {setting} written",
    effect_overwrites_all_lines: { one: "Overwrites the setting on the bulb's only line.", other: "Overwrites the setting on all {lines} lines of the bulb." },
    effect_clears_calibration: "Clears the bulb's calibration of the empty room.",
    effect_disables_auto_calibration: "Turns off the bulb's automatic calibration.",
    effect_more_radio_traffic: "More radio traffic in the Zigbee network.",
    effect_stops_sensing: "The bulb stops sensing motion; its lines go dark for Outglow.",
    effect_starts_calibration: "Starts a calibration of about {seconds} s. Keep the room empty.",
    unknown_value: "unknown",
  },
  {
    title: "Zmiana w żarówce · {bulb}",
    setting: "Ustawienie",
    value: "Nowa wartość",
    setting_sensitivity: "Czułość",
    setting_probes: "Sondy na linię",
    setting_sensing: "Wykrywanie ruchu",
    setting_auto_calibration: "Automatyczna kalibracja",
    setting_self_tuning: "Samostrojenie dobowe",
    setting_calibrate: "Kalibruj teraz",
    calibrate_hint: "Żarówka przez minutę nagrywa pusty pokój. Po potwierdzeniu wyjdź z pokoju.",
    on: "Włączone",
    off: "Wyłączone",
    promise: "Nic nie zostanie zapisane bez Twojego potwierdzenia. Outglow nigdy nie zapisuje do żarówek sam.",
    check: "Sprawdź skutki",
    checking: "Sprawdzanie…",
    now: "Teraz",
    after: "Po zmianie",
    effects: "Co się stanie",
    no_effects: "Bez skutków ubocznych.",
    valid: "Potwierdzenie ważne jeszcze {time}",
    expired: "Potwierdzenie wygasło. Sprawdź skutki jeszcze raz.",
    write: "Zapisz w żarówce",
    writing: "Zapisywanie…",
    written: "{bulb}: zapisano {setting}",
    effect_overwrites_all_lines: {
      one: "Nadpisze ustawienie jedynej linii żarówki.",
      few: "Nadpisze ustawienie wszystkich {lines} linii żarówki.",
      many: "Nadpisze ustawienie wszystkich {lines} linii żarówki.",
      other: "Nadpisze ustawienie wszystkich {lines} linii żarówki.",
    },
    effect_clears_calibration: "Skasuje kalibrację pustego pokoju zapisaną w żarówce.",
    effect_disables_auto_calibration: "Wyłączy automatyczną kalibrację w żarówce.",
    effect_more_radio_traffic: "Więcej ruchu radiowego w sieci Zigbee.",
    effect_stops_sensing: "Żarówka przestanie wykrywać ruch; jej linie znikną dla Outglow.",
    effect_starts_calibration: "Uruchomi kalibrację na około {seconds} s. Pokój ma być pusty.",
    unknown_value: "nieznane",
  },
);

export const SETTINGS: BulbSetting[] = ["sensitivity", "probes", "sensing", "auto_calibration", "self_tuning", "calibrate"];

export type SettingKind = "number" | "bool" | "action";

export function settingKind(setting: BulbSetting): SettingKind {
  if (setting === "sensitivity" || setting === "probes") return "number";
  if (setting === "calibrate") return "action";
  return "bool";
}

export function settingRange(setting: BulbSetting): [number, number] {
  return setting === "probes" ? [1, 16] : [1, 100];
}

export function currentValue(bulb: Bulb, setting: BulbSetting): BulbValue | null {
  switch (setting) {
    case "sensitivity":
      return bulb.sensitivity;
    case "probes":
      return bulb.probes;
    case "sensing":
      return bulb.sensing;
    case "auto_calibration":
      return bulb.auto_calibration;
    default:
      return null;
  }
}

export function defaultValue(bulb: Bulb, setting: BulbSetting): BulbValue {
  const kind = settingKind(setting);
  if (kind === "action") return true;
  const now = currentValue(bulb, setting);
  if (kind === "bool") return now === null ? true : !now;
  return typeof now === "number" ? now : setting === "probes" ? 5 : 40;
}

export function valueText(loc: Loc | Lang, setting: BulbSetting, value: BulbValue | null): string {
  if (value === null) return tw(loc, "unknown_value");
  if (settingKind(setting) === "bool" || typeof value === "boolean") return tw(loc, value ? "on" : "off");
  return String(value);
}

export function effectText(loc: Loc | Lang, effect: BulbEffect): string {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(effect.params)) {
    if (typeof v === "number" || typeof v === "string") params[k] = v;
  }
  if (effect.code === "overwrites_all_lines" && typeof params.lines === "number") params.n = params.lines;
  if (effect.code === "starts_calibration" && params.seconds === undefined) params.seconds = 60;
  return tw(loc, `effect_${effect.code}`, params);
}

export const TOKEN_TTL_S = 60;

export class OgBulbWrite extends LitElement {
  static override properties = {
    hass: { attribute: false },
    loc: { attribute: false },
    bulb: { attribute: false },
    setting: { attribute: false },
    value: { attribute: false },
    _setting: { state: true },
    _value: { state: true },
    _preview: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _left: { state: true },
  };

  declare hass: Hass | undefined;
  declare loc: Loc;
  declare bulb: Bulb | null;
  declare setting: BulbSetting;
  declare value: BulbValue | null;
  declare _setting: BulbSetting;
  declare _value: BulbValue;
  declare _preview: BulbWritePreview | null;
  declare _busy: boolean;
  declare _error: string | null;
  declare _left: number;

  private _deadline = 0;
  private _timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    super();
    this.loc = { lang: "en", numbers: "en", hour12: undefined };
    this.bulb = null;
    this.setting = "sensitivity";
    this.value = null;
    this._setting = "sensitivity";
    this._value = 40;
    this._preview = null;
    this._busy = false;
    this._error = null;
    this._left = 0;
  }

  static override styles = [
    tokens,
    shared,
    css`
      .grid {
        display: grid;
        gap: 16px;
      }
      .two {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      @media (max-width: 480px) {
        .two {
          grid-template-columns: 1fr;
        }
      }
      .compare {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-radius: var(--og-radius-s);
        background: var(--og-tint);
      }
      .compare b {
        display: block;
        font-size: 22px;
        line-height: 28px;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
      }
      .compare .arrow {
        color: var(--og-fg2);
        font-size: 20px;
      }
      .effects {
        display: grid;
        gap: 8px;
      }
      .countdown {
        display: grid;
        gap: 6px;
        font-size: 13px;
        color: var(--og-fg2);
      }
      .countdown .bar > span {
        background: var(--og-warning);
        transition: width 1s linear;
      }
      .toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 44px;
        gap: 12px;
        font-size: 15px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        width: 100%;
      }
    `,
  ];

  override willUpdate(changed: PropertyValues<this>): void {
    if ((changed.has("bulb") || changed.has("setting") || changed.has("value")) && this.bulb) {
      this._setting = this.setting;
      this._value = this.value ?? defaultValue(this.bulb, this.setting);
      this._reset();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearInterval(this._timer);
  }

  private _reset(): void {
    this._preview = null;
    this._error = null;
    clearInterval(this._timer);
  }

  private _close(): void {
    this._reset();
    this.dispatchEvent(new CustomEvent("closed", { bubbles: true, composed: true }));
  }

  private _emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private _pickSetting(setting: BulbSetting): void {
    this._setting = setting;
    this._value = this.bulb ? defaultValue(this.bulb, setting) : true;
    this._reset();
  }

  private _setValue(value: BulbValue): void {
    this._value = value;
    this._reset();
  }

  private async _check(): Promise<void> {
    if (!this.hass || !this.bulb) return;
    this._busy = true;
    this._error = null;
    try {
      this._preview = await call(this.hass, "outglow/bulb/write_preview", {
        ieee: this.bulb.ieee,
        setting: this._setting,
        value: this._value,
      });
      this._deadline = Date.now() + TOKEN_TTL_S * 1000;
      this._tickCountdown();
      clearInterval(this._timer);
      this._timer = setInterval(() => this._tickCountdown(), 1000);
    } catch (err) {
      this._error = errorText(this.loc, err);
    } finally {
      this._busy = false;
    }
  }

  private _tickCountdown(): void {
    this._left = Math.max(0, Math.round((this._deadline - Date.now()) / 1000));
    if (this._left <= 0) clearInterval(this._timer);
  }

  private async _write(): Promise<void> {
    const preview = this._preview;
    if (!this.hass || !this.bulb || !preview) return;
    this._busy = true;
    try {
      await call(this.hass, "outglow/bulb/write", {
        ieee: this.bulb.ieee,
        setting: this._setting,
        value: this._value,
        confirm_token: preview.confirm_token,
      });
      this._emit("og-toast", { text: tw(this.loc, "written", { bulb: this.bulb.name, setting: tw(this.loc, `setting_${this._setting}`) }) });
      this._emit("og-refresh-bulbs", {});
      this._close();
    } catch (err) {
      const code = errorCode(err);
      this._error = errorText(this.loc, err);
      if (code === "token_expired" || code === "token_mismatch") {
        this._preview = null;
        clearInterval(this._timer);
      }
    } finally {
      this._busy = false;
    }
  }

  private _valueInput() {
    const loc = this.loc;
    const kind = settingKind(this._setting);
    if (kind === "action") {
      return html`<div class="notice info">${icon(mdiInformation, 20)}<span>${tw(loc, "calibrate_hint")}</span></div>`;
    }
    if (kind === "bool") {
      return html`<label class="toggle">
        <span>${tw(loc, "value")}: <b>${valueText(loc, this._setting, this._value)}</b></span>
        <span class="switch"
          ><input
            type="checkbox"
            aria-label=${tw(loc, "value")}
            .checked=${Boolean(this._value)}
            @change=${(e: Event) => this._setValue((e.target as HTMLInputElement).checked)} /><span></span
        ></span>
      </label>`;
    }
    const [min, max] = settingRange(this._setting);
    return html`<label class="field">
      ${tw(loc, "value")}
      <input
        type="number"
        inputmode="numeric"
        min=${min}
        max=${max}
        .value=${String(this._value)}
        @input=${(e: Event) => {
          const n = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(n)) this._setValue(Math.max(min, Math.min(max, Math.round(n))));
        }}
      />
    </label>`;
  }

  private _previewBlock(preview: BulbWritePreview) {
    const loc = this.loc;
    const expired = this._left <= 0;
    const kind = settingKind(this._setting);
    return html`
      ${kind === "action"
        ? nothing
        : html`<div class="compare" aria-label=${tw(loc, "effects")}>
            <div><span class="eyebrow">${tw(loc, "now")}</span><b>${valueText(loc, this._setting, preview.previous)}</b></div>
            <span class="arrow" aria-hidden="true">→</span>
            <div><span class="eyebrow">${tw(loc, "after")}</span><b>${valueText(loc, this._setting, this._value)}</b></div>
          </div>`}
      <div class="effects">
        <span class="eyebrow">${tw(loc, "effects")}</span>
        ${preview.effects.length
          ? preview.effects.map((e) => html`<div class="notice warning">${icon(mdiAlert, 20)}<span>${effectText(loc, e)}</span></div>`)
          : html`<div class="notice">${icon(mdiShieldCheck, 20)}<span>${tw(loc, "no_effects")}</span></div>`}
      </div>
      ${expired
        ? html`<div class="notice error" role="alert">${icon(mdiAlert, 20)}<span>${tw(loc, "expired")}</span></div>`
        : html`<div class="countdown" role="timer" aria-live="off">
            <span>${tw(loc, "valid", { time: fmtDuration(this._left) })}</span>
            <span class="bar"><span style="width:${(this._left / TOKEN_TTL_S) * 100}%"></span></span>
          </div>`}
    `;
  }

  override render() {
    const loc = this.loc;
    const bulb = this.bulb;
    const preview = this._preview;
    const ready = Boolean(preview) && this._left > 0;
    return html`<og-sheet
      .open=${Boolean(bulb)}
      heading=${bulb ? tw(loc, "title", { bulb: bulb.name }) : ""}
      close-label=${tc(loc, "close")}
      @closed=${(e: Event) => {
        e.stopPropagation();
        this._close();
      }}
    >
      ${bulb
        ? html`<div class="grid">
            <div class="two">
              <label class="field">
                ${tw(loc, "setting")}
                <select @change=${(e: Event) => this._pickSetting((e.target as HTMLSelectElement).value as BulbSetting)}>
                  ${SETTINGS.map((s) => html`<option value=${s} ?selected=${s === this._setting}>${tw(loc, `setting_${s}`)}</option>`)}
                </select>
              </label>
              ${settingKind(this._setting) === "number" ? this._valueInput() : nothing}
            </div>
            ${settingKind(this._setting) === "number" ? nothing : this._valueInput()}
            <div class="notice">${icon(mdiShieldCheck, 20)}<span>${tw(loc, "promise")}</span></div>
            ${preview ? this._previewBlock(preview) : nothing}
            ${this._error ? html`<div class="notice error" role="alert">${icon(mdiAlert, 20)}<span>${this._error}</span></div>` : nothing}
          </div>`
        : nothing}
      <div slot="actions" class="actions">
        <button class="btn neutral" @click=${() => this._close()}>${tc(loc, "cancel")}</button>
        ${ready
          ? html`<button class="btn filled" data-action="write" ?disabled=${this._busy} @click=${() => void this._write()}>
              ${this._busy ? tw(loc, "writing") : tw(loc, "write")}
            </button>`
          : html`<button class="btn tonal" data-action="check" ?disabled=${this._busy} @click=${() => void this._check()}>
              ${this._busy ? tw(loc, "checking") : tw(loc, "check")}
            </button>`}
      </div>
    </og-sheet>`;
  }
}

if (!customElements.get("og-bulb-write")) {
  customElements.define("og-bulb-write", OgBulbWrite);
}

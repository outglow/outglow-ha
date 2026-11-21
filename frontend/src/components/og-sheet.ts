import { LitElement, css, html, type PropertyValues } from "lit";
import { icon, mdiClose } from "../icons";
import { shared, tokens } from "../theme";

export class OgSheet extends LitElement {
  static override properties = {
    open: { type: Boolean, reflect: true },
    heading: {},
    closeLabel: { attribute: "close-label" },
    wide: { type: Boolean },
  };

  declare open: boolean;
  declare heading: string;
  declare closeLabel: string;
  declare wide: boolean;

  constructor() {
    super();
    this.open = false;
    this.heading = "";
    this.closeLabel = "Close";
    this.wide = false;
  }

  static override styles = [
    tokens,
    shared,
    css`
      dialog {
        border: none;
        padding: 0;
        margin: auto;
        width: min(560px, calc(100vw - 32px));
        max-height: min(86vh, 880px);
        border-radius: 28px;
        background: var(--og-card);
        color: var(--og-fg);
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.28);
        overflow: hidden;
        font-family: var(--og-font);
      }
      dialog.wide {
        width: min(760px, calc(100vw - 32px));
      }
      dialog:focus,
      dialog:focus-visible {
        outline: none;
      }
      dialog[open] {
        display: flex;
        flex-direction: column;
        animation: rise 220ms var(--og-ease);
      }
      dialog::backdrop {
        background: rgba(0, 0, 0, 0.42);
        animation: fade 220ms ease;
      }
      header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 16px 12px 8px 24px;
      }
      header h2 {
        flex: 1;
        font-size: 20px;
        line-height: 28px;
        font-weight: 400;
      }
      .body {
        padding: 4px 24px 16px;
        overflow: auto;
        flex: 1;
        font-size: 14px;
        line-height: 20px;
      }
      footer {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        padding: 8px 16px 16px;
      }
      footer:not(:has(slot[name="actions"] *)) {
        display: flex;
      }
      .handle {
        display: none;
      }
      @media (max-width: 600px) {
        dialog {
          width: 100vw;
          max-width: 100vw;
          margin: auto 0 0;
          border-radius: 28px 28px 0 0;
          max-height: 88vh;
          padding-bottom: env(safe-area-inset-bottom);
        }
        dialog.wide {
          width: 100vw;
        }
        dialog[open] {
          animation: slide 260ms var(--og-ease);
        }
        .handle {
          display: block;
          width: 32px;
          height: 4px;
          border-radius: 2px;
          background: var(--og-tint-strong);
          margin: 10px auto 0;
        }
        header {
          padding-top: 4px;
        }
      }
      @keyframes rise {
        from {
          opacity: 0;
          transform: translateY(12px) scale(0.98);
        }
      }
      @keyframes slide {
        from {
          transform: translateY(100%);
        }
      }
      @keyframes fade {
        from {
          opacity: 0;
        }
      }
    `,
  ];

  override updated(changed: PropertyValues<this>): void {
    if (!changed.has("open")) return;
    const dialog = this.renderRoot.querySelector("dialog");
    if (!dialog) return;
    if (this.open && !dialog.open) {
      dialog.showModal();
      dialog.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    } else if (!this.open && dialog.open) {
      dialog.close();
    }
  }

  close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent("closed", { bubbles: true, composed: true }));
  }

  private _onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  private _onClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  override render() {
    return html`<dialog
      tabindex="-1"
      class=${this.wide ? "wide" : ""}
      aria-label=${this.heading}
      @cancel=${this._onCancel}
      @click=${this._onClick}
    >
      <div class="handle"></div>
      <header>
        <h2>${this.heading}</h2>
        <button class="icon-btn" aria-label=${this.closeLabel} @click=${() => this.close()}>${icon(mdiClose)}</button>
      </header>
      <div class="body"><slot></slot></div>
      <footer><slot name="actions"></slot></footer>
    </dialog>`;
  }
}

if (!customElements.get("og-sheet")) {
  customElements.define("og-sheet", OgSheet);
}

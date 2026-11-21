import { css } from "lit";

export const ROOM_PALETTE = ["#4e9af1", "#f28b30", "#42b883", "#e2598b", "#9c6ade", "#e6b422", "#2bb3c0", "#c0603a"] as const;

export const tokens = css`
  :host {
    --og-font: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, Roboto, system-ui, -apple-system, "Segoe UI", sans-serif));
    --og-fg: var(--primary-text-color, #212121);
    --og-fg2: var(--secondary-text-color, #727272);
    --og-bg: var(--primary-background-color, #fafafa);
    --og-card: var(--card-background-color, var(--ha-card-background, #fff));
    --og-divider: var(--divider-color, rgba(0, 0, 0, 0.12));
    --og-primary: var(--primary-color, #03a9f4);
    --og-on-primary: var(--text-primary-color, #fff);
    --og-motion: var(--state-binary_sensor-motion-on-color, var(--state-active-color, #ff9800));
    --og-error: var(--error-color, #db4437);
    --og-warning: var(--warning-color, #ffa600);
    --og-success: var(--success-color, #43a047);
    --og-info: var(--info-color, #039be5);
    --og-radius: var(--ha-card-border-radius, 12px);
    --og-radius-s: 8px;
    --og-shadow: var(--ha-card-box-shadow, none);
    --og-border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--og-divider));
    --og-tint: color-mix(in srgb, var(--og-fg) 5%, transparent);
    --og-tint-strong: color-mix(in srgb, var(--og-fg) 10%, transparent);
    --og-primary-tint: color-mix(in srgb, var(--og-primary) 14%, transparent);
    --og-motion-tint: color-mix(in srgb, var(--og-motion) 18%, transparent);
    --og-ease: cubic-bezier(0.2, 0, 0, 1);
    font-family: var(--og-font);
    color: var(--og-fg);
    -webkit-font-smoothing: antialiased;
  }
`;

export const shared = css`
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  .icon {
    flex: none;
    display: block;
  }
  h1,
  h2,
  h3,
  h4,
  p {
    margin: 0;
  }
  .title {
    font-size: 22px;
    line-height: 28px;
    font-weight: 400;
    letter-spacing: 0;
  }
  .headline {
    font-size: 16px;
    line-height: 24px;
    font-weight: 500;
  }
  .eyebrow {
    font-size: 11px;
    line-height: 16px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--og-fg2);
  }
  .muted {
    color: var(--og-fg2);
  }
  .small {
    font-size: 13px;
    line-height: 18px;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .card {
    background: var(--og-card);
    border-radius: var(--og-radius);
    box-shadow: var(--og-shadow);
    border: var(--og-border);
  }
  .card-body {
    padding: 16px;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 56px;
    padding: 12px 16px 4px;
  }
  .card-head > .headline {
    flex: 1;
    min-width: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .wrap {
    flex-wrap: wrap;
  }
  .stack {
    display: grid;
    gap: 16px;
    align-content: start;
  }
  button {
    font: inherit;
    color: inherit;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 16px;
    border-radius: 20px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--og-primary);
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 0.01em;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 150ms var(--og-ease), box-shadow 150ms var(--og-ease), opacity 150ms;
    -webkit-tap-highlight-color: transparent;
    position: relative;
  }
  .btn::after {
    content: "";
    position: absolute;
    inset: -3px 0;
  }
  .btn:hover {
    background: var(--og-primary-tint);
  }
  .btn.filled {
    background: var(--og-primary);
    color: var(--og-on-primary);
  }
  .btn.filled:hover {
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    background: color-mix(in srgb, var(--og-primary) 88%, var(--og-fg));
  }
  .btn.tonal {
    background: var(--og-primary-tint);
  }
  .btn.tonal:hover {
    background: color-mix(in srgb, var(--og-primary) 22%, transparent);
  }
  .btn.outlined {
    border-color: var(--og-divider);
  }
  .btn.neutral {
    color: var(--og-fg);
  }
  .btn.danger {
    color: var(--og-error);
  }
  .btn.danger.filled {
    background: var(--og-error);
    color: #fff;
  }
  .btn.big {
    min-height: 56px;
    border-radius: 28px;
    padding: 0 28px;
    font-size: 16px;
  }
  .btn:disabled,
  .icon-btn:disabled {
    opacity: 0.38;
    cursor: default;
    pointer-events: none;
  }
  .icon-btn {
    display: inline-grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--og-fg2);
    cursor: pointer;
    flex: none;
    transition: background-color 150ms var(--og-ease), color 150ms;
    -webkit-tap-highlight-color: transparent;
  }
  .icon-btn:hover {
    background: var(--og-tint);
    color: var(--og-fg);
  }
  .icon-btn[aria-pressed="true"] {
    background: var(--og-primary-tint);
    color: var(--og-primary);
  }
  :focus-visible {
    outline: 2px solid var(--og-primary);
    outline-offset: 2px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 12px;
    border-radius: 16px;
    border: 1px solid var(--og-divider);
    background: transparent;
    font-size: 13px;
    font-weight: 500;
    color: var(--og-fg);
    white-space: nowrap;
    cursor: pointer;
    position: relative;
  }
  .chip::after {
    content: "";
    position: absolute;
    inset: -6px 0;
  }
  .chip[aria-pressed="true"],
  .chip[aria-selected="true"] {
    background: var(--og-primary-tint);
    border-color: transparent;
    color: var(--og-primary);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 22px;
    padding: 0 8px;
    border-radius: 11px;
    font-size: 12px;
    font-weight: 500;
    background: var(--og-tint);
    color: var(--og-fg2);
    white-space: nowrap;
  }
  .badge.warning {
    background: color-mix(in srgb, var(--og-warning) 18%, transparent);
    color: color-mix(in srgb, var(--og-warning) 55%, var(--og-fg));
  }
  .badge.error {
    background: color-mix(in srgb, var(--og-error) 16%, transparent);
    color: color-mix(in srgb, var(--og-error) 70%, var(--og-fg));
  }
  .badge.success {
    background: color-mix(in srgb, var(--og-success) 16%, transparent);
    color: color-mix(in srgb, var(--og-success) 65%, var(--og-fg));
  }
  .badge.motion {
    background: var(--og-motion-tint);
    color: color-mix(in srgb, var(--og-motion) 60%, var(--og-fg));
  }
  .segmented {
    display: inline-flex;
    border: 1px solid var(--og-divider);
    border-radius: 20px;
    overflow: hidden;
    max-width: 100%;
  }
  .segmented button {
    min-height: 40px;
    min-width: 48px;
    padding: 0 14px;
    border: none;
    border-left: 1px solid var(--og-divider);
    background: transparent;
    font-size: 14px;
    font-weight: 500;
    color: var(--og-fg);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }
  .segmented button:first-child {
    border-left: none;
  }
  .segmented button[aria-checked="true"],
  .segmented button[aria-pressed="true"] {
    background: var(--og-primary-tint);
    color: var(--og-primary);
  }
  .segmented button:focus-visible {
    outline-offset: -3px;
  }
  label.field {
    display: grid;
    gap: 4px;
    font-size: 12px;
    font-weight: 500;
    color: var(--og-fg2);
  }
  input[type="text"],
  input[type="number"],
  input[type="search"],
  select,
  textarea {
    font: inherit;
    font-size: 15px;
    color: var(--og-fg);
    background: var(--og-tint);
    border: 1px solid transparent;
    border-bottom: 1px solid color-mix(in srgb, var(--og-fg) 38%, transparent);
    border-radius: var(--og-radius-s) var(--og-radius-s) 0 0;
    min-height: 44px;
    padding: 8px 12px;
    width: 100%;
    min-width: 0;
  }
  input:focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-bottom: 2px solid var(--og-primary);
  }
  textarea {
    min-height: 140px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    resize: vertical;
  }
  input[type="range"] {
    width: 100%;
    accent-color: var(--og-primary);
    min-height: 44px;
  }
  .check {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    min-height: 44px;
    padding: 10px 0;
    cursor: pointer;
    font-size: 15px;
    line-height: 22px;
  }
  .check input {
    width: 20px;
    height: 20px;
    margin: 1px 0 0;
    accent-color: var(--og-primary);
    flex: none;
  }
  .switch {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    flex: none;
  }
  .switch input {
    position: absolute;
    inset: -10px;
    opacity: 0;
    margin: 0;
    cursor: pointer;
    z-index: 1;
  }
  .switch span {
    position: absolute;
    inset: 0;
    border-radius: 12px;
    background: color-mix(in srgb, var(--og-fg) 26%, transparent);
    transition: background-color 150ms;
  }
  .switch span::before {
    content: "";
    position: absolute;
    left: 3px;
    top: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    transition: transform 150ms var(--og-ease);
  }
  .switch input:checked + span {
    background: var(--og-primary);
  }
  .switch input:checked + span::before {
    transform: translateX(20px);
  }
  .switch input:focus-visible + span {
    outline: 2px solid var(--og-primary);
    outline-offset: 2px;
  }
  .switch input:disabled + span {
    opacity: 0.4;
  }
  .notice {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 12px 14px;
    border-radius: var(--og-radius-s);
    background: var(--og-tint);
    font-size: 14px;
    line-height: 20px;
  }
  .notice .icon {
    margin-top: -1px;
    color: var(--og-fg2);
  }
  .notice.warning {
    background: color-mix(in srgb, var(--og-warning) 14%, transparent);
  }
  .notice.warning .icon {
    color: var(--og-warning);
  }
  .notice.error {
    background: color-mix(in srgb, var(--og-error) 12%, transparent);
  }
  .notice.error .icon {
    color: var(--og-error);
  }
  .notice.info .icon {
    color: var(--og-info);
  }
  .bar {
    position: relative;
    height: 6px;
    border-radius: 3px;
    background: var(--og-tint-strong);
    overflow: hidden;
  }
  .bar > span {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: var(--og-primary);
    transition: width 300ms var(--og-ease);
  }
  .swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex: none;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th {
    text-align: left;
    font-size: 12px;
    font-weight: 500;
    color: var(--og-fg2);
    padding: 8px 12px;
    white-space: nowrap;
  }
  td {
    padding: 10px 12px;
    border-top: 1px solid var(--og-divider);
    font-size: 14px;
    vertical-align: middle;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .empty-state {
    display: grid;
    justify-items: center;
    gap: 12px;
    padding: 40px 24px;
    text-align: center;
    color: var(--og-fg2);
  }
  .empty-state .icon {
    color: var(--og-fg2);
    opacity: 0.6;
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      transition-duration: 0ms !important;
      animation-duration: 0ms !important;
      animation-iteration-count: 1 !important;
    }
  }
`;

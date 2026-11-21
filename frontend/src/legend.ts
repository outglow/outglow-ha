import { css, html, svg } from "lit";
import { strings, type Loc } from "./i18n";

const t = strings(
  {
    both: "both directions",
    one: "one direction",
    room: "motion in room",
    heat: "heat (illustration)",
    gate: "bulb listening",
    trail: "trail",
    offline: "offline",
    legend: "Legend",
  },
  {
    both: "obie strony",
    one: "jedna strona",
    room: "ruch w pokoju",
    heat: "ciepło (ilustracja)",
    gate: "żarówka słucha",
    trail: "ślad",
    offline: "offline",
    legend: "Legenda",
  },
);

export const legendStyles = css`
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 12px;
    line-height: 16px;
    color: var(--og-fg2);
  }
  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
  }
  .legend svg {
    flex: none;
    overflow: visible;
  }
`;

export interface LegendItems {
  lines?: boolean;
  heat?: boolean;
  trail?: boolean;
}

export function legend(loc: Loc, items: LegendItems = { lines: true, heat: true, trail: true }) {
  const motion = "var(--og-motion)";
  return html`<ul class="legend" aria-label=${t(loc, "legend")}>
    ${items.lines
      ? html`<li>
            <svg width="28" height="10" aria-hidden="true">
              ${svg`<line x1="2" y1="5" x2="26" y2="5" stroke=${motion} stroke-width="9" stroke-opacity="0.18" stroke-linecap="round"></line>
              <line x1="2" y1="5" x2="26" y2="5" stroke=${motion} stroke-width="3" stroke-linecap="round"></line>`}
            </svg>
            ${t(loc, "both")}
          </li>
          <li>
            <svg width="28" height="10" aria-hidden="true">
              ${svg`<line x1="2" y1="5" x2="26" y2="5" stroke=${motion} stroke-width="1.6" stroke-dasharray="5 6" stroke-linecap="round"></line>`}
            </svg>
            ${t(loc, "one")}
          </li>`
      : null}
    <li>
      <svg width="16" height="12" aria-hidden="true">
        ${svg`<rect x="0.5" y="0.5" width="15" height="11" rx="2" fill="#4e9af1" fill-opacity="0.42" stroke="#4e9af1"></rect>`}
      </svg>
      ${t(loc, "room")}
    </li>
    ${items.heat
      ? html`<li>
          <svg width="28" height="12" aria-hidden="true">
            ${svg`<defs><radialGradient id="lg-heat"><stop offset="0" stop-color=${motion} stop-opacity="0.85"></stop><stop offset="1" stop-color=${motion} stop-opacity="0"></stop></radialGradient></defs>
            <ellipse cx="14" cy="6" rx="14" ry="6" fill="url(#lg-heat)"></ellipse>`}
          </svg>
          ${t(loc, "heat")}
        </li>`
      : null}
    <li>
      <svg width="14" height="14" aria-hidden="true">
        ${svg`<circle cx="7" cy="7" r="6" fill=${motion} fill-opacity="0.25"></circle><circle cx="7" cy="7" r="4" fill=${motion}></circle>`}
      </svg>
      ${t(loc, "gate")}
    </li>
    ${items.trail
      ? html`<li>
          <svg width="28" height="10" aria-hidden="true">
            ${svg`<path d="M2 8 Q14 0 26 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="1 6" stroke-linecap="round"></path>`}
          </svg>
          ${t(loc, "trail")}
        </li>`
      : null}
  </ul>`;
}

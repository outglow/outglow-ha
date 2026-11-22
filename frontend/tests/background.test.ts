import { html, render } from "lit";
import { describe, expect, it } from "vitest";
import type { BackgroundGetResponse, BackgroundImage } from "../src/api/types";
import { backdrop, savedBackground } from "../src/background";
import type { Hass, HassMessage } from "../src/hass";

function hassAnswering(answers: BackgroundGetResponse[]): Hass & { asked: number } {
  const hass = {
    asked: 0,
    language: "en",
    connection: {
      sendMessagePromise<T>(_message: HassMessage): Promise<T> {
        const answer = answers[Math.min(hass.asked, answers.length - 1)]!;
        hass.asked += 1;
        return Promise.resolve(answer as T);
      },
      subscribeMessage: () => Promise.resolve(() => Promise.resolve()),
    },
  };
  return hass;
}

const PNG: BackgroundImage = { mime: "image/png", data_base64: "iVBORw0KGgo=" };
const SVG: BackgroundImage = { mime: "image/svg+xml", data_base64: "PHN2Zy8+" };

describe("the saved background", () => {
  it("is kept for the file it was read from, not for a file the server no longer has", async () => {
    const hass = hassAnswering([
      { image: PNG, file: "plan-0000000000000001.png" },
      { image: SVG, file: "plan-0000000000000002.svg" },
    ]);
    expect(await savedBackground(hass, "plan-0000000000000002.svg")).toBeNull();
    expect(await savedBackground(hass, "plan-0000000000000002.svg")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(await savedBackground(hass, "plan-0000000000000002.svg")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(hass.asked).toBe(2);
  });

  it("is asked for again when the server had none yet", async () => {
    const hass = hassAnswering([{ image: null, file: null }, { image: PNG, file: "plan-0000000000000003.png" }]);
    expect(await savedBackground(hass, "plan-0000000000000003.png")).toBeNull();
    expect(await savedBackground(hass, "plan-0000000000000003.png")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("is inverted in the dark theme only when it is a drawn map, not a photo", () => {
    const placed = { file: "f", x: 0, y: 0, m_per_px: 0.01, opacity: 0.35 };
    const classes = (url: string, dark: boolean): string => {
      const host = document.createElement("div");
      render(html`<svg>${backdrop(url, [10, 10], placed, dark)}</svg>`, host);
      return host.querySelector("image")!.getAttribute("class")!.trim();
    };
    expect(classes("data:image/svg+xml;base64,PHN2Zy8+", true)).toBe("backdrop dark");
    expect(classes("data:image/png;base64,iVBORw0KGgo=", true)).toBe("backdrop");
    expect(classes("data:image/jpeg;base64,/9j/", true)).toBe("backdrop");
    expect(classes("data:image/svg+xml;base64,PHN2Zy8+", false)).toBe("backdrop");
  });
});

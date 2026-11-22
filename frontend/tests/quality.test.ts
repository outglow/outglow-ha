import { describe, expect, it } from "vitest";
import qualityFixture from "../../tests/fixtures/ws/quality.json";
import type { BulbEffect, DirectionQuality, QualityReport, Recommendation } from "../src/api/types";
import { currentValue, defaultValue, effectText, settingKind, valueText } from "../src/components/bulb-write-dialog";
import {
  actionText,
  coverageDots,
  noiseAt,
  noiseColour,
  noiseLevel,
  overBudget,
  pairInformation,
  pairNoise,
  recommendationText,
  sortDirections,
} from "../src/quality";
import { trend } from "../src/views/settings-view";
import { MockBackend } from "../mock/hass";

const report = qualityFixture.response as unknown as QualityReport;
const names = {
  bulb: (ieee: string) => ({ "0x0000000000000001": "Ceiling", "0x0000000000000002": "Window", "0x0000000000000004": "Desk", "0x0000000000000003": "Hall" })[ieee] ?? ieee,
  room: (id: string) => ({ office: "Biuro", hall: "Korytarz" })[id] ?? id,
};

function rec(kind: Recommendation["kind"]): Recommendation {
  return report.recommendations.find((r) => r.kind === kind)!;
}

describe("noise colours", () => {
  it("runs from green through amber to red on a log scale", () => {
    expect(noiseLevel(0)).toBe(0);
    expect(noiseLevel(-3)).toBe(0);
    expect(noiseLevel(300)).toBeCloseTo(1);
    expect(noiseLevel(5000)).toBe(1);
    expect(noiseColour(0)).toBe("rgb(46, 160, 67)");
    expect(noiseColour(10000)).toBe("rgb(221, 51, 51)");
    expect(noiseColour(noiseAt(0.5))).toBe("rgb(232, 163, 23)");
    expect(noiseLevel(10)).toBeLessThan(noiseLevel(30));
  });

  it("inverts the scale", () => {
    expect(noiseLevel(noiseAt(0.3))).toBeCloseTo(0.3);
    expect(noiseAt(0)).toBe(0);
  });
});

describe("recommendation texts", () => {
  it("quotes the numbers in English", () => {
    expect(recommendationText("en", rec("skip_direction"), names)).toBe(
      "Ceiling ← Window fires 290 times an hour in an empty home, mostly one way (×4 against the reverse). Skip this direction.",
    );
    expect(recommendationText("en", rec("raise_sensitivity"), names)).toContain("Desk opens its gate only 2 % of the time");
    expect(recommendationText("en", rec("raise_sensitivity"), names)).toContain("to 50.");
    expect(recommendationText("en", rec("weak_coverage"), names)).toMatch(/^Biuro is covered by only 2 pairs\./);
    expect(recommendationText("en", rec("more_empty_house"), names)).toContain("Only 0.7 h");
    expect(recommendationText("en", rec("frozen_direction"), names)).toContain("Hall ← Desk is frozen at -89 dBm");
  });

  it("speaks Polish with decimal commas and plurals", () => {
    expect(recommendationText("pl", rec("more_empty_house"), names)).toContain("tylko 0,7 h");
    expect(recommendationText("pl", rec("weak_coverage"), names)).toMatch(/^Biuro: tylko 2 pary obejmują ten pokój\./);
    const five = { ...rec("weak_coverage"), numbers: { pairs: 5 } };
    expect(recommendationText("pl", five, names)).toMatch(/tylko 5 par obejmuje/);
    const one = { ...rec("weak_coverage"), numbers: { pairs: 1 } };
    expect(recommendationText("pl", one, names)).toMatch(/tylko 1 para obejmuje/);
    expect(recommendationText("pl", rec("skip_direction"), names)).toContain("290 razy na godzinę");
  });

  it("explains rooms without bulbs, more firmly in rules mode", () => {
    const base: Recommendation = { id: "no_bulbs:office", kind: "no_bulbs", severity: "warning", action: "none", room: "office", rx: null, tx: null, bulb: null, numbers: { crossing: 3, rules: 1 }, candidates: [] };
    expect(recommendationText("en", base, names)).toBe(
      "Biuro has no bulbs. Only lines crossing it can see motion there, now 3 lines. Rules mode never lights it; bayes mode uses the crossing lines.",
    );
    expect(recommendationText("pl", { ...base, numbers: { crossing: 1, rules: 0 } }, names)).toBe(
      "Biuro nie ma żarówek. Ruch widzą tam tylko linie przechodzące przez pokój, teraz 1 linia.",
    );
    expect(recommendationText("en", { ...base, numbers: { crossing: 0, rules: 0 } }, names)).toMatch(/no line crosses it/);
    expect(recommendationText("pl", base, names)).toBe(
      "Biuro nie ma żarówek. Ruch widzą tam tylko linie przechodzące przez pokój, teraz 3 linie. Tryb reguł nigdy nie zapala pokoju bez żarówek; tryb bayes korzysta z przechodzących linii.",
    );
    expect(recommendationText("pl", { ...base, numbers: { crossing: 0, rules: 0 } }, names)).toBe(
      "Biuro nie ma żarówek i przez ten pokój nie przechodzi żadna linia, więc ruch jest tam niewidoczny. Postaw w nim żarówkę albo między sąsiednimi pokojami.",
    );
  });

  it("explains why a room with one bulb next to a room with its own pair wants a second one", () => {
    const lone: Recommendation = { id: "one_bulb:office", kind: "one_bulb", severity: "info", action: "show_candidates", room: "office", rx: null, tx: null, bulb: null, numbers: { lines_m: 8.8 }, candidates: [] };
    expect(recommendationText("en", lone, names)).toBe(
      "Biuro has one bulb. In rules mode, while someone moves in a neighbouring room with bulbs of its own, Biuro lights only when all of at least 3 lines from its bulb into that room move. A second bulb or node at a marked spot gives it lines of its own.",
    );
    expect(recommendationText("pl", lone, names)).toBe(
      "Biuro ma jedną żarówkę. W trybie reguł, gdy ktoś rusza się w sąsiednim pokoju z własnymi żarówkami, Biuro zapala się tylko wtedy, gdy ruszają się wszystkie, co najmniej 3, linie z jego żarówki do tamtego pokoju. Druga żarówka albo węzeł w jednym z zaznaczonych miejsc da mu własne linie.",
    );
  });

  it("names the action or none", () => {
    expect(actionText("en", rec("skip_direction"))).toBe("Skip direction");
    expect(actionText("pl", rec("more_empty_house"))).toBe("Zacznij Naukę");
    expect(actionText("en", rec("frozen_direction"))).toBeNull();
  });
});

describe("directions", () => {
  const backend = new MockBackend(() => 1_800_000_000);
  const dirs: DirectionQuality[] = backend.quality.directions;

  it("sorts by noise, signal and asymmetry with unknowns last", () => {
    const noise = sortDirections(dirs, "noise").map((d) => d.exceed_per_h);
    expect(noise).toEqual([...noise].sort((a, b) => b - a));
    const signal = sortDirections(dirs, "signal").map((d) => d.signal_dbm ?? 0);
    expect(signal).toEqual([...signal].sort((a, b) => a - b));
    const asym = sortDirections(dirs, "asymmetry");
    expect(asym.at(-1)!.asymmetry).toBeNull();
    expect(asym[0]!.asymmetry).toBe(Math.max(...dirs.map((d) => d.asymmetry ?? 0)));
    expect(sortDirections(dirs, "noise")).not.toBe(dirs);
  });

  it("takes the noisier direction of a pair", () => {
    expect(pairNoise(report.directions, "0x0000000000000002", "0x0000000000000001")).toBe(290);
    expect(pairNoise(report.directions, "0x0000000000000001", "0x0000000000000009")).toBeNull();
  });

  it("normalises pair information to the best pair", () => {
    const info = pairInformation(report.pairs);
    expect(info.get("0x0000000000000003|0x0000000000000004")).toBe(1);
    expect(info.get("0x0000000000000001|0x0000000000000002")).toBeCloseTo(0.5 / 1.1);
    expect(pairInformation([]).size).toBe(0);
  });
});

describe("rooms", () => {
  it("draws coverage dots by class", () => {
    expect(coverageDots(2.6, "good")).toBe(5);
    expect(coverageDots(1.4, "good")).toBe(3);
    expect(coverageDots(0.5, "weak")).toBe(1);
    expect(coverageDots(3, "weak")).toBe(2);
    expect(coverageDots(0.1, "good")).toBe(3);
    expect(coverageDots(2, "none")).toBe(0);
  });

  it("flags false alarms above the budget only when known", () => {
    expect(overBudget(2.1, 1)).toBe(true);
    expect(overBudget(0.4, 1)).toBe(false);
    expect(overBudget(null, 1)).toBe(false);
    expect(overBudget(2, undefined)).toBe(false);
  });

  it("judges model changes", () => {
    expect(trend(0.71, 0.86, true)).toBe("better");
    expect(trend(0.6, 0.9, false)).toBe("worse");
    expect(trend(null, 0.61, true)).toBe("better");
    expect(trend(0.5, null, true)).toBe("unknown");
    expect(trend(0.5, 0.5, false)).toBe("same");
  });
});

describe("bulb write dialog logic", () => {
  const bulb = new MockBackend().bulbs.find((b) => b.ieee === "0x0000000000000004")!;

  it("knows what kind of value each setting takes", () => {
    expect(settingKind("sensitivity")).toBe("number");
    expect(settingKind("sensing")).toBe("bool");
    expect(settingKind("calibrate")).toBe("action");
    expect(currentValue(bulb, "sensitivity")).toBe(40);
    expect(defaultValue(bulb, "sensitivity")).toBe(40);
    expect(defaultValue(bulb, "sensing")).toBe(false);
    expect(defaultValue(bulb, "calibrate")).toBe(true);
    expect(valueText("pl", "auto_calibration", false)).toBe("Wyłączone");
    expect(valueText("en", "sensitivity", null)).toBe("unknown");
  });

  it("translates effects with their numbers", () => {
    const lines: BulbEffect = { code: "overwrites_all_lines", params: { lines: 3 } };
    expect(effectText("en", lines)).toBe("Overwrites the setting on all 3 lines of the bulb.");
    expect(effectText("en", { code: "overwrites_all_lines", params: { lines: 1 } })).toBe("Overwrites the setting on the bulb's only line.");
    expect(effectText("pl", lines)).toBe("Nadpisze ustawienie wszystkich 3 linii żarówki.");
    expect(effectText("pl", { code: "clears_calibration", params: {} })).toContain("kalibrację");
    expect(effectText("en", { code: "starts_calibration", params: {} })).toContain("60 s");
  });

  it("writes only with a fresh token for the same change", () => {
    const backend = new MockBackend(() => 1000);
    const preview = backend.dispatch({ type: "outglow/bulb/write_preview", ieee: bulb.ieee, setting: "sensitivity", value: 50 }) as {
      confirm_token: string;
      effects: BulbEffect[];
    };
    expect(preview.effects.map((e) => e.code)).toContain("clears_calibration");
    expect(() =>
      backend.dispatch({ type: "outglow/bulb/write", ieee: bulb.ieee, setting: "sensitivity", value: 60, confirm_token: preview.confirm_token }),
    ).toThrow(/another change/);
    backend.dispatch({ type: "outglow/bulb/write", ieee: bulb.ieee, setting: "sensitivity", value: 50, confirm_token: preview.confirm_token });
    expect(backend.bulbs.find((b) => b.ieee === bulb.ieee)!.sensitivity).toBe(50);
  });
});

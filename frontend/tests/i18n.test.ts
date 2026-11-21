import { describe, expect, it } from "vitest";
import { fmtAgo, fmtDuration, fmtNumber, fmtPercent } from "../src/format";
import { langOf, locOf, strings } from "../src/i18n";
import { errorText, tc } from "../src/strings/common";

const t = strings(
  { pairs: { one: "{n} pair", other: "{n} pairs" }, hello: "Hello {name}" },
  { pairs: { one: "{n} para", few: "{n} pary", many: "{n} par", other: "{n} pary" }, hello: "Cześć {name}" },
);

describe("translations", () => {
  it("follows the Home Assistant language", () => {
    expect(langOf({ language: "pl-PL" } as never)).toBe("pl");
    expect(langOf({ language: "de" } as never)).toBe("en");
    expect(langOf({ language: "en", locale: { language: "pl" } } as never)).toBe("pl");
    expect(langOf(undefined)).toBe("en");
  });

  it("uses Polish plural forms", () => {
    expect([1, 2, 5, 12, 22, 25].map((n) => t("pl", "pairs", { n }))).toEqual([
      "1 para",
      "2 pary",
      "5 par",
      "12 par",
      "22 pary",
      "25 par",
    ]);
    expect(t("en", "pairs", { n: 1 })).toBe("1 pair");
    expect(t("en", "pairs", { n: 3 })).toBe("3 pairs");
  });

  it("interpolates and formats numbers by locale", () => {
    expect(t("pl", "hello", { name: "Ala" })).toBe("Cześć Ala");
    expect(fmtNumber("pl", 0.4)).toBe("0,4");
    expect(fmtNumber("en", 0.4)).toBe("0.4");
    expect(fmtPercent("pl", 0.856)).toBe("86 %");
    expect(fmtNumber("en", null)).toBe("—");
    const loc = locOf({ language: "pl", locale: { language: "pl", number_format: "comma_decimal" } } as never);
    expect(fmtNumber(loc, 1.5)).toBe("1.5");
  });

  it("formats durations and ages", () => {
    expect(fmtDuration(41)).toBe("0:41");
    expect(fmtDuration(600)).toBe("10:00");
    expect(fmtDuration(3725)).toBe("1:02:05");
    expect(fmtAgo("en", 42)).toContain("42");
  });

  it("translates contract errors", () => {
    expect(errorText("pl", { code: "rev_conflict", message: "x" })).toBe(tc("pl", "error_rev_conflict"));
    expect(errorText("en", { code: "weird", message: "boom" })).toContain("boom");
  });
});

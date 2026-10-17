import { conditionMatches } from "@engenty-wizards/shared/definition";
import { formatBytes, formatMoney, readNumber } from "@engenty-wizards/shared/numbers";
import { describe, expect, it } from "vitest";
import { numberOf } from "../src/services/space-categories.js";

describe("readNumber", () => {
  it("reads a decimal comma and a decimal point alike", () => {
    expect(readNumber("89,90")).toBe(89.9);
    expect(readNumber("1,5")).toBe(1.5);
    expect(readNumber("1.5")).toBe(1.5);
    expect(readNumber("-0,25")).toBe(-0.25);
    expect(readNumber(",5")).toBe(0.5);
    expect(readNumber(" 42 ")).toBe(42);
  });

  it("knows no thousands separators: one mark is the decimal mark, whatever follows it", () => {
    expect(readNumber("1.23")).toBe(1.23);
    expect(readNumber("1.234")).toBe(1.234);
    expect(readNumber("1,234")).toBe(1.234);
    expect(readNumber("1.2345")).toBe(1.2345);
  });

  it("passes numbers through and refuses what is no number", () => {
    expect(readNumber(12.5)).toBe(12.5);
    expect(readNumber(Number.NaN)).toBeNull();
    expect(readNumber(Number.POSITIVE_INFINITY)).toBeNull();
    for (const v of [
      "",
      "  ",
      "abc",
      "12abc",
      "1.234,50",
      "1,234.50",
      "1.234.567",
      "1 234",
      "-",
      "1e3",
      "0x10",
      null,
      undefined,
      true,
    ]) {
      expect(readNumber(v)).toBeNull();
    }
  });

  it("drops units around the number only when asked", () => {
    expect(readNumber("38 h")).toBeNull();
    expect(readNumber("38 h", { units: true })).toBe(38);
    expect(readNumber("19 %", { units: true })).toBe(19);
    expect(readNumber("12,5 €", { units: true })).toBe(12.5);
    expect(readNumber("€", { units: true })).toBeNull();
  });
});

describe("one reading of numbers", () => {
  it("conditions and categories agree on a typed amount", () => {
    const gt = (value: unknown) =>
      conditionMatches({ field: "a", op: "gt", value: 1000 }, { a: value });
    expect(gt("1234,50")).toBe(true);
    expect(gt("999,99")).toBe(false);
    expect(gt("1.234,50")).toBe(false);
    expect(numberOf("1234,50")).toBe(1234.5);
    expect(numberOf("38 h")).toBe(38);
  });
});

describe("formatBytes", () => {
  it("counts in thousands, never below 1 KB for a file with content", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(1)).toBe("1 KB");
    expect(formatBytes(340_400)).toBe("340 KB");
    expect(formatBytes(999_499)).toBe("999 KB");
  });

  it("switches to MB and GB where KB would round over", () => {
    expect(formatBytes(999_500)).toBe("1.0 MB");
    expect(formatBytes(2_400_000)).toBe("2.4 MB");
    expect(formatBytes(999_949_999)).toBe("999.9 MB");
    expect(formatBytes(999_950_000)).toBe("1.0 GB");
    expect(formatBytes(1_234_000_000)).toBe("1.2 GB");
  });
});

describe("formatMoney", () => {
  it("writes an amount as the language does", () => {
    expect(formatMoney(1234.5, "EUR", "de").replace(/\s/g, " ")).toBe("1.234,50 €");
    expect(formatMoney(1234.5, "EUR", "en")).toBe("€1,234.50");
  });

  it("names a currency the browser does not know by its code", () => {
    expect(formatMoney(12, "euro", "de")).toBe("12.00 euro");
  });
});

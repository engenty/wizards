import { CONNECTION_LIMITS } from "@engenty/wizards-shared/connectors";
import { afterAll, describe, expect, it, vi } from "vitest";
import { lang, setLang } from "../../lib/i18n";
import { limitText, readLimit, usedToday } from "./connection-words";

// Switching the language marks the page and keeps a cookie: here there is neither.
vi.stubGlobal("window", { location: { hostname: "localhost", protocol: "http:" } });
vi.stubGlobal("document", { documentElement: { lang: "" }, cookie: "" });
const before = lang;
afterAll(() => {
  setLang(before);
  vi.unstubAllGlobals();
});

describe("a connection's limits in words", () => {
  it("shows a limit as its number and none as an empty field", () => {
    expect(limitText(null)).toBe("");
    expect(limitText(30)).toBe("30");
  });

  it("reads an empty field as no limit, a whole number from 1 as one, and nothing else", () => {
    expect(readLimit("")).toBeNull();
    expect(readLimit("  ")).toBeNull();
    expect(readLimit("30")).toBe(30);
    expect(readLimit(" 500 ")).toBe(500);
    expect(readLimit(String(CONNECTION_LIMITS.calls))).toBe(CONNECTION_LIMITS.calls);
    for (const wrong of ["0", "-1", "1.5", "1,5", "zehn", String(CONNECTION_LIMITS.calls + 1)]) {
      expect(readLimit(wrong), wrong).toBeUndefined();
    }
  });

  it("counts today's calls against the limit per day where there is one", () => {
    setLang("de");
    expect(usedToday({ callsToday: 38, callsPerDay: 500 })).toBe("heute 38 von 500 Aufrufen");
    expect(usedToday({ callsToday: 1200, callsPerDay: 5000 })).toBe(
      "heute 1.200 von 5.000 Aufrufen",
    );
    expect(usedToday({ callsToday: 0, callsPerDay: null })).toBe("heute 0 Aufrufe");
    expect(usedToday({ callsToday: 1, callsPerDay: null })).toBe("heute 1 Aufruf");
    expect(usedToday({ callsToday: 38, callsPerDay: null })).toBe("heute 38 Aufrufe");
    setLang("en");
    expect(usedToday({ callsToday: 38, callsPerDay: 500 })).toBe("38 of 500 calls today");
    expect(usedToday({ callsToday: 1, callsPerDay: null })).toBe("1 call today");
    expect(usedToday({ callsToday: 2, callsPerDay: null })).toBe("2 calls today");
  });
});

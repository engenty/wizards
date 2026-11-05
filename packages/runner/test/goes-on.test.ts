import { describe, expect, it } from "vitest";
import { setRunnerLang } from "../src/i18n.js";
import { goesOnText } from "../src/RunnerView.js";

describe("what a sleeping run says", () => {
  const at = "2026-11-10T08:00:00.000Z";

  it("a wait says when it goes on, a retry that it tries again", () => {
    setRunnerLang("en");
    expect(goesOnText(at)).toMatch(/^Goes on /);
    expect(goesOnText(at, { kind: "retry" })).toMatch(/It tries again /);
  });

  it("waiting for a person names no time: the next look says nothing about them", () => {
    setRunnerLang("en");
    expect(goesOnText(at, { kind: "credits" })).toMatch(/Out of credits/);
    expect(goesOnText(at, { kind: "credits" })).not.toMatch(/2026|November/);
    expect(goesOnText(at, { kind: "sign_in", service: "Gmail" })).toMatch(/^Gmail needs a new sign-in/);
  });

  it("in German too", () => {
    setRunnerLang("de");
    expect(goesOnText(at, { kind: "credits" })).toMatch(/Guthaben/);
    expect(goesOnText(at, { kind: "retry" })).toMatch(/Neuer Versuch/);
    setRunnerLang("en");
  });
});

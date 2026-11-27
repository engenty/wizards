import type { StepWarning } from "@engenty/wizards-shared/connectors";
import { afterAll, describe, expect, it, vi } from "vitest";
import { lang, setLang } from "../../lib/i18n";
import { warningAdvice, warningLink, warningOfStep, warningText } from "./step-warnings";

// Switching the language marks the page and keeps a cookie: here there is neither.
vi.stubGlobal("window", { location: { hostname: "localhost", protocol: "http:" } });
vi.stubGlobal("document", { documentElement: { lang: "" }, cookie: "" });
const before = lang;
afterAll(() => {
  setLang(before);
  vi.unstubAllGlobals();
});

const warning = (kind: "write" | "send", name = "Team-Slack"): StepWarning => ({
  stepId: "notify",
  kind: "rule_never",
  connection: { id: "c/1 2", name },
  action: { id: kind === "send" ? "post_message" : "update_message", kind },
});

describe("the editor's warning for a fixed step", () => {
  it("names the connection and the rule, as the connection's page names them", () => {
    setLang("de");
    expect(warningText(warning("send"))).toBe(
      "Bei der Verbindung „Team-Slack“ steht „Senden“ auf „Nie“. Darum schlägt dieser Schritt in einem Lauf fehl.",
    );
    expect(warningText(warning("write", "Bestellungen"))).toContain(
      "Bei der Verbindung „Bestellungen“ steht „Ändern“ auf „Nie“.",
    );
    setLang("en");
    expect(warningText(warning("send"))).toBe(
      "The connection “Team-Slack” has “Send” on “Never”. That is why this step fails in a run.",
    );
    expect(warningText(warning("write"))).toContain("has “Change” on “Never”");
  });

  it("tells an admin to change the rule, and a member to ask the admins", () => {
    setLang("de");
    expect(warningAdvice(true)).toBe("Stell die Regel auf „Erlaubt“, dann läuft er.");
    expect(warningAdvice(false)).toBe(
      "Die Regel ändern die Admins des Space. Frag sie, ob „Erlaubt“ hier passt.",
    );
    setLang("en");
    expect(warningAdvice(true)).toBe("Set the rule to “Allowed” and it runs.");
    expect(warningAdvice(false)).toMatch(/admins change the rule/);
  });

  it("leads to the connection's page", () => {
    expect(warningLink(warning("send"))).toBe("/capabilities/connectors?show=c%2F1%202");
  });

  it("starts with the step's title where several steps are listed", () => {
    setLang("de");
    const steps = [{ id: "notify", title: "Team benachrichtigen" }];
    expect(warningOfStep(warning("send"), steps)).toMatch(
      /^„Team benachrichtigen“: Bei der Verbindung „Team-Slack“ steht „Senden“/,
    );
    // A step that is gone from the draft still reads: by its id.
    expect(warningOfStep(warning("send"), [])).toMatch(/^„notify“: /);
  });
});

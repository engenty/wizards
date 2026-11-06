import {
  BROKER_REFUSALS,
  CONNECTION_ACTION_KINDS,
  CONNECTION_OUTCOMES,
  CRITICAL_KINDS,
} from "@engenty/wizards-shared/connectors";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type Key, lang, setLang, t } from "../../lib/i18n";
import {
  actionWord,
  answerCondition,
  answerSentence,
  CRITICAL_WORDS,
  KIND_WORDS,
  outcomeOf,
  REFUSAL_WORDS,
  RULE_WORDS,
  refusalWord,
  ruleWord,
  runStateWord,
  runUnderWay,
  VERB_WORDS,
  whoWord,
} from "./protocol-words";

/** A key with no line comes back as itself: such a value would show raw on the page. */
function said(key: Key): boolean {
  const text = t(key);
  return text.length > 0 && text !== key;
}

// Switching the language marks the page and keeps a cookie: here there is neither.
vi.stubGlobal("window", { location: { hostname: "localhost", protocol: "http:" } });
vi.stubGlobal("document", { documentElement: { lang: "" }, cookie: "" });
const before = lang;
afterAll(() => {
  setLang(before);
  vi.unstubAllGlobals();
});

describe.each(["de", "en"] as const)("the Protokoll's words in %s", (language) => {
  it("has words for every refusal the broker has", () => {
    setLang(language);
    for (const refused of BROKER_REFUSALS) {
      expect(REFUSAL_WORDS[refused], refused).toBeDefined();
      expect(said(REFUSAL_WORDS[refused]), refused).toBe(true);
      expect(refusalWord(refused, null)).not.toBe(refused);
    }
  });

  it("has words for every critical kind and every kind of action", () => {
    setLang(language);
    for (const kind of CRITICAL_KINDS) {
      expect(said(CRITICAL_WORDS[kind]), kind).toBe(true);
    }
    for (const kind of CONNECTION_ACTION_KINDS) {
      expect(said(KIND_WORDS[kind]), kind).toBe(true);
      expect(said(VERB_WORDS[kind]), kind).toBe(true);
    }
  });

  it("names every rule `decide` and the host and mail paths give", () => {
    setLang(language);
    const rules = [
      ...Object.keys(RULE_WORDS),
      ...CONNECTION_ACTION_KINDS.map((k) => `rules.${k}`),
      "policy.create_contact",
      "run.cancelled",
      "run.done",
      "run.failed",
      null,
    ];
    for (const rule of rules) {
      const words = ruleWord(rule);
      expect(words, String(rule)).not.toBe(rule);
      expect(words).not.toMatch(/^protocol\./);
    }
  });

  it("says every outcome of a line in words", () => {
    setLang(language);
    const results = ["ok", ...BROKER_REFUSALS, "sign_in_failed", "TypeError"];
    for (const outcome of CONNECTION_OUTCOMES) {
      for (const result of results) {
        const { text } = outcomeOf({ outcome, result, rule: "audience" });
        expect(text, `${outcome} ${result}`).not.toMatch(/protocol\.|\{\w+\}/);
      }
    }
    expect(outcomeOf({ outcome: "ask", result: "needs_approval", rule: "rules.write" }).tone).toBe(
      "held",
    );
    expect(outcomeOf({ outcome: "deny", result: "denied", rule: "audience" }).tone).toBe("refused");
    expect(outcomeOf({ outcome: "allow", result: "ok", rule: "rules.read" }).tone).toBe("done");
  });

  it("answers „Was darf …?“ in one sentence with no gap left open", () => {
    setLang(language);
    const names = { who: "Julia", connection: "Gmail · Bestellungen", audience: "members" };
    for (const outcome of CONNECTION_OUTCOMES) {
      for (const kind of CONNECTION_ACTION_KINDS) {
        const sentence = answerSentence(
          {
            outcome,
            rule: outcome === "deny" ? "audience" : `rules.${kind}`,
            action: { id: "x", kind, known: true },
            admins: outcome === "ask" ? true : undefined,
          },
          names,
        );
        expect(sentence).toContain("Julia");
        expect(sentence).toContain("Gmail · Bestellungen");
        expect(sentence).not.toMatch(/protocol\.|\{\w+\}/);
      }
    }
  });

  it("says under what a guest's post holds, and nothing where no condition is", () => {
    setLang(language);
    expect(answerCondition({})).toBeNull();
    const condition = answerCondition({ fixedChannel: true });
    expect(condition).toMatch(/Kanal|channel/);
    expect(condition).not.toMatch(/protocol\./);
  });
});

describe("plain words", () => {
  it("in German: who, and why a guest may not", () => {
    setLang("de");
    expect(whoWord({ kind: "guest", id: "v1", name: null })).toBe("Ein Gast");
    expect(whoWord({ kind: "admin", id: "u1", name: "Anna" })).toBe("Anna (Admin)");
    expect(
      whoWord({ kind: "step", id: "s", name: null, for: { kind: "guest", id: null, name: null } }),
    ).toBe("Ein fester Schritt für einen Gast");
    expect(
      answerSentence(
        { outcome: "deny", rule: "audience", action: { id: "x", kind: "send", known: true } },
        { who: "Ein Gast", connection: "Gmail", audience: "members" },
      ),
    ).toBe("Ein Gast darf in Gmail nicht senden – die Verbindung ist nur für Mitglieder.");
    expect(
      answerSentence(
        {
          outcome: "ask",
          rule: "rules.send",
          admins: true,
          action: { id: "x", kind: "send", known: true },
        },
        { who: "Julia", connection: "Gmail" },
      ),
    ).toBe("Julia darf in Gmail senden – mit Freigabe durch die Admins.");
  });

  it("in German: a run that was stopped, a connection that pauses", () => {
    setLang("de");
    const refused = (result: string, rule: string) => outcomeOf({ outcome: "deny", result, rule });
    expect(refused("run_ended", "run.cancelled")).toEqual({
      tone: "refused",
      text: "abgelehnt: der Lauf wurde gestoppt",
    });
    expect(refused("run_ended", "run.done").text).toBe("abgelehnt: der Lauf ist fertig");
    expect(refused("run_ended", "run.failed").text).toBe("abgelehnt: der Lauf ist fehlgeschlagen");
    expect(refused("paused", "paused").text).toBe("abgelehnt: die Verbindung ist pausiert");
    expect(ruleWord("run.cancelled")).toBe("Ein beendeter Lauf ruft nichts mehr auf");
    expect(
      answerSentence(
        {
          outcome: "deny",
          rule: "paused",
          refused: "paused",
          action: { id: "x", kind: "read", known: true },
        },
        { who: "Julia", connection: "Gmail", audience: "members" },
      ),
    ).toBe("Julia darf in Gmail nicht lesen – die Verbindung ist pausiert.");
    // The detail of a line: the run's state, and whether an admin can still stop it.
    expect(runStateWord("cancelled")).toBe("gestoppt");
    expect(runStateWord("running")).toBe("läuft");
    expect(["running", "waiting_input", "sleeping"].every(runUnderWay)).toBe(true);
    expect(["done", "failed", "cancelled"].some(runUnderWay)).toBe(false);
  });

  it("in German: pausing and resuming read as what they are, other changes as changed rules", () => {
    setLang("de");
    const change = (input: { fields: Record<string, number>; sample: string }) =>
      actionWord({ actionId: "change_rules", actionName: null, input });
    expect(change({ fields: { paused: 3 }, sample: "paused: yes" })).toBe("Verbindung pausiert");
    expect(change({ fields: { paused: 2 }, sample: "paused: no" })).toBe("Verbindung fortgesetzt");
    expect(change({ fields: { audience: 13 }, sample: "audience: all → members" })).toBe(
      "Regeln geändert",
    );
  });

  it("in German: a connection's limit has its own words, apart from a guest's mails", () => {
    setLang("de");
    const refused = (result: string, rule: string) => outcomeOf({ outcome: "deny", result, rule });
    expect(refused("calls_per_run", "limits.run")).toEqual({
      tone: "refused",
      text: "abgelehnt: der Lauf hat die Aufrufe gemacht, die die Verbindung je Lauf annimmt",
    });
    expect(refused("calls_per_day", "limits.day").text).toBe(
      "abgelehnt: die Verbindung hat ihre Aufrufe für heute angenommen",
    );
    // A guest's mails read as they did: the two limits never share a sentence.
    expect(refused("run_limit", "guest_send").text).toMatch(/E-Mails und Nachrichten/);
    expect(refused("calls_per_run", "limits.run").text).not.toMatch(/E-Mail|Nachricht/);
    expect(ruleWord("limits.run")).toBe("Die Grenzen der Verbindung für Aufrufe");
    expect(ruleWord("limits.day")).toBe(ruleWord("limits.run"));
    // A call that took its place and has not ended yet is no failure.
    expect(outcomeOf({ outcome: "allow", result: null, rule: "rules.read" })).toEqual({
      tone: "held",
      text: "läuft noch",
    });
    // A changed limit says so; with a rule changed beside it, the line is a changed rule.
    const change = (fields: Record<string, number>, sample: string) =>
      actionWord({ actionId: "change_rules", actionName: null, input: { fields, sample } });
    expect(change({ limits: 24 }, "limits: calls per run: none → 20")).toBe("Grenzen geändert");
    expect(change({ rules: 18, limits: 24 }, "rules: write: ask → allow")).toBe("Regeln geändert");
  });
});

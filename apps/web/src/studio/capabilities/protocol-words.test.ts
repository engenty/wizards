import {
  BROKER_REFUSALS,
  CONNECTION_ACTION_KINDS,
  CONNECTION_OUTCOMES,
  CRITICAL_KINDS,
} from "@engenty/wizards-shared/connectors";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type Key, lang, setLang, t } from "../../lib/i18n";
import {
  answerSentence,
  CRITICAL_WORDS,
  KIND_WORDS,
  outcomeOf,
  REFUSAL_WORDS,
  RULE_WORDS,
  refusalWord,
  ruleWord,
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
});

import {
  RWX_ASK_KINDS,
  RWX_ASKED,
  RWX_ORIGINS,
  RWX_PERMS,
  RWX_RESOURCE_KINDS,
  type RwxPerm,
  type RwxResourceKind,
  type RwxSubjectKind,
} from "@engenty/wizards-shared/rwx";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type Key, lang, setLang, t } from "../../lib/i18n";
import {
  ALL_WORDS,
  GONE_WORDS,
  hasEffect,
  KIND_WORDS,
  NAMED_WORDS,
  ORIGIN_WORDS,
  originLink,
  PERM_WORDS,
  PLAIN_WORDS,
  RIGHTS,
  type RuleWords,
  ruleSentence,
  rulesSentence,
  saysOf,
  VERB_WORDS,
  whatOf,
} from "./rights-words";

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

/** A rule with nothing set, to lay a test's fields over. */
const rule = (over: Partial<RuleWords>): RuleWords => ({
  subjectKind: "guest",
  subjectId: null,
  resourceKind: "page",
  resourceId: "p1",
  r: null,
  w: null,
  x: null,
  subjectName: null,
  resourceName: "Preise intern",
  folder: true,
  ...over,
});

describe.each(["de", "en"] as const)("the rights' words in %s", (language) => {
  it("has words for every kind, permission, verb and origin", () => {
    setLang(language);
    for (const kind of RWX_RESOURCE_KINDS) {
      // A kind is named, or is one of a kind: the setup, and what no rule is asked about.
      expect(Boolean(PLAIN_WORDS[kind]) !== Boolean(NAMED_WORDS[kind]), kind).toBe(true);
      for (const words of PLAIN_WORDS[kind]
        ? [PLAIN_WORDS]
        : [ALL_WORDS, NAMED_WORDS, GONE_WORDS]) {
        expect(said(words[kind] as Key), kind).toBe(true);
      }
    }
    for (const kind of RWX_ASK_KINDS) {
      expect(said(KIND_WORDS[kind] as Key), kind).toBe(true);
    }
    for (const perm of RWX_PERMS) {
      expect(said(PERM_WORDS[perm]), perm).toBe(true);
    }
    for (const key of Object.values(VERB_WORDS)) {
      expect(said(key), key).toBe(true);
    }
    for (const origin of RWX_ORIGINS) {
      expect(said(ORIGIN_WORDS[origin]), origin).toBe(true);
    }
    for (const row of RIGHTS) {
      expect(said(row.label), row.label).toBe(true);
      expect(!row.client || said(row.client), row.label).toBe(true);
    }
  });

  it("says every rule the runtime takes as who may, or may not, do what", () => {
    setLang(language);
    const nothing = ruleSentence(rule({}));
    for (const kind of RWX_RESOURCE_KINDS) {
      for (const perm of RWX_PERMS) {
        for (const subjectKind of RWX_ASKED[kind][perm] ?? []) {
          const asked = rule({
            subjectKind,
            subjectId: subjectKind === "guest" || subjectKind === "agent" ? null : "member",
            subjectName: "Julia",
            resourceKind: kind,
            resourceName: "Name",
            [perm]: "deny",
          });
          const text = ruleSentence(asked);
          expect(hasEffect(asked), `${subjectKind} ${kind} ${perm}`).toBe(true);
          expect(text, `${subjectKind} ${kind} ${perm}`).not.toBe(nothing);
          expect(text).not.toMatch(/\{\w+\}/);
          expect(text).toContain(whatOf(asked));
        }
      }
    }
  });
});

describe("a rule as a sentence", () => {
  it("in German: who, darf or dürfen, what, the verb last", () => {
    setLang("de");
    expect(ruleSentence(rule({ r: "deny" }))).toBe(
      "Gäste dürfen den Ordner „Preise intern“ nicht lesen.",
    );
    // What the folder's dialog writes for the team: read and Goose's write, both denied.
    expect(
      ruleSentence(rule({ subjectKind: "role", subjectId: "member", r: "deny", w: "deny" })),
    ).toBe(
      "Mitglieder dürfen den Ordner „Preise intern“ nicht lesen und nicht von Goose ändern lassen.",
    );
    expect(
      ruleSentence(
        rule({
          subjectKind: "person",
          subjectId: "u1",
          subjectName: "Julia Berger",
          resourceKind: "document",
          resourceName: "vertrag.pdf",
          folder: false,
          r: "deny",
        }),
      ),
    ).toBe("Julia Berger darf das Dokument „vertrag.pdf“ nicht lesen.");
    expect(
      ruleSentence(
        rule({
          subjectKind: "role",
          subjectId: "client",
          resourceKind: "wizard",
          resourceName: "Angebot",
          r: "allow",
          x: "allow",
        }),
      ),
    ).toBe("Kund:innen dürfen den Wizard „Angebot“ sehen und starten.");
    expect(
      ruleSentence(
        rule({
          subjectKind: "role",
          subjectId: "member",
          resourceKind: "wizard",
          resourceId: "*",
          resourceName: null,
          r: "allow",
          x: "allow",
        }),
      ),
    ).toBe("Mitglieder dürfen alle Wizards von der KI finden und starten lassen.");
    expect(
      ruleSentence(
        rule({
          subjectKind: "agent",
          resourceKind: "mount",
          resourceName: "Kunden",
          r: "allow",
          w: "allow",
        }),
      ),
    ).toBe("Die KI in Work darf den Ordner „Kunden“ in Dateien lesen und ändern.");
    expect(
      ruleSentence(
        rule({
          subjectKind: "goose",
          subjectId: "u1",
          subjectName: "Julia Berger",
          resourceKind: "setup",
          resourceId: "*",
          resourceName: null,
          w: "deny",
        }),
      ),
    ).toBe("Goose für Julia Berger darf die Einrichtung des Space nicht ändern.");
    expect(
      ruleSentence(
        rule({
          subjectKind: "wizard",
          subjectId: "*",
          resourceKind: "table",
          resourceName: "Lieferanten",
          r: "deny",
        }),
      ),
    ).toBe("Jeder Wizard darf die Tabelle „Lieferanten“ nicht lesen.");
    expect(
      ruleSentence(
        rule({ resourceKind: "skill", resourceName: "angebot-pdf", r: "allow", x: "deny" }),
      ),
    ).toBe("Gäste dürfen den Skill „angebot-pdf“ nutzen, aber nicht mit Skripten ausführen.");
  });

  it("in English: who, may or may not, the verb, what", () => {
    setLang("en");
    expect(ruleSentence(rule({ r: "deny" }))).toBe(
      "Guests may not read the folder “Preise intern”.",
    );
    expect(
      ruleSentence(rule({ subjectKind: "role", subjectId: "member", r: "deny", w: "deny" })),
    ).toBe("Members may not read or have Goose change the folder “Preise intern”.");
    expect(
      ruleSentence(rule({ subjectKind: "role", subjectId: "member", folder: false, w: "deny" })),
    ).toBe("Members may not have Goose change the page “Preise intern”.");
    expect(
      ruleSentence(
        rule({ resourceKind: "skill", resourceName: "angebot-pdf", r: "allow", x: "deny" }),
      ),
    ).toBe("Guests may use the skill “angebot-pdf”, but may not run the scripts of it.");
    expect(
      ruleSentence(
        rule({
          subjectKind: "person",
          subjectId: "u1",
          subjectName: "Julia Berger",
          resourceKind: "wizard",
          resourceName: "Offer",
          x: "deny",
        }),
      ),
    ).toBe("Julia Berger may not let the AI start the wizard “Offer”.");
  });

  it("says rules that say the same about one thing as one sentence", () => {
    const mount = { resourceKind: "mount" as const, resourceId: "m1", resourceName: "Kunden" };
    const reads = [
      rule({ ...mount, subjectKind: "role", subjectId: "admin", r: "allow" }),
      rule({ ...mount, subjectKind: "role", subjectId: "member", r: "allow" }),
      rule({ ...mount, subjectKind: "wizard", subjectId: "*", r: "allow" }),
      rule({ ...mount, subjectKind: "agent", r: "allow" }),
    ];
    expect(new Set(reads.map(saysOf)).size).toBe(1);
    // Another flag, another resource: a sentence of its own.
    expect(
      saysOf(rule({ ...mount, subjectKind: "role", subjectId: "admin", r: "allow", w: "allow" })),
    ).not.toBe(saysOf(reads[0]));
    expect(saysOf(rule({ ...mount, resourceId: "m2", subjectKind: "agent", r: "allow" }))).not.toBe(
      saysOf(reads[0]),
    );
    setLang("de");
    expect(rulesSentence(reads)).toBe(
      "Admins, Mitglieder, jeder Wizard und die KI in Work dürfen den Ordner „Kunden“ in Dateien lesen.",
    );
    expect(rulesSentence([reads[3]])).toBe(
      "Die KI in Work darf den Ordner „Kunden“ in Dateien lesen.",
    );
    setLang("en");
    expect(rulesSentence(reads)).toBe(
      "Admins, members, every wizard and the AI in Work may read the folder “Kunden” in Files.",
    );
    // A name keeps its capital, wherever it stands.
    expect(
      rulesSentence([
        reads[3],
        rule({
          ...mount,
          subjectKind: "person",
          subjectId: "u1",
          subjectName: "Julia Berger",
          r: "allow",
        }),
        rule({
          ...mount,
          subjectKind: "goose",
          subjectId: "u1",
          subjectName: "Julia Berger",
          r: "allow",
        }),
      ]),
    ).toBe(
      "The AI in Work, Julia Berger and Goose for Julia Berger may read the folder “Kunden” in Files.",
    );
  });

  it("names what is gone as gone, and never an id", () => {
    setLang("de");
    const gone = ruleSentence(
      rule({
        subjectKind: "person",
        subjectId: "user-8f3a",
        resourceKind: "document",
        resourceId: "file-77c1",
        resourceName: null,
        r: "deny",
      }),
    );
    expect(gone).toBe("Eine entfernte Person darf ein gelöschtes Dokument nicht lesen.");
    expect(gone).not.toMatch(/user-8f3a|file-77c1/);
    expect(
      ruleSentence(
        rule({ subjectKind: "wizard", subjectId: "w-1", resourceName: null, r: "deny" }),
      ),
    ).toBe("Ein gelöschter Wizard darf eine gelöschte Seite nicht lesen.");
  });

  it("says a rule nothing asks as that: a flag no reader asks, a kind with none", () => {
    setLang("de");
    const stored = rule({
      subjectKind: "role",
      subjectId: "member",
      resourceKind: "connection",
      resourceId: "c1",
      resourceName: null,
      r: "allow",
    });
    expect(hasEffect(stored)).toBe(false);
    expect(ruleSentence(stored)).toBe(
      "Nach dieser Regel fragt nichts: Mitglieder, eine Verbindung.",
    );
    // The start set's `w` on documents is asked by no reader: the sentence leaves it out.
    expect(
      ruleSentence(
        rule({
          subjectKind: "role",
          subjectId: "member",
          resourceKind: "document",
          resourceId: "*",
          resourceName: null,
          r: "allow",
          w: "allow",
        }),
      ),
    ).toBe("Mitglieder dürfen alle Dokumente lesen.");
  });
});

describe("the rights a group has", () => {
  it("are a row for every permission a role is asked about on the enforced kinds", () => {
    const rows = RIGHTS.map((r) => `${r.kind}:${r.perm}`).sort();
    const asked = RWX_ASK_KINDS.flatMap((kind: RwxResourceKind) =>
      RWX_PERMS.filter((perm: RwxPerm) =>
        (RWX_ASKED[kind][perm] ?? []).includes("role" as RwxSubjectKind),
      ).map((perm) => `${kind}:${perm}`),
    ).sort();
    expect(rows).toEqual(asked);
  });
});

describe("where „Dort ändern“ leads", () => {
  it("to the page's dialog in Wissen, the mount in Dateien, the clients' switch; nowhere for Rechte's own", () => {
    const of = (origin: (typeof RWX_ORIGINS)[number], resourceKind: RwxResourceKind) =>
      originLink({ origin, resourceKind, resourceId: "x1" });
    expect(of("folder", "page")).toBe("/space/knowledge?show=p:x1&audience=1");
    expect(of("mount", "mount")).toBe("/space/files?show=m:x1");
    expect(of("clients", "document")).toBe("/space/knowledge?show=f:x1");
    expect(of("clients", "table")).toBe("/space/knowledge?show=t:x1");
    expect(of("clients", "wizard")).toBe("/space/clients");
    expect(of("rights", "page")).toBeNull();
    expect(of("start", "page")).toBeNull();
  });
});

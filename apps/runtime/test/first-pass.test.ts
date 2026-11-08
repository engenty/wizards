import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIZARD_TEXT_EXAMPLES, wizardTextTags } from "@engenty/wizards-shared/catalog-prompt";
import { parseWizard } from "@engenty/wizards-shared/definition";
import { parseWizardText } from "@engenty/wizards-shared/wizard-text";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-first-pass-"));
process.env.DATA_DIR = dir;
// The suite runs with durableRuns on and off from outside; this file turns fastCreate on itself.
const outside = process.env.FEATURES ?? "";
const features = (fast: "on" | "off") =>
  [outside, `fastCreate=${fast}`].filter(Boolean).join(",");
process.env.FEATURES = features("on");

/** The text the stubbed model writes on its first pass, in pieces. */
let script = "";
/** What each call got as its system prompt, to tell the first pass from the architect. */
const systems: string[] = [];
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const pieces = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
const model = new MockLanguageModelV3({
  doStream: async (options: any) => {
    const system = options.prompt
      .filter((m: any) => m.role === "system")
      .map((m: any) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    systems.push(system);
    const first = system.includes("THE TEXT FORM");
    const text = first ? script : "Ich habe den Entwurf fertig gemacht.";
    return {
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        ...pieces(text, 37).map((delta) => ({ type: "text-delta", id: "t", delta })),
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ] as never[]),
    };
  },
});
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  chatModel: async () => ({
    model,
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: false,
  }),
}));
vi.mock("../src/agents/subscription.js", async (original) => ({
  ...(await original<typeof import("../src/agents/subscription.js")>()),
  chatTurnWay: async () => "anthropic",
}));

let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");
let firstPassMod: typeof import("../src/services/first-pass");
let architect: typeof import("../src/services/architect");
let events: typeof import("../src/services/draft-events");

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  wizards = await import("../src/services/wizards");
  firstPassMod = await import("../src/services/first-pass");
  architect = await import("../src/services/architect");
  events = await import("../src/services/draft-events");
}, 60_000);

const inTenant = <T>(fn: () => Promise<T>) => client.withTenant("tenant-a", fn);

/** A wizard as the wish box makes it: blank, no template, nothing said yet. */
const blank = () => inTenant(async () => (await wizards.createWizard("user-a", { lang: "de" })).id);

const io = () => {
  const said = { text: "", activity: [] as string[], preparing: [] as string[][] };
  return {
    said,
    io: {
      signal: new AbortController().signal,
      onText: (d: string) => {
        said.text += d;
      },
      onActivity: (l: string) => {
        said.activity.push(l);
      },
      onThought: () => {},
      onBuilding: () => {},
      onPreparing: (ids: string[]) => {
        said.preparing.push(ids);
      },
    },
  };
};

// A draft with what the code fixes: a field without an id, a field id used twice, a look that does
// not fit, a rule to a step that does not exist, and no result step.
const flawed = `<Wizard title="Umzug melden" lang="de">
<Page id="who" title="Wer zieht um?">
  <Field kind="text" label="Dein Name" required />
  <Field id="date" kind="date" label="Wann?" look="slider" />
</Page>
<Page id="where" title="Wohin?">
## Die neue Adresse
  <Field id="date" kind="text" label="Neue Adresse" required />
  <Next when={date == "x"} goto="nowhere" />
</Page>
<Agent id="letter" title="Brief schreiben">
Schreib die Ummeldung für {{dein_name}}.
</Agent>
</Wizard>`;

describe("fixDraft", () => {
  it("fixes ids, a missing result, rules to nowhere and looks that do not fit", () => {
    const { definition, cuts } = parseWizardText(flawed);
    expect(cuts).toEqual([]);
    const { definition: fixed, fixes } = firstPassMod.fixDraft(definition as never, "de", true);
    expect(fixes).toEqual([
      'A field in step "who" had no id; now "dein_name".',
      'look "slider" did not fit field "date"; left out.',
      'Field "date" in step "where" is now "date_2" (used twice).',
      'The wizard had no result step; added "done".',
      'A rule of step "where" went to "nowhere", which is no step; left out.',
    ]);
    const where = fixed.steps[1];
    expect(where.fields[0].id).toBe("date_2");
    // The Field component that places it follows.
    expect(where.components.find((c: any) => c.component === "Field").name).toBe("date_2");
    expect(where.next).toBeUndefined();
    expect(fixed.steps.at(-1)).toEqual({
      id: "done",
      type: "result",
      title: "Fertig",
      deliverables: [],
    });
    const checked = parseWizard(fixed);
    expect(checked.ok && checked.issues).toEqual([]);
  });

  it("makes ids from words", () => {
    expect(firstPassMod.idFrom("Wie groß ist dein Büro?", "x")).toBe("wie_gross_ist_dein_buro");
    expect(firstPassMod.idFrom("42 Äpfel", "x")).toBe("apfel");
    expect(firstPassMod.idFrom("…", "field3")).toBe("field3");
  });
});

describe("the catalog prompt", () => {
  it("has its worked examples parse without cuts and pass the validator", () => {
    for (const example of WIZARD_TEXT_EXAMPLES) {
      const { definition, cuts } = parseWizardText(example);
      expect(cuts).toEqual([]);
      const checked = parseWizard(definition);
      expect(checked.ok && checked.issues).toEqual([]);
    }
  });

  it("names <Wait> and durable runs' keys only with durableRuns", () => {
    const on = wizardTextTags({ durableRuns: true });
    const off = wizardTextTags({ durableRuns: false });
    expect(on).toContain("<Wait ");
    expect(on).toContain("onFail?=");
    expect(off).not.toContain("<Wait ");
    for (const key of ["onFail", "who", "timeout", "remind", "approve", "durable", "signal"]) {
      expect(off).not.toMatch(new RegExp(`\\b${key}\\?=|\\b${key}\\?\\s`));
    }
    // About 3k tokens with the rules and the examples: well under the architect's 15k.
    const system = firstPassMod.firstPassSystem(true);
    expect(system.length).toBeLessThan(20_000);
  });
});

describe("the first pass", () => {
  it("saves each step as its tag closes, then the fixed draft", async () => {
    script = WIZARD_TEXT_EXAMPLES[1];
    const wizardId = await blank();
    const saved: string[][] = [];
    const seen: string[][] = [];
    const result = await inTenant(async () => {
      const stop = events.subscribeDraft(wizardId, (change) => {
        seen.push(change.touched);
      });
      try {
        return await firstPassMod.firstPass({
          userId: "user-a",
          wizardId,
          wish: "Schlaglöcher melden",
          way: "anthropic",
          signal: new AbortController().signal,
          started: Date.now(),
          onSaved: (ids) => saved.push(ids),
        });
      } finally {
        await new Promise((r) => setTimeout(r, 50));
        stop();
      }
    });
    expect(result.empty).toBe(false);
    // The first page alone first, then more with each save while the text streams (steps that
    // close during a save go into the next one); the last save is the whole draft.
    const counts = saved.map((ids) => ids.length);
    expect(counts[0]).toBe(1);
    expect(counts.every((n, i) => i === 0 || n >= counts[i - 1])).toBe(true);
    expect(counts.length).toBeGreaterThan(3);
    expect(saved.at(-1)).toEqual(["what", "triage", "call", "letter", "check", "done"]);
    expect(seen.length).toBe(saved.length);
    expect(result).toMatchObject({ steps: 6, fixes: [], issues: [], saves: saved.length });
    expect(result.firstStep).not.toBeNull();
    const w = await inTenant(() => wizards.ownedWizard("user-a", wizardId));
    expect(w.draft.steps.map((s) => s.id)).toEqual(saved.at(-1));
  });

  it("fixes the draft at the end and leaves the rest to the architect", async () => {
    script = flawed;
    const wizardId = await blank();
    const result = await inTenant(() =>
      firstPassMod.firstPass({
        userId: "user-a",
        wizardId,
        wish: "Umzug melden",
        way: "anthropic",
        signal: new AbortController().signal,
        started: Date.now(),
      }),
    );
    expect(result.fixes).toHaveLength(5);
    expect(result.issues).toEqual([]);
    const w = await inTenant(() => wizards.ownedWizard("user-a", wizardId));
    expect(w.draft.steps.map((s) => s.id)).toEqual(["who", "where", "letter", "done"]);
  });

  it("is empty when the model writes no step", async () => {
    script = "Gern! Was soll der Wizard können?";
    const wizardId = await blank();
    const result = await inTenant(() =>
      firstPassMod.firstPass({
        userId: "user-a",
        wizardId,
        wish: "hi",
        way: "anthropic",
        signal: new AbortController().signal,
        started: Date.now(),
      }),
    );
    expect(result).toMatchObject({ empty: true, steps: 0, saves: 0 });
  });
});

describe("fastCreateTurn", () => {
  it("is taken for a new wizard's first message only, while fastCreate is on", async () => {
    const wizardId = await blank();
    expect(await inTenant(() => architect.fastCreateFor("user-a", wizardId))).toBe(true);
    process.env.FEATURES = features("off");
    try {
      expect(await inTenant(() => architect.fastCreateFor("user-a", wizardId))).toBe(false);
    } finally {
      process.env.FEATURES = features("on");
    }
    await inTenant(() =>
      wizards.addMessage(wizardId, { role: "user", content: "Schon gesagt" }),
    );
    expect(await inTenant(() => architect.fastCreateFor("user-a", wizardId))).toBe(false);
  });

  it("writes the draft, then the architect finishes it with the wish once in the thread", async () => {
    script = flawed.replace("look=\"slider\"", "");
    const wizardId = await blank();
    systems.length = 0;
    const { said, io: turnIo } = io();
    const result = await inTenant(() =>
      architect.fastCreateTurn("user-a", wizardId, "Umzug melden", "de", false, turnIo),
    );
    expect(systems).toHaveLength(2);
    expect(systems[0]).toContain("THE TEXT FORM");
    expect(systems[1]).not.toContain("THE TEXT FORM");
    expect(said.activity[0]).toBe("Schreibt die ersten Seiten …");
    expect(said.text).toContain("Der erste Entwurf steht: 4 Schritte.");
    expect(said.preparing).toEqual([[]]);
    expect(result.reply).toBe("Ich habe den Entwurf fertig gemacht.");
    expect(result.draft.steps.map((s) => s.id)).toEqual(["who", "where", "letter", "done"]);
    const thread = await inTenant(() => wizards.wizardMessages(wizardId));
    expect(thread.map((m) => [m.role, m.content])).toEqual([
      ["user", "Umzug melden"],
      ["assistant", "Ich habe den Entwurf fertig gemacht."],
    ]);
  });

  it("leaves the wizard to the architect when the first pass writes nothing", async () => {
    script = "Kein Wizard.";
    const wizardId = await blank();
    systems.length = 0;
    const { io: turnIo } = io();
    await inTenant(() => architect.fastCreateTurn("user-a", wizardId, "hi", "de", false, turnIo));
    expect(systems).toHaveLength(2);
    const thread = await inTenant(() => wizards.wizardMessages(wizardId));
    expect(thread.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

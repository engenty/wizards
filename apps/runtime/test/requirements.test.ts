import type { ModelClass, WizardDefinition } from "@engenty/wizards-shared/definition";
import { noteText } from "@engenty/wizards-shared/run";
import type { ModelTier } from "@engenty/wizards-shared/tiers";
import { describe, expect, it, vi } from "vitest";
import {
  blockingMessage,
  closedChoices,
  missingModels,
  missingModelsSaid,
  mostAlongOnePath,
  maskedNote,
  optionalCapabilities,
  tierRefusalSaid,
  unavoidableSteps,
} from "../src/engine/requirements";

const unavailable = new Set<ModelClass>();
// The organization's model tier, while a test sets one.
let tier: ModelTier | null = null;
vi.mock("../src/models", async (actual) => ({
  classProblem: async (cls: ModelClass) =>
    unavailable.has(cls)
      ? { code: "noModelFor", params: { makes: cls } }
      : null,
  currentTier: async () => tier,
  tierRefusal: ((await actual()) as typeof import("../src/models")).tierRefusal,
}));

/** The property video's shape: voice and video sit behind a choice, the photos do not. */
const tour = {
  title: "Objektvideo",
  steps: [
    {
      id: "object",
      type: "page",
      title: "Welches Objekt?",
      fields: [
        { id: "motion", kind: "select", label: "Bewegung", options: ["Kamerafahrt", "Fotos"] },
        { id: "voiceOn", kind: "toggle", label: "Mit Sprecher" },
      ],
    },
    {
      id: "plan",
      type: "agent",
      title: "Räume ansehen",
      tools: [],
      output: { format: "json", fields: [] },
      next: [{ when: { field: "voiceOn", op: "notEquals", value: true }, goto: "staged" }],
    },
    { id: "voice", type: "generate", title: "Sprecher aufnehmen", asset: "voice" },
    { id: "staged", type: "generate", title: "Fotos aufbereiten", asset: "image" },
    {
      id: "stagedCheck",
      type: "review",
      title: "Passen die Bilder?",
      show: ["staged"],
      next: [{ when: { field: "motion", op: "equals", value: "Fotos" }, goto: "film" }],
    },
    { id: "clips", type: "generate", title: "Rundgang drehen", asset: "video" },
    { id: "film", type: "widget", title: "Rundgang schneiden" },
    { id: "done", type: "result", title: "Fertig" },
  ],
} as unknown as WizardDefinition;

describe("what a wizard needs of the models before it starts", () => {
  it("finds the steps every run passes through", () => {
    const steps = unavoidableSteps(tour);
    expect([...steps].sort()).toEqual(
      ["object", "plan", "staged", "stagedCheck", "film", "done"].sort(),
    );
    expect(steps.has("voice")).toBe(false);
    expect(steps.has("clips")).toBe(false);
  });

  it("only warns when the missing models sit behind a choice", async () => {
    unavailable.clear();
    unavailable.add("video").add("speech");
    const missing = await missingModels(tour);
    expect(missing.map((m) => [m.cls, m.blocking])).toEqual([
      ["speech", false],
      ["video", false],
    ]);
    expect(blockingMessage(await missingModelsSaid(tour))).toBeNull();
  });

  it("refuses the start when a step on every path cannot run", async () => {
    unavailable.clear();
    unavailable.add("image");
    const missing = await missingModels(tour);
    expect(missing).toEqual([
      {
        cls: "image",
        problem: "No model is set up for image.",
        steps: [{ id: "staged", title: "Fotos aufbereiten" }],
        blocking: true,
      },
    ]);
    const blocked = blockingMessage(await missingModelsSaid(tour));
    expect(blocked && noteText(blocked, "de")).toBe(
      "„Fotos aufbereiten“: Für image ist kein Modell eingerichtet.",
    );
    expect(blocked && noteText(blocked, "en")).toBe("“Fotos aufbereiten”: No model is set up for image.");
    expect((await missingModels(tour, "de"))[0].problem).toBe("Für image ist kein Modell eingerichtet.");
  });

  it("says a problem two classes share once, naming each step once", () => {
    const missingClient = { code: "clientNotInstalled", params: { name: "Claude Code" } } as const;
    const ideas = { id: "ideas", title: "Ideen finden" };
    const blocked = blockingMessage([
      { cls: "low", problem: missingClient, steps: [ideas], blocking: true },
      { cls: "standard", problem: missingClient, steps: [ideas, ideas], blocking: true },
      {
        cls: "image",
        problem: { code: "noModelFor", params: { makes: "image" } },
        steps: [{ id: "cover", title: "Titelbild" }],
        blocking: true,
      },
    ]);
    expect(blocked && noteText(blocked, "en")).toBe(
      "“Ideen finden”: Claude Code isn’t installed on this computer. Install it under Settings → Models. " +
        "“Titelbild”: No model is set up for image.",
    );
  });
});

describe("choices that lead to a step without a model", () => {
  const page = tour.steps[0] as Extract<WizardDefinition["steps"][number], { type: "page" }>;

  it("closes the values whose path runs through it", async () => {
    unavailable.clear();
    unavailable.add("video").add("speech");
    expect(await closedChoices(tour, page, {})).toEqual({
      motion: { values: ["Kamerafahrt"], classes: ["video"] },
      voiceOn: { values: [true], classes: ["speech"] },
    });
  });

  it("closes nothing when every model is there", async () => {
    unavailable.clear();
    expect(await closedChoices(tour, page, {})).toEqual({});
  });

  it("leaves a choice open whose every value leads there", async () => {
    unavailable.clear();
    unavailable.add("image");
    expect(await closedChoices(tour, page, {})).toEqual({});
  });

  it("names what only some paths need", () => {
    expect([...optionalCapabilities(tour)].sort()).toEqual(["speech", "video"]);
  });
});

describe("voice notes without a model to listen to them", () => {
  const report = (required: boolean) =>
    ({
      title: "Schadensmeldung",
      steps: [
        {
          id: "what",
          type: "page",
          title: "Was ist passiert?",
          fields: [
            { id: "note", kind: "audio", label: "Erzähl es", required },
            { id: "details", kind: "textarea", label: "Oder schreib es" },
          ],
        },
        { id: "summary", type: "agent", title: "Zusammenfassen", tools: [], output: { format: "text" } },
        { id: "done", type: "result", title: "Fertig" },
      ],
    }) as unknown as WizardDefinition;

  it("only warns about an optional voice note, and closes its field", async () => {
    unavailable.clear();
    unavailable.add("audio");
    const def = report(false);
    expect((await missingModels(def)).map((m) => [m.cls, m.blocking])).toEqual([["audio", false]]);
    expect([...optionalCapabilities(def)]).toEqual(["listening"]);
    const page = def.steps[0] as Extract<WizardDefinition["steps"][number], { type: "page" }>;
    expect(await closedChoices(def, page, {})).toEqual({
      note: { values: [], classes: ["audio"] },
    });
  });

  it("refuses the start when the voice note is required", async () => {
    unavailable.clear();
    unavailable.add("audio");
    const def = report(true);
    expect((await missingModels(def)).map((m) => [m.cls, m.blocking])).toEqual([["audio", true]]);
    expect([...optionalCapabilities(def)]).toEqual([]);
  });
});

describe("what a run adds up to along one way", () => {
  /** The video ad's shape: 720p clips, 480p clips or animated stills, never two of them. */
  const ad = {
    title: "Werbevideo",
    steps: [
      { id: "look", type: "page", title: "Wie soll es aussehen?", fields: [] },
      {
        id: "stillsCheck",
        type: "review",
        title: "Passen die Bilder?",
        show: [],
        next: [
          { when: { field: "motion", op: "equals", value: "Fotos" }, goto: "film" },
          { when: { field: "motion", op: "equals", value: "480p" }, goto: "clipsDraft" },
        ],
      },
      {
        id: "clips",
        type: "generate",
        title: "Clips",
        asset: "video",
        next: [{ when: { field: "motion", op: "notEquals", value: "480p" }, goto: "film" }],
      },
      { id: "clipsDraft", type: "generate", title: "Clips 480p", asset: "video" },
      { id: "film", type: "widget", title: "Schnitt" },
    ],
  } as unknown as WizardDefinition;
  const costs: Record<string, number> = { clips: 100, clipsDraft: 40, film: 1 };
  const cost = (s: { id: string }) => costs[s.id] ?? 0;

  it("never adds up branches that exclude each other", () => {
    expect(mostAlongOnePath(ad, cost)).toBe(101);
  });

  it("goes around the steps without a model here", () => {
    expect(mostAlongOnePath(ad, cost, new Set(["clips", "clipsDraft"]))).toBe(1);
  });

  it("counts them again where nothing else reaches the end", () => {
    const only = { ...ad, steps: ad.steps.map((s) => ({ ...s, next: undefined })) };
    expect(mostAlongOnePath(only, cost, new Set(["clips"]))).toBe(141);
  });
});

describe("what an organization's model tier doesn't offer", () => {
  const sovereign: ModelTier = {
    id: "eu-sovereign",
    name: "EU Sovereign",
    locked: true,
    rules: { regions: ["eu"], zdr: true, noTraining: true, ownKeys: false, search: false, decisions: false },
    classes: {
      low: { model: "ovh/mistral-small", name: "Mistral Small 3.2", route: "OVHcloud", region: "France" },
      standard: { model: "stackit/gpt-oss-120b", name: "gpt-oss-120b", route: "STACKIT", region: "Germany" },
      high: { model: "ionos/qwen", name: "Qwen3.5 397B", route: "IONOS", region: "Germany" },
      "anthropic/high": { model: null, name: "Claude Opus 5.5", reason: "maker" },
      video: { model: null, name: null, reason: "region" },
    },
  };
  const answer = {
    title: "Kundenanfrage",
    steps: [
      { id: "draft", type: "agent", title: "Antwort entwerfen", model: "high", maker: "anthropic", tools: [], output: { format: "text" } },
      { id: "read", type: "agent", title: "Anfrage lesen", tools: [], output: { format: "text" } },
      { id: "film", type: "generate", title: "Erklärvideo", asset: "video" },
      { id: "voice", type: "generate", title: "Sprecher", asset: "voice" },
    ],
  } as unknown as WizardDefinition;

  it("lists each class it leaves out with why, and the rest as before", async () => {
    tier = sovereign;
    try {
      const missing = await missingModels(answer);
      expect(missing.map((m) => [m.tierClass, m.blocking])).toEqual([
        ["anthropic/high", true],
        ["video", true],
        ["speech", true],
      ]);
      expect(missing[0].problem).toBe(
        "EU Sovereign, your organization’s tier, leaves out Anthropic. Pick another maker in the Inspector.",
      );
      expect(missing[1].problem).toBe(
        "EU Sovereign, your organization’s tier, offers no model for videos (no route in the tier’s regions).",
      );
      expect(missing[2].problem).toBe("EU Sovereign, your organization’s tier, offers no model for speech.");
    } finally {
      tier = null;
    }
    // Without a tier the same wizard needs nothing.
    expect(await missingModels(answer)).toEqual([]);
  });

  it("says why the gateway refused a step, and what the gateway masked", async () => {
    tier = sovereign;
    try {
      const refused = Object.assign(new Error("Forbidden"), {
        cause: {
          responseBody: JSON.stringify({
            error: { message: "x", type: "outside_tier", class: "video", tier: { id: "eu-sovereign", name: "EU Sovereign" } },
          }),
        },
      });
      expect(noteText((await tierRefusalSaid(refused))!, "en")).toBe(
        "Didn’t run: EU Sovereign, your organization’s tier, offers no model for videos (no route in the tier’s regions). Change the step, or ask an admin.",
      );
      const policy = new Error('{"error":{"message":"x","type":"not_in_policy","class":"anthropic/high"}}');
      expect(noteText((await tierRefusalSaid(policy))!, "en")).toContain("haven’t approved Claude · High for wizards");
      expect(await tierRefusalSaid(new Error("timeout"))).toBeNull();
    } finally {
      tier = null;
    }
    expect(noteText(maskedNote({ person: 2, email: 1, contract: 1 }), "en")).toBe(
      "4 personal details masked and put back in the answer: 2 names, 1 e-mail address, 1 contract number",
    );
    expect(noteText(maskedNote({ person: 1, LOCATION: 2 }), "de")).toBe(
      "3 persönliche Angaben maskiert und in der Antwort wieder eingesetzt: 1 Name, 2 andere Angaben",
    );
  });
});

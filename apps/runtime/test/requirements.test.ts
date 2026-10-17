import type { ModelClass, WizardDefinition } from "@engenty-wizards/shared/definition";
import { noteText } from "@engenty-wizards/shared/run";
import { describe, expect, it, vi } from "vitest";
import {
  blockingMessage,
  closedChoices,
  missingModels,
  missingModelsSaid,
  mostAlongOnePath,
  optionalCapabilities,
  unavoidableSteps,
} from "../src/engine/requirements";

const unavailable = new Set<ModelClass>();
vi.mock("../src/models", () => ({
  classProblem: async (cls: ModelClass) =>
    unavailable.has(cls)
      ? { code: "noModelFor", params: { makes: cls } }
      : null,
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

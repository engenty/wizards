import type { WizardDefinition } from "@engenty-wizards/shared/definition";
import {
  closedChoicesFor,
  needs,
  standaloneEntry,
  standaloneFit,
  unavoidableSteps,
} from "@engenty-wizards/shared/fit";
import { describe, expect, it } from "vitest";

/** A quote request as a WordPress site runs it: pages, one thinking step, a text result. */
const quote = {
  title: "Angebotsanfrage",
  steps: [
    {
      id: "contact",
      type: "page",
      title: "Kontakt",
      fields: [
        { id: "name", kind: "text", label: "Name", required: true },
        { id: "email", kind: "email", label: "E-Mail", required: true },
      ],
    },
    {
      id: "wish",
      type: "page",
      title: "Was soll gebaut werden?",
      fields: [
        { id: "piece", kind: "select", label: "Möbelstück", options: ["Tisch", "Schrank"] },
        { id: "photos", kind: "image", label: "Fotos", multiple: true },
      ],
    },
    {
      id: "estimate",
      type: "agent",
      title: "Einschätzung",
      instructions: "Schätze {{piece}} mit {{photos}}.",
      tools: [],
      output: { format: "markdown" },
    },
    {
      id: "done",
      type: "result",
      title: "Fertig",
      deliverables: [{ from: "estimate", formats: ["html", "md", "pdf"] }],
    },
  ],
} as unknown as WizardDefinition;

/** The property video: voice and clips sit behind choices, the film does not. */
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
      instructions: "x",
      tools: [],
      output: { format: "json", fields: [] },
      next: [{ when: { field: "voiceOn", op: "notEquals", value: true }, goto: "staged" }],
    },
    { id: "voice", type: "generate", title: "Sprecher aufnehmen", asset: "voice", prompt: "x" },
    { id: "staged", type: "generate", title: "Fotos aufbereiten", asset: "image", prompt: "x" },
    {
      id: "stagedCheck",
      type: "review",
      title: "Passen die Bilder?",
      show: ["staged"],
      next: [{ when: { field: "motion", op: "equals", value: "Fotos" }, goto: "film" }],
    },
    { id: "clips", type: "generate", title: "Rundgang drehen", asset: "video", prompt: "x" },
    { id: "film", type: "widget", title: "Rundgang schneiden", entry: "film.html", data: {} },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
} as unknown as WizardDefinition;

describe("what a step needs beyond a text model", () => {
  it("names every need once, with whether the step can do without", () => {
    const def = {
      title: "Alles",
      lists: [{ id: "rows", title: "Rows", columns: [] }],
      steps: [
        {
          id: "ask",
          type: "page",
          title: "Ask",
          fields: [
            { id: "note", kind: "audio", label: "Note" },
            { id: "must", kind: "audio", label: "Must", required: true },
            { id: "where", kind: "location", label: "Where" },
            { id: "slot", kind: "slot", label: "When", options: [] },
            { id: "doc", kind: "file", label: "Doc" },
          ],
        },
        {
          id: "think",
          type: "agent",
          title: "Think",
          instructions: "{{memory}} {{lists.rows}}",
          tools: ["web_search", "pages", "http", "crm.find"],
          mcp: ["notion"],
          connections: ["mail"],
          each: "steps.other.rows",
          output: { format: "json" },
        },
        { id: "draw", type: "generate", title: "Draw", asset: "image", prompt: "x" },
        { id: "write", type: "generate", title: "Write", asset: "document", prompt: "x" },
        { id: "cut", type: "film", title: "Cut", brief: "x", skills: [], inputs: {} },
        { id: "clip", type: "widget", title: "Clip", entry: "a.html", data: {}, video: true },
        {
          id: "done",
          type: "result",
          title: "Done",
          deliverables: [
            { from: "think", formats: ["docx"] },
            { from: "write", formats: ["pdf"] },
            { from: "lists.rows", formats: ["csv"] },
          ],
        },
      ],
    } as unknown as WizardDefinition;
    const by = (id: string) =>
      needs(def.steps.find((s) => s.id === id)!, def).map((n) => `${n.need}${n.hard ? "" : "?"}`);
    expect(by("ask")).toEqual([
      "field:audio",
      "field:location?",
      "field:slot",
      "field:file-read",
    ]);
    // Reading a page and calling an API the site does itself (its abilities): no need.
    expect(by("think")).toEqual([
      "memory",
      "lists",
      "tool:web_search",
      "tool:pages?",
      "plugin:crm",
      "mcp",
      "connections",
      "each?",
    ]);
    expect(by("draw")).toEqual(["asset:image"]);
    // A document is HTML a text model writes: no need; its PDF is the browser's print.
    expect(by("write")).toEqual([]);
    expect(by("cut")).toEqual(["film"]);
    expect(by("clip")).toEqual(["widget:video"]);
    expect(by("done")).toEqual(["format:docx", "format:pdf?", "lists"]);
  });

  it("a file nobody reads later is soft", () => {
    const def = {
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "p",
          fields: [{ id: "doc", kind: "file", label: "Doc" }],
        },
        { id: "done", type: "result", title: "Done", deliverables: [] },
      ],
    } as unknown as WizardDefinition;
    expect(needs(def.steps[0], def)).toEqual([{ stepId: "p", need: "field:file", hard: false }]);
  });
});

describe("whether a wizard runs on its own", () => {
  it("a quote request runs with less: photos where the provider takes them; its PDF the runner makes in the browser", () => {
    const fit = standaloneFit(quote);
    expect(fit.fit).toBe("less");
    expect(fit.notes).toEqual([{ stepId: "wish", need: "field:image", hard: false }]);
    const entry = standaloneEntry(quote);
    expect(entry.missing).toEqual([]);
    expect(entry.optional).toEqual(["documents"]);
    expect(entry.without).toEqual([]);
    expect(entry.needs).toEqual([]);
  });

  it("runs as is without any need", () => {
    const plain = {
      ...quote,
      steps: [
        quote.steps[0],
        { ...quote.steps[2], instructions: "Schätze." },
        { ...quote.steps[3], deliverables: [{ from: "estimate", formats: ["md"] }] },
      ],
    } as WizardDefinition;
    expect(standaloneFit(plain)).toEqual({ fit: "full", notes: [] });
  });

  it("a hard need on an unavoidable step: no; one behind a choice: with less", () => {
    const fit = standaloneFit(tour);
    // The stills and the film's widget are on every path; the clips and the voice are not.
    expect(fit.fit).toBe("no");
    const entry = standaloneEntry(tour);
    expect(entry.missing).toEqual(["image"]);
    expect(entry.optional).toEqual(["speech", "video"]);
    // Without the stills and the widget, the voice and the clips both sit behind a choice.
    const avoidable = {
      ...tour,
      steps: tour.steps
        .filter((s) => s.id !== "staged" && s.id !== "film")
        .map((s) =>
          s.id === "plan"
            ? { ...s, next: [{ ...s.next![0], goto: "stagedCheck" }] }
            : s.id === "stagedCheck"
              ? { ...s, show: ["plan"], next: [{ ...s.next![0], goto: "done" }] }
              : s,
        ),
    } as WizardDefinition;
    expect(standaloneFit(avoidable).fit).toBe("less");
  });

  it("a plugin's tool needs the account; the gallery says which plugin", () => {
    const def = {
      title: "Termin",
      steps: [
        {
          id: "p",
          type: "page",
          title: "p",
          fields: [{ id: "name", kind: "text", label: "Name" }],
        },
        {
          id: "slots",
          type: "agent",
          title: "Freie Zeiten",
          instructions: "",
          call: { tool: "appointments.free_slots", input: {} },
          tools: [],
          output: { format: "json" },
        },
        { id: "done", type: "result", title: "Done", deliverables: [] },
      ],
    } as unknown as WizardDefinition;
    const entry = standaloneEntry(def);
    expect(entry.fit).toBe("no");
    expect(entry.needs).toEqual(["appointments"]);
    expect(entry.missing).toEqual([]);
  });

  it("finds the steps every run passes through", () => {
    expect([...unavoidableSteps(tour)].sort()).toEqual(
      ["object", "plan", "staged", "stagedCheck", "film", "done"].sort(),
    );
  });

  it("closes the choices that lead to what is lacking, given what lacks per step", () => {
    const lacking = (step: { id: string }) =>
      step.id === "voice" || step.id === "clips" ? ["video"] : [];
    const closed = closedChoicesFor(tour, tour.steps[0] as never, {}, lacking as never);
    // The voice toggle's "on" leads to the voice step, "off" does not; "Kamerafahrt" leads to
    // the clips, "Fotos" around them.
    expect(closed.voiceOn).toEqual({ values: [true], classes: ["video"] });
    expect(closed.motion).toEqual({ values: ["Kamerafahrt"], classes: ["video"] });
  });
});

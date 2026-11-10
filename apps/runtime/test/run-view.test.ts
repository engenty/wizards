import type { Step, WizardDefinition } from "@engenty/wizards-shared/definition";
import type { RunEvent, RunState } from "@engenty/wizards-shared/run";
import {
  formatsOf,
  type ReportExtras,
  reportOf,
  type ViewedRun,
  type ViewExtras,
  viewNeeds,
  viewOf,
} from "@engenty/wizards-shared/run-view";
import { describe, expect, it } from "vitest";

/** The run view and report from a definition, a run and what the host adds: no database. */

const def = {
  version: 1,
  title: "Tour",
  description: "A tour",
  avatar: "round",
  steps: [
    {
      id: "object",
      type: "form",
      title: "Which object?",
      fields: [
        { id: "motion", kind: "select", label: "Motion", options: ["Drive", "Photos"] },
        {
          id: "note",
          kind: "text",
          label: "Note",
          when: { field: "motion", op: "eq", value: "Photos" },
        },
      ],
      next: [{ when: { field: "motion", op: "eq", value: "Drive" }, goto: "clips" }, { goto: "more" }],
    },
    { id: "more", type: "form", title: "More", fields: [{ id: "name", kind: "text", label: "Name" }] },
    {
      id: "write",
      type: "agent",
      title: "Write",
      instructions: "Write.",
      tools: [],
      output: { format: "text" },
      next: [{ goto: "check" }],
    },
    { id: "clips", type: "generate", title: "Clips", asset: "video" },
    { id: "check", type: "review", title: "Check", show: ["write"] },
    {
      id: "done",
      type: "result",
      title: "Done",
      deliverables: [{ from: "write", formats: ["md", "pdf", "mp4"], label: "Text" }],
    },
  ],
} as unknown as WizardDefinition;

const runAt = (
  cursor: string,
  status: ViewedRun["status"],
  state: Partial<RunState> = {},
  more: Partial<ViewedRun> = {},
): ViewedRun => ({
  id: "run1",
  wizardId: "wiz1",
  status,
  cursor,
  mode: "live",
  lang: null,
  rev: 3,
  error: null,
  ask: null,
  unsent: null,
  startedBy: null,
  shareToken: null,
  wakeAt: null,
  expiresAt: null,
  state: { values: {}, outputs: {}, history: [], notes: {}, ...state } as RunState,
  ...more,
});

const event = (message: string, note: RunEvent["note"] = null): RunEvent => ({
  id: 1,
  at: "2026-11-10T10:00:00.000Z",
  stepId: null,
  type: "info",
  message,
  note,
});

const brand = { name: "Acme", accent: null, logoUrl: null, theme: null } as never;

const extras = (more: Partial<ViewExtras> = {}): ViewExtras => ({
  brand,
  translation: null,
  missing: [],
  lists: {},
  ffmpeg: false,
  page: null,
  prefill: {},
  waitKey: "",
  talk: true,
  events: [],
  connections: [],
  secrets: false,
  publicUrl: "https://wizards.test",
  shareJob: null,
  ...more,
});

const written = { text: "Two lines.", at: "2026-11-10T10:00:00.000Z" };

describe("viewOf", () => {
  it("shows a page: what it starts with, the closed choices, the pages ahead", () => {
    const view = viewOf(
      def,
      runAt("object", "waiting_input", {}, { unsent: { object: { note: "half" } } }),
      extras({
        missing: ["video"],
        prefill: { motion: "Drive" },
        page: { known: {}, options: {}, cards: {}, decided: [] },
      }),
    );
    expect(view.step?.id).toBe("object");
    // "Drive" leads to a step without a model: closed, and what the page starts with opens.
    expect(view.closed).toEqual({ motion: { values: ["Drive"], classes: ["video"] } });
    expect(view.prefill).toEqual({ motion: "Photos" });
    expect(view.unsent).toEqual({ note: "half" });
    expect(Object.keys(view.ahead ?? {})).toEqual(["object", "more"]);
    expect(view.ahead?.object.next).toEqual([
      { when: { field: "motion", op: "eq", value: "Drive" }, goto: "clips" },
      { goto: "more" },
    ]);
    expect(view.ahead?.more).toMatchObject({ next: [{ goto: "write" }], progress: { done: 1 } });
    expect(view).toMatchObject({
      pagesSent: 0,
      known: {},
      decidedFields: [],
      talk: true,
      progress: { done: 0, total: 6 },
      canBack: false,
    });
  });

  it("leaves a started run's page to the runner", () => {
    const view = viewOf(
      def,
      runAt("object", "waiting_input", {}, { startedBy: { kind: "schedule" } as never }),
      extras(),
    );
    expect(view.ahead).toBeUndefined();
    expect(view.pagesSent).toBeUndefined();
  });

  it("writes the view in the viewer's language", () => {
    const view = viewOf(
      def,
      runAt("object", "waiting_input", {}, { lang: "fr" }),
      extras({
        translation: {
          "Which object?": { text: "Quel objet ?", by: "author" },
          Drive: { text: "Travelling", by: "machine" },
          working: { text: "au travail", by: "machine" },
        },
        events: [event("working"), event("working", { code: "runStarted" })],
      }),
    );
    expect(view.step?.title).toBe("Quel objet ?");
    expect(view.lang).toBe("en");
    expect(view.translation).toEqual({
      lang: "fr",
      labels: { Drive: "Travelling" },
      machine: true,
      results: {},
    });
    // A step's own words are the wizard's; a note is written by the runner.
    expect(view.events.map((e) => e.message)).toEqual(["au travail", "working"]);
  });

  it("shows the result, and keeps a step in the space from a guest", () => {
    const run = runAt(
      "done",
      "done",
      { outputs: { write: written }, history: ["object", "check"] },
      { shareToken: "tok", expiresAt: "2026-12-01T00:00:00.000Z" },
    );
    const view = viewOf(def, run, extras({ secrets: true }));
    expect(view.shown).toEqual([
      { step: def.steps[2], output: written, formats: ["md", "pdf"], label: "Text" },
    ]);
    expect(view.outputs).toEqual({ write: written });
    expect(view).toMatchObject({
      keeps: true,
      shareUrl: "https://wizards.test/s/tok",
      expiresAt: "2026-12-01T00:00:00.000Z",
      progress: { done: 6, total: 6 },
      canBack: true,
      prefill: {},
      closed: {},
    });

    const kept = viewOf(def, run, extras({ hide: new Set(["write"]) }));
    expect(kept.shown).toEqual([
      { step: def.steps[2], output: null, formats: [], label: "Text", kept: true },
    ]);
    expect(kept.outputs).toEqual({});
    expect(kept.keeps).toBe(false);
  });

  it("says what a sleeping run and a run that waits for a signal wait for", () => {
    const at = "2026-11-11T08:00:00.000Z";
    const asleep = viewOf(
      def,
      runAt("write", "sleeping", { pause: { kind: "retry" } }, { wakeAt: at }),
      extras({ talk: true }),
    );
    expect(asleep).toMatchObject({ wakeAt: at, pause: { kind: "retry" }, talk: false });
    const waits = viewOf(
      { ...def, steps: [{ id: "paid", type: "wait", title: "Paid" } as Step, ...def.steps] },
      runAt("paid", "waiting_signal"),
      extras({ waitKey: "order-7" }),
    );
    expect(waits).toMatchObject({ waitsFor: "order-7", talk: false, pause: null });
  });
});

describe("viewNeeds", () => {
  it("names only what the view reads", () => {
    expect(viewNeeds(def, runAt("object", "waiting_input"))).toEqual({
      missing: true,
      lists: false,
      ffmpeg: false,
      talk: true,
      connections: false,
      secrets: false,
      shareJob: false,
    });
    expect(viewNeeds(def, runAt("done", "done"))).toMatchObject({
      missing: false,
      secrets: true,
      shareJob: true,
    });
    expect(viewNeeds(def, runAt("write", "sleeping")).talk).toBe(false);
  });
});

describe("formatsOf", () => {
  const widget = { id: "w", type: "widget", title: "W" } as Step;
  const drawn = { widget: { duration: 5 }, at: "" } as never;

  it("offers a widget's video where it can be rendered", () => {
    expect(formatsOf(widget, drawn, undefined, true)).toContain("mp4");
    expect(formatsOf(widget, drawn, undefined, false)).not.toContain("mp4");
    expect(formatsOf(widget, undefined, ["png", "mp4"], true)).toEqual(["png"]);
  });
});

describe("reportOf", () => {
  const report = (more: Partial<ReportExtras> = {}): ReportExtras => ({
    hidden: [],
    mayAct: true,
    page: null,
    autopilot: false,
    credits: 2,
    events: [],
    browserUrl: null,
    studioUrl: null,
    text: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    link: (path) => `signed:${path}`,
    ...more,
  });

  it("lists a page's fields, its conditions following the draft", () => {
    const run = runAt("object", "waiting_input");
    const page = { known: {}, options: {}, cards: {}, decided: [] };
    const asked = reportOf(def, run, report({ page, draft: { motion: "Photos" } }));
    expect(asked.waitingFor).toMatchObject({
      form: "object",
      hint: "hint.page",
      fields: [
        { id: "motion", options: ["Drive", "Photos"], inChat: true },
        { id: "note", shown: true },
      ],
    });
    expect(reportOf(def, run, report({ page })).waitingFor).toMatchObject({
      fields: [{ id: "motion" }, { id: "note", shown: false }],
    });
    // An autopilot fills the page: the run counts as running.
    expect(reportOf(def, run, report({ autopilot: true })).status).toBe("running");
  });

  it("tells a viewer who may not answer only whose the step is", () => {
    const told = reportOf(def, runAt("check", "waiting_input"), report({ mayAct: false }));
    expect(told.waitingFor).toEqual({
      answeredBy: "person",
      title: "Check",
      hint: "hint.answered_by",
    });
  });

  it("says when a sleeping run tries again", () => {
    const at = "2026-11-11T08:00:00.000Z";
    const run = runAt("write", "sleeping", { pause: { kind: "retry" } }, { wakeAt: at });
    expect(reportOf(def, run, report()).waitingFor).toEqual({
      wait: "write",
      title: "Write",
      until: at,
      pause: { kind: "retry" },
      hint: "hint.pause_retry",
    });
  });

  it("links the outputs, and leaves out a step kept from the viewer", () => {
    const run = runAt("done", "done", { outputs: { write: written } }, { mode: "test" });
    const done = reportOf(def, run, report({ studioUrl: "https://studio" }));
    expect(done).toMatchObject({
      runId: "run1",
      wizardId: "wiz1",
      status: "done",
      credits: 2,
      passed: ["write", "done"],
      studioUrl: "https://studio",
    });
    expect(done.outputs).toEqual([
      {
        stepId: "write",
        title: "Write",
        text: "Two lines.",
        json: undefined,
        assets: [],
        downloads: {
          md: "signed:/api/runs/run1/steps/write/download?format=md",
          pdf: "signed:/api/runs/run1/steps/write/download?format=pdf",
        },
        picture: null,
      },
    ]);
    expect(reportOf(def, run, report({ hidden: ["write"] })).outputs).toEqual([]);
    expect("studioUrl" in reportOf(def, { ...run, mode: "live" }, report())).toBe(false);
  });
});

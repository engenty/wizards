import { createHash } from "node:crypto";
import { type AskRow, type Battery, NeedsLeave, type Run, view } from "@engenty/wizards-kernel";
import type { Field, Step, WizardDefinition } from "@engenty/wizards-shared/definition";
import type { RunState, StepOutput } from "@engenty/wizards-shared/run";
import { runAutomaticStep } from "../engine/steps.js";
import type { RunRow, SpaceRow, StepContext } from "../engine/types.js";
import { executorActions } from "./executor.js";
import { asRefs, viewData } from "./views.js";

/**
 * Who answers an ask of a run in version 0.3.0 at once (docs/plans/kernel.md): today's step
 * executors. An ask becomes the step of version 0.2.0 it would have been, with its text already
 * written, and runs as that. So models, connections, the broker and what a step costs are the
 * ones every run has. An action of a connection that its connector lacks is executor's.
 */
export type MakeContext = (
  run: RunRow,
  space: SpaceRow,
  state: RunState,
  signal: AbortSignal,
  own: Partial<Pick<StepContext, "stepId" | "emit" | "ask" | "share">>,
) => Promise<StepContext>;

const emptyState = (): RunState => ({ values: {}, outputs: {}, history: [], notes: {} });

/** `gmail.send` as a connection of the definition and its action; nothing for any other tool. */
function actionOf(def: WizardDefinition, name: string) {
  const [connection, ...rest] = name.split(".");
  return def.connections?.some((c) => c.id === connection) && rest.length
    ? { connection, action: rest.join(".") }
    : undefined;
}

/** The definition as this one ask may use it: its connections narrowed to the actions it names. */
function narrowed(def: WizardDefinition, row: AskRow, run: Run): WizardDefinition {
  const named = [...(row.tools ?? []), ...(typeof row.call === "string" ? [row.call] : [])]
    .map((name) => actionOf(def, name))
    .filter((found) => found !== undefined);
  const connections = (def.connections ?? []).flatMap((connection) => {
    const actions = named.filter((n) => n.connection === connection.id).map((n) => n.action);
    // An agent is not handed an action the file sets to ask: its own turn cannot ask yet.
    const kept =
      row.type === "agent"
        ? actions.filter((action) => run.grant?.connections[connection.id]?.[action] !== "ask")
        : actions;
    return kept.length
      ? [
          {
            ...connection,
            actions: kept,
            policy: Object.fromEntries(kept.map((action) => [action, "allow" as const])),
          },
        ]
      : [];
  });
  return { ...def, connections };
}

/** The ask as the step of version 0.2.0 it would have been. */
export function stepOf(def: WizardDefinition, row: AskRow): Step {
  const base = { id: row.step, title: String(row.title ?? row.step) };
  const {
    n,
    step,
    role,
    state,
    answer,
    error,
    by,
    due,
    approves,
    parent,
    asksLeave,
    tries,
    // What to change of a film already made: handed to the step beside its brief (the battery).
    note: _note,
    ...spec
  } = row;
  // A decision over the step's ways: the model names the one whose statement holds, or none.
  const ways =
    row.type === "decision" && row.ways && typeof row.ways === "object"
      ? Object.entries(row.ways as Record<string, unknown>)
      : [];
  if (ways.length) {
    const { ways: _ways, ...rest } = spec;
    return {
      ...rest,
      ...base,
      type: "decision",
      instructions: [
        String(row.instructions ?? ""),
        'Choose where the wizard goes next: the way whose statement holds, or "none" where none does.',
        ...ways.map(([to, holds]) => `- ${to}: ${String(holds)}`),
      ]
        .filter(Boolean)
        .join("\n"),
      tools: [],
      connections: [],
      output: {
        format: "json",
        fields: [
          {
            id: "to",
            label: "to",
            kind: "choice",
            options: [...ways.map(([to]) => to), "none"],
            required: true,
          },
        ],
      },
    } as unknown as Step;
  }
  if (row.type === "agent" || row.type === "decision") {
    const tools = (row.tools ?? []).filter((name) => !actionOf(def, name));
    return {
      ...spec,
      ...base,
      type: row.type,
      instructions: String(row.instructions ?? ""),
      tools,
      connections: (def.connections ?? []).map((c) => c.id),
      output: row.fields?.length
        ? {
            format: "json",
            fields: row.fields,
            // A view of what the agent returns: written by the step, or composed by a model.
            ...(row.surface === undefined ? {} : { surface: row.surface }),
          }
        : { format: row.format === "markdown" ? "markdown" : "text" },
    } as unknown as Step;
  }
  if (row.type === "tool") {
    const action = typeof row.call === "string" ? actionOf(def, row.call) : undefined;
    const input = (row.input ?? {}) as Record<string, unknown>;
    return {
      ...base,
      type: "tool",
      call: action ? { ...action, input } : { tool: row.call, input },
      output: {},
    } as unknown as Step;
  }
  // generate, widget, motion-graphics, surface: the ask is the step, as it is written.
  return { ...spec, ...base } as unknown as Step;
}

/** What a step made, as the answer the ask gives back. */
function answerOf(output: StepOutput): unknown {
  const { at, ...made } = output;
  if (made.json !== undefined) {
    // Data and files together (a film with what it was cut from, an agent's kept pictures): the
    // step reads the data as before and finds the files beside it.
    // A view of the data comes along the same way: a step that returns it leaves it to be shown.
    const data = made.json;
    const beside = {
      ...(made.assets?.length ? { assets: made.assets } : {}),
      ...(made.surface ? { surface: made.surface } : {}),
    };
    return Object.keys(beside).length && data && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), ...beside }
      : data;
  }
  const keys = Object.keys(made);
  return keys.length === 1 && keys[0] === "text" ? made.text : made;
}

/**
 * The files a person gave so far, as today's executors look for them: the upload fields that
 * were asked, in the input and on every page, and what was put into each. Nothing else of the
 * answers: a step passes those itself.
 */
function givenFiles(run: RunRow, kernelRun: Run) {
  const fields = new Map<string, Field>();
  const values: Record<string, unknown> = {};
  const take = (asked: unknown, answers: unknown) => {
    for (const field of (Array.isArray(asked) ? asked : []) as Field[]) {
      if (field.kind !== "image" && field.kind !== "file" && field.kind !== "signature") continue;
      fields.set(field.id, field);
      const value = (answers as Record<string, unknown> | null | undefined)?.[field.id];
      if (value !== undefined) values[field.id] = value;
    }
  };
  take(run.definition.kernel?.input?.fields, kernelRun.input);
  for (const row of kernelRun.rows) {
    if (!("left" in row) && row.type === "form") take(row.fields, row.answer);
  }
  return { fields: [...fields.values()], values };
}

/** A step's value as the output today's executors read: its text, or its data with its files. */
function outputOfValue(value: unknown, at: string): StepOutput {
  if (typeof value === "string") return { text: value, at };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { assets, ...rest } = value as Record<string, unknown>;
    if (Array.isArray(assets)) {
      const only = Object.keys(rest);
      return only.length === 1 && typeof rest.text === "string"
        ? { text: rest.text, assets: assets as StepOutput["assets"], at }
        : { json: rest, assets: assets as StepOutput["assets"], at };
    }
  }
  return { json: value ?? {}, at };
}

/**
 * A film's material as today's executor finds it: each input in the state under a name of its
 * own. An input is a value the step passes, or a text naming one: `steps.<id>` for what a step
 * made, a field's id for what the person gave.
 */
export function motionInputs(row: AskRow, kernelRun: Run, state: RunState): Record<string, string> {
  const seen = view(kernelRun);
  const answers: Record<string, unknown> = { ...kernelRun.input };
  for (const one of kernelRun.rows) {
    if (!("left" in one) && one.type === "form" && one.answer && typeof one.answer === "object") {
      Object.assign(answers, one.answer);
    }
  }
  const refs: Record<string, string> = {};
  for (const [name, raw] of Object.entries((row.inputs ?? {}) as Record<string, unknown>)) {
    let value = raw;
    if (typeof raw === "string") {
      const [head, id, ...rest] = raw.trim().split(".");
      if (head === "steps" && id && id in seen.steps) {
        value = rest.reduce<unknown>(
          (at, key) => (at as Record<string, unknown> | undefined)?.[key],
          seen.steps[id],
        );
      } else if (raw.trim() in answers) {
        value = answers[raw.trim()];
      }
    }
    const key = `arg__${name}`;
    const files = [value].flat();
    if (value != null && files.every((one) => typeof one === "string")) {
      state.values[key] = value;
      refs[name] = key;
    } else {
      // The same value, the same mark: a film made from it is gone on with, not made anew.
      const at = createHash("sha256")
        .update(JSON.stringify(value ?? null))
        .digest("hex");
      state.outputs[key] = outputOfValue(value, at);
      refs[name] = `steps.${key}`;
    }
  }
  return refs;
}

export function kernelBatteries(
  run: RunRow,
  space: SpaceRow,
  signal: AbortSignal,
  makeContext: MakeContext,
): Record<string, Battery> {
  const battery: Battery = async (row, kernelRun) => {
    const def = narrowed(run.definition, row, kernelRun);
    // The person's photos and files are the run's: a step that names one finds it.
    const given = givenFiles(run, kernelRun);
    const asked = given.fields.length
      ? ({
          ...def,
          steps: [
            { id: "asked__", type: "form", title: def.title, fields: given.fields },
            ...def.steps,
          ],
        } as WizardDefinition)
      : def;
    const state = { ...emptyState(), values: { ...given.values } };
    // A film that is to be changed keeps its brief and takes what to change as a note, as after
    // a review of version 0.2.0: the film made before is changed, not made again from nothing.
    if (row.type === "motion-graphics" && typeof row.note === "string" && row.note.trim()) {
      state.notes[row.step] = row.note.trim().slice(0, 2000);
    }
    // A film reads its material from the state: what the step passes is put there.
    // A surface reads its data from the state too: the values the step worked out are put there.
    const values = row.type === "surface" ? viewData(row.data) : undefined;
    const asks =
      row.type === "motion-graphics"
        ? { ...row, inputs: motionInputs(row, kernelRun, state) }
        : values
          ? { ...row, data: asRefs(row.step, values, state.outputs, new Date().toISOString()) }
          : row;
    const ctx = await makeContext({ ...run, definition: asked }, space, state, signal, {
      stepId: row.step,
      // A step that wants the person's yes for what it is about to do: the kernel asks, as a row.
      ask: async (ask) => {
        if (ask.kind !== "confirm") {
          throw new Error(
            "This step needs the person in the middle of its work, which a run of version 0.3.0 cannot do yet.",
          );
        }
        if (row.asksLeave) {
          return { type: "done" };
        }
        throw new NeedsLeave();
      },
    });
    // A name the file gives that its connector has no action for is an operation of the service's
    // API: executor makes that call, below the broker (kernel/executor.ts).
    ctx.operations = executorActions;
    return answerOf(await runAutomaticStep(stepOf(def, asks), ctx));
  };
  return {
    agent: battery,
    decision: battery,
    tool: battery,
    generate: battery,
    widget: battery,
    "motion-graphics": battery,
    surface: battery,
  };
}

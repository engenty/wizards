import { type AskRow, type Battery, NeedsLeave, type Run } from "@engenty/wizards-kernel";
import type { Field, Step, WizardDefinition } from "@engenty/wizards-shared/definition";
import type { RunState, StepOutput } from "@engenty/wizards-shared/run";
import { runAutomaticStep } from "../engine/steps.js";
import type { RunRow, SpaceRow, StepContext } from "../engine/types.js";

/**
 * Who answers an ask of a run in version 0.3.0 at once (docs/plans/kernel.md): today's step
 * executors. An ask becomes the step of version 1 it would have been, with its text already
 * written, and runs as that. So models, connections, the broker and what a step costs are the
 * ones every run has.
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

/** The ask as the step of version 1 it would have been. */
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
        ? { format: "json", fields: row.fields }
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
    const data = made.json;
    return made.assets?.length && data && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), assets: made.assets }
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
    const state = { ...emptyState(), values: given.values };
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
    return answerOf(await runAutomaticStep(stepOf(def, row), ctx));
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

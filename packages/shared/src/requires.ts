// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import {
  isDecidedField,
  type Maker,
  type ModelClass,
  pluginToolOf,
  type Requires,
  type Step,
  TOOL_IDS,
  textClassOf,
  type WizardDefinition,
} from "./definition.js";
import { unavoidableSteps } from "./fit.js";
import { wizardCodeOf, wizardToolsUsed } from "./wizard-code.js";

/**
 * What a wizard needs before a run starts, worked out from its steps: the root `requires` of a
 * definition. The runtime, the import, the marketplace and `wizards validate` read it from here.
 */

/**
 * The classes a step calls, as the runtime's engine/steps.ts and media/generate.ts call them —
 * and the classifier where a decision picks its next step or a form's fields.
 */
export function stepClasses(step: Step): ModelClass[] {
  const own = ownClasses(step);
  const decides =
    step.next?.some((r) => r.ask) || (step.type === "form" && step.fields.some(isDecidedField));
  return decides && !own.includes("classifier") ? [...own, "classifier"] : own;
}

function ownClasses(step: Step): ModelClass[] {
  switch (step.type) {
    case "decision":
      return ["classifier"];
    case "agent": {
      const classes: ModelClass[] = [textClassOf(step.model ?? "standard")];
      if (step.tools.includes("image")) {
        classes.push("image");
      }
      if (step.output.format === "json") {
        classes.push("classifier");
      }
      if (step.output.surface === true && !classes.includes("low")) {
        classes.push("low");
      }
      return classes;
    }
    case "generate":
      switch (step.asset) {
        case "image":
          return ["low", "image"];
        case "video":
          return ["low", "video"];
        case "voice":
          return ["speech"];
        default:
          return [textClassOf(step.model ?? "standard")];
      }
    case "motion-graphics":
      return [textClassOf(step.model ?? "low")];
    case "form":
      // A voice note the form asks for is listened to before the next step reads it.
      return step.fields.some((f) => f.kind === "audio" && f.required) ? ["audio"] : [];
    default:
      // Tools, code, reviews (they redo a generate step counted already), widgets, results.
      return [];
  }
}

/** The classes a step can do without: a voice note the person may leave out. */
export function optionalStepClasses(step: Step): ModelClass[] {
  return step.type === "form" &&
    step.fields.some((f) => f.kind === "audio" && !f.required) &&
    !stepClasses(step).includes("audio")
    ? ["audio"]
    : [];
}

const BUILT_IN: ReadonlySet<string> = new Set(TOOL_IDS);

const sorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort();

/** The plugins a definition's steps use, by id: a runtime without one of them cannot run it. */
export function pluginsOf(def: Pick<WizardDefinition, "steps">): string[] {
  return sorted(
    def.steps.flatMap((step) => {
      const tools =
        step.type === "agent"
          ? step.tools
          : step.type === "tool" && step.call && "tool" in step.call
            ? [step.call.tool]
            : [];
      return tools.flatMap((tool) => pluginToolOf(tool)?.plugin ?? []);
    }),
  );
}

/**
 * What a definition needs, from its steps. Lists are sorted and empty ones left out. A class
 * only steps behind a branch call is `optional`: a run can go around it.
 */
export function requiresOf(def: WizardDefinition): Requires {
  const unavoidable = unavoidableSteps(def);
  const models = new Set<ModelClass>();
  const optionalModels = new Set<ModelClass>();
  const makers = new Set<Maker>();
  const tools = new Set<string>();
  let durable = false;
  for (const step of def.steps) {
    for (const cls of stepClasses(step)) {
      (unavoidable.has(step.id) ? models : optionalModels).add(cls);
    }
    for (const cls of optionalStepClasses(step)) {
      optionalModels.add(cls);
    }
    if ("maker" in step && step.maker) {
      makers.add(step.maker);
    }
    if (step.type === "agent") {
      for (const tool of step.tools) {
        if (BUILT_IN.has(tool) || wizardCodeOf(tool)?.kind === "tool") {
          tools.add(tool);
        }
      }
    }
    // A durable agent step runs without it where it is off; a wait step can't.
    durable ||= step.type === "wait";
  }
  for (const cls of models) {
    optionalModels.delete(cls);
  }
  // A code step, or a function tool of the wizard: its own code runs.
  const code = def.steps.some((s) => s.type === "code") || wizardToolsUsed(def).length > 0;
  const connections = sorted((def.connections ?? []).flatMap((c) => (c.kind ? [c.kind] : [])));
  const features = [
    ...(code ? (["codeSteps"] as const) : []),
    ...(durable ? (["durableRuns"] as const) : []),
  ];
  const out: Requires = {
    models: sorted(models),
    makers: sorted(makers),
    tools: sorted(tools),
    run: code ? ["code"] : [],
    ...(tools.has("sandbox") ? { sandbox: "shell" as const } : {}),
    plugins: pluginsOf(def),
    connections,
    features: [...features].sort(),
    ...(def.data ? { data: def.data.scope } : {}),
    ...(optionalModels.size ? { optional: { models: sorted(optionalModels) } } : {}),
  };
  return Object.fromEntries(
    Object.entries(out).filter(([, v]) => !Array.isArray(v) || v.length > 0),
  ) as Requires;
}

/** The definition with its `requires` as its steps say: what every writer saves. */
export function withRequires<T extends WizardDefinition>(def: T): T {
  const requires = requiresOf(def);
  const { requires: _, steps, ...rest } = def;
  // `requires` stands before the steps, where people read it.
  return {
    ...rest,
    ...(Object.keys(requires).length ? { requires } : {}),
    steps,
  } as T;
}

/** Why a definition's `requires` is not what its steps need, or null when it is. */
export function requiresProblem(def: WizardDefinition): string | null {
  const want = requiresOf(def);
  const have = def.requires ?? {};
  if (JSON.stringify(normal(have)) === JSON.stringify(normal(want))) {
    return null;
  }
  return `"requires" is not what the steps need; it is ${JSON.stringify(want)}.`;
}

/** A requires with its keys in one order and its lists sorted, for comparing. */
function normal(r: Requires): Record<string, unknown> {
  const flat = (o: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.keys(o)
        .sort()
        .flatMap((k) => {
          const v = o[k];
          if (Array.isArray(v)) {
            return v.length ? [[k, [...v].sort()]] : [];
          }
          if (v && typeof v === "object") {
            const inner = flat(v as Record<string, unknown>);
            return Object.keys(inner).length ? [[k, inner]] : [];
          }
          return v === undefined ? [] : [[k, v]];
        }),
    );
  return flat(r as Record<string, unknown>);
}

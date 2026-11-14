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
import type { WizardAgent } from "./wizard-agents.js";
import {
  isSandboxToolPath,
  stepAgents,
  wizardAgentsUsed,
  wizardCodeOf,
  wizardToolsIn,
  wizardToolsUsed,
} from "./wizard-code.js";

/** What an agent of the wizard needs, by name: `requires.agents`. */
export type AgentNeeds = NonNullable<Requires["agents"]>;

/**
 * What a wizard needs before a run starts, worked out from its steps: the root `requires` of a
 * definition. The runtime, the import, the marketplace and `wizards validate` read it from here.
 */

/**
 * The classes a step calls, as the runtime's engine/steps.ts and media/generate.ts call them —
 * and the classifier where a decision picks its next step or a form's fields.
 */
export function stepClasses(step: Step, agents?: AgentNeeds): ModelClass[] {
  const own = ownClasses(step, agents);
  const decides =
    step.next?.some((r) => r.ask) || (step.type === "form" && step.fields.some(isDecidedField));
  return decides && !own.includes("classifier") ? [...own, "classifier"] : own;
}

function ownClasses(step: Step, agents?: AgentNeeds): ModelClass[] {
  switch (step.type) {
    case "decision":
      return ["classifier"];
    case "agent": {
      // A step an agent of the wizard runs calls the agent's classes (the default class where
      // they aren't known yet); an agent it lists as a tool adds its own.
      const used = stepAgents(step);
      const ran = used.own ? agents?.[used.own]?.models : undefined;
      const classes: ModelClass[] = ran ? [...ran] : [textClassOf(step.model ?? "standard")];
      for (const name of used.tools) {
        classes.push(...(agents?.[name]?.models ?? []));
      }
      if (step.tools.includes("image")) {
        classes.push("image");
      }
      if (step.output.format === "json") {
        classes.push("classifier");
      }
      if (step.output.surface === true && !classes.includes("low")) {
        classes.push("low");
      }
      return [...new Set(classes)];
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
    !ownClasses(step).includes("audio")
    ? ["audio"]
    : [];
}

const BUILT_IN: ReadonlySet<string> = new Set(TOOL_IDS);

const sorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort();

/**
 * What an agent of the wizard needs, as its file says: its class, `image` where it draws,
 * `classifier` where its answer is JSON, and the tools it lists.
 */
export function agentNeedsOf(agent: WizardAgent): AgentNeeds[string] {
  const models: ModelClass[] = [textClassOf(agent.model)];
  if (agent.tools.includes("image")) {
    models.push("image");
  }
  if (agent.output) {
    models.push("classifier");
  }
  return {
    models: sorted(models),
    ...(agent.tools.length ? { tools: sorted(agent.tools) } : {}),
  };
}

/**
 * What the agents the steps use need, by name: from their files where `agents` gives them,
 * else as the definition's `requires.agents` says (what only reads the definition keeps it).
 */
export function agentsNeeded(
  def: WizardDefinition,
  agents?: ReadonlyMap<string, WizardAgent>,
): AgentNeeds {
  const out: AgentNeeds = {};
  for (const name of wizardAgentsUsed(def)) {
    const agent = agents?.get(name);
    const needs = agents ? (agent ? agentNeedsOf(agent) : undefined) : def.requires?.agents?.[name];
    if (needs) {
      out[name] = needs;
    }
  }
  return out;
}

/**
 * The tools a step works with: its own, or those of the agent it runs where it lists none, and
 * those of the agents it lists as tools.
 */
export function toolsAt(step: Step, agents: AgentNeeds): string[] {
  if (step.type !== "agent") {
    return [];
  }
  const used = stepAgents(step);
  const own = used.own && !step.tools.length ? (agents[used.own]?.tools ?? []) : step.tools;
  // An agent listed as a tool works with its own.
  return [...own, ...used.tools.flatMap((name) => agents[name]?.tools ?? [])];
}

/** The plugins a definition's steps use, by id: a runtime without one of them cannot run it. */
export function pluginsOf(def: Pick<WizardDefinition, "steps">, agents: AgentNeeds = {}): string[] {
  return sorted(
    def.steps.flatMap((step) => {
      const tools =
        step.type === "agent"
          ? toolsAt(step, agents)
          : step.type === "tool" && step.call && "tool" in step.call
            ? [step.call.tool]
            : [];
      return tools.flatMap((tool) => pluginToolOf(tool)?.plugin ?? []);
    }),
  );
}

/**
 * Whether the wizard's own tools need a sandbox that runs a shell: one of `tools`, what the
 * steps and their agents work with, is a sandbox tool (`tools/<name>/TOOL.md`). That is in the
 * workspace: with `paths` it is read, without them what the definition says already is kept, as
 * long as a tool of the wizard is among them.
 */
function ownToolsNeedShell(
  def: WizardDefinition,
  tools: ReadonlySet<string>,
  paths?: readonly string[],
): boolean {
  const own = [...tools].flatMap((id) => {
    const code = wizardCodeOf(id);
    return code?.kind === "tool" ? [code.name] : [];
  });
  if (!paths) {
    return def.requires?.sandbox === "shell" && own.length > 0;
  }
  const files = wizardToolsIn(paths);
  return own.some((name) => {
    const found = files.get(name);
    return found?.length === 1 && isSandboxToolPath(found[0]);
  });
}

/**
 * What a definition needs, from its steps. Lists are sorted and empty ones left out. A class
 * only steps behind a branch call is `optional`: a run can go around it. `agents`: the wizard's
 * agents as their files say (wizard-agents.ts); left out, `requires.agents` stands for them.
 * `paths`: the workspace's files, which say whether a tool of the wizard runs in the sandbox.
 */
export function requiresOf(
  def: WizardDefinition,
  agents?: ReadonlyMap<string, WizardAgent>,
  paths?: readonly string[],
): Requires {
  const needs = agentsNeeded(def, agents);
  const unavoidable = unavoidableSteps(def);
  const models = new Set<ModelClass>();
  const optionalModels = new Set<ModelClass>();
  const makers = new Set<Maker>();
  const tools = new Set<string>();
  let code = false;
  let durable = false;
  for (const step of def.steps) {
    for (const cls of stepClasses(step, needs)) {
      (unavoidable.has(step.id) ? models : optionalModels).add(cls);
    }
    for (const cls of optionalStepClasses(step)) {
      optionalModels.add(cls);
    }
    if ("maker" in step && step.maker) {
      makers.add(step.maker);
    }
    for (const tool of [...(step.type === "agent" ? step.tools : []), ...toolsAt(step, needs)]) {
      if (BUILT_IN.has(tool) || wizardCodeOf(tool)) {
        tools.add(tool);
      }
      code ||= wizardCodeOf(tool)?.kind === "tool";
    }
    const own = step.type === "agent" ? stepAgents(step).own : undefined;
    if (own) {
      tools.add(`agent.${own}`);
    }
    // A durable agent step runs without it where it is off; a wait step can't.
    durable ||= step.type === "wait";
  }
  for (const cls of models) {
    optionalModels.delete(cls);
  }
  // A code step, or a function tool of the wizard or of one of its agents: its own code runs.
  code ||= def.steps.some((s) => s.type === "code") || wizardToolsUsed(def).length > 0;
  const connections = sorted((def.connections ?? []).flatMap((c) => (c.kind ? [c.kind] : [])));
  const connectors = sorted(
    (def.connections ?? []).flatMap((c) => (c.connector ? [c.connector] : [])),
  );
  const features = [
    ...(code ? (["codeSteps"] as const) : []),
    ...(durable ? (["durableRuns"] as const) : []),
  ];
  const out: Requires = {
    models: sorted(models),
    makers: sorted(makers),
    tools: sorted(tools),
    run: code ? ["code"] : [],
    ...(tools.has("sandbox") || ownToolsNeedShell(def, tools, paths)
      ? { sandbox: "shell" as const }
      : {}),
    plugins: pluginsOf(def, needs),
    connections,
    connectors,
    features: [...features].sort(),
    ...(def.data ? { data: def.data.scope } : {}),
    ...(optionalModels.size ? { optional: { models: sorted(optionalModels) } } : {}),
    ...(Object.keys(needs).length
      ? { agents: Object.fromEntries(Object.entries(needs).sort(([a], [b]) => a.localeCompare(b))) }
      : {}),
  };
  return Object.fromEntries(
    Object.entries(out).filter(([, v]) => !Array.isArray(v) || v.length > 0),
  ) as Requires;
}

/**
 * The definition with its `requires` as its steps say: what every writer saves. `agents`: the
 * wizard's agents as their files say, where the writer has them; `paths`, the workspace's files.
 */
export function withRequires<T extends WizardDefinition>(
  def: T,
  agents?: ReadonlyMap<string, WizardAgent>,
  paths?: readonly string[],
): T {
  const requires = requiresOf(def, agents, paths);
  const { requires: _, steps, ...rest } = def;
  // `requires` stands before the steps, where people read it.
  return {
    ...rest,
    ...(Object.keys(requires).length ? { requires } : {}),
    steps,
  } as T;
}

/**
 * Where `requires.agents` is not what the agents' files say, one message per agent: an agent a
 * step uses whose entry is missing or differs from its file, an entry no step uses. An agent
 * without a file (or one that doesn't parse) is said by the step that names it, not here.
 */
export function agentsMismatch(
  def: WizardDefinition,
  agents: ReadonlyMap<string, WizardAgent>,
): { name: string; message: string }[] {
  const have = def.requires?.agents ?? {};
  const used = new Set(wizardAgentsUsed(def));
  const out: { name: string; message: string }[] = [];
  const said = (needs: AgentNeeds[string]) =>
    `models ${JSON.stringify(needs.models)}, tools ${JSON.stringify(needs.tools ?? [])}`;
  for (const name of used) {
    const agent = agents.get(name);
    if (!agent) {
      continue;
    }
    const want = agentNeedsOf(agent);
    const entry = have[name];
    if (!entry) {
      out.push({
        name,
        message: `"requires.agents" has no "${name}": agents/${name}.md needs ${said(want)}.`,
      });
    } else if (JSON.stringify(normal(entry)) !== JSON.stringify(normal(want))) {
      out.push({
        name,
        message: `"requires.agents.${name}" says ${said(entry)}; agents/${name}.md needs ${said(want)}.`,
      });
    }
  }
  for (const name of Object.keys(have).sort()) {
    if (!used.has(name)) {
      out.push({ name, message: `"requires.agents.${name}": no step uses this agent.` });
    }
  }
  return out;
}

/**
 * Why a definition's `requires` is not what its steps need, or null when it is. `agents`: the
 * wizard's agents as their files say; where `requires.agents` differs from them, the message
 * names the agent. `paths`: the workspace's files, as for `requiresOf`.
 */
export function requiresProblem(
  def: WizardDefinition,
  agents?: ReadonlyMap<string, WizardAgent>,
  paths?: readonly string[],
): string | null {
  const mismatch = agents ? agentsMismatch(def, agents) : [];
  if (mismatch.length) {
    return mismatch.map((m) => m.message).join(" ");
  }
  const want = requiresOf(def, agents, paths);
  const have = def.requires ?? {};
  if (JSON.stringify(normal(have)) === JSON.stringify(normal(want))) {
    return null;
  }
  return `"requires" is not what the steps need; it is ${JSON.stringify(want)}.`;
}

/** A requires with its keys in one order and its lists sorted, for comparing. */
function normal(r: Requires | AgentNeeds[string]): Record<string, unknown> {
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

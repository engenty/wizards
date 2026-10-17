// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import {
  type AssetKind,
  conditionsOf,
  dataRef,
  type FieldKind,
  type Format,
  isOtherwise,
  listRef,
  type ModelClass,
  type PageStep,
  pluginToolOf,
  ruleMatches,
  type Step,
  type ToolId,
  templateRefs,
  type WizardDefinition,
} from "./definition.js";
import type { Capability } from "./marketplace.js";
import type { ClosedChoice } from "./run.js";

/**
 * What a wizard needs beyond a text model, and whether it runs where there is nothing else: a
 * WordPress site with the AI Client, no tools, no plugins, no media models (docs/plans/
 * wordpress-plugin.md, "The check"). One function, computed in the studio, on upload into the
 * plugin and by the gallery, so every place gives the same answer.
 */

/** Something a step wants beyond a text model, as a stable id every app can word. */
export type Need =
  | `tool:${ToolId}`
  | "mcp"
  | "connections"
  | `plugin:${string}`
  | `asset:${AssetKind}`
  | "film"
  /** A widget runs in the runtime's widget host; the standalone runner has none yet. */
  | "widget"
  | "widget:video"
  | `field:${Extract<FieldKind, "audio" | "connection" | "slot" | "location" | "image" | "file">}`
  /** A file the person gives that a later thinking step reads: reading documents is the runtime's. */
  | "field:file-read"
  | `format:${Format}`
  | "lists"
  | "memory"
  | "each";

export interface StepNeed {
  stepId: string;
  need: Need;
  /** The step cannot run without it; a soft need is left out and the step runs with less. */
  hard: boolean;
}

/** What the standalone runner can hand over of a thinking step's text itself. */
const BASE_FORMATS: ReadonlySet<Format> = new Set(["html", "md", "txt", "csv", "json"]);

/**
 * A program over the step's tools: where programs do not run, the step calls its tools one by
 * one and loses nothing. No need at all.
 */
const OPTIONAL_TOOLS: ReadonlySet<ToolId> = new Set(["code"]);

/** Tools the standalone runner has no way to run; `pages` only reads the space's pages, which it lacks. */
const HARD_TOOLS: ReadonlySet<ToolId> = new Set(["web_search", "browser", "sandbox", "image"]);

/**
 * Tools the standalone runner runs itself: a WordPress site reads a public page and calls a
 * public API through its own abilities (the plugin's `Engenty_Abilities`). No need at all.
 */
const RUNNER_TOOLS: ReadonlySet<ToolId> = new Set(["web_fetch", "http"]);

const MEMORY_RE = /\{\{\s*memory\b/;

/** The templates a step renders: what may name lists or the memory. */
function templatesOf(step: Step): string[] {
  switch (step.type) {
    case "agent":
      return [step.instructions, step.call ? JSON.stringify(step.call.input) : ""];
    case "generate":
      return [step.prompt, step.options?.style ?? ""];
    case "film":
      return [step.brief];
    case "widget":
    case "surface":
      return Object.values(step.data).map((ref) => `{{${dataRef(ref)}}}`);
    default:
      return [];
  }
}

/** Whether a thinking step that reads files may run after `index`. */
function readsFilesLater(def: WizardDefinition, index: number): boolean {
  return def.steps
    .slice(index + 1)
    .some((s) => (s.type === "agent" && !s.call) || s.type === "generate" || s.type === "film");
}

/** What one step wants beyond a text model. */
export function needs(step: Step, def: WizardDefinition): StepNeed[] {
  const out: StepNeed[] = [];
  const add = (need: Need, hard: boolean) => {
    const found = out.find((n) => n.need === need);
    if (found) {
      found.hard ||= hard;
    } else {
      out.push({ stepId: step.id, need, hard });
    }
  };
  const index = def.steps.indexOf(step);
  for (const template of templatesOf(step)) {
    if (MEMORY_RE.test(template)) {
      add("memory", true);
    }
    if (templateRefs(template).some((ref) => ref.startsWith("lists."))) {
      add("lists", true);
    }
  }
  switch (step.type) {
    case "page":
      for (const field of step.fields) {
        switch (field.kind) {
          case "audio":
            add("field:audio", Boolean(field.required));
            break;
          case "connection":
            add("field:connection", true);
            break;
          case "slot":
            add("field:slot", true);
            break;
          case "list":
            add("lists", true);
            break;
          case "location":
            add("field:location", false);
            break;
          case "image":
            add("field:image", false);
            break;
          case "file":
            if (readsFilesLater(def, index)) {
              add("field:file-read", true);
            } else {
              add("field:file", false);
            }
            break;
          default:
            break;
        }
        if (
          field.optionsFrom &&
          listRef(dataRef(field.optionsFrom).split(".").slice(0, 2).join("."))
        ) {
          add("lists", true);
        }
      }
      break;
    case "agent": {
      const tools = step.call ? [...step.tools, step.call.tool] : step.tools;
      for (const tool of tools) {
        const plugin = pluginToolOf(tool);
        if (plugin) {
          add(`plugin:${plugin.plugin}`, true);
        } else if (RUNNER_TOOLS.has(tool as ToolId) || OPTIONAL_TOOLS.has(tool as ToolId)) {
          // The site runs it, or the step does without.
        } else if (HARD_TOOLS.has(tool as ToolId)) {
          add(`tool:${tool as ToolId}`, true);
        } else {
          add(`tool:${tool as ToolId}`, false);
        }
      }
      if (step.mcp?.length) {
        add("mcp", true);
      }
      if (step.connections?.length) {
        add("connections", true);
      }
      if (step.each) {
        if (listRef(dataRef(step.each))) {
          add("lists", true);
        } else {
          add("each", false);
        }
      }
      break;
    }
    case "generate":
      // A document or a dashboard is HTML a text model writes in one call: the standalone runner
      // makes it too, and the browser prints it. Media need a model of their own.
      if (step.asset !== "document" && step.asset !== "dashboard") {
        add(`asset:${step.asset}`, true);
      }
      break;
    case "film":
      add("film", true);
      break;
    case "widget":
      add(step.video ? "widget:video" : "widget", true);
      break;
    case "surface":
      if (Object.values(step.data).some((ref) => listRef(dataRef(ref)))) {
        add("lists", true);
      }
      break;
    case "review":
      if (step.show.some((ref) => listRef(ref))) {
        add("lists", true);
      }
      break;
    case "result":
      for (const d of step.deliverables) {
        if (listRef(d.from)) {
          add("lists", true);
          continue;
        }
        const from = def.steps.find((s) => s.id === d.from);
        // What a media step, a widget or a film makes is the step's own need.
        const written =
          from?.type === "agent" ||
          (from?.type === "generate" && (from.asset === "document" || from.asset === "dashboard"));
        if (!written) {
          continue;
        }
        const stays = d.formats.some((f) => BASE_FORMATS.has(f));
        for (const f of d.formats) {
          if (BASE_FORMATS.has(f)) {
            continue;
          }
          // A PDF of a written text the runner makes in the browser (packages/runner/src/pdf.ts);
          // of a document the browser prints the HTML. The others fall away where another stays.
          if (f === "pdf" && from?.type === "agent") {
            continue;
          }
          add(`format:${f}`, f !== "pdf" && !stays);
        }
      }
      break;
  }
  return out;
}

export interface Fit {
  /** `full`: runs as is. `less`: the choices leading to a hard need are closed, soft needs are left out. `no`: a hard need on a step every run passes through. */
  fit: "full" | "less" | "no";
  notes: StepNeed[];
}

/** Whether a wizard runs on its own, with what left out. */
export function standaloneFit(def: WizardDefinition): Fit {
  const notes = def.steps.flatMap((s) => needs(s, def));
  if (def.lists?.length && !notes.some((n) => n.need === "lists")) {
    notes.push({ stepId: def.steps[0]?.id ?? "", need: "lists", hard: true });
  }
  if (def.connections?.length && !notes.some((n) => n.need === "connections")) {
    notes.push({ stepId: def.steps[0]?.id ?? "", need: "connections", hard: true });
  }
  const unavoidable = unavoidableSteps(def);
  const blocked = notes.some((n) => n.hard && unavoidable.has(n.stepId));
  return { fit: blocked ? "no" : notes.length ? "less" : "full", notes };
}

/** The gallery's capability a need stands for; none for what the gallery has no word for. */
export function capabilityOf(need: Need): Capability | null {
  switch (need) {
    case "tool:web_search":
    case "tool:web_fetch":
      return "web";
    case "tool:browser":
      return "browser";
    case "tool:sandbox":
      return "code";
    case "tool:image":
    case "asset:image":
      return "image";
    case "asset:video":
    case "film":
    case "widget:video":
      return "video";
    case "asset:voice":
      return "speech";
    case "field:audio":
      return "listening";
    case "tool:http":
    case "mcp":
    case "connections":
    case "field:connection":
      return "connectors";
    case "field:image":
    case "field:file":
    case "field:file-read":
      return "documents";
    default:
      return null;
  }
}

/**
 * The fit in the fields a marketplace entry already has, so the gallery's chips and entry
 * dialog draw it: `missing` is what the wizard cannot do without here (rose, "nicht
 * eingerichtet"), `optional` what it runs without (amber, "geht auch ohne"), `needs` the
 * plugins behind an account, `without` the result formats that fall away.
 */
export interface StandaloneFit extends Fit {
  missing: Capability[];
  optional: Capability[];
  needs: string[];
  without: Format[];
}

export function standaloneEntry(def: WizardDefinition): StandaloneFit {
  const fit = standaloneFit(def);
  const unavoidable = unavoidableSteps(def);
  const missing = new Set<Capability>();
  const optional = new Set<Capability>();
  const needs = new Set<string>();
  const without = new Set<Format>();
  for (const note of fit.notes) {
    if (note.need.startsWith("plugin:")) {
      needs.add(note.need.slice("plugin:".length));
      continue;
    }
    if (note.need.startsWith("format:")) {
      without.add(note.need.slice("format:".length) as Format);
      continue;
    }
    const capability = capabilityOf(note.need);
    if (!capability) {
      continue;
    }
    if (note.hard && unavoidable.has(note.stepId)) {
      missing.add(capability);
    } else {
      optional.add(capability);
    }
  }
  for (const c of missing) {
    optional.delete(c);
  }
  return {
    ...fit,
    missing: [...missing],
    optional: [...optional],
    needs: [...needs].sort(),
    without: [...without],
  };
}

// --- the steps every run passes through ------------------------------------------------------

/** The steps every run passes through: without one of them the end is not reachable. */
export function unavoidableSteps(def: WizardDefinition): Set<string> {
  return def.steps.length ? unavoidableFrom(def, def.steps[0].id, {}) : new Set();
}

/**
 * The steps every path from `from` to the end passes through. A rule on an answer in `known`
 * goes one way; a rule on anything else may go either way.
 */
export function unavoidableFrom(
  def: WizardDefinition,
  from: string,
  known: Record<string, unknown>,
): Set<string> {
  const index = new Map(def.steps.map((s, i) => [s.id, i]));
  const start = index.get(from) ?? 0;
  const successors = (i: number): number[] => {
    const out: number[] = [];
    for (const rule of def.steps[i].next ?? []) {
      if (isOtherwise(rule)) {
        continue;
      }
      const target = rule.goto === "end" ? def.steps.length : (index.get(rule.goto) ?? -1);
      if (rule.ask || !conditionsOf(rule.when).every((c) => c.field in known)) {
        if (target >= 0) {
          out.push(target);
        }
        continue;
      }
      if (ruleMatches(rule, known)) {
        // The first rule that matches decides; nothing after it is tried.
        return target >= 0 ? [...out, target] : out;
      }
    }
    // No rule matching goes on to the "otherwise" step, else the next (or ends after the last).
    out.push(otherwiseIndex(def, i, index));
    return out;
  };
  const reachesEnd = (without: number): boolean => {
    if (without === start) {
      return false;
    }
    const seen = new Set<number>([start]);
    const queue = [start];
    while (queue.length) {
      const i = queue.shift()!;
      if (i >= def.steps.length) {
        return true;
      }
      for (const j of successors(i)) {
        if (j !== without && !seen.has(j)) {
          seen.add(j);
          queue.push(j);
        }
      }
    }
    return false;
  };
  return new Set(def.steps.filter((_, i) => !reachesEnd(i)).map((s) => s.id));
}

/** Where step `i` goes when none of its rules holds, as an index; the length = the end. */
export function otherwiseIndex(
  def: WizardDefinition,
  i: number,
  index: Map<string, number>,
): number {
  const goto = def.steps[i].next?.find(isOtherwise)?.goto;
  if (goto === undefined) {
    return i + 1;
  }
  return goto === "end" ? def.steps.length : (index.get(goto) ?? i + 1);
}

// --- closed choices ---------------------------------------------------------------------------

/** The choices a page offers: each select's options, a toggle's on and off. */
export interface PageChoice {
  field: string;
  values: (string | boolean)[];
}

export function choicesOf(step: PageStep): PageChoice[] {
  return step.fields.flatMap((f): PageChoice[] => {
    if (f.kind === "select" && f.options?.length) {
      return [{ field: f.id, values: f.options }];
    }
    if (f.kind === "toggle") {
      return [{ field: f.id, values: [true, false] }];
    }
    return [];
  });
}

/**
 * The answers on a page that lead to a step this runtime cannot run: with them the run would
 * stop there, after what came before was paid for. `lacking` says per step what it lacks (model
 * classes on a runtime, needs on a standalone site). The answers given already count; the page's
 * other fields may still go either way. A choice whose every value leads there is left open: the
 * run cannot go around it, and the start already warned. `closedFields` are closed as a whole
 * (no values): a voice note nothing here can listen to.
 */
export function closedChoicesFor(
  def: WizardDefinition,
  step: PageStep,
  values: Record<string, unknown>,
  lacking: (step: Step) => ModelClass[],
  closedFields: (field: PageStep["fields"][number]) => ModelClass[] | null = () => null,
): Record<string, ClosedChoice> {
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const known = Object.fromEntries(
    Object.entries(values).filter(([id]) => !step.fields.some((f) => f.id === id)),
  );
  const out: Record<string, ClosedChoice> = {};
  for (const field of step.fields) {
    const whole = closedFields(field);
    if (whole) {
      out[field.id] = { values: [], classes: whole };
    }
  }
  for (const choice of choicesOf(step)) {
    const closed: ClosedChoice = { values: [], classes: [] };
    for (const value of choice.values) {
      const ahead = unavoidableFrom(def, step.id, { ...known, [choice.field]: value });
      const missing = [...ahead].flatMap((id) => {
        const s = byId.get(id);
        return s ? lacking(s) : [];
      });
      if (missing.length) {
        closed.values.push(value);
        closed.classes = [...new Set([...closed.classes, ...missing])];
      }
    }
    if (closed.values.length && closed.values.length < choice.values.length) {
      out[choice.field] = closed;
    }
  }
  return out;
}

/** The answer a closed choice gets instead: its first value that stays open. */
export function openValue(
  step: PageStep,
  field: string,
  closed: ClosedChoice,
): string | boolean | undefined {
  const choice = choicesOf(step).find((c) => c.field === field);
  return choice?.values.find((v) => !closed.values.some((c) => String(c) === String(v)));
}

import {
  type AssetKind,
  FIELD_KINDS,
  type FieldKind,
  type Step,
  type WizardDefinition,
} from "./definition.js";

/**
 * A runner is a door a wizard runs through: the stepped page, the chat, and the ones plugins
 * add (a call, a messenger). Each declares what it can take in and show; the runtime works out
 * per wizard which runners run it fully, which hand off at some step, and which cannot.
 */

/** What a step hands on, by the shape a runner has to carry: a text, a picture, a file, a view. */
export type OutputKind = AssetKind | "text" | "data" | "widget" | "film" | "surface";

export const OUTPUT_KINDS: OutputKind[] = [
  "text",
  "data",
  "image",
  "video",
  "voice",
  "document",
  "dashboard",
  "widget",
  "film",
  "surface",
];

export interface RunnerCapabilities {
  /** The field kinds the runner asks itself; the rest need another runner. */
  input: FieldKind[];
  output: {
    /** What it shows as it is: text in a thread, a picture on a screen. */
    shows: OutputKind[];
    /** What it shows as a picture with a link to the real thing. Anything else is a link. */
    pictures: OutputKind[];
  };
  /** A sign-in is typed on a page the model never sees: only a browser can take it. */
  asks: ("confirm" | "login")[];
  review: ("accept" | "regenerate" | "edit")[];
  /** Stays through a step that takes minutes, with a note now and then. */
  waits: boolean;
  /** How a link to the run page reaches the person for what the runner cannot do itself. */
  handoff: ("screen" | "thread" | "sms" | "push")[];
}

export interface RunnerInfo {
  /** Lower case, digits and "-": the sub-path of the wizard's address, `/w/<token>/<id>`. */
  id: string;
  label: { de: string; en: string };
  /** A page the person opens, or a channel with an address of its own (a number, a bot). */
  kind: "page" | "channel";
  capabilities: RunnerCapabilities;
  /** Ships with the runtime: steps and chat. */
  builtIn?: boolean;
  /** The plugin that registered it. */
  plugin?: string;
  /** Why the runner cannot be used here right now (a model not set up); null when it can. */
  problem?: string | null;
  /**
   * What kind of problem: `setup` (to set up, the default), `waiting` (asked for, waiting for
   * someone else), `plan` (not in the tenant's plan).
   */
  problemKind?: "setup" | "waiting" | "plan";
  /** What the share dialog's row says about the problem, instead of its own words. */
  problemNote?: { de: string; en: string } | null;
  /** `plan`: the plan that has it. */
  problemPlan?: string | null;
}

export const RUNNER_ID = /^[a-z][a-z0-9-]{0,23}$/;

/** Sub-paths of a wizard's address that are not runners. */
export const RESERVED_PATHS = ["runs", "icons", "manifest.webmanifest", "avatar.svg"];

const EVERYTHING: RunnerCapabilities = {
  input: [...FIELD_KINDS],
  output: { shows: [...OUTPUT_KINDS], pictures: [] },
  asks: ["confirm", "login"],
  review: ["accept", "regenerate", "edit"],
  waits: true,
  handoff: ["screen", "push"],
};

/** The runners every runtime has: the page draws every field kind, so both run every wizard. */
export const BUILT_IN_RUNNERS: RunnerInfo[] = [
  {
    id: "steps",
    label: { de: "Schritte", en: "Steps" },
    kind: "page",
    capabilities: EVERYTHING,
    builtIn: true,
  },
  {
    id: "chat",
    label: { de: "Chat", en: "Chat" },
    kind: "page",
    capabilities: EVERYTHING,
    builtIn: true,
  },
  // The chat with a live conversation on top: the screen beside it takes what a voice cannot.
  {
    id: "talk",
    label: { de: "Sprachgespräch", en: "Live voice" },
    kind: "page",
    capabilities: EVERYTHING,
    builtIn: true,
  },
  // The call screen: the camera and the conversation on a stage, the chat as the screen beside it.
  {
    id: "video",
    label: { de: "Videoanruf", en: "Video call" },
    kind: "page",
    capabilities: EVERYTHING,
    builtIn: true,
  },
];

/** The built-in runners that hold a live conversation: offered only where a speech model is set up. */
export const CONVERSATION_RUNNERS = ["talk", "video"];

/** The runners every wizard offers until the owner says otherwise. */
export const DEFAULT_ENABLED = ["steps", "chat"];

export const DEFAULT_RUNNER = "steps";

/** How a wizard is offered: the runner its link opens, and the ones switched on beside it. */
export interface RunnerSettings {
  default: string;
  enabled: string[];
}

export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  default: DEFAULT_RUNNER,
  enabled: DEFAULT_ENABLED,
};

/** A step a runner cannot take itself, and why. */
export interface RunnerGap {
  stepId: string;
  title: string;
  /** What the step needs, as the owner reads it: a field's label, "a sign-in", "to be looked at". */
  why: string;
}

export interface RunnerFit {
  runner: string;
  /** `full`: every step native. `handoff`: some steps on the run page. `no`: a step nobody can take. */
  outcome: "full" | "handoff" | "no";
  steps: RunnerGap[];
}

/** What a step hands on, or null when it hands on nothing (a page, a review, the result). */
export function outputKindOf(step: Step): OutputKind | null {
  switch (step.type) {
    case "agent":
      return step.output?.fields?.length || step.output?.schema ? "data" : "text";
    case "generate":
      return step.asset;
    case "widget":
      return step.video ? "film" : "widget";
    case "film":
      return "film";
    case "surface":
      return "surface";
    default:
      return null;
  }
}

/** Steps that take minutes: a door that cannot wait must come back for them. */
function takesMinutes(step: Step): boolean {
  return step.type === "agent" || step.type === "generate" || step.type === "film";
}

/**
 * Whether a runner runs a wizard, and where it hands off. Every step counts: since the AI can
 * decide which branch a run takes and which fields a page shows, each step may be reached.
 */
export function runnerFit(def: WizardDefinition, runner: RunnerInfo): RunnerFit {
  const caps = runner.capabilities;
  const gaps: RunnerGap[] = [];
  let blocked = false;
  const canHandOff = caps.handoff.length > 0;
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const carries = (kind: OutputKind | null) =>
    kind === null || caps.output.shows.includes(kind) || caps.output.pictures.includes(kind);
  for (const step of def.steps) {
    if (step.type === "page") {
      // A decided field may or may not be shown: it counts as if it were.
      const missing = step.fields.filter((f) => !caps.input.includes(f.kind));
      const login =
        step.fields.some((f) => f.kind === "connection") && !caps.asks.includes("login");
      if (missing.length || login) {
        const why = missing.map((f) => f.label).join(", ") || "a sign-in";
        gaps.push({ stepId: step.id, title: step.title, why });
        if (!canHandOff) {
          blocked = true;
        }
      }
    } else if (step.type === "review") {
      if (!caps.review.includes("accept")) {
        gaps.push({ stepId: step.id, title: step.title, why: "to be looked at" });
        blocked = true;
        continue;
      }
      const unseen = step.show.filter((id) => !carries(outputKindOf(byId.get(id) ?? step)));
      if (unseen.length) {
        gaps.push({
          stepId: step.id,
          title: step.title,
          why: unseen.map((id) => byId.get(id)?.title ?? id).join(", "),
        });
        if (!canHandOff) {
          blocked = true;
        }
      }
    } else if (takesMinutes(step) && !caps.waits) {
      gaps.push({ stepId: step.id, title: step.title, why: "takes minutes" });
      blocked = true;
    }
    // A sign-in a running step meets (an ask of kind login) can only be typed in a browser; it
    // is not known in advance, so it hands off when it happens.
  }
  return {
    runner: runner.id,
    outcome: blocked ? "no" : gaps.length ? "handoff" : "full",
    steps: gaps,
  };
}

/** The fit of every runner given, in the order given. */
export function runnersFor(def: WizardDefinition, runners: RunnerInfo[]): RunnerFit[] {
  return runners.map((r) => runnerFit(def, r));
}

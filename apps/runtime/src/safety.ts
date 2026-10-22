import type { ChoiceQuestion } from "@engenty/wizards-shared/decision";
import { note } from "@engenty/wizards-shared/run";
import { decide } from "./engine/decide.js";
import { NotedError } from "./model-errors.js";
import type { CallMeta } from "./models.js";
import { prompt, promptSections } from "./prompts.js";

/**
 * The content rules, in one place. `prompts/safety.md` holds them: its `policy` goes into the
 * system prompts, and its `check.*` sections are the question asked here before anything is
 * generated. Every image, video and speech generation passes `checkContent` (media/generate.ts),
 * whichever step, tool or route asked for it.
 *
 * The decision model answers first (Jev: fast, with probabilities), the classifier class's model
 * where there is none. A check that cannot run stops the generation: nothing is made unchecked.
 */

export type ContentKind = "image" | "video" | "speech" | "wizard";

/** A request the content rules stop; `rule` is the criterion it broke. */
export class ContentBlockedError extends NotedError {
  constructor(
    readonly rule: string,
    readonly kind: ContentKind,
  ) {
    super(note("contentBlocked"));
  }
}

const CRITERION = "check.criterion.";

/** The question, read from safety.md on every call so an edit applies at once from source. */
export function contentQuestion(): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const [name, text] of promptSections("safety")) {
    if (name.startsWith(CRITERION)) criteria[name.slice(CRITERION.length)] = text;
  }
  if (!("allowed" in criteria)) throw new Error("prompts/safety.md: no check.criterion.allowed");
  return { type: "choice", instructions: prompt("safety", "check.instructions"), criteria };
}

/** The rules for a system prompt. */
export function contentPolicy(): string {
  return prompt("safety", "policy");
}

/** Throws ContentBlockedError when the request breaks a content rule. */
export async function checkContent(input: {
  kind: ContentKind;
  text: string;
  call?: CallMeta;
  signal?: AbortSignal;
}): Promise<void> {
  let rule: string;
  try {
    const decision = await decide({
      state: { kind: input.kind, request: input.text },
      questions: { rule: contentQuestion() },
      call: input.call,
      signal: input.signal,
    });
    const answer = decision.answers.rule;
    rule = answer?.type === "choice" ? answer.choice : "unanswered";
  } catch (err) {
    if (input.signal?.aborted) throw err;
    throw new NotedError(
      note("contentCheckFailed", { detail: (err as Error).message || String(err) }),
    );
  }
  if (rule !== "allowed") {
    console.warn(`[safety] ${input.kind} stopped: ${rule}`);
    throw new ContentBlockedError(rule, input.kind);
  }
}

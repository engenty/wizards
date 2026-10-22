import { note } from "@engenty/wizards-shared/run";
import { decide } from "./engine/decide.js";
import { NotedError } from "./model-errors.js";
import type { CallMeta } from "./models.js";
import { prompt } from "./prompts.js";

/**
 * The content rules, in one place. `prompts/safety.md` holds them: its `policy` goes into the
 * system prompts, and `check` asks whether a request breaks them. Every image, video and speech
 * generation passes `checkContent` (media/generate.ts), whichever step, tool or route asked.
 *
 * The decision model answers first (Jev: fast, with probabilities), the classifier class's model
 * where there is none. A check that cannot run stops the generation: nothing is made unchecked.
 */

export type ContentKind = "image" | "video" | "speech";

/** A request the content rules stop. */
export class ContentBlockedError extends NotedError {
  constructor(readonly kind: ContentKind) {
    super(note("contentBlocked"));
  }
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
  let breaks: boolean;
  try {
    const decision = await decide({
      state: { kind: input.kind, request: input.text },
      questions: {
        breaks: {
          type: "noul",
          instructions: prompt("safety", "check", { policy: contentPolicy() }),
        },
      },
      call: input.call,
      signal: input.signal,
    });
    const answer = decision.answers.breaks;
    // No usable answer counts as a yes: nothing is made unchecked.
    breaks = answer?.type === "noul" ? answer.noul >= 0.5 : true;
  } catch (err) {
    if (input.signal?.aborted) throw err;
    throw new NotedError(
      note("contentCheckFailed", { detail: (err as Error).message || String(err) }),
    );
  }
  if (breaks) {
    console.warn(`[safety] ${input.kind} stopped`);
    throw new ContentBlockedError(input.kind);
  }
}

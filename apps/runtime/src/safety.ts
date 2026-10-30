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

export type ContentKind = "image" | "video" | "speech" | "text" | "input" | "injection";

/**
 * A run of someone without an account: a guest on a public wizard. What it makes is checked
 * against the rules before it is kept, and stays private (docs/plans/guest-content-guards.md).
 */
export const guestRun = (run: { mode: string; userId: string | null }) =>
  run.mode === "live" && !run.userId;

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

/**
 * Asks the decision model the questions about a text; the first one answered yes (or not at all)
 * names what stops it. Throws ContentBlockedError then, NotedError when no check could run.
 */
async function ask(
  state: Record<string, unknown>,
  questions: Partial<Record<ContentKind, string>>,
  meta: { call?: CallMeta; signal?: AbortSignal },
): Promise<void> {
  let stopped: ContentKind | undefined;
  try {
    const decision = await decide({
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([kind, instructions]) => [
          kind,
          { type: "noul" as const, instructions: instructions ?? "" },
        ]),
      ),
      call: meta.call,
      signal: meta.signal,
    });
    // No usable answer counts as a yes: nothing is made unchecked.
    stopped = (Object.keys(questions) as ContentKind[]).find((kind) => {
      const answer = decision.answers[kind];
      return answer?.type === "noul" ? answer.noul >= 0.5 : true;
    });
  } catch (err) {
    if (meta.signal?.aborted) throw err;
    throw new NotedError(
      note("contentCheckFailed", { detail: (err as Error).message || String(err) }),
    );
  }
  if (stopped) {
    console.warn(`[safety] ${stopped} stopped`);
    throw new ContentBlockedError(stopped);
  }
}

/** Throws ContentBlockedError when an image, video or speech request breaks a content rule. */
export async function checkContent(input: {
  kind: "image" | "video" | "speech";
  text: string;
  call?: CallMeta;
  signal?: AbortSignal;
}): Promise<void> {
  await ask(
    { kind: input.kind, request: input.text },
    { [input.kind]: prompt("safety", "check", { policy: contentPolicy() }) },
    input,
  );
}

/** Throws ContentBlockedError when what an AI step wrote for a guest breaks a content rule. */
export async function checkGuestText(input: {
  text: string;
  call?: CallMeta;
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.text.trim()) return;
  await ask(
    { text: input.text.slice(0, 20_000) },
    { text: prompt("safety", "check_text", { policy: contentPolicy() }) },
    input,
  );
}

/**
 * Throws ContentBlockedError when a guest's answers ask for what the rules forbid (`input`) or
 * try to change what the AI is told to do (`injection`). One call for both.
 */
export async function checkGuestInput(input: {
  text: string;
  call?: CallMeta;
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.text.trim()) return;
  await ask(
    { answers: input.text.slice(0, 20_000) },
    {
      input: prompt("safety", "check_input.rules", { policy: contentPolicy() }),
      injection: prompt("safety", "check_input.override"),
    },
    input,
  );
}

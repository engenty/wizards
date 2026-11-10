import type { AskResult } from "@engenty/wizards-engine/types";
import type { AskInput, RunState } from "@engenty/wizards-shared/run";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { feature, remoteFeatures } from "../features.js";
import type { Where } from "./call.js";

/*
 * What a run did outside happens once, behind `durableRuns`. A run can start again after a crash
 * and a step with it, so a mail may have left already. Each action that is no read has a row in
 * `run_effect`, written before it acts. Found `done`: the stored output, no action. Found
 * `started`: it may have happened, so a person decides, and without one the call answers so.
 * `failed`: the service said no, and it may be tried again.
 *
 * Not an input's hash: a model asked again words its input differently, and a loop's real repeat
 * has the same input and must act. So the identity is the call's own:
 *
 * - An agent step's call: `<turn>:<toolCallId>`. A durable turn keeps its tool call ids across a
 *   recovery. An agent step without a turn has new ones after a restart, so nothing can match
 *   them: it gets no row and repeats as it always did.
 * - A fixed `call` step: `<run>:<step>:<visit>`. It makes one call per visit, and the visit is
 *   counted on the run before it acts (`enterVisit`).
 *
 * - A program's call in a durable turn: the program's tool call id, what it calls with what input,
 *   and how often it did so before (`toolCallIdOf`). A crash repeats the whole program, and each of
 *   its writes finds its row. A program that changes its input, say with the time, acts again.
 *
 * No other call has an identity: a plugin's own calls.
 */

/** Which call this is, as far as the caller knows. */
export interface EffectCall {
  /** The durable turn the call is made in. */
  turn?: string;
  toolCallId?: string;
  /** A fixed step's visit, from `RunState.visits`. */
  visit?: number;
}

/** A row's id; null where this call is not recorded. */
export async function effectIdOf(where: Where, call?: EffectCall): Promise<string | null> {
  if (!(call && where.runId && where.stepId)) {
    return null;
  }
  let id: string | null = null;
  if (call.toolCallId) {
    id = call.turn ? `${call.turn}:${call.toolCallId}` : null;
  } else if (call.visit) {
    id = `${where.runId}:${where.stepId}:${call.visit}`;
  }
  return id && (await effectsOn()) ? id : null;
}

/** Whether what a run does is made to last: the switch of this whole plan. */
export async function effectsOn(): Promise<boolean> {
  return feature("durableRuns", await remoteFeatures().catch(() => null));
}

/**
 * A fixed step that calls a connection counts its visit on the run before it acts: a restart finds
 * `visiting` and keeps the number, a loop, a regenerate or going back has cleared it and gets a new
 * one. True when `state` changed and has to be written.
 */
export async function enterVisit(
  step: { id: string; type: string; call?: object },
  state: RunState,
): Promise<boolean> {
  if (step.type !== "tool" || !step.call || !("connection" in step.call)) {
    return false;
  }
  if (state.visiting === step.id || !(await effectsOn())) {
    return false;
  }
  state.visiting = step.id;
  state.visits = { ...state.visits, [step.id]: (state.visits?.[step.id] ?? 0) + 1 };
  return true;
}

export function findEffect(id: string) {
  return db.query.runEffect.findFirst({ where: eq(schema.runEffect.id, id) });
}

/**
 * Takes the row before an action: new, or one that failed. False when another process holds it,
 * which then counts as `started`. Throws where the row can't be written: no action without it.
 */
export async function startEffect(row: {
  id: string;
  runId: string;
  stepId: string;
  tool: string;
}): Promise<boolean> {
  const at = new Date();
  const taken = await db
    .insert(schema.runEffect)
    .values({ ...row, state: "started", output: null, at })
    .onConflictDoUpdate({
      target: schema.runEffect.id,
      set: { state: "started", at },
      setWhere: eq(schema.runEffect.state, "failed"),
    })
    .returning({ id: schema.runEffect.id });
  return taken.length > 0;
}

/**
 * The action ran. A row that can't be written stays `started`, which says the truth for a later
 * look: it may have happened.
 */
export async function effectDone(id: string, output: unknown): Promise<void> {
  try {
    await db
      .update(schema.runEffect)
      .set({ state: "done", output: output ?? null, at: new Date() })
      .where(eq(schema.runEffect.id, id));
  } catch (err) {
    console.error(`[broker] effect ${id} could not be kept:`, err);
  }
}

/** Errors that say the service gave no answer: the request may have arrived all the same. */
const NO_ANSWER = /fetch failed|timed? ?out|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR/i;

/**
 * The action threw. A service that answered with an error did nothing: `failed`, and it may be
 * tried again. Without an answer nobody knows, so the row stays `started`.
 */
export async function effectThrew(id: string, err: unknown): Promise<void> {
  const { name, message, cause } = (err ?? {}) as {
    name?: string;
    message?: string;
    cause?: { code?: string };
  };
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    NO_ANSWER.test(`${message ?? String(err)} ${cause?.code ?? ""}`)
  ) {
    return;
  }
  try {
    await db
      .update(schema.runEffect)
      .set({ state: "failed", at: new Date() })
      .where(and(eq(schema.runEffect.id, id), eq(schema.runEffect.state, "started")));
  } catch (failed) {
    console.error(`[broker] effect ${id} could not be kept:`, failed);
  }
}

/**
 * Asks whether an action that may have happened should happen again. Only a person's yes repeats
 * it; nobody there to ask is a no.
 */
export async function askAgain(
  ask: ((ask: AskInput) => Promise<AskResult | null>) | undefined,
  what: {
    service: string;
    actionId: string;
    summary: string;
    destructive: boolean;
    input: string;
  },
): Promise<"again" | "not_again" | "nobody"> {
  const answer = await ask?.({
    kind: "confirm",
    again: true,
    once: true,
    reason: what.summary,
    service: what.service,
    action: { id: what.actionId, summary: what.summary, destructive: what.destructive },
    input: what.input,
  });
  if (!answer) {
    return "nobody";
  }
  return answer.type === "done" ? "again" : "not_again";
}

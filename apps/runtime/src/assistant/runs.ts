import type { AssistantSignal } from "@engenty-wizards/shared/assistant";

/**
 * The studio assistant's turns while they run, and what the person writes meanwhile. A message
 * sent into a running turn waits here until the turn takes it: before its next model step, or
 * after its answer. One web process holds the turn and takes the messages (like browser.ts).
 */

interface Running {
  userId: string;
  inbox: AssistantSignal[];
}

const running = new Map<string, Running>();

export function startRun(runId: string, userId: string): void {
  running.set(runId, { userId, inbox: [] });
}

export function endRun(runId: string): void {
  running.delete(runId);
}

/** Puts a message into the person's running turn; false when that turn is over. */
export function signalRun(userId: string, runId: string, signal: AssistantSignal): boolean {
  const run = running.get(runId);
  if (!run || run.userId !== userId) {
    return false;
  }
  run.inbox.push(signal);
  return true;
}

/** The messages that came in since the turn last looked, oldest first. */
export function takeSignals(runId: string): AssistantSignal[] {
  const run = running.get(runId);
  if (!run?.inbox.length) {
    return [];
  }
  return run.inbox.splice(0);
}

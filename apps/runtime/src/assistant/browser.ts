import { BROWSER_TOOL_TIMEOUT_MS } from "@engenty/wizards-shared/assistant";

/**
 * Tools the browser runs for the studio assistant. The turn stays open: the runtime sends
 * `tool_call` on the stream that is already open and waits here until the browser posts the
 * result (POST /api/studio/assistant/tool/:callId). An installed AI client's MCP call simply
 * waits meanwhile. One web process holds the turn and takes the result.
 */

interface Waiting {
  userId: string;
  resolve(result: unknown): void;
}

const waiting = new Map<string, Waiting>();

/** The browser's answer to `callId`; a note for the model when it gives none in time. */
export function awaitBrowser(
  userId: string,
  callId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve) => {
    const done = (result: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      waiting.delete(callId);
      resolve(result);
    };
    const aborted = () => done({ error: "The person closed the page." });
    const timer = setTimeout(
      () => done({ error: "The page did not answer in time; it may be closed or busy." }),
      BROWSER_TOOL_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", aborted, { once: true });
    waiting.set(callId, { userId, resolve: done });
  });
}

/** Hands the browser's result to the turn that waits for it; false when none does. */
export function answerBrowser(userId: string, callId: string, result: unknown): boolean {
  const found = waiting.get(callId);
  if (!found || found.userId !== userId) {
    return false;
  }
  found.resolve(result);
  return true;
}

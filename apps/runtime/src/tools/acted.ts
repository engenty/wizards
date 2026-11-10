import { descriptorOf } from "../broker/index.js";
import { type LogRow, summarizeInput, writeLog } from "../broker/log.js";
import type { RunResources } from "../engine/resources.js";
import { feature, remoteFeatures } from "../features.js";

/** Whether a tool only looks, by its descriptor: a tool without one, of any origin, counts as acting. */
export function onlyReads(name: string): boolean {
  return descriptorOf(name)?.kind === "read";
}

/**
 * Notes when a step's model uses a tool that may have done something. A retry starts the step from
 * the top, and such a step would do it again: a mail twice, an order twice. Nothing else tells: tool
 * call ids change with every try, so `run_effect` can't match them. That holds for a durable turn
 * too, whose failure drops its snapshot; only a crash goes on with its ids. `before`: what else to
 * do first, for a turn its mark on the row, because a later process has no `resources` to read.
 */
export function watchActions(
  tools: Record<string, unknown>,
  resources: Pick<RunResources, "acted">,
  before?: () => Promise<void>,
) {
  for (const [name, tool] of Object.entries(tools)) {
    if (onlyReads(name)) {
      continue;
    }
    const t = tool as { execute?: (...args: unknown[]) => unknown };
    const execute = t.execute;
    if (typeof execute === "function") {
      t.execute = async (...args: unknown[]) => {
        resources.acted = true;
        await before?.();
        return execute.apply(t, args);
      };
    }
  }
}

/** Who calls and where, as each line of the step's calls has it. */
export type LineBase = Pick<
  LogRow,
  "whoKind" | "whoId" | "runId" | "stepId" | "client" | "chatId" | "wizardId" | "spaceId"
>;

/** A URL without its query and fragment: either may carry a key. */
function withoutQuery(input: unknown): unknown {
  const url = (input as { url?: unknown } | null)?.url;
  if (typeof url !== "string") {
    return input;
  }
  try {
    const u = new URL(url);
    return { ...(input as object), url: `${u.origin}${u.pathname}` };
  } catch {
    return input;
  }
}

/** What came of a call, as the log's result: a tool hands most failures back as `{ error }`. */
function resultOf(output: unknown): string {
  return output && typeof output === "object" && "error" in output ? "error" : "ok";
}

/** Whether a run's requests go through the broker with the run's token, each tool call a line of its log. */
export async function runServicesOn(): Promise<boolean> {
  return feature("runServices", await remoteFeatures().catch(() => null));
}

/**
 * One line of the broker's log for each call of a step's tool, by its descriptor
 * (broker/registry.ts): what it is about, what it does, its kind. A tool whose calls have their
 * line elsewhere (`brokerCall`, `brokerHost`, the catalogue's gate) gets none here, nor does one
 * without a descriptor. Only with `runServices` on.
 */
export async function logCalls(tools: Record<string, unknown>, base: LineBase): Promise<void> {
  if (!(await runServicesOn())) {
    return;
  }
  for (const [name, tool] of Object.entries(tools)) {
    const descriptor = descriptorOf(name);
    const t = tool as { execute?: (...args: unknown[]) => unknown };
    const execute = t.execute;
    if (!descriptor || descriptor.logged === true || typeof execute !== "function") {
      continue;
    }
    const { logged } = descriptor;
    t.execute = async (...args: unknown[]) => {
      const [input] = args;
      if (logged?.(input)) {
        return execute.apply(t, args);
      }
      const started = Date.now();
      const line = (result: string, size: number | null) =>
        writeLog({
          at: new Date(started),
          durationMs: Date.now() - started,
          ...base,
          connectionId: descriptor.resource,
          actionId: descriptor.action,
          kind: descriptor.kind,
          inputSummary: summarizeInput(withoutQuery(input)),
          outcome: "allow",
          rule: null,
          reason: null,
          result,
          resultSize: size,
        });
      let output: unknown;
      try {
        output = await execute.apply(t, args);
      } catch (err) {
        const failed = (err as { code?: string })?.code ?? (err as Error)?.name ?? "error";
        await line(String(failed).slice(0, 40), null);
        throw err;
      }
      await line(resultOf(output), JSON.stringify(output ?? null)?.length ?? null);
      return output;
    };
  }
}

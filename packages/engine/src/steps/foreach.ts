import { type AgentStep, dataRef } from "@engenty/wizards-shared/definition";
import type { AssetRef, StepOutput } from "@engenty/wizards-shared/run";
import { note as runNote } from "@engenty/wizards-shared/run";
import { resolveRef, type TemplateScope } from "../template.js";
import { type StepContext, StepError } from "../types.js";
import { composeSurface, runAgentStep } from "./agent.js";

/** An agent step runs this many times at most with `foreach`; more entries are left out. */
const MAX_AGENT_ENTRIES = 20;

/** The entries an agent step with `foreach` runs for: rows of a table, entries of a list, list rows. */
export function agentEntries(step: AgentStep, ctx: StepContext): unknown[] {
  const ref = dataRef(step.foreach ?? "");
  const list = ref.match(/^lists\.([a-zA-Z][a-zA-Z0-9_]*)$/)?.[1];
  const value = list
    ? (ctx.scope.lists?.[list]?.rows ?? []).map((r) => r.cells)
    : resolveRef(ref, ctx.scope);
  return (Array.isArray(value) ? value : []).slice(0, MAX_AGENT_ENTRIES);
}

/** The step as one entry runs it. The view, if any, is composed once over the table of all entries. */
export function entryStep(step: AgentStep): AgentStep {
  return { ...step, foreach: undefined, output: { ...step.output, surface: false } };
}

/**
 * An entry's context: it reads its entry as {{item}} and runs in its own turn. The run's
 * services build an entry's tools over the same (apps/runtime/src/routes/run-services.ts).
 */
export function entryContext<C extends StepContext>(
  ctx: C,
  entries: unknown[],
  index: number,
  turn: string,
): C {
  const scope: TemplateScope = {
    ...ctx.scope,
    entry: { item: entries[index], index, count: entries.length },
  };
  return { ...ctx, scope, turn };
}

/**
 * An agent step with `foreach`: the step once per entry, one after the other, each reading its
 * entry as {{item}}. The results become one table — the entry's columns and the step's output
 * fields — and one text with a heading per entry.
 */
export async function runAgentEach(
  step: AgentStep,
  ctx: StepContext,
  agentPart?: string,
): Promise<StepOutput> {
  const entries = agentEntries(step, ctx);
  if (!entries.length) {
    throw new StepError(runNote("noEntriesStepWork"));
  }
  const single = entryStep(step);
  const rows: Record<string, unknown>[] = [];
  const texts: string[] = [];
  const assets: AssetRef[] = [];
  // `concurrency` entries at a time; the rows keep the entries' order.
  const outs = await inParallel([...entries.entries()], step.concurrency ?? 1, async ([index]) => {
    await ctx.emit("info", { code: "entry", params: { n: index + 1, total: entries.length } });
    // Each entry is a turn of its own, under the step's.
    return runAgentStep(
      single,
      entryContext(ctx, entries, index, `${ctx.turn}.${index}`),
      false,
      agentPart,
    );
  });
  for (const [index, item] of entries.entries()) {
    const out = outs[index];
    const own = item && typeof item === "object" ? (item as Record<string, unknown>) : { item };
    const json =
      out.json && typeof out.json === "object" ? (out.json as Record<string, unknown>) : {};
    rows.push({ ...own, ...json });
    const title = Object.values(own).find((v) => typeof v === "string") ?? `${index + 1}`;
    texts.push(`## ${String(title)}\n\n${out.text ?? ""}`.trim());
    assets.push(...(out.assets ?? []));
  }
  const json = { rows };
  const surface = Array.isArray(step.output.surface)
    ? { components: step.output.surface, data: json }
    : step.output.surface
      ? await composeSurface(
          {
            ...step,
            output: {
              ...step.output,
              schema: undefined,
              fields: [
                {
                  id: "rows",
                  kind: "table",
                  description: "One row per entry: its columns and the step's fields",
                },
              ],
            },
          },
          json,
          ctx,
        )
      : undefined;
  return {
    text: texts.join("\n\n"),
    json,
    ...(surface ? { surface } : {}),
    assets: assets.length ? assets : undefined,
    at: new Date().toISOString(),
  };
}

/** Runs `work` over the entries, a few at a time, results in order. */
export async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]);
      }
    }),
  );
  return out;
}

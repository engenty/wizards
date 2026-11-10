import type { FlowEvent, FlowResult } from "@engenty/wizards-shared/transition";
import { describe, expect, it, vi } from "vitest";
import stampPlugin from "../../../apps/runtime/test/fixtures/pinned-runs/plugins/pinned.js";
import * as pinned from "../../../apps/runtime/test/fixtures/pinned-runs/runs.js";
import { type MemoryRun, type MemoryTool, memoryHost } from "./memory-host.js";

/**
 * The runtime's six pinned runs (apps/runtime/test/pinned-runs.test.ts), on the engine alone: a
 * host in memory, no database, no runtime. They make the same moves and end with the same state,
 * log and model calls as the runner's.
 */

/** Every move `transition()` made, as "event ⇒ command → status", with its wizard's title. */
const moves = vi.hoisted(() => [] as { wizard: string; move: string }[]);
vi.mock("@engenty/wizards-shared/transition", async (original) => {
  const mod = await original<typeof import("@engenty/wizards-shared/transition")>();
  const eventOf = (e: FlowEvent) => `${e.kind}${"stepId" in e ? ` ${e.stepId}` : ""}`;
  const commandOf = ({ command, run }: FlowResult) => {
    switch (command.kind) {
      case "run":
      case "ask":
        return `${command.kind} ${command.step.id}`;
      case "decide":
        return `decide ${command.stepId} [${command.rules.join(",")}]`;
      case "fail":
        return `fail ${command.stepId}`;
      case "waitSignal":
        return `waitSignal ${command.name}:${command.key}`;
      case "sleep":
        return `sleep ${run.cursor}${run.state.pause ? ` (${run.state.pause.kind})` : ""}`;
      default:
        return `${command.kind} ${run.cursor}`;
    }
  };
  return {
    ...mod,
    transition: (...args: Parameters<typeof mod.transition>) => {
      const [def, , event] = args;
      const result = mod.transition(...args);
      moves.push({
        wizard: def.title,
        move: `${eventOf(event)} ⇒ ${commandOf(result)} → ${result.run.status}`,
      });
      return result;
    },
  };
});

/**
 * The moves as the engine makes them. The runner stands a run once more where a move left it (a
 * `resume` that changes nothing, after a step it ran and at the result); `advance` goes on from
 * the move itself.
 */
const byEngine = (pinnedMoves: string[]) =>
  pinnedMoves.filter(
    (m, i) =>
      !(
        m.startsWith("resume ⇒ ") &&
        i > 0 &&
        m.split(" ⇒ ")[1] === pinnedMoves[i - 1].split(" ⇒ ")[1]
      ),
  );

/** The test plugin's tools, by the name a step calls them with, as the runtime registers them. */
function pluginTools(id: string, plugin: typeof stampPlugin): Record<string, MemoryTool> {
  const tools: Record<string, MemoryTool> = {};
  const registerTool = (tool: {
    name: string;
    inputSchema: { parse(input: unknown): unknown };
    execute(input: unknown, ctx: unknown): unknown;
  }) => {
    tools[`${id}.${tool.name}`] = (input, call) =>
      tool.execute(tool.inputSchema.parse(input), call);
  };
  (plugin as (wizards: unknown) => void)({ server: { registerTool } });
  return tools;
}

const stamps = () => {
  const g = globalThis as { __pinnedStamps?: { run: string }[] };
  g.__pinnedStamps ??= [];
  return g.__pinnedStamps;
};

function runOf(run: pinned.PinnedRun, n: number): MemoryRun {
  return memoryHost(run.wizard, {
    runId: `run-pinned-${n}`,
    script: run.script,
    tools: pluginTools("pinned", stampPlugin),
  });
}

/** The run ended done, as the runner's did: its moves, the model's calls, its log and its state. */
function ended(mem: MemoryRun, run: pinned.PinnedRun) {
  expect(moves.filter((m) => m.wizard === run.title).map((m) => m.move)).toEqual(
    byEngine(run.moves),
  );
  expect(mem.calls).toEqual(run.calls);
  expect(mem.lines).toEqual(run.log);
  const { cursor, status, wakeAt, state } = mem.row.run;
  expect({ cursor, status, wakeAt }).toEqual({ cursor: "done", status: "done", wakeAt: null });
  expect(state).toEqual(run.state);
}

describe("a pinned run, on the engine in memory", () => {
  it("1: a page, an agent that writes, an approval, the result", async () => {
    const run = pinned.pageAgentReview;
    const mem = runOf(run, 1);
    await mem.start();
    expect(mem.row.run).toMatchObject({ cursor: "ask", status: "waiting_input" });
    await mem.answer("ask", { topic: "otters" });
    expect(mem.row.run).toMatchObject({ cursor: "check", status: "waiting_input" });
    expect(mem.asked).toEqual(["ask", "check"]);
    await mem.review("check", true);
    ended(mem, run);
  });

  it("2: a decision step branches, and the other branch never runs", async () => {
    const run = pinned.decision;
    const mem = runOf(run, 2);
    await mem.start();
    await mem.answer("ask", { message: "Broken on arrival, I want my money back!" });
    ended(mem, run);
  });

  it("3: a tool step calls a plugin's tool once, with no model", async () => {
    const run = pinned.tool;
    const mem = runOf(run, 3);
    await mem.start();
    ended(mem, run);
    // The tool's one call, its input filled in: "3" became a number.
    expect(stamps().filter((s) => s.run === mem.host.runId)).toEqual([
      { run: mem.host.runId, step: "stamp", word: "ab", times: 3 },
    ]);
  });

  it("4: foreach runs an agent once per entry of a list", async () => {
    const run = pinned.foreach;
    const mem = runOf(run, 4);
    await mem.start();
    ended(mem, run);
  });

  it("5: a wait for a signal, and the signal comes", async () => {
    const run = pinned.signal;
    const mem = runOf(run, 5);
    await mem.start();
    expect(mem.row.run).toMatchObject({ cursor: "paid", status: "waiting_signal", wakeAt: null });
    expect(await mem.signal("order.paid", "order-7", { amount: 42, extra: "dropped" })).toBe(true);
    await mem.wake();
    ended(mem, run);
  });

  it("6: a step that fails once passes on its retry", async () => {
    const run = pinned.retry;
    const mem = runOf(run, 6);
    await mem.start();
    const asleep = mem.row.run;
    expect(asleep).toMatchObject({ cursor: "draft", status: "sleeping" });
    // FLOW_LIMITS.failureRetryMs (10 s) from now.
    expect(asleep.wakeAt! - mem.clock.now).toBe(10_000);
    expect(asleep.state).toEqual(pinned.retryAsleep);
    await mem.wake();
    ended(mem, run);
  });
});

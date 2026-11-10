import { advance } from "@engenty/wizards-engine/advance";
import type { Hold, Move, RunHost, RunStart, SignalCame, StepFailure } from "@engenty/wizards-engine/host";
import { RunMoved } from "@engenty/wizards-engine/host";
import type { StepContext } from "@engenty/wizards-engine/types";
import type { Decision } from "@engenty/wizards-shared/decision";
import { parseWizard, type Step, type WizardDefinition } from "@engenty/wizards-shared/definition";
import type { RunEventType, RunState, Said, StepOutput } from "@engenty/wizards-shared/run";
import { ServiceError, type Notice } from "@engenty/wizards-shared/run-services";
import { type FlowFailure, FlowRefused, type FlowRun } from "@engenty/wizards-shared/transition";
import { describe, expect, it } from "vitest";

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-10T09:00:00Z");

const base = { version: 1, title: "Advance", description: "", avatar: "round" };
const made = (id: string, more: object = {}) => ({
  id,
  type: "generate",
  title: id,
  asset: "image",
  prompt: "A picture.",
  ...more,
});
const page = (id: string, more: object = {}) => ({
  id,
  type: "form",
  title: id,
  fields: [{ id: `${id}A`, kind: "text", label: "A", required: true }],
  ...more,
});
const review = (id: string, show: string[], more: object = {}) => ({
  id,
  type: "review",
  title: id,
  show,
  ...more,
});
const end = (id = "done") => ({ id, type: "result", title: id, deliverables: [] });

function wizard(steps: unknown[]): WizardDefinition {
  const parsed = parseWizard({ ...base, steps });
  if (!parsed.ok) {
    throw new Error(parsed.issues.map((i) => i.message).join("; "));
  }
  return parsed.wizard;
}

const output = (stepId: string): StepOutput => ({ text: `made ${stepId}`, at: new Date(NOW).toISOString() });

interface Line {
  stepId: string | null;
  type: RunEventType;
  said: string;
}

/** A host in memory: the run's row in a variable, everything it is asked kept for the test to read. */
function memoryHost(def: WizardDefinition, more: Partial<MemoryOptions> = {}) {
  const o: MemoryOptions = {
    run: { cursor: null, status: "running", state: { values: {}, outputs: {}, history: [], notes: {} }, wakeAt: null },
    durable: true,
    effects: false,
    make: async (step) => output(step.id),
    sort: (err) => ({ kind: "failed", failure: failureOf(err), acted: false, said: String((err as Error).message) }),
    hold: "held",
    canSpend: true,
    start: null,
    stored: null,
    decide: (stepId) => ({ answers: { next: { type: "choice", choice: "r0" } }, source: "llm" }) as Decision,
    ...more,
  };
  let row = { run: structuredClone(o.run), rev: 1 };
  const host = {
    now: NOW,
    saves: [] as Move[],
    lines: [] as Line[],
    wakes: [] as (number | null)[],
    asked: [] as string[],
    watched: [] as string[],
    dropped: 0,
    notices: [] as Notice[],
    ran: [] as string[],
    contexts: [] as RunState[],
    decided: [] as string[],
    get row() {
      return row;
    },
    move(run: Partial<FlowRun>) {
      row = { run: { ...row.run, ...structuredClone(run) }, rev: row.rev + 1 };
    },
  };
  const abort = new AbortController();
  const runHost: RunHost = {
    runId: "run1",
    def,
    files: [],
    store: {
      load: async () => structuredClone(row),
      async save(move, rev) {
        if (rev !== row.rev) {
          throw new RunMoved();
        }
        host.saves.push(structuredClone(move));
        row = { run: structuredClone(move.run), rev: rev + 1 };
        return row.rev;
      },
    },
    turns: { load: async () => null, save: async () => {}, drop: async () => {} },
    clock: {
      now: () => host.now,
      wakeAt: async (at) => {
        host.wakes.push(at);
      },
    },
    event: async (stepId, type, said: Said) => {
      host.lines.push({ stepId, type, said: typeof said === "string" ? said : said.code });
    },
    ask: async (step) => {
      host.asked.push(step.id);
    },
    signals: {
      watch: async (stepId, name, key) => {
        host.watched.push(`${stepId} ${name} ${key}`);
        return o.stored;
      },
      drop: async () => {
        host.dropped++;
      },
    },
    credits: { hold: async () => o.hold, canSpend: async () => o.canSpend },
    start: async () => o.start,
    context: async (step, state, signal) => {
      host.contexts.push(structuredClone(row.run.state));
      return {
        runId: "run1",
        stepId: step.id,
        def,
        state,
        signal,
        services: {
          context: { prepareInputs: async () => {} },
          steps: {
            run: async (s: Step) => {
              host.ran.push(s.id);
              return o.make(s);
            },
          },
        },
      } as unknown as StepContext;
    },
    failure: async (err, _stepId, acted) => {
      if (err instanceof RunMoved) {
        throw err;
      }
      const sorted = o.sort(err);
      return sorted.kind === "failed" ? { ...sorted, acted: sorted.acted || acted } : sorted;
    },
    within: (_kind, work) => work(abort.signal),
    signal: abort.signal,
    services: {
      models: {
        decide: async (request: { stepId: string }) => {
          host.decided.push(request.stepId);
          return o.decide(request.stepId);
        },
      },
      people: {
        tell: async (notice: Notice) => {
          host.notices.push(notice);
        },
      },
      data: { counts: async () => ({}), rows: async () => ({ def: {}, rows: [] }) },
    } as unknown as RunHost["services"],
    switches: { durable: o.durable, effects: o.effects, lookAgainMs: 5 * MIN },
  };
  return { host, runHost, abort, o };
}

interface MemoryOptions {
  run: FlowRun;
  durable: boolean;
  effects: boolean;
  make: (step: Step) => Promise<StepOutput>;
  sort: (err: unknown) => StepFailure;
  hold: Hold;
  canSpend: boolean;
  start: RunStart | null;
  stored: SignalCame | null;
  decide: (stepId: string) => Decision;
}

function failureOf(err: unknown): FlowFailure {
  return err instanceof ServiceError ? err.failure : { class: "final" };
}

const types = (lines: Line[], stepId?: string) =>
  lines.filter((l) => stepId === undefined || l.stepId === stepId).map((l) => `${l.type} ${l.said}`);

describe("advance", () => {
  it("runs the automatic steps to the result and writes every move (run, end)", async () => {
    const def = wizard([made("a"), made("b"), end()]);
    const { host, runHost } = memoryHost(def);
    const result = await advance(runHost, { kind: "start" });
    expect(result.command).toEqual({ kind: "end" });
    expect(host.ran).toEqual(["a", "b"]);
    expect(host.row.run).toMatchObject({ cursor: "done", status: "done" });
    expect(host.row.run.state.outputs.b?.text).toBe("made b");
    // At the result: written at work there, then stood with `resume`.
    expect(host.saves.map((m) => [m.command?.kind ?? null, m.run.status])).toEqual([
      ["run", "running"],
      ["run", "running"],
      [null, "running"],
      ["end", "done"],
    ]);
    expect(types(host.lines)).toEqual(["step_started a", "step_done a", "step_started b", "step_done b"]);
  });

  it("asks a model which `ask` rule holds, and keeps the decision (decide)", async () => {
    const def = wizard([
      made("read", { next: [{ ask: "The person wants a refund", goto: "refund" }, { goto: "done" }] }),
      made("refund"),
      end(),
    ]);
    const { host, runHost } = memoryHost(def);
    await advance(runHost, { kind: "start" });
    expect(host.decided).toEqual(["read"]);
    expect(host.ran).toEqual(["read", "refund"]);
    expect(host.row.run.state.decisions?.read).toMatchObject({ rule: 0, source: "llm" });
    expect(host.saves.map((m) => m.command?.kind ?? null)).toEqual(["run", "decide", "run", null, "end"]);
    expect(types(host.lines, "read")).toContain("info deciding");
  });

  it("stands at a person's step, then goes on with the answer (ask)", async () => {
    const def = wizard([page("ask", { timeout: "2d" }), made("a"), end()]);
    const { host, runHost } = memoryHost(def);
    await advance(runHost, { kind: "start" });
    expect(host.row.run).toMatchObject({ cursor: "ask", status: "waiting_input", wakeAt: NOW + 2 * DAY });
    expect(host.asked).toEqual(["ask"]);
    expect(host.wakes).toEqual([NOW + 2 * DAY]);
    expect(types(host.lines)).toEqual(["wait runWaitsAnswerUntil"]);

    await advance(runHost, { kind: "answered", stepId: "ask", values: { askA: "x" } });
    expect(host.row.run).toMatchObject({ cursor: "done", status: "done" });
    expect(host.row.run.state.values).toEqual({ askA: "x" });
    expect(host.ran).toEqual(["a"]);
  });

  it("moves past a person's step when its time is up, and says so", async () => {
    const def = wizard([page("ask", { timeout: "2d" }), end()]);
    const { host, runHost } = memoryHost(def);
    await advance(runHost, { kind: "start" });
    host.now = NOW + 3 * DAY;
    await advance(runHost, { kind: "woke" });
    expect(host.row.run.status).toBe("done");
    expect(host.row.run.state.outputs.ask?.json).toEqual({ timedOut: true });
    expect(types(host.lines, "ask").slice(-2)).toEqual(["woken stepTimedOut", "step_done ask"]);
  });

  it("picks a page's decided fields once, as the run reaches it", async () => {
    const def = wizard([
      page("ask", {
        fields: [
          { id: "name", kind: "text", label: "Name" },
          { id: "vat", kind: "text", label: "VAT number", ask: "The person is a company" },
        ],
      }),
      end(),
    ]);
    const { host, runHost } = memoryHost(def, {
      decide: () => ({ answers: { f_vat: { type: "noul", noul: 0.9 } }, source: "llm" }) as Decision,
    });
    await advance(runHost, { kind: "start" });
    expect(host.decided).toEqual(["ask"]);
    expect(host.row.run.state.pages?.ask).toEqual({ shown: ["vat"] });
    expect(host.row.run).toMatchObject({ cursor: "ask", status: "waiting_input" });
    expect(host.saves.map((m) => [m.command?.kind ?? null, m.run.status])).toEqual([
      [null, "running"],
      [null, "running"],
      ["ask", "waiting_input"],
    ]);
  });

  it("fills a started run's page from its answers and passes its review", async () => {
    const def = wizard([page("ask"), made("a"), review("check", ["a"]), end()]);
    const run: FlowRun = {
      cursor: null,
      status: "running",
      state: { values: {}, outputs: {}, history: [], notes: {}, fill: { askA: "from the start" } },
      wakeAt: null,
    };
    const { host, runHost } = memoryHost(def, { run, start: { passReviews: true } });
    await advance(runHost, { kind: "start" });
    expect(host.row.run.status).toBe("done");
    expect(host.row.run.state.values).toEqual({ askA: "from the start" });
    expect(host.asked).toEqual([]);
  });

  it("waits for the owner when the start can't fill the page", async () => {
    const def = wizard([page("ask"), end()]);
    const { host, runHost } = memoryHost(def, { start: { passReviews: true } });
    await advance(runHost, { kind: "start" });
    expect(host.row.run).toMatchObject({ cursor: "ask", status: "waiting_input" });
    expect(host.asked).toEqual(["ask"]);
  });

  it("sleeps at a wait, stays on an early wake, goes on when due (sleep, stay)", async () => {
    const def = wizard([made("send"), { id: "pause", type: "wait", title: "Pause", for: "3d" }, made("remind"), end()]);
    const { host, runHost } = memoryHost(def);
    await advance(runHost, { kind: "start" });
    expect(host.row.run).toMatchObject({ cursor: "pause", status: "sleeping", wakeAt: NOW + 3 * DAY });
    expect(types(host.lines, "pause")).toEqual(["step_started Pause", "wait runWaitsUntil"]);

    host.now = NOW + DAY;
    const saves = host.saves.length;
    const early = await advance(runHost, { kind: "woke" });
    expect(early.command).toEqual({ kind: "stay" });
    expect(host.saves.length).toBe(saves);
    expect(host.wakes.at(-1)).toBe(NOW + 3 * DAY);

    host.now = NOW + 3 * DAY;
    await advance(runHost, { kind: "woke" });
    expect(host.row.run.status).toBe("done");
    expect(host.ran).toEqual(["send", "remind"]);
    expect(types(host.lines, "pause").slice(-2)).toEqual(["woken runWaitOver", "step_done Pause"]);
  });

  it("holds credits on a wake: refused waits for a top-up, unsure keeps the time due", async () => {
    const def = wizard([{ id: "pause", type: "wait", title: "Pause", for: "1d" }, made("a"), end()]);
    const unsure = memoryHost(def, { hold: "unsure" });
    await advance(unsure.runHost, { kind: "start" });
    unsure.host.now = NOW + 2 * DAY;
    const saves = unsure.host.saves.length;
    await advance(unsure.runHost, { kind: "woke" });
    expect(unsure.host.saves.length).toBe(saves);
    expect(unsure.host.wakes.at(-1)).toBe(NOW + DAY);

    const refused = memoryHost(def, { hold: "refused" });
    await advance(refused.runHost, { kind: "start" });
    refused.host.now = NOW + 2 * DAY;
    await advance(refused.runHost, { kind: "woke" });
    expect(refused.host.row.run).toMatchObject({ cursor: "a", status: "sleeping" });
    expect(refused.host.row.run.state.pause).toEqual({ kind: "credits" });
    expect(refused.host.row.run.state.outputs.pause?.json).toEqual({ waited: true });
    expect(refused.host.notices).toMatchObject([{ kind: "needs_you", waitKey: "pause:credits" }]);
    expect(refused.host.ran).toEqual([]);
  });

  it("registers a signal wait and goes on with the signal (waitSignal)", async () => {
    const def = wizard([
      made("send"),
      { id: "reply", type: "wait", title: "Reply", signal: { name: "mail.reply", key: "thread:1", timeout: "3d" } },
      made("answer"),
      end(),
    ]);
    const { host, runHost } = memoryHost(def);
    await advance(runHost, { kind: "start" });
    expect(host.row.run).toMatchObject({ cursor: "reply", status: "waiting_signal", wakeAt: NOW + 3 * DAY });
    expect(host.watched).toEqual(["reply mail.reply thread:1"]);
    expect(types(host.lines, "reply")).toEqual(["step_started Reply", "wait runWaitsSignalUntil"]);

    await advance(runHost, { kind: "signal", stepId: "reply", id: "s1", data: { text: "yes" } });
    expect(host.row.run.status).toBe("done");
    expect(host.row.run.state.outputs.reply?.json).toEqual({ came: true, timedOut: false, data: { text: "yes" } });
    expect(host.dropped).toBe(1);
    expect(host.wakes.at(-1)).toBeNull();
    expect(types(host.lines, "reply").slice(-2)).toEqual(["info signalCame", "step_done Reply"]);
  });

  it("takes a signal that came before the wait, without standing there", async () => {
    const def = wizard([
      { id: "reply", type: "wait", title: "Reply", signal: { name: "mail.reply", key: "thread:1" } },
      end(),
    ]);
    const { host, runHost } = memoryHost(def, { stored: { id: "s0", data: null } });
    await advance(runHost, { kind: "start" });
    expect(host.row.run.status).toBe("done");
    expect(host.saves.map((m) => m.run.status)).toEqual(["running", "done"]);
    expect(host.dropped).toBe(1);
    expect(types(host.lines, "reply")).toEqual(["step_started Reply", "info signalCame", "step_done Reply"]);
  });

  it("looks for a stored signal when the clock wakes the wait", async () => {
    const def = wizard([
      { id: "reply", type: "wait", title: "Reply", signal: { name: "mail.reply", key: "thread:1", timeout: "1d" } },
      end(),
    ]);
    const memory = memoryHost(def);
    await advance(memory.runHost, { kind: "start" });
    memory.o.stored = { id: "s1", data: { ok: true } };
    await advance(memory.runHost, { kind: "woke" });
    expect(memory.host.row.run.state.outputs.reply?.json).toMatchObject({ came: true });
  });

  it("sleeps for a retry and runs the step again when woken", async () => {
    const def = wizard([made("a"), end()]);
    let tries = 0;
    const { host, runHost } = memoryHost(def, {
      make: async (step) => {
        tries++;
        if (tries === 1) {
          throw new ServiceError({ class: "retry", retryAfterMs: null }, "busy");
        }
        return output(step.id);
      },
    });
    await advance(runHost, { kind: "start" });
    expect(host.row.run).toMatchObject({ cursor: "a", status: "sleeping", wakeAt: NOW + MIN });
    expect(host.row.run.state.pause).toEqual({ kind: "retry" });
    expect(types(host.lines, "a")).toEqual(["step_started a", "info stepRetries"]);

    host.now = NOW + MIN;
    await advance(runHost, { kind: "woke" });
    expect(host.row.run.status).toBe("done");
    expect(host.row.run.state.pause).toBeUndefined();
    expect(tries).toBe(2);
  });

  it("waits for a sign-in, and tells the person once", async () => {
    const def = wizard([made("a"), end()]);
    const { host, runHost } = memoryHost(def, {
      make: async () => {
        throw new ServiceError({ class: "sign_in", service: "Gmail" }, "signed out");
      },
    });
    await advance(runHost, { kind: "start" });
    expect(host.row.run).toMatchObject({ status: "sleeping", wakeAt: NOW + 5 * MIN });
    expect(host.row.run.state.pause).toEqual({ kind: "sign_in", service: "Gmail" });
    expect(host.notices).toMatchObject([{ kind: "needs_you", stepId: "a", waitKey: "pause:sign_in" }]);
    host.now = NOW + 5 * MIN;
    await advance(runHost, { kind: "woke" });
    expect(host.notices).toHaveLength(1);
  });

  it("waits for a top-up before a step when it can't spend", async () => {
    const def = wizard([made("a"), end()]);
    const { host, runHost } = memoryHost(def, { canSpend: false });
    await advance(runHost, { kind: "start" });
    expect(host.row.run.state.pause).toEqual({ kind: "credits" });
    expect(host.ran).toEqual([]);
  });

  it("holds again before a step after an answer that waited long", async () => {
    const def = wizard([made("a"), end()]);
    const run: FlowRun = {
      cursor: "a",
      status: "running",
      state: { values: {}, outputs: {}, history: [], notes: {}, holdLater: true },
      wakeAt: null,
    };
    const held = memoryHost(def, { run });
    await advance(held.runHost, { kind: "resume" });
    // At work at its step: the step runs with no move first.
    expect(held.host.saves[0]).toMatchObject({ command: null, run: { cursor: "a", status: "running" } });
    expect(held.host.row.run.state.holdLater).toBeUndefined();
    expect(held.host.row.run.status).toBe("done");

    const refused = memoryHost(def, { run, hold: "refused" });
    await advance(refused.runHost, { kind: "resume" });
    expect(refused.host.row.run.state).toMatchObject({ pause: { kind: "credits" } });
    expect(refused.host.row.run.state.holdLater).toBeUndefined();
  });

  it("takes the step's onFail past every try, and says so", async () => {
    const def = wizard([made("a", { onFail: "fallback" }), made("fallback"), end()]);
    const { host, runHost } = memoryHost(def, {
      make: async (step) => {
        if (step.id === "a") {
          throw new Error("broken");
        }
        return output(step.id);
      },
    });
    await advance(runHost, { kind: "start" });
    expect(host.row.run.status).toBe("done");
    expect(host.ran).toEqual(["a", "fallback"]);
    expect(types(host.lines, "a")).toEqual(["step_started a", "error broken", "info stepFailedGoesOn"]);
  });

  it("fails the run with what the error says (fail)", async () => {
    const def = wizard([made("a"), end()]);
    const err = new Error("broken");
    const { host, runHost } = memoryHost(def, {
      make: async () => {
        throw err;
      },
    });
    const result = await advance(runHost, { kind: "start" });
    expect(result.command).toEqual({ kind: "fail", stepId: "a" });
    expect(host.row.run).toMatchObject({ cursor: "a", status: "failed" });
    expect(host.saves.at(-1)?.failed).toEqual({ said: "broken", err });
    expect(types(host.lines, "a")).toEqual(["step_started a", "error broken"]);
  });

  it("does not start a step that acted again by itself", async () => {
    const def = wizard([made("a"), end()]);
    const { host, runHost } = memoryHost(def, {
      make: async () => {
        throw new ServiceError({ class: "retry", retryAfterMs: null }, "timeout");
      },
      sort: (err) => ({ kind: "failed", failure: failureOf(err), acted: true, said: "timeout" }),
    });
    await advance(runHost, { kind: "start" });
    expect(host.row.run.status).toBe("failed");
  });

  it("stores the turn when it stops to ask the person", async () => {
    const def = wizard([made("a"), end()]);
    const { host, runHost } = memoryHost(def, {
      make: async () => {
        throw new Error("asks");
      },
      sort: () => ({ kind: "asked", question: "Which one?" }),
    });
    await advance(runHost, { kind: "start" });
    expect(host.row.run).toMatchObject({ cursor: "a", status: "waiting_input" });
    expect(host.saves.at(-1)?.command).toBeNull();
    expect(types(host.lines, "a")).toEqual(["step_started a", "info turnAsked"]);
  });

  it("counts a connection step's visit on the run before it acts", async () => {
    const parsed = wizard([made("send"), end()]);
    const send = {
      id: "send",
      type: "tool",
      title: "Send",
      call: { connection: "mail", action: "send", input: {} },
      output: {},
    } as unknown as Step;
    const def = { ...parsed, steps: [send, parsed.steps[1]] } as WizardDefinition;
    const { host, runHost } = memoryHost(def, {
      effects: true,
      make: async () => {
        throw new Error("not reached");
      },
    });
    runHost.guard = {
      before: async () => {
        throw new Error("stopped before acting");
      },
      after: async () => {},
    };
    await advance(runHost, { kind: "start" });
    expect(host.contexts[0]).toMatchObject({ visiting: "send", visits: { send: 1 } });
  });

  it("cancels a waiting run", async () => {
    const def = wizard([page("ask"), end()]);
    const { host, runHost } = memoryHost(def);
    await advance(runHost, { kind: "start" });
    const result = await advance(runHost, { kind: "cancel" });
    expect(result.command).toEqual({ kind: "end" });
    expect(host.row.run.status).toBe("cancelled");
  });

  it("refuses an event the run can't take", async () => {
    const def = wizard([page("ask"), end()]);
    const { runHost } = memoryHost(def);
    await advance(runHost, { kind: "start" });
    await expect(advance(runHost, { kind: "answered", stepId: "other", values: {} })).rejects.toBeInstanceOf(
      FlowRefused,
    );
  });

  it("stops when the run moved under its write", async () => {
    const def = wizard([made("a"), end()]);
    const memory = memoryHost(def, {
      make: async (step) => {
        memory.host.move({ status: "cancelled" });
        return output(step.id);
      },
    });
    await expect(advance(memory.runHost, { kind: "start" })).rejects.toBeInstanceOf(RunMoved);
    expect(memory.host.row.run.status).toBe("cancelled");
  });

  it("writes nothing more once the host stops it", async () => {
    const def = wizard([made("a"), made("b"), end()]);
    const memory = memoryHost(def, {
      make: async (step) => {
        memory.abort.abort();
        return output(step.id);
      },
    });
    await advance(memory.runHost, { kind: "start" });
    expect(memory.host.ran).toEqual(["a"]);
    expect(memory.host.row.run).toMatchObject({ cursor: "a", status: "running" });
  });
});

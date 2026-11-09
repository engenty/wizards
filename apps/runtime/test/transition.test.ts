import { parseWizard, type WizardDefinition } from "@engenty/wizards-shared/definition";
import type { RunState } from "@engenty/wizards-shared/run";
import {
  FLOW_LIMITS,
  type FlowEvent,
  type FlowHost,
  FlowRefused,
  type FlowRun,
  transition,
} from "@engenty/wizards-shared/transition";
import { describe, expect, it } from "vitest";

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-09T09:00:00Z");

const base = { version: 2, title: "Flow", description: "", avatar: "round" };
const agent = (id: string, more: object = {}) => ({
  id,
  type: "agent",
  title: id,
  instructions: "Do it.",
  tools: [],
  output: { format: "text" },
  ...more,
});
const page = (id: string, more: object = {}) => ({
  id,
  type: "page",
  title: id,
  fields: [
    { id: `${id}A`, kind: "text", label: "A" },
    { id: `${id}B`, kind: "text", label: "B" },
  ],
  ...more,
});
const review = (id: string, more: object = {}) => ({
  id,
  type: "review",
  title: id,
  show: ["made"],
  ...more,
});
const end = (id = "done") => ({ id, type: "result", title: id, deliverables: [] });

function wizard(steps: unknown[]): WizardDefinition {
  const parsed = parseWizard({ ...base, steps });
  if (!parsed.ok) {
    throw new Error(parsed.issues.map((i) => i.message).join("; "));
  }
  expect(parsed.issues).toEqual([]);
  return parsed.wizard;
}

/** Fills `{{steps.<id>.<key>}}` and `{{<field>}}` from the state, as the runtime's templates do. */
const render = (text: string, state: RunState) =>
  text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, ref: string) => {
    const [first, id, key] = ref.split(".");
    if (first === "steps") {
      return String((state.outputs[id]?.json as Record<string, unknown> | undefined)?.[key] ?? "");
    }
    return String(state.values[ref] ?? "");
  });

const host = (more: Partial<FlowHost> = {}): FlowHost => ({ now: NOW, render, ...more });

const fresh = (): FlowRun => ({
  cursor: null,
  status: "running",
  state: { values: {}, outputs: {}, history: [], notes: {} },
  wakeAt: null,
});

/** Feeds events in order; each runs at its own time when given one. */
function walk(def: WizardDefinition, events: (FlowEvent | [FlowEvent, number])[], h = host()) {
  let result = transition(def, fresh(), { kind: "start" }, h);
  for (const item of events) {
    const [event, now] = Array.isArray(item) ? item : [item, h.now];
    result = transition(def, result.run, event, { ...h, now });
  }
  return result;
}

const done = (stepId: string, json?: unknown): FlowEvent => ({
  kind: "stepDone",
  stepId,
  output: { ...(json === undefined ? { text: "ok" } : { json }), at: "" },
});

describe("arriving at steps", () => {
  it("asks a person at a page, runs an automatic step, ends at the result", () => {
    const def = wizard([page("ask"), agent("made"), end()]);
    const started = transition(def, fresh(), { kind: "start" }, host());
    expect(started.run).toMatchObject({ cursor: "ask", status: "waiting_input", wakeAt: null });
    expect(started.command).toMatchObject({ kind: "ask", who: "person", remindAt: null });

    const answered = transition(
      def,
      started.run,
      { kind: "answered", stepId: "ask", values: { askA: "x" } },
      host(),
    );
    expect(answered.run).toMatchObject({ cursor: "made", status: "running" });
    expect(answered.command).toMatchObject({ kind: "run", step: { id: "made" } });

    const finished = transition(def, answered.run, done("made"), host());
    expect(finished.run).toMatchObject({ cursor: "done", status: "done" });
    expect(finished.command).toEqual({ kind: "end" });
  });

  it("ends with the cursor on nothing when a rule goes to the end", () => {
    const def = wizard([agent("made", { next: [{ goto: "end" }] }), end()]);
    const { run, command } = walk(def, [done("made")]);
    expect(run).toMatchObject({ cursor: null, status: "done" });
    expect(command).toEqual({ kind: "end" });
  });

  it("gives a person's step its deadline and reminder, and who is asked", () => {
    const def = wizard([page("ask", { timeout: "2d", remind: "1d", who: "team" }), end()]);
    const { run, command } = transition(def, fresh(), { kind: "start" }, host());
    expect(run.wakeAt).toBe(NOW + 2 * DAY);
    expect(command).toMatchObject({ kind: "ask", who: "team", remindAt: NOW + DAY });
  });

  it("gives no deadline or reminder with durable runs off", () => {
    const def = wizard([page("ask", { timeout: "2d", remind: "1d" }), end()]);
    const { run, command } = transition(def, fresh(), { kind: "start" }, host({ durable: false }));
    expect(run.wakeAt).toBeNull();
    expect(command).toMatchObject({ kind: "ask", remindAt: null });
  });
});

describe("a page's answer", () => {
  it("keeps what was given, clears what was left empty, and forgets later pages' picks", () => {
    const def = wizard([page("ask"), page("later"), end()]);
    const first = transition(def, fresh(), { kind: "start" }, host()).run;
    first.state.values = { askA: "old", askB: "old" };
    first.state.pages = { later: { shown: ["laterA"] } };
    const { run } = transition(
      def,
      first,
      { kind: "answered", stepId: "ask", values: { askA: "new" } },
      host(),
    );
    expect(run.state.values).toEqual({ askA: "new" });
    expect(run.state.pages).toEqual({});
    expect(run.state.history).toEqual(["ask"]);
    // No deadline, so nothing is handed on.
    expect(run.state.outputs.ask).toBeUndefined();
  });

  it("hands on timedOut: false where the page has a deadline", () => {
    const def = wizard([page("ask", { timeout: "2d" }), end()]);
    const { run } = walk(def, [{ kind: "answered", stepId: "ask", values: {} }]);
    expect(run.state.outputs.ask.json).toEqual({ timedOut: false });
  });

  it("follows `when` rules on the answer", () => {
    const def = wizard([
      page("ask", { next: [{ when: { field: "askA", op: "equals", value: "b" }, goto: "b" }] }),
      agent("a"),
      agent("b"),
      end(),
    ]);
    expect(walk(def, [{ kind: "answered", stepId: "ask", values: { askA: "b" } }]).run.cursor).toBe(
      "b",
    );
    expect(walk(def, [{ kind: "answered", stepId: "ask", values: { askA: "a" } }]).run.cursor).toBe(
      "a",
    );
  });

  it("is refused at another step, or while the run works", () => {
    const def = wizard([page("ask"), agent("made"), end()]);
    const started = transition(def, fresh(), { kind: "start" }, host()).run;
    expect(() =>
      transition(def, started, { kind: "answered", stepId: "made", values: {} }, host()),
    ).toThrow(new FlowRefused("notThisStep"));
    const working = walk(def, [{ kind: "answered", stepId: "ask", values: {} }]).run;
    expect(() =>
      transition(def, working, { kind: "answered", stepId: "ask", values: {} }, host()),
    ).toThrow(new FlowRefused("runBusy"));
  });
});

describe("branches a model decides", () => {
  const def = wizard([
    agent("read", { next: [{ ask: "The person wants a refund", goto: "refund" }, { goto: "done" }] }),
    agent("refund"),
    end(),
  ]);

  it("ask for a decision after no `when` rule held, and keep the cursor on the step", () => {
    const { run, command } = walk(def, [done("read")]);
    expect(run).toMatchObject({ cursor: "read", status: "running" });
    expect(run.state.deciding).toBe("read");
    expect(command).toEqual({ kind: "decide", stepId: "read", rules: [0] });
  });

  it("go where the decided rule leads, and count it", () => {
    const { run } = walk(def, [done("read"), { kind: "decided", stepId: "read", rule: 0 }]);
    expect(run.cursor).toBe("refund");
    expect(run.state.deciding).toBeUndefined();
    expect(run.state.loops).toEqual({ "read→refund": 1 });
  });

  it("go the otherwise way when none holds", () => {
    const { run } = walk(def, [done("read"), { kind: "decided", stepId: "read", rule: null }]);
    expect(run).toMatchObject({ cursor: "done", status: "done" });
  });

  it("refuse a decision nobody waits for", () => {
    const { run } = walk(def, []);
    expect(() =>
      transition(def, run, { kind: "decided", stepId: "read", rule: 0 }, host()),
    ).toThrow(new FlowRefused("notThisStep"));
  });
});

describe("a wait for a time", () => {
  const def = wizard([agent("send"), { id: "pause", type: "wait", title: "Pause", for: "3d" }, agent("remind"), end()]);

  it("sleeps until its time, with nothing to run", () => {
    const { run, command } = walk(def, [done("send")]);
    expect(run).toMatchObject({ cursor: "pause", status: "sleeping", wakeAt: NOW + 3 * DAY });
    expect(command).toEqual({ kind: "sleep" });
  });

  it("stays when woken early, and goes on when its time has come", () => {
    const early = walk(def, [done("send"), [{ kind: "woke" }, NOW + DAY]]);
    expect(early.command).toEqual({ kind: "stay" });
    expect(early.run.status).toBe("sleeping");

    const due = walk(def, [done("send"), [{ kind: "woke" }, NOW + 3 * DAY]]);
    expect(due.run).toMatchObject({ cursor: "remind", status: "running", wakeAt: null });
    expect(due.run.state.outputs.pause.json).toEqual({ waited: true });
  });

  it("waits for nothing when `until` has gone by, and fails on text that is no date", () => {
    const dated = wizard([
      page("ask", { fields: [{ id: "deadline", kind: "text", label: "Deadline" }] }),
      { id: "pause", type: "wait", title: "Pause", until: "{{deadline}}" },
      agent("after"),
      end(),
    ]);
    const until = (value: string) => ({ def: dated, values: { deadline: value } });
    const past = until("2026-01-01T00:00:00Z");
    const gone = walk(past.def, [{ kind: "answered", stepId: "ask", values: past.values }]);
    expect(gone.run.cursor).toBe("after");
    expect(gone.run.state.outputs.pause.json).toEqual({ waited: true });

    const later = until("2026-12-24T18:00:00Z");
    const waits = walk(later.def, [{ kind: "answered", stepId: "ask", values: later.values }]);
    expect(waits.run).toMatchObject({ status: "sleeping", wakeAt: Date.parse("2026-12-24T18:00:00Z") });

    const nonsense = until("next Tuesday-ish");
    const failed = walk(nonsense.def, [{ kind: "answered", stepId: "ask", values: nonsense.values }]);
    expect(failed.run).toMatchObject({ cursor: "pause", status: "failed" });
    expect(failed.command).toEqual({ kind: "fail", stepId: "pause" });
    expect(failed).toMatchObject({
      error: {
        stepId: "pause",
        said: { code: "waitDateUnreadable", params: { date: "next Tuesday-ish" } },
      },
    });
  });

  it("takes the wait's onFail when it can't be entered, and says why", () => {
    const def = wizard([
      page("ask", { fields: [{ id: "deadline", kind: "text", label: "Deadline" }] }),
      {
        id: "pause",
        type: "wait",
        title: "Pause",
        until: "{{deadline}}",
        onFail: "fallback",
        next: [{ goto: "done" }],
      },
      agent("fallback", { next: [{ goto: "end" }] }),
      end(),
    ]);
    const result = walk(def, [{ kind: "answered", stepId: "ask", values: { deadline: "soon" } }]);
    expect(result.run).toMatchObject({ cursor: "fallback", status: "running" });
    expect(result.command).toMatchObject({ kind: "run", step: { id: "fallback" } });
    expect(result).toMatchObject({ error: { stepId: "pause", said: { code: "waitDateUnreadable" } } });
    expect(result.run.state.loops).toEqual({ "pause→fallback": 1 });
  });
});

describe("a wait for a signal", () => {
  const def = wizard([
    agent("send", { output: { format: "json", fields: [{ id: "thread_id", kind: "text", label: "Thread" }] } }),
    {
      id: "reply",
      type: "wait",
      title: "Reply",
      signal: { name: "invoice.paid", key: "thread:{{steps.send.thread_id}}", timeout: "3d", fields: ["amount"] },
      next: [
        { when: { field: "steps.reply.timedOut", op: "equals", value: true }, goto: "remind" },
        { goto: "done" },
      ],
    },
    agent("remind"),
    end(),
  ]);
  const sent = done("send", { thread_id: "T-42" });

  it("watches for its name and key, until its timeout", () => {
    const { run, command } = walk(def, [sent]);
    expect(run).toMatchObject({ cursor: "reply", status: "waiting_signal", wakeAt: NOW + 3 * DAY });
    expect(command).toEqual({ kind: "waitSignal", name: "invoice.paid", key: "thread:T-42" });
  });

  it("goes on with what the signal brought, only the fields it names", () => {
    const { run } = walk(def, [
      sent,
      { kind: "signal", stepId: "reply", id: "s1", data: { amount: 90, secret: "x" } },
    ]);
    expect(run).toMatchObject({ cursor: "done", status: "done" });
    expect(run.state.outputs.reply.json).toEqual({ came: true, timedOut: false, data: { amount: 90 } });
    expect(run.state.signals).toEqual(["s1"]);
  });

  it("takes a delivery once", () => {
    const waiting = walk(def, [sent]).run;
    waiting.state.signals = ["s1"];
    const again = transition(def, waiting, { kind: "signal", stepId: "reply", id: "s1", data: {} }, host());
    expect(again).toEqual({ run: waiting, command: { kind: "stay" } });
  });

  it("times out on the clock and takes the branch on timedOut", () => {
    const early = walk(def, [sent, [{ kind: "woke" }, NOW + DAY]]);
    expect(early.command).toEqual({ kind: "stay" });
    const { run } = walk(def, [sent, [{ kind: "woke" }, NOW + 3 * DAY]]);
    expect(run.cursor).toBe("remind");
    expect(run.state.outputs.reply.json).toEqual({ came: false, timedOut: true });
  });

  it("fails when its key comes out empty", () => {
    const bare = wizard([
      agent("send", { output: { format: "json", fields: [{ id: "thread_id", kind: "text", label: "Thread" }] } }),
      { id: "reply", type: "wait", title: "Reply", signal: { name: "invoice.paid", key: "{{steps.send.thread_id}}" } },
      end(),
    ]);
    const result = walk(bare, [done("send", { thread_id: " " })]);
    expect(result.run.status).toBe("failed");
    expect(result.command).toEqual({ kind: "fail", stepId: "reply" });
    expect(result).toMatchObject({ error: { said: { code: "signalKeyEmpty" } } });
  });
});

describe("a person's step past its deadline", () => {
  it("leaves the page's fields empty and takes the branch on timedOut", () => {
    const def = wizard([
      page("ask", {
        timeout: "2d",
        next: [{ when: { field: "steps.ask.timedOut", op: "equals", value: true }, goto: "late" }],
      }),
      agent("onTime", { next: [{ goto: "done" }] }),
      agent("late"),
      end(),
    ]);
    const started = transition(def, fresh(), { kind: "start" }, host()).run;
    started.state.values = { askA: "typed earlier" };
    const early = transition(def, started, { kind: "woke" }, host({ now: NOW + DAY }));
    expect(early.command).toEqual({ kind: "stay" });
    const { run } = transition(def, started, { kind: "woke" }, host({ now: NOW + 2 * DAY }));
    expect(run).toMatchObject({ cursor: "late", status: "running", wakeAt: null });
    expect(run.state.values).toEqual({});
    expect(run.state.outputs.ask.json).toEqual({ timedOut: true });
    expect(run.state.history).toEqual(["ask"]);
  });

  it("gives no approval", () => {
    const def = wizard([
      agent("made"),
      review("check", {
        approve: true,
        timeout: "2d",
        next: [{ when: { field: "steps.check.approved", op: "equals", value: false }, goto: "made" }],
      }),
      end(),
    ]);
    const { run } = walk(def, [done("made"), [{ kind: "woke" }, NOW + 2 * DAY]]);
    expect(run.state.outputs.check.json).toEqual({ timedOut: true, approved: false });
    expect(run.cursor).toBe("made");
  });
});

describe("a review", () => {
  const approval = wizard([
    agent("made"),
    review("check", {
      approve: true,
      edit: true,
      next: [{ when: { field: "steps.check.approved", op: "equals", value: false }, goto: "made" }],
    }),
    end(),
  ]);

  it("hands on an approval and its note", () => {
    const { run } = walk(approval, [
      done("made"),
      { kind: "reviewed", stepId: "check", approved: true, note: "  fine  " },
    ]);
    expect(run.state.outputs.check.json).toEqual({ approved: true, note: "fine" });
    expect(run).toMatchObject({ cursor: "done", status: "done" });
  });

  it("goes back on a decline, counting the loop", () => {
    const { run } = walk(approval, [done("made"), { kind: "reviewed", stepId: "check", approved: false }]);
    expect(run.cursor).toBe("made");
    expect(run.state.loops).toEqual({ "check→made": 1 });
  });

  it("takes edits only on outputs it shows", () => {
    const { run } = walk(approval, [
      done("made"),
      {
        kind: "reviewed",
        stepId: "check",
        approved: true,
        edited: { made: { text: "changed", at: "" }, other: { text: "no", at: "" } },
      },
    ]);
    expect(run.state.outputs.made.text).toBe("changed");
    expect(run.state.outputs.other).toBeUndefined();
  });

  it("refuses a decline where it asks for no approval", () => {
    const def = wizard([agent("made"), review("check"), end()]);
    const waiting = walk(def, [done("made")]).run;
    expect(() =>
      transition(def, waiting, { kind: "reviewed", stepId: "check", approved: false }, host()),
    ).toThrow(new FlowRefused("notAnApproval"));
    const accepted = transition(def, waiting, { kind: "reviewed", stepId: "check", approved: true }, host());
    expect(accepted.run.state.outputs.check).toBeUndefined();
    expect(accepted.run.status).toBe("done");
  });

  it("sends an output back to be made again with a note", () => {
    const { run, command } = walk(approval, [
      done("made"),
      { kind: "regenerate", stepId: "check", target: "made", note: "shorter", items: [1] },
    ]);
    expect(run).toMatchObject({ cursor: "made", status: "running" });
    expect(run.state.notes).toEqual({ made: "shorter" });
    expect(run.state.redo).toEqual({ made: [1] });
    expect(command).toMatchObject({ kind: "run", step: { id: "made" } });
  });

  it("refuses to make again what it doesn't show", () => {
    const waiting = walk(approval, [done("made")]).run;
    expect(() =>
      transition(approval, waiting, { kind: "regenerate", stepId: "check", target: "check", note: "" }, host()),
    ).toThrow(new FlowRefused("unknownTarget"));
  });
});

describe("back", () => {
  const def = wizard([page("first"), page("second"), agent("made"), end()]);

  it("moves the cursor to the page answered last, and forgets what belonged to the step left", () => {
    const at = walk(def, [{ kind: "answered", stepId: "first", values: { firstA: "x" } }]).run;
    at.state.retries = { step: "second", count: 1, since: "" };
    at.state.answeredBy = { first: { userId: "u", name: "U" } };
    const { run, command } = transition(def, at, { kind: "back" }, host());
    expect(run).toMatchObject({ cursor: "first", status: "waiting_input" });
    expect(run.state.history).toEqual([]);
    expect(run.state.retries).toBeUndefined();
    expect(run.state.answeredBy).toEqual({});
    // The answer stays, for the page to show again.
    expect(run.state.values).toEqual({ firstA: "x" });
    expect(command).toMatchObject({ kind: "ask", step: { id: "first" } });
  });

  it("works from done and failed, not while the run works or waits", () => {
    const finished = walk(def, [
      { kind: "answered", stepId: "first", values: {} },
      { kind: "answered", stepId: "second", values: {} },
      done("made"),
    ]).run;
    expect(transition(def, finished, { kind: "back" }, host()).run.cursor).toBe("second");
    const working = walk(def, [
      { kind: "answered", stepId: "first", values: {} },
      { kind: "answered", stepId: "second", values: {} },
    ]).run;
    expect(() => transition(def, working, { kind: "back" }, host())).toThrow(new FlowRefused("runBusy"));
  });

  it("is refused at the first page", () => {
    const started = transition(def, fresh(), { kind: "start" }, host()).run;
    expect(() => transition(def, started, { kind: "back" }, host())).toThrow(
      new FlowRefused("noStepBefore"),
    );
  });
});

describe("a step that fails", () => {
  const def = wizard([agent("made", { onFail: "fallback" }), agent("fallback"), end()]);
  const fail = (failure: Extract<FlowEvent, { kind: "stepFailed" }>["failure"], acted?: boolean): FlowEvent => ({
    kind: "stepFailed",
    stepId: "made",
    failure,
    ...(acted ? { acted } : {}),
  });
  const retry = fail({ class: "retry", retryAfterMs: null });

  it("tries again after 1, 5 and 30 minutes, then takes onFail", () => {
    let run = walk(def, []).run;
    let now = NOW;
    for (const minutes of FLOW_LIMITS.retryMinutes) {
      const slept = transition(def, run, retry, host({ now }));
      expect(slept.run).toMatchObject({ cursor: "made", status: "sleeping", wakeAt: now + minutes * MIN });
      expect(slept.run.state.pause).toEqual({ kind: "retry" });
      expect(slept.command).toEqual({ kind: "sleep" });
      now += minutes * MIN;
      const woken = transition(def, slept.run, { kind: "woke" }, host({ now }));
      expect(woken.command).toMatchObject({ kind: "run", step: { id: "made" } });
      expect(woken.run.state.pause).toBeUndefined();
      run = woken.run;
    }
    const past = transition(def, run, retry, host({ now }));
    expect(past.run).toMatchObject({ cursor: "fallback", status: "running" });
    expect(past.run.state.retries).toBeUndefined();
  });

  it("sleeps as long as Retry-After says, within its bounds", () => {
    const run = walk(def, []).run;
    const asked = (ms: number) =>
      transition(def, run, fail({ class: "retry", retryAfterMs: ms }), host()).run.wakeAt;
    expect(asked(10 * MIN)).toBe(NOW + 10 * MIN);
    expect(asked(1000)).toBe(NOW + MIN);
    expect(asked(2 * DAY)).toBe(NOW + FLOW_LIMITS.retryAfterMaxMs);
  });

  it("is not tried again when it may have acted", () => {
    const run = walk(def, []).run;
    expect(transition(def, run, fail({ class: "retry", retryAfterMs: null }, true), host()).run.cursor).toBe(
      "fallback",
    );
  });

  it("takes onFail at most three times, then fails the run", () => {
    const loop = wizard([agent("made", { onFail: "made2" }), agent("made2", { onFail: "made" }), end()]);
    let run = walk(loop, []).run;
    const final = { class: "final" } as const;
    for (let i = 0; i < 6; i++) {
      const step = run.cursor as string;
      run = transition(loop, run, { kind: "stepFailed", stepId: step, failure: final }, host()).run;
    }
    expect(run.state.loops).toEqual({ "made→made2": 3, "made2→made": 3 });
    const last = transition(loop, run, { kind: "stepFailed", stepId: "made", failure: final }, host());
    expect(last.run).toMatchObject({ cursor: "made", status: "failed" });
    expect(last.command).toEqual({ kind: "fail", stepId: "made" });
  });

  it("waits for credits, says so once, and fails after 30 days", () => {
    const run = walk(def, []).run;
    const first = transition(def, run, fail({ class: "credits" }), host());
    expect(first.run).toMatchObject({ status: "sleeping", wakeAt: NOW + FLOW_LIMITS.lookAgainMs });
    expect(first.command).toEqual({ kind: "sleep", tell: { kind: "credits" } });

    const woken = transition(def, first.run, { kind: "woke" }, host({ now: NOW + FLOW_LIMITS.lookAgainMs }));
    const second = transition(def, woken.run, fail({ class: "credits" }), host({ now: NOW + 10 * MIN }));
    expect(second.command).toEqual({ kind: "sleep" });

    const month = transition(def, woken.run, fail({ class: "credits" }), host({ now: NOW + 31 * DAY }));
    expect(month.run.status).toBe("failed");
  });

  it("waits for a sign-in even after it acted, since a refused sign-in did nothing", () => {
    const run = walk(def, []).run;
    const { command } = transition(def, run, fail({ class: "sign_in", service: "gmail" }, true), host());
    expect(command).toEqual({ kind: "sleep", tell: { kind: "sign_in", service: "gmail" } });
  });

  it("fails the run at once with durable runs off", () => {
    const run = walk(def, []).run;
    const { run: after, command } = transition(def, run, retry, host({ durable: false }));
    expect(after.status).toBe("failed");
    expect(command).toEqual({ kind: "fail", stepId: "made" });
  });
});

describe("a step that is done", () => {
  it("answers the note and redo asked for it, and closes its visit and turn", () => {
    const def = wizard([agent("made"), review("check"), end()]);
    const run = walk(def, []).run;
    run.state.notes = { made: "Shorter, please.", other: "keep" };
    run.state.redo = { made: [1] };
    run.state.visiting = { step: "made", n: 2 } as never;
    run.state.turn = { stepId: "made" } as never;
    const after = transition(def, run, done("made"), host()).run;
    expect(after.state.notes).toEqual({ other: "keep" });
    expect(after.state.redo).toEqual({});
    expect(after.state.visiting).toBeUndefined();
    expect(after.state.turn).toBeUndefined();
  });
});

describe("resume", () => {
  const def = wizard([
    agent("made", { next: [{ ask: "It needs a check", goto: "check" }, { goto: "done" }] }),
    page("check", { timeout: "1d" }),
    end(),
  ]);

  it("stands a running run at its step, as on arrival", () => {
    const moved: FlowRun = { ...fresh(), cursor: "check" };
    const { run, command } = transition(def, moved, { kind: "resume" }, host());
    expect(run).toMatchObject({ cursor: "check", status: "waiting_input", wakeAt: NOW + DAY });
    expect(command).toMatchObject({ kind: "ask", step: { id: "check" } });
  });

  it("asks for the open decision again, not for the step it is about", () => {
    const deciding = walk(def, [done("made")]).run;
    const { command } = transition(def, deciding, { kind: "resume" }, host());
    expect(command).toEqual({ kind: "decide", stepId: "made", rules: [0] });
  });

  it("is a person's try again on a failed run: every try anew", () => {
    const failedRun = transition(def, walk(def, []).run, {
      kind: "stepFailed",
      stepId: "made",
      failure: { class: "final" },
    }, host()).run;
    failedRun.state.retries = { step: "made", count: 3, since: "" };
    const { run, command } = transition(def, failedRun, { kind: "resume" }, host());
    expect(run).toMatchObject({ cursor: "made", status: "running" });
    expect(run.state.retries).toBeUndefined();
    expect(command).toMatchObject({ kind: "run", step: { id: "made" } });
  });

  it("is refused while the run waits", () => {
    const waiting: FlowRun = { ...fresh(), cursor: "check", status: "waiting_input" };
    expect(() => transition(def, waiting, { kind: "resume" }, host())).toThrow(
      new FlowRefused("runBusy"),
    );
  });

  it("a retry of a decision decides again after its sleep", () => {
    const deciding = walk(def, [done("made")]).run;
    const slept = transition(def, deciding, {
      kind: "stepFailed",
      stepId: "made",
      failure: { class: "retry", retryAfterMs: null },
    }, host()).run;
    const { command } = transition(def, slept, { kind: "woke" }, host({ now: NOW + MIN }));
    expect(command).toEqual({ kind: "decide", stepId: "made", rules: [0] });
  });
});

describe("cancel", () => {
  it("ends the run where it stands and clears its wake", () => {
    const def = wizard([{ id: "pause", type: "wait", title: "Pause", for: "1d" }, end()]);
    const waiting = transition(def, fresh(), { kind: "start" }, host()).run;
    const { run, command } = transition(def, waiting, { kind: "cancel" }, host());
    expect(run).toMatchObject({ cursor: "pause", status: "cancelled", wakeAt: null });
    expect(command).toEqual({ kind: "end" });
  });
});

describe("purity", () => {
  it("leaves the run it was given as it was", () => {
    const def = wizard([page("ask"), agent("made"), end()]);
    const before = transition(def, fresh(), { kind: "start" }, host()).run;
    const copy = structuredClone(before);
    transition(def, before, { kind: "answered", stepId: "ask", values: { askA: "x" } }, host());
    expect(before).toEqual(copy);
  });
});

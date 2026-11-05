import type { PluginRunReport, PluginRuns } from "@engenty/wizards/plugin";
import { freshThreadState, type Thread, ThreadDoor } from "@engenty/wizards/plugin/thread";
import { describe, expect, it, vi } from "vitest";

/** Where a channel's message goes: a person's step takes the answer, a wait the signal, never both. */

const waiting = (signal: string | null, until: string | null = null): PluginRunReport =>
  ({
    runId: "r",
    mode: "live",
    lang: "de",
    status: signal ? "waiting_signal" : "sleeping",
    step: { id: "wait", type: "wait", title: "Warten" },
    passed: [],
    waitingFor: { wait: "wait", title: "Warten", until, signal, hint: "" },
  }) as unknown as PluginRunReport;

const pageReport = {
  runId: "r",
  mode: "live",
  lang: "de",
  status: "waiting_input",
  step: { id: "ask", type: "page", title: "Frage" },
  passed: [],
  waitingFor: {
    page: "ask",
    title: "Frage",
    fields: [{ id: "x", kind: "text", label: "X", required: true }],
    hint: "",
  },
} as unknown as PluginRunReport;

function door(reports: PluginRunReport[], message: PluginRuns["message"]) {
  const sent: { text?: string }[] = [];
  const answerPage = vi.fn(async () => undefined);
  const report = vi.fn(async () => reports.shift() ?? (reports[0] as PluginRunReport));
  const thread: Thread = {
    id: "t",
    runId: "r",
    state: freshThreadState("de"),
  } as Thread;
  const it = new ThreadDoor({
    runs: { report, message, answerPage } as unknown as PluginRuns,
    surface: {
      runner: "test",
      asks: ["text"],
      send: async (_t, prompt) => {
        sent.push(prompt as { text?: string });
      },
    },
    offered: async () => [],
    watch: () => undefined,
    unwatch: () => undefined,
    log: { warn: () => undefined },
  });
  const write = (text: string) =>
    it.inbound(thread, { id: "m-1", from: "t", at: 0, kind: "text", text });
  return { write, sent, answerPage, thread };
}

describe("what a person writes while the run stands at a wait", () => {
  it("goes to a wait that listens, as a signal with the message's id", async () => {
    const message = vi.fn(async () => ({ runs: 1 }));
    const { write, sent, answerPage } = door(
      [waiting("message.received")],
      message as PluginRuns["message"],
    );
    await write("Ja, passt");
    expect(message).toHaveBeenCalledWith("r", { text: "Ja, passt", delivery: "m-1" });
    expect(answerPage).not.toHaveBeenCalled();
    expect(sent.map((s) => s.text)).toEqual(["Danke, das ist angekommen."]);
  });

  it("is only told it waits when the wait listens for something else", async () => {
    const message = vi.fn(async () => null);
    const { write, sent, answerPage } = door(
      [waiting("invoice.paid"), waiting("invoice.paid")],
      message as PluginRuns["message"],
    );
    await write("Ist bezahlt");
    expect(message).toHaveBeenCalledOnce();
    expect(answerPage).not.toHaveBeenCalled();
    expect(sent.map((s) => s.text)).toEqual([
      "Der Wizard wartet auf ein Ereignis und geht dann von selbst weiter.",
    ]);
  });

  it("does not go anywhere as a signal when the wait is for a time", async () => {
    const message = vi.fn(async () => null);
    const { write } = door([waiting(null)], message as PluginRuns["message"]);
    await write("Hallo");
    expect(message).not.toHaveBeenCalled();
  });

  it("goes to the person's step, and not as a signal, when a page stands", async () => {
    const message = vi.fn(async () => ({ runs: 1 }));
    const { write } = door([pageReport], message as PluginRuns["message"]);
    await write("Meine Antwort");
    expect(message).not.toHaveBeenCalled();
  });

  it("goes to the step the run just reached, when the wait ended as it was written", async () => {
    const message = vi.fn(async () => null);
    const { write, sent } = door(
      [waiting("message.received"), pageReport],
      message as PluginRuns["message"],
    );
    await write("Meine Antwort");
    expect(message).toHaveBeenCalledOnce();
    expect(sent.map((s) => s.text)).not.toContain("Danke, das ist angekommen.");
  });
});

describe("a review that asks for a decision", () => {
  const report = (approve: boolean) =>
    ({
      runId: "r",
      mode: "live",
      lang: "de",
      status: "waiting_input",
      step: { id: "check", type: "review", title: "Prüfen" },
      passed: [],
      outputs: [],
      waitingFor: { review: "check", title: "Prüfen", show: [], editable: false, approve, hint: "" },
    }) as unknown as PluginRunReport;
  function door_(approve: boolean) {
    const sent: { options?: { id: string; title: string }[] }[] = [];
    const review = vi.fn(async () => undefined);
    const thread = { id: "t", runId: "r", state: freshThreadState("de") } as Thread;
    const it_ = new ThreadDoor({
      runs: { report: async () => report(approve), review } as unknown as PluginRuns,
      surface: {
        runner: "test",
        asks: ["text", "choice"],
        send: async (_t, prompt) => {
          sent.push(prompt as (typeof sent)[number]);
        },
      },
      offered: async () => [],
      watch: () => undefined,
      unwatch: () => undefined,
      log: { warn: () => undefined },
    });
    const say = (msg: object) =>
      it_.inbound(thread, { id: "m", from: "t", at: 0, kind: "text", ...msg } as never);
    return { say, sent, review };
  }

  it("offers approve and decline, and a decline says so", async () => {
    const { say, sent, review } = door_(true);
    await say({ text: "Hallo" });
    expect(sent.at(-1)?.options?.map((o) => o.title)).toEqual(["Freigeben", "Ablehnen"]);
    await say({ replyId: "r:no" });
    expect(review).toHaveBeenCalledWith("r", "check", { type: "decline" });
  });

  it("an approval is an accept", async () => {
    const { say, review } = door_(true);
    await say({ replyId: "r:ok" });
    expect(review).toHaveBeenCalledWith("r", "check", { type: "accept" });
  });

  it("a review without approve stays as it was, and has no decline", async () => {
    const { say, sent, review } = door_(false);
    await say({ replyId: "r:no" });
    expect(review).not.toHaveBeenCalled();
    expect(sent.at(-1)?.options?.map((o) => o.title)).toEqual(["Passt", "Neue Version"]);
  });
});

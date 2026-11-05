import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  freshThreadState,
  type Thread,
  ThreadDoor,
  type ThreadPrompt,
} from "../../../packages/wizards/src/plugin/thread";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-durable-doors-"));
process.env.APP_URL = "http://localhost:5181";

describe("a channel's thread, when a step asks", () => {
  const set = () => {
    const sent: ThreadPrompt[] = [];
    let waitingFor: unknown = {
      question: "Welches Angebot?",
      title: "Angebot",
      hint: "Ask the person.",
    };
    const answerQuestion = vi.fn(async () => {
      waitingFor = undefined;
    });
    const door = new ThreadDoor({
      runs: {
        report: async () => ({ status: waitingFor ? "waiting_input" : "running", waitingFor }),
        answerQuestion,
      } as never,
      surface: {
        runner: "test",
        asks: ["text"],
        send: async (_thread: Thread, prompt: ThreadPrompt) => {
          sent.push(prompt);
        },
      } as never,
      offered: async () => [],
      watch: () => undefined,
      unwatch: () => undefined,
      log: { warn: () => undefined },
    });
    const thread: Thread = {
      id: "+43",
      name: null,
      runId: "run-1",
      state: freshThreadState("de"),
      lastInboundAt: 0,
      lastMessageId: null,
    };
    return { door, thread, sent, answerQuestion };
  };
  const says = (text: string) =>
    ({ id: "m", from: "+43", at: 1, kind: "text", text }) as const;

  it("puts the question, then takes the next message as the answer", async () => {
    const { door, thread, sent, answerQuestion } = set();
    await door.resume(thread);
    expect(sent).toEqual([{ kind: "text", text: "Welches Angebot?" }]);
    expect(answerQuestion).not.toHaveBeenCalled();
    await door.inbound(thread, says("Das vom 28. Oktober"));
    expect(answerQuestion).toHaveBeenCalledWith("run-1", "Das vom 28. Oktober");
  });

  it("does not take a message as the answer before the question was put", async () => {
    const { door, thread, sent, answerQuestion } = set();
    await door.inbound(thread, says("Hallo"));
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(sent).toEqual([{ kind: "text", text: "Welches Angebot?" }]);
  });
});

describe("a write while a transaction is open", () => {
  it("waits for the transaction instead of failing with SQLITE_BUSY", async () => {
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    const T = "tenant-durable-doors";
    const db = await client.tenantClient(T);
    await db.execute("CREATE TABLE IF NOT EXISTS gate_test (id INTEGER PRIMARY KEY, what TEXT)");
    const tx = await db.transaction("write");
    await tx.execute({ sql: "INSERT INTO gate_test (what) VALUES (?)", args: ["in the transaction"] });
    // The write comes while the transaction is open across an await, as Mastra's fenced writes.
    const started = Date.now();
    const write = db.execute({ sql: "INSERT INTO gate_test (what) VALUES (?)", args: ["after it"] });
    // A read does not wait.
    const read = await db.execute("SELECT count(*) AS n FROM gate_test");
    expect(Number(read.rows[0].n)).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    await tx.commit();
    await write;
    expect(Date.now() - started).toBeLessThan(2000);
    const rows = await db.execute("SELECT what FROM gate_test ORDER BY id");
    expect(rows.rows.map((r) => r.what)).toEqual(["in the transaction", "after it"]);
  });
});

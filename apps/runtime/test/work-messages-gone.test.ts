import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { describe, expect, it } from "vitest";

const GONE = ["mastra_messages", "mastra_threads", "mastra_resources"];
const sql = readFileSync(
  join(import.meta.dirname, "../src/db/migrations/tenant/0080_work_messages_gone.sql"),
  "utf8",
);

async function migrate(db: Client) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    await db.execute(statement.trim());
  }
}
async function tables(db: Client) {
  const found = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
  return found.rows.map((r) => String(r.name));
}
const rows = async (db: Client, table: string) =>
  Number((await db.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

describe("migration 0080", () => {
  it("takes the messages of Work's chats and leaves a durable turn's snapshots", async () => {
    const db = createClient({ url: ":memory:" });
    const store = new LibSQLStore({ id: "work-chats", client: db });
    await store.init();
    const memory = await store.getStore("memory");
    const now = new Date();
    await memory?.saveThread({
      thread: { id: "chat-1", resourceId: "space-1", title: "Plans", createdAt: now, updatedAt: now },
    });
    await memory?.saveMessages({
      messages: [
        {
          id: "m-1",
          threadId: "chat-1",
          resourceId: "space-1",
          role: "user",
          createdAt: now,
          content: { format: 2, parts: [{ type: "text", text: "What a person wrote in Work." }] },
        },
      ],
    });
    await memory?.saveResource({
      resource: { id: "space-1", workingMemory: "A note.", createdAt: now, updatedAt: now },
    });
    const workflows = await store.getStore("workflows");
    await workflows?.persistWorkflowSnapshot({
      workflowName: "wizard-step",
      runId: "run-1.turn",
      snapshot: { runId: "run-1.turn", status: "running", value: {}, context: {} } as never,
    });
    for (const table of GONE) {
      expect(await rows(db, table)).toBe(1);
    }

    await migrate(db);
    const left = await tables(db);
    for (const table of GONE) {
      expect(left).not.toContain(table);
    }
    expect(await rows(db, "mastra_workflow_snapshot")).toBe(1);

    // A second time changes nothing.
    await migrate(db);

    // A durable turn's store makes the three again, empty.
    await new LibSQLStore({ id: "wizard-steps", client: db }).init();
    for (const table of GONE) {
      expect(await rows(db, table)).toBe(0);
    }
    expect(await rows(db, "mastra_workflow_snapshot")).toBe(1);
  });

  it("runs on a database Work never wrote to", async () => {
    const db = createClient({ url: ":memory:" });
    await migrate(db);
    expect(await tables(db)).toEqual([]);
  });
});

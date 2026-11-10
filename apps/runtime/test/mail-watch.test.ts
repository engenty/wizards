import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-mail-watch-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "all";
process.env.FEATURES = "durableRuns=on";

const worked = vi.hoisted(() => [] as { run: string; step: string }[]);
vi.mock("../src/engine/steps/index.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps/index.js")>()),
  runAutomaticStep: async (step: { id: string }, ctx: { runId: string }) => {
    worked.push({ run: ctx.runId, step: step.id });
    return step.id === "send"
      ? { json: { message_id: "m-sent", thread_id: "T-Sent", sent: true }, at: new Date().toISOString() }
      : { text: `made ${step.id}`, at: new Date().toISOString() };
  },
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

import type {
  ConnectorDefinition,
  InboundMessage,
  StreamPullCtx,
  StreamPullResult,
} from "../src/engenty/connections-sdk/types";

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let watch: typeof import("../src/engine/mail-watch");
let connections: typeof import("../src/connectors/space-connections");
let services: typeof import("../src/services/signals");
let crypto: typeof import("../src/secrets/crypto");
let connector: ConnectorDefinition;
let realPull: NonNullable<ConnectorDefinition["stream"]>["pull"];

/** Stands in for Gmail: what a pull answers, and how it was called. */
const pulls: { cursor: string | null; since?: string; limit?: number; connection: string }[] = [];
let answer: (cursor: string | null, ctx: StreamPullCtx) => Promise<StreamPullResult>;
/** Stands in for reading one mail: which ones were asked for, and what comes back. */
const reads: string[] = [];
let readAnswer: (message: string) => Promise<InboundMessage | null>;

const T = "tenant-mail-watch";
const base = { version: 1, title: "Mail", description: "", avatar: "round" };
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const agent = (id: string) => ({
  id,
  type: "agent",
  title: id,
  instructions: "Do it.",
  tools: [],
  output: { format: "text" },
});
const waitFor = (key: string, more: object = {}) => ({
  id: "reply",
  type: "wait",
  title: "Reply",
  signal: { name: "mail.received", key, ...more },
});

/** Every test its own sender: mails stay in the tables between tests. */
let n = 0;
let ANNA = "";
beforeEach(() => {
  n += 1;
  ANNA = `anna-${n}@kunde.at`;
  pulls.length = 0;
  answer = async (cursor) => ({ hasMore: false, items: [], nextCursor: cursor ?? "history-1" });
  readAnswer = async () => mail({ body_text: "Aus dem Postfach gelesen." });
});

const mail = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  attachments: [],
  body_html: null,
  body_text: "Passt, danke.",
  cc: [],
  from_email: ANNA,
  from_name: "Anna",
  provider_message_id: `m-${n}`,
  provider_thread_id: `t-${n}`,
  received_at: new Date().toISOString(),
  subject: "Re: Angebot",
  to: ["vertrieb@firma.at"],
  ...over,
});

const inTenant = <R>(fn: () => Promise<R>, tenant = T) => client.withTenant(tenant, fn);
const row = (id: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }));

async function until(ok: () => Promise<boolean>, ms = 8000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}
const hasStatus = (id: string, s: string) => until(async () => (await row(id))?.status === s);
const rests = (id: string) =>
  until(async () => {
    const line = await client.controlDb.query.runIndex.findFirst({
      where: eq(client.control.runIndex.runId, id),
    });
    return (await row(id))?.status === "waiting_signal" && line?.active === false;
  });

const makeSpace = (name: string, tenant = T) =>
  inTenant(async () => {
    const id = `space-${Math.random().toString(36).slice(2)}`;
    await client.db.insert(client.schema.space).values({ id, tenantId: tenant, name });
    return id;
  }, tenant);

/** A mailbox of a space: signed in, and switched on unless told otherwise. */
const mailbox = (
  spaceId: string,
  options: { on?: boolean; rules?: object; tenant?: string } = {},
) =>
  inTenant(async () => {
    const id = `conn-${Math.random().toString(36).slice(2)}`;
    await client.db.insert(client.schema.spaceConnection).values({
      id,
      spaceId,
      connectorId: "google-gmail",
      name: "Vertrieb",
      label: "vertrieb@firma.at",
      signIn: "space",
      audience: "members",
      rules: { read: "allow", write: "ask", send: "ask", destructive: "deny", ...options.rules },
      secret: crypto.seal({ accessToken: "fake", refreshToken: null, expiresAt: null, scopes: [] }),
      autonomousMode: options.on === false ? "off" : "read_only",
    });
    if (options.on !== false) {
      await client.db
        .insert(client.schema.mailCursor)
        .values({ connectionId: id, since: new Date(Date.now() - 3_600_000) });
    }
    return id;
  }, options.tenant);

/** A wizard in that space and a run of it. */
async function startIn(spaceId: string, steps: unknown[], tenant = T) {
  return inTenant(async () => {
    const made = await wizards.createWizard("u", {
      definition: { ...base, steps } as never,
      spaceId,
    } as never);
    return runner.createRun({
      wizardId: made.id,
      definition: { ...base, steps } as never,
      files: [],
      version: null,
      mode: "test",
      userId: "u",
    });
  }, tenant);
}

const cursorOf = (connectionId: string, tenant = T) =>
  inTenant(
    () =>
      client.db.query.mailCursor.findFirst({
        where: eq(client.schema.mailCursor.connectionId, connectionId),
      }),
    tenant,
  );
const signalsOf = (spaceId: string, tenant = T) =>
  inTenant(
    () =>
      client.db.query.runSignal.findMany({
        where: and(
          eq(client.schema.runSignal.spaceId, spaceId),
          eq(client.schema.runSignal.name, "mail.received"),
        ),
      }),
    tenant,
  );
/** Each look of the minute job, past the lease another look left. */
const nextMinute = (() => {
  let at = Date.now();
  return () => {
    at += 60_000;
    return watch.watchMail(new Date(Math.max(at, Date.now())));
  };
})();

let space: string;

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.controlDb
    .insert(client.control.tenant)
    .values([
      { id: T, name: T, status: "active" },
      { id: `${T}-b`, name: `${T}-b`, status: "active" },
    ] as never)
    .onConflictDoNothing();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  watch = await import("../src/engine/mail-watch");
  connections = await import("../src/connectors/space-connections");
  services = await import("../src/services/signals");
  crypto = await import("../src/secrets/crypto");
  const { googleConnectors } = await import("../src/engenty/connections-google/definitions");
  connector = googleConnectors.find((c) => c.id === "google-gmail") as ConnectorDefinition;
  const stream = connector.stream as NonNullable<ConnectorDefinition["stream"]>;
  realPull = stream.pull;
  stream.read = async (_ctx, message) => {
    reads.push(message);
    return readAnswer(message);
  };
  stream.pull = (ctx, cursor) => {
    pulls.push({
      cursor,
      since: ctx.since,
      limit: ctx.limit,
      connection: ctx.connection.id,
    });
    return answer(cursor, ctx);
  };
  runner.startRunner();
  space = await makeSpace("Vertrieb");
});
afterAll(() => runner.stopRunner());

/** Each test's mailbox off again: they all share a space. */
const others = new Set<string>();
const own = async (options: Parameters<typeof mailbox>[1] = {}, spaceId = space) => {
  await inTenant(() =>
    client.db
      .update(client.schema.spaceConnection)
      .set({ autonomousMode: "off" })
      .where(eq(client.schema.spaceConnection.spaceId, spaceId)),
  );
  const id = await mailbox(spaceId, options);
  others.add(id);
  return id;
};

describe("a mail wakes a run", () => {
  it("by its sender: two signals, the data below `data`, and the run goes on", async () => {
    const id = await own();
    const runId = await startIn(space, [waitFor(ANNA), agent("after"), end]);
    expect(await rests(runId)).toBe(true);
    const sent = mail();
    answer = async () => ({ hasMore: false, items: [sent], nextCursor: "history-2" });
    await nextMinute();
    expect(await hasStatus(runId, "done")).toBe(true);
    const output = (await row(runId))?.state.outputs.reply?.json as {
      came: boolean;
      data: Record<string, unknown>;
    };
    expect(output.came).toBe(true);
    expect(output.data).toMatchObject({
      from: ANNA,
      name: "Anna",
      subject: "Re: Angebot",
      text: "Passt, danke.",
      thread: sent.provider_thread_id,
      message: sent.provider_message_id,
    });
    const keys = (await signalsOf(space))
      .filter((s) => s.delivery === sent.provider_message_id)
      .map((s) => s.key);
    expect(keys.sort()).toEqual([ANNA, `thread:t-${n}`].sort());
    const kept = await cursorOf(id);
    expect(kept?.cursor).toBe("history-2");
    expect(kept?.readAt).toBeTruthy();
    expect(kept?.error).toBeNull();
  });

  it("by the thread of the mail the run sent: its send's thread_id is the exact match", async () => {
    await own();
    const key = "thread:{{steps.send.thread_id}}";
    const runId = await startIn(space, [agent("send"), waitFor(key), agent("after"), end]);
    expect(await rests(runId)).toBe(true);
    // A mail from someone else entirely, in that thread. Thread ids keep their case at the provider.
    answer = async () => ({
      hasMore: false,
      items: [mail({ from_email: `chef-${n}@kunde.at`, provider_thread_id: "T-Sent" })],
      nextCursor: "h",
    });
    await nextMinute();
    expect(await hasStatus(runId, "done")).toBe(true);
    expect((await row(runId))?.state.outputs.reply?.json).toMatchObject({ came: true });
  });

  it("another sender leaves it waiting", async () => {
    await own();
    const runId = await startIn(space, [waitFor(ANNA), end]);
    expect(await rests(runId)).toBe(true);
    answer = async () => ({
      hasMore: false,
      items: [mail({ from_email: `else-${n}@kunde.at`, provider_thread_id: `else-${n}` })],
      nextCursor: "h",
    });
    await nextMinute();
    await aWakeWouldHaveCome();
    expect((await row(runId))?.status).toBe("waiting_signal");
    await inTenant(() => runner.cancel(runId));
  });

  it("a mail that came after the run began but before it waits is still there", async () => {
    const id = await own();
    const first = await startIn(space, [waitFor(`nobody-${n}@kunde.at`), end]);
    expect(await rests(first)).toBe(true);
    // The other run has begun and works; the mail comes while it does, and the first run has the mailbox read.
    const later = await startIn(space, [agent("slow"), waitFor(ANNA), agent("after"), end]);
    answer = async () => ({ hasMore: false, items: [mail()], nextCursor: "h" });
    await nextMinute();
    expect(pulls.at(-1)?.connection).toBe(id);
    expect(await hasStatus(later, "done")).toBe(true);
    await inTenant(() => runner.cancel(first));
  });

  it("keeps a mail's text only where a run waits on it, and a later run reads it in the mailbox", async () => {
    await own();
    const waiting = await startIn(space, [waitFor(`thread:t-${n}`), end]);
    expect(await rests(waiting)).toBe(true);
    // Dated after the later run begins: a run only hears what came since it began.
    const soon = new Date(Date.now() + 30_000).toISOString();
    answer = async () => ({ hasMore: false, items: [mail({ received_at: soon })], nextCursor: "h" });
    await nextMinute();
    const rows = (await signalsOf(space)).filter((s) => s.delivery === `m-${n}`);
    const of = (key: string) => rows.find((r) => r.key === key)?.data as Record<string, unknown>;
    expect(of(`thread:t-${n}`).text).toBe("Passt, danke.");
    expect(of(ANNA)).toMatchObject({ from: ANNA, subject: "Re: Angebot", message: `m-${n}` });
    expect(of(ANNA)).not.toHaveProperty("text");

    reads.length = 0;
    const later = await startIn(space, [waitFor(ANNA), end]);
    expect(await hasStatus(later, "done")).toBe(true);
    expect(reads).toEqual([`m-${n}`]);
    expect((await row(later))?.state.outputs.reply?.json).toMatchObject({
      came: true,
      data: { from: ANNA, text: "Aus dem Postfach gelesen." },
    });
  });

  it("a mail gone from the mailbox still wakes the run, with no text", async () => {
    await own();
    const first = await startIn(space, [waitFor(`nobody-${n}@kunde.at`), end]);
    expect(await rests(first)).toBe(true);
    const soon = new Date(Date.now() + 30_000).toISOString();
    answer = async () => ({ hasMore: false, items: [mail({ received_at: soon })], nextCursor: "h" });
    await nextMinute();
    readAnswer = async () => null;
    const later = await startIn(space, [waitFor(ANNA), end]);
    expect(await hasStatus(later, "done")).toBe(true);
    expect((await row(later))?.state.outputs.reply?.json).toMatchObject({
      came: true,
      data: { text: null },
    });
    await inTenant(() => runner.cancel(first));
  });

  it("a sender who failed the provider's checks wakes no wait on that sender, and their thread does", async () => {
    await own();
    const bySender = await startIn(space, [waitFor(ANNA), end]);
    const byThread = await startIn(space, [waitFor(`thread:t-${n}`), end]);
    expect(await rests(bySender)).toBe(true);
    expect(await rests(byThread)).toBe(true);
    answer = async () => ({
      hasMore: false,
      items: [mail({ sender_failed_checks: true })],
      nextCursor: "h",
    });
    await nextMinute();
    expect(await hasStatus(byThread, "done")).toBe(true);
    expect((await row(bySender))?.status).toBe("waiting_signal");
    await inTenant(() => runner.cancel(bySender));
  });
});

/** Long enough for a wake to have reached a runner: it looks at the line every 2 s. */
const aWakeWouldHaveCome = () => new Promise((r) => setTimeout(r, 2300));

describe("what wakes nobody", () => {
  const stays = async (item: Partial<InboundMessage>, written = 0) => {
    await own();
    const runId = await startIn(space, [waitFor(`thread:t-${n}`), end]);
    expect(await rests(runId)).toBe(true);
    answer = async () => ({ hasMore: false, items: [mail(item)], nextCursor: "h" });
    await nextMinute();
    expect(pulls.length).toBeGreaterThan(0);
    const same = (await signalsOf(space)).filter((s) => s.delivery === `m-${n}`);
    expect(same).toHaveLength(written);
    await aWakeWouldHaveCome();
    expect((await row(runId))?.status).toBe("waiting_signal");
    await inTenant(() => runner.cancel(runId));
  };

  it("the run's own sent mail, though it is in the thread", () => stays({ outgoing: true }));
  it("an out-of-office answer or a bounce", () => stays({ auto_reply: true }));
  it("a mail from before the run began, though the mailbox was read that far", async () => {
    // Another run is older, so this mail is read: the wait must still not take it.
    const older = await startIn(space, [waitFor(`nobody-${n}@kunde.at`), end]);
    expect(await rests(older)).toBe(true);
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ createdAt: new Date(Date.now() - 3_000_000) })
        .where(eq(client.schema.run.id, older)),
    );
    await stays({ received_at: new Date(Date.now() - 1_000_000).toISOString() }, 2);
    await inTenant(() => runner.cancel(older));
  });
  it("a mail from before anyone could care is not even kept", () =>
    stays({ received_at: new Date(Date.now() - 86_400_000).toISOString() }));

  it("a From that spells a thread's key does not reach that thread", async () => {
    await own();
    const thread = `thread:secret-${n}`;
    const runId = await startIn(space, [waitFor(thread), end]);
    expect(await rests(runId)).toBe(true);
    answer = async () => ({
      hasMore: false,
      items: [mail({ from_email: thread, provider_thread_id: `other-${n}` })],
      nextCursor: "h",
    });
    await nextMinute();
    const keys = (await signalsOf(space))
      .filter((s) => s.delivery === `m-${n}`)
      .map((s) => s.key);
    expect(keys).toEqual([`thread:other-${n}`]);
    await aWakeWouldHaveCome();
    expect((await row(runId))?.status).toBe("waiting_signal");
    await inTenant(() => runner.cancel(runId));
  });
});

describe("the cursor", () => {
  it("expired: starts over from a date, and what it already sent is not sent again", async () => {
    const id = await own();
    await inTenant(() =>
      client.db
        .update(client.schema.mailCursor)
        .set({ cursor: "history-old" })
        .where(eq(client.schema.mailCursor.connectionId, id)),
    );
    const runId = await startIn(space, [waitFor(ANNA), agent("after"), end]);
    expect(await rests(runId)).toBe(true);
    answer = async (cursor) => {
      if (cursor === "history-old") {
        throw new Error("gmail_stream_cursor_expired: the history cursor is no longer valid");
      }
      return { hasMore: false, items: [mail()], nextCursor: "history-new" };
    };
    await nextMinute();
    expect(pulls.map((p) => p.cursor)).toEqual(["history-old", null]);
    expect(pulls[1].since).toBeTruthy();
    expect((await cursorOf(id))?.cursor).toBe("history-new");
    expect((await cursorOf(id))?.error).toBeNull();
    expect(await hasStatus(runId, "done")).toBe(true);
  });

  it("a crash before the cursor is saved repeats no signal", async () => {
    const id = await own();
    const runId = await startIn(space, [
      waitFor(ANNA),
      { ...waitFor(ANNA), id: "again" },
      agent("after"),
      end,
    ]);
    expect(await rests(runId)).toBe(true);
    const same = mail();
    answer = async () => ({ hasMore: false, items: [same], nextCursor: "history-2" });
    await nextMinute();
    // The process died after the signals, before the cursor: nothing is left of the save.
    await inTenant(() =>
      client.db
        .update(client.schema.mailCursor)
        .set({ cursor: null })
        .where(eq(client.schema.mailCursor.connectionId, id)),
    );
    // The first wait took the mail; the second must not take it again on the repeat.
    expect(await until(async () => (await row(runId))?.cursor === "again")).toBe(true);
    expect(await rests(runId)).toBe(true);
    const before = (await signalsOf(space)).filter((s) => s.delivery === same.provider_message_id);
    expect(before).toHaveLength(2);
    await nextMinute();
    await nextMinute();
    expect((await cursorOf(id))?.cursor).toBe("history-2");
    const after = (await signalsOf(space)).filter((s) => s.delivery === same.provider_message_id);
    expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort());
    await aWakeWouldHaveCome();
    expect((await row(runId))?.status).toBe("waiting_signal");
    expect((await row(runId))?.cursor).toBe("again");
    await inTenant(() => runner.cancel(runId));
  });

  it("many pages: saved after each, the rest next minute", async () => {
    const id = await own();
    const runId = await startIn(space, [waitFor(`nobody-${n}@kunde.at`), end]);
    expect(await rests(runId)).toBe(true);
    answer = async (cursor) => ({
      hasMore: true,
      items: [],
      nextCursor: `${cursor ?? ""}x`,
    });
    await nextMinute();
    expect(pulls).toHaveLength(5);
    expect((await cursorOf(id))?.cursor).toBe("xxxxx");
    await inTenant(() => runner.cancel(runId));
  });

  it("a failed pull is kept for the share dialog and waits longer each time", async () => {
    const id = await own();
    const runId = await startIn(space, [waitFor(`nobody-${n}@kunde.at`), end]);
    expect(await rests(runId)).toBe(true);
    answer = async () => {
      throw new Error("Google API error (401)");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = Date.now() + 10 * 3_600_000;
    await watch.watchMail(new Date(now));
    expect(pulls).toHaveLength(1);
    const first = await cursorOf(id);
    expect(first?.error).toBe("sign_in");
    expect(first?.failures).toBe(1);
    expect(first?.nextAt?.getTime()).toBe(now + 120_000);
    // A minute on it is not asked again.
    await watch.watchMail(new Date(now + 60_000));
    expect(pulls).toHaveLength(1);
    await watch.watchMail(new Date(now + 121_000));
    expect(pulls).toHaveLength(2);
    expect((await cursorOf(id))?.failures).toBe(2);
    warn.mockRestore();
    await inTenant(() => runner.cancel(runId));
  });
});

describe("what is never pulled", () => {
  it("a mailbox nobody waits on", async () => {
    const quiet = await makeSpace(`Still ${n}`);
    await mailbox(quiet);
    const runId = await startIn(quiet, [agent("work"), end]);
    expect(await hasStatus(runId, "done")).toBe(true);
    await nextMinute();
    expect(pulls.filter((p) => p.connection)).toHaveLength(0);
  });

  it("a run that waits on other signals costs no pull either", async () => {
    const quiet = await makeSpace(`Rechnung ${n}`);
    await mailbox(quiet);
    const runId = await startIn(quiet, [
      { id: "paid", type: "wait", title: "x", signal: { name: "invoice.paid", key: ANNA } },
      end,
    ]);
    expect(await rests(runId)).toBe(true);
    await nextMinute();
    expect(pulls).toHaveLength(0);
    await inTenant(() => runner.cancel(runId));
  });

  it("a wait ended: pulling stops with it", async () => {
    const quiet = await makeSpace(`Ende ${n}`);
    const id = await mailbox(quiet);
    const runId = await startIn(quiet, [waitFor(ANNA), end]);
    expect(await rests(runId)).toBe(true);
    await nextMinute();
    expect(pulls.map((p) => p.connection)).toEqual([id]);
    await inTenant(() => runner.cancel(runId));
    expect(await hasStatus(runId, "cancelled")).toBe(true);
    pulls.length = 0;
    await nextMinute();
    expect(pulls).toHaveLength(0);
  });

  it("a mailbox no admin switched on, though a run waits", async () => {
    const closed = await makeSpace(`Zu ${n}`);
    await mailbox(closed, { on: false });
    const runId = await startIn(closed, [waitFor(ANNA), end]);
    expect(await rests(runId)).toBe(true);
    await nextMinute();
    expect(pulls).toHaveLength(0);
    await inTenant(() => runner.cancel(runId));
  });

  it("a connection whose rule asks before reading: refused, and said in the dialog", async () => {
    const ruled = await makeSpace(`Regel ${n}`);
    const id = await mailbox(ruled, { rules: { read: "ask" } });
    const runId = await startIn(ruled, [waitFor(ANNA), end]);
    expect(await rests(runId)).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await nextMinute();
    warn.mockRestore();
    expect(pulls).toHaveLength(0);
    expect((await cursorOf(id))?.error).toBe("rules");
    await inTenant(() => runner.cancel(runId));
  });

  it("each person's own sign-in", async () => {
    const own2 = await makeSpace(`Person ${n}`);
    const id = await mailbox(own2);
    await inTenant(() =>
      client.db
        .update(client.schema.spaceConnection)
        .set({ signIn: "person" })
        .where(eq(client.schema.spaceConnection.id, id)),
    );
    const runId = await startIn(own2, [waitFor(ANNA), end]);
    expect(await rests(runId)).toBe(true);
    await nextMinute();
    expect(pulls).toHaveLength(0);
    await inTenant(() => runner.cancel(runId));
  });
});

describe("other spaces and tenants", () => {
  it("another space's mail wakes nothing here", async () => {
    const here = await makeSpace(`Hier ${n}`);
    const there = await makeSpace(`Dort ${n}`);
    await mailbox(there);
    const waiting = await startIn(here, [waitFor(ANNA), end]);
    const reading = await startIn(there, [waitFor(`nobody-${n}@kunde.at`), end]);
    expect(await rests(waiting)).toBe(true);
    expect(await rests(reading)).toBe(true);
    answer = async () => ({ hasMore: false, items: [mail()], nextCursor: "h" });
    await nextMinute();
    expect((await signalsOf(there)).length).toBeGreaterThan(0);
    expect(await signalsOf(here)).toHaveLength(0);
    await aWakeWouldHaveCome();
    expect((await row(waiting))?.status).toBe("waiting_signal");
    await inTenant(() => runner.cancel(waiting));
    await inTenant(() => runner.cancel(reading));
  });

  it("a run waiting in a space does not get another tenant's mailbox pulled", async () => {
    const other = `${T}-b`;
    const theirs = await makeSpace("Fremd", other);
    await mailbox(theirs, { tenant: other });
    const runId = await startIn(space, [waitFor(`nobody-${n}@kunde.at`), end]);
    expect(await rests(runId)).toBe(true);
    await own();
    await nextMinute();
    expect(pulls.length).toBeGreaterThan(0);
    const here = [...others];
    expect(pulls.every((p) => here.includes(p.connection))).toBe(true);
    await inTenant(() => runner.cancel(runId));
  });
});

describe("the switch", () => {
  const admin = { id: "u", role: "owner" } as never;

  it("needs an admin, and starts from now: what came before stays unread", async () => {
    const mine = await makeSpace(`Schalter ${n}`);
    const id = await mailbox(mine, { on: false });
    const before = Date.now();
    const seen = await inTenant(() =>
      connections.updateSpaceConnection("u", id, { autonomousMode: "read_only" }),
    );
    expect(seen.autonomousMode).toBe("read_only");
    const kept = await cursorOf(id);
    expect(kept?.cursor).toBeNull();
    expect(kept?.since.getTime()).toBeGreaterThanOrEqual(before);
    const log = await inTenant(() =>
      client.db.query.brokerLog.findFirst({
        where: and(
          eq(client.schema.brokerLog.connectionId, id),
          eq(client.schema.brokerLog.actionId, "change_rules"),
        ),
      }),
    );
    expect(log?.reason).toContain("read while a run waits");
  });

  it("off forgets the cursor", async () => {
    const mine = await makeSpace(`Aus ${n}`);
    const id = await mailbox(mine);
    await inTenant(() => connections.updateSpaceConnection("u", id, { autonomousMode: "off" }));
    expect(await cursorOf(id)).toBeUndefined();
  });

  it("another account signing in ends the consent; the same one keeps it", async () => {
    const mine = await makeSpace(`Konto ${n}`);
    const id = await mailbox(mine);
    const rowOf = () => inTenant(() => connections.spaceConnectionById(id));
    await inTenant(async () =>
      connections.keepSpaceSignIn(await rowOf(), "vertrieb@firma.at", {
        accessToken: "new",
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      }),
    );
    expect((await rowOf()).autonomousMode).toBe("read_only");
    expect(await cursorOf(id)).toBeTruthy();
    await inTenant(async () =>
      connections.keepSpaceSignIn(await rowOf(), "privat@firma.at", {
        accessToken: "new",
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      }),
    );
    expect((await rowOf()).autonomousMode).toBe("off");
    expect(await cursorOf(id)).toBeUndefined();
  });

  it("only a mailbox can be switched", async () => {
    const mine = await makeSpace(`Kalender ${n}`);
    const id = await mailbox(mine, { on: false });
    await inTenant(() =>
      client.db
        .update(client.schema.spaceConnection)
        .set({ connectorId: "google-calendar" })
        .where(eq(client.schema.spaceConnection.id, id)),
    );
    await expect(
      inTenant(() => connections.updateSpaceConnection("u", id, { autonomousMode: "read_only" })),
    ).rejects.toThrow(/no mailbox/);
  });

  it("the share dialog's list says what it read and what went wrong", async () => {
    const mine = await makeSpace(`Liste ${n}`);
    const id = await mailbox(mine);
    const closed = await mailbox(mine, { on: false });
    const runId = await startIn(mine, [waitFor(ANNA), end]);
    expect(await rests(runId)).toBe(true);
    await nextMinute();
    const wizardId = (await row(runId))?.wizardId as string;
    const answerOf = await inTenant(() => services.wizardMailboxes(admin, wizardId));
    expect(answerOf.canSwitch).toBe(true);
    const on = answerOf.mailboxes.find((m) => m.id === id);
    expect(on).toMatchObject({ on: true, account: "vertrieb@firma.at", error: null });
    expect(on?.readAt).toBeTruthy();
    expect(answerOf.mailboxes.find((m) => m.id === closed)).toMatchObject({
      on: false,
      readAt: null,
    });
    await inTenant(() => runner.cancel(runId));
  });
});

describe("the broker", () => {
  it("keeps a line of a pull that found mail, as the runtime and by the admin's consent; an empty one leaves none", async () => {
    const mine = await makeSpace(`Log ${n}`);
    const id = await mailbox(mine);
    const runId = await startIn(mine, [waitFor(ANNA), end]);
    expect(await rests(runId)).toBe(true);
    const lines = () =>
      inTenant(() =>
        client.db.query.brokerLog.findMany({
          where: and(
            eq(client.schema.brokerLog.connectionId, id),
            eq(client.schema.brokerLog.actionId, "pull_stream"),
          ),
        }),
      );
    await nextMinute();
    expect(pulls.length).toBeGreaterThan(0);
    expect(await lines()).toHaveLength(0);
    answer = async () => ({ hasMore: false, items: [mail()], nextCursor: "h" });
    await nextMinute();
    const [line] = await lines();
    expect(line).toMatchObject({
      whoKind: "runtime",
      kind: "read",
      outcome: "allow",
      rule: "autonomous_mode",
      result: "ok",
    });
    await inTenant(() => runner.cancel(runId));
  });

  it("the account a pull gets says the connection's own consent", async () => {
    const mine = await makeSpace(`Mode ${n}`);
    await mailbox(mine);
    const runId = await startIn(mine, [waitFor(ANNA), end]);
    expect(await rests(runId)).toBe(true);
    let mode = "";
    answer = async (cursor, ctx) => {
      mode = ctx.connection.autonomous_mode;
      return { hasMore: false, items: [], nextCursor: cursor };
    };
    await nextMinute();
    expect(mode).toBe("read_only");
    await inTenant(() => runner.cancel(runId));
  });
});

/** Gmail's own pull, against a fake of its HTTP API. No mailbox is reached. */
describe("Gmail's pull", () => {
  const message = (id: string, labelIds: string[], headers: Record<string, string> = {}) => ({
    id,
    threadId: `thread-of-${id}`,
    labelIds,
    internalDate: "1793900000000",
    snippet: "Hallo",
    payload: {
      mimeType: "text/plain",
      body: { data: Buffer.from("Hallo").toString("base64url") },
      headers: Object.entries({ From: "Anna <anna@kunde.at>", Subject: "Re", ...headers }).map(
        ([name, value]) => ({ name, value }),
      ),
    },
  });
  const fakeCtx = (routes: Record<string, unknown | number>) =>
    ({
      accessToken: "fake",
      log: () => undefined,
      limit: 50,
      since: "2026-11-05T10:00:00.000Z",
      fetchImpl: async (url: string) => {
        const path = new URL(url);
        const key = Object.keys(routes).find((k) => (path.pathname + path.search).includes(k));
        const answered = key === undefined ? 404 : routes[key];
        return typeof answered === "number"
          ? new Response("{}", { status: answered })
          : new Response(JSON.stringify(answered), { status: 200 });
      },
    }) as never;

  it("reads Gmail's own verdict on a sender, not one the sender added below it", async () => {
    const withHeaders = (headers: { name: string; value: string }[]) => {
      const raw = message("in", ["INBOX"]);
      return {
        ...raw,
        payload: { ...raw.payload, headers: [...headers, ...(raw.payload?.headers ?? [])] },
      };
    };
    const verdict = async (headers: { name: string; value: string }[]) => {
      const got = await realPull(
        fakeCtx({
          "/history": {
            historyId: "9",
            history: [{ id: "8", messagesAdded: [{ message: { id: "in", labelIds: ["INBOX"] } }] }],
          },
          "/messages/in": withHeaders(headers),
        }),
        "5",
      );
      return got.items[0].sender_failed_checks;
    };
    const said = (value: string) => ({ name: "Authentication-Results", value });
    expect(await verdict([said("mx.google.com; spf=fail smtp.mailfrom=x; dmarc=fail")])).toBe(true);
    expect(await verdict([said("mx.google.com; spf=pass; dmarc=fail")])).toBe(true);
    expect(await verdict([said("mx.google.com; spf=softfail; dmarc=pass")])).toBe(false);
    expect(await verdict([])).toBe(false);
    expect(
      await verdict([said("mx.google.com; spf=pass; dmarc=pass"), said("evil; spf=fail")]),
    ).toBe(false);
  });

  it("gives a mail's sender, thread and date, and marks the mailbox's own", async () => {
    const got = await realPull(
      fakeCtx({
        "/history": {
          historyId: "9",
          history: [
            {
              id: "8",
              messagesAdded: [
                { message: { id: "in", labelIds: ["INBOX"] } },
                { message: { id: "out", labelIds: ["SENT"] } },
              ],
            },
          ],
        },
        "/messages/in": message("in", ["INBOX"]),
        "/messages/out": message("out", ["SENT"]),
      }),
      "5",
    );
    expect(got.nextCursor).toBe("9");
    const [a, b] = got.items;
    expect(a).toMatchObject({
      from_email: "anna@kunde.at",
      from_name: "Anna",
      provider_message_id: "in",
      provider_thread_id: "thread-of-in",
      outgoing: false,
      auto_reply: false,
    });
    expect(b.outgoing).toBe(true);
  });

  it("marks an out-of-office answer and a bounce, keeps an invoice that a machine wrote", async () => {
    const history = (ids: string[]) => ({
      historyId: "9",
      history: [
        {
          id: "8",
          messagesAdded: ids.map((id) => ({ message: { id, labelIds: ["INBOX"] } })),
        },
      ],
    });
    const got = await realPull(
      fakeCtx({
        "/history": history(["ooo", "x", "bounce", "invoice"]),
        "/messages/ooo": message("ooo", ["INBOX"], { "Auto-Submitted": "auto-replied" }),
        "/messages/x": message("x", ["INBOX"], { "X-Autoreply": "yes" }),
        "/messages/bounce": message("bounce", ["INBOX"], {
          From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        }),
        "/messages/invoice": message("invoice", ["INBOX"], { "Auto-Submitted": "auto-generated" }),
      }),
      "5",
    );
    expect(Object.fromEntries(got.items.map((m) => [m.provider_message_id, m.auto_reply]))).toEqual(
      { ooo: true, x: true, bounce: true, invoice: false },
    );
  });

  it("leaves out what Gmail threw out, though the history lists it without a label", async () => {
    const got = await realPull(
      fakeCtx({
        "/history": {
          historyId: "9",
          history: [{ id: "8", messagesAdded: [{ message: { id: "spam" } }] }],
        },
        "/messages/spam": message("spam", ["SPAM"]),
      }),
      "5",
    );
    expect(got.items).toEqual([]);
  });

  it("says when its cursor expired", async () => {
    await expect(realPull(fakeCtx({ "/history": 404 }), "5")).rejects.toThrow(
      /gmail_stream_cursor_expired/,
    );
  });

  it("starts without a cursor from `since`, not from thirty days back", async () => {
    let query = "";
    const ctx = fakeCtx({ "/profile": { historyId: "7" } }) as { fetchImpl: typeof fetch };
    const answer0 = ctx.fetchImpl;
    ctx.fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes("/messages?")) {
        query = new URL(url).searchParams.get("q") ?? "";
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return answer0(url, init);
    }) as never;
    const got = await realPull(ctx as never, null);
    expect(query).toContain(`after:${Date.parse("2026-11-05T10:00:00.000Z") / 1000}`);
    expect(got.nextCursor).toBe("7");
  });
});

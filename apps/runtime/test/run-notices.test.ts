import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-run-notices-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "durableRuns=on";

/** What the Manage-App was asked to send. */
const mails = vi.fn(async (_input: Record<string, unknown>) => ({ ok: true, sent: true }));
const pushes = vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }));
vi.mock("../src/manage.js", async (original) => ({
  ...(await original<typeof import("../src/manage.js")>()),
  managed: true,
  runMail: mails,
  pushToDevice: pushes,
  tenantInfo: async (id: string) => ({ id, status: "active", limits: {} }),
}));

vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
  canSpend: async () => true,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let notices: typeof import("../src/engine/notices");
let push: typeof import("../src/engine/push");
let signing: typeof import("../src/secrets/signing");
let manage: typeof import("../src/manage");
let app: { fetch: (r: Request) => Promise<Response> };

const T = "tenant-run-notices";
const SPACE = "space-1";
const USER = "u";
const OTHER = "u2";
const SECRET = "AT611904300234573201";

const result = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const first = {
  id: "first",
  type: "page",
  title: "Deine Daten",
  fields: [
    { id: "iban", kind: "text", label: "IBAN" },
    { id: "email", kind: "email", label: "E-Mail", notify: true },
    { id: "kunde", kind: "email", label: "Kunde" },
  ],
};
const second = {
  id: "second",
  type: "page",
  title: "Noch eine Frage",
  fields: [{ id: "more", kind: "text", label: "Mehr" }],
};
/** A page, a page that makes it wait for the person again, the end. */
const flow = {
  version: 1,
  title: "Angebot nachfassen",
  description: "",
  avatar: "round",
  steps: [first, second, result],
};

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);

const allNotices = () => inTenant(() => client.db.query.notice.findMany());
const noticesOf = async (runId: string) => (await allNotices()).filter((n) => n.runId === runId);

async function until(ok: () => boolean | Promise<boolean>, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const statusOf = (runId: string) =>
  inTenant(async () => {
    const row = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) });
    return row?.status;
  });

/** A published wizard and a run on its first page, by whoever `who` says. */
async function startRun(
  who: { userId?: string; visitorId?: string; mode?: "test" | "live" } = {},
  def: object = flow,
) {
  return inTenant(async () => {
    // The cloud builds no wizards: the row comes as a computer would have published it.
    const created = { id: nanoid(12), shareToken: nanoid(16) };
    await client.db.insert(client.schema.wizard).values({
      ...created,
      spaceId: SPACE,
      tenantId: T,
      title: flow.title,
      draft: def as never,
      publishedVersion: 1,
    });
    const w = { draft: def as never, shareToken: created.shareToken };
    const runId = await runner.createRun({
      wizardId: created.id,
      definition: w.draft,
      files: [],
      version: 1,
      mode: who.mode ?? "live",
      userId: who.userId ?? null,
      visitorId: who.visitorId ?? null,
    });
    return { runId, wizardId: created.id, token: w.shareToken };
  });
}

/** Fills the first page: the run goes on by itself and waits on the second. */
async function toSecondPage(runId: string, values: Record<string, unknown> = { iban: SECRET }) {
  await inTenant(() => runner.submitPage(runId, "first", values));
  expect(
    await until(async () => {
      const row = await inTenant(() =>
        client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }),
      );
      return row?.status === "waiting_input" && row.cursor === "second";
    }),
  ).toBe(true);
}

const deliver = (at = new Date()) => inTenant(() => notices.deliverNotices(at));
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(T);
  await client.controlDb
    .insert(client.control.tenant)
    .values({ id: T, status: "active" } as never)
    .onConflictDoNothing()
    .catch(() => undefined);
  const { env } = await import("../src/env");
  env.limits.concurrentRuns = 1000;
  env.runner.maxRuns = 1000;
  runner = await import("../src/engine/runner");
  await inTenant(() =>
    client.db.insert(client.schema.space).values({ id: SPACE, tenantId: T, name: "Space" } as never),
  );
  notices = await import("../src/engine/notices");
  push = await import("../src/engine/push");
  signing = await import("../src/secrets/signing");
  manage = await import("../src/manage");
  app = (await import("../src/app")).default as never;
  runner.startRunner();
}, 60_000);

afterAll(() => runner.stopRunner?.());

beforeEach(async () => {
  mails.mockClear();
  mails.mockImplementation(async () => ({ ok: true, sent: true }));
  pushes.mockClear();
  pushes.mockImplementation(async () => ({ ok: true }));
  process.env.FEATURES = "durableRuns=on";
  // Whatever the test before left due is not this test's, also what its run does after its end.
  await until(async () => {
    const rows = await inTenant(() =>
      client.db.query.run.findMany({ where: eq(client.schema.run.status, "running") }),
    );
    return rows.length === 0;
  });
  await inTenant(() => client.db.delete(client.schema.notice));
});

describe("the outbox", () => {
  it("writes the row with the status, and nothing goes out until a sender looks", async () => {
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    const [row] = await noticesOf(runId);
    expect(row).toMatchObject({
      kind: "needs_you",
      userId: USER,
      waitKey: "step:second",
      detail: "Noch eine Frage",
      shown: false,
    });
    expect(row?.dueAt).toBeTruthy();
    expect(mails).not.toHaveBeenCalled();
    expect(await inTenant(() => notices.listNotices(USER))).toHaveLength(0);
  });

  it("writes neither the status's notice nor anything else when the status's guard fails", async () => {
    const { runId, wizardId } = await startRun({ userId: USER });
    await inTenant(async () => {
      const values = {
        kind: "done" as const,
        wizardId,
        runId,
        userId: USER,
        shown: false,
        dueAt: new Date(),
      };
      const no = eq(client.schema.run.id, "no-such-run");
      await client.db.batch([...notices.noticeWrites(values, no)]);
      expect(await client.db.query.notice.findMany()).toHaveLength(0);
      const yes = eq(client.schema.run.id, runId);
      await client.db.batch([...notices.noticeWrites(values, yes)]);
      expect(await client.db.query.notice.findMany()).toHaveLength(1);
      // The same word again replaces the first.
      await client.db.batch([...notices.noticeWrites(values, yes)]);
      expect(await client.db.query.notice.findMany()).toHaveLength(1);
    });
  });

  it("loses nothing when a sender dies holding a row: the next one sends it, once", async () => {
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    // A sender took it and died before it sent anything.
    await inTenant(() =>
      client.db
        .update(client.schema.notice)
        .set({ claimUntil: inMinutes(2) })
        .where(eq(client.schema.notice.runId, runId)),
    );
    await deliver();
    expect(mails).not.toHaveBeenCalled();
    await deliver(inMinutes(3));
    expect(mails).toHaveBeenCalledTimes(1);
    await deliver(inMinutes(30));
    expect(mails).toHaveBeenCalledTimes(1);
  });

  it("uses the same key and link after a sender died between the mail and writing it down", async () => {
    const { runId, token } = await startRun({ visitorId: "v-crash" });
    await toSecondPage(runId, { iban: SECRET, email: "gast@example.test" });
    const [row] = await noticesOf(runId);
    await deliver();
    const firstTry = mails.mock.calls[0]?.[0] as { key: string; url: string };
    expect(firstTry.key).toBe(row?.id);
    expect(firstTry.url).toContain(`/w/${token}/${runId}?rt=`);
    // As if the row had never been marked: the sender died right after the mail went.
    await inTenant(async () => {
      const again = {
        ...row,
        id: row?.id as string,
        dueAt: new Date(),
        claimUntil: null,
        mailedAt: null,
      };
      await client.db.insert(client.schema.notice).values(again as never);
    });
    await deliver();
    const secondTry = mails.mock.calls[1]?.[0] as { key: string; url: string };
    expect(secondTry).toEqual(firstTry);
  });

  it("two senders at once send each row once", async () => {
    const runs = await Promise.all([1, 2, 3].map(() => startRun({ userId: USER })));
    await Promise.all(runs.map((r) => toSecondPage(r.runId)));
    await Promise.all([deliver(), deliver(), deliver()]);
    expect(mails).toHaveBeenCalledTimes(3);
    const links = mails.mock.calls.map((c) => c[0].url);
    expect(new Set(links).size).toBe(3);
  });

  it("the sender goes through every active tenant", async () => {
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    await notices.deliverAllNotices();
    expect(mails).toHaveBeenCalledTimes(1);
  });
});

describe("someone looking", () => {
  it("a person watching isn't told, and an answer before they leave ends it", async () => {
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    await push.setRunViewed(runId);
    await deliver();
    expect(mails).not.toHaveBeenCalled();
    expect(await inTenant(() => notices.listNotices(USER))).toHaveLength(0);
    await inTenant(() => runner.submitPage(runId, "second", { more: "x" }));
    await deliver(inMinutes(30));
    expect(mails).toHaveBeenCalledTimes(0);
    // The run ended: that word was for someone watching too, and the wait's row is gone.
    expect((await noticesOf(runId)).some((n) => n.kind === "needs_you")).toBe(false);
  });

  it("who leaves without answering: the bell and device at once, the mail after ten minutes", async () => {
    const { runId } = await startRun({ userId: USER });
    await push.setPushDevice(runId, { token: "12345678", platform: "ios", lang: "de" });
    await toSecondPage(runId);
    await push.setRunViewed(runId);
    await deliver(inMinutes(2));
    expect(pushes).toHaveBeenCalledTimes(1);
    expect(await inTenant(() => notices.listNotices(USER))).toHaveLength(1);
    expect(mails).not.toHaveBeenCalled();
    await deliver(inMinutes(9));
    expect(mails).not.toHaveBeenCalled();
    await deliver(inMinutes(11));
    expect(mails).toHaveBeenCalledTimes(1);
    expect(pushes).toHaveBeenCalledTimes(1);
  });

  it("nobody hears a run ended that they watched end", async () => {
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    await inTenant(() => runner.submitPage(runId, "second", { more: "x" }));
    expect(await until(async () => (await statusOf(runId)) === "done")).toBe(true);
    await push.setRunViewed(runId);
    await deliver(inMinutes(30));
    expect(mails).not.toHaveBeenCalled();
    expect(await inTenant(() => notices.listNotices(USER))).toHaveLength(0);
  });

  it("another member looking does not count as the person looking", async () => {
    const { runId } = await startRun({ visitorId: "v-looked-at" });
    const before = await client.controlDb.query.runIndex.findFirst({
      where: eq(client.control.runIndex.runId, runId),
    });
    const res = await app.fetch(
      new Request(`http://localhost:5181/api/runs/${runId}/seen`, {
        method: "POST",
        headers: { "x-wizards-visitor": "someone-else" },
      }),
    );
    expect(res.status).toBe(404);
    expect(before?.viewedAt).toBeNull();
    const own = await app.fetch(
      new Request(`http://localhost:5181/api/runs/${runId}/seen`, {
        method: "POST",
        headers: { "x-wizards-visitor": "v-looked-at" },
      }),
    );
    expect(own.status).toBe(200);
    const after = await client.controlDb.query.runIndex.findFirst({
      where: eq(client.control.runIndex.runId, runId),
    });
    expect(after?.viewedAt).toBeTruthy();
  });
});

describe("every path that waits", () => {
  it("createRun: who starts a run stands on its first page and isn't told", async () => {
    const member = await startRun({ userId: USER });
    const guest = await startRun({ visitorId: "v-start" });
    expect(await statusOf(member.runId)).toBe("waiting_input");
    expect(await noticesOf(member.runId)).toHaveLength(0);
    expect(await noticesOf(guest.runId)).toHaveLength(0);
  });

  it("noticeFor tells the run's person when someone else brought it there", async () => {
    const run = {
      id: "r",
      wizardId: "w",
      userId: USER,
      visitorId: null,
      runner: null,
      unattended: false,
      impersonatedBy: null,
      startedBy: null,
    };
    await inTenant(async () => {
      expect(await notices.noticeFor(run, "needs_you", { by: { userId: USER } })).toBeNull();
      expect(await notices.noticeFor(run, "needs_you", { by: { userId: OTHER } })).not.toBeNull();
      expect(await notices.noticeFor(run, "needs_you")).not.toBeNull();
    });
  });

  it("goBack: going back on one's own page tells nobody", async () => {
    const { runId } = await startRun({ visitorId: "v-back" });
    await toSecondPage(runId, { iban: SECRET, email: "gast@example.test" });
    await deliver();
    mails.mockClear();
    const res = await app.fetch(
      new Request(`http://localhost:5181/api/runs/${runId}/back`, {
        method: "POST",
        headers: { "x-wizards-visitor": "v-back" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await noticesOf(runId)).toHaveLength(0);
    await deliver(inMinutes(30));
    expect(mails).not.toHaveBeenCalled();
  });

  it("goBack by someone else tells the run's person", async () => {
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    await inTenant(() => runner.goBack(runId, { userId: OTHER }));
    const rows = await noticesOf(runId);
    expect(rows.filter((n) => n.kind === "needs_you")).toHaveLength(1);
    expect(rows[0]?.waitKey).toBe("step:first");
  });

  it("a wait someone answered tells nobody any more, and counts as read in the bell", async () => {
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    await deliver();
    expect((await inTenant(() => notices.listNotices(USER)))[0]?.read).toBe(false);
    await inTenant(() => runner.submitPage(runId, "second", { more: "x" }));
    const list = await inTenant(() => notices.listNotices(USER));
    expect(list.find((n) => n.kind === "needs_you")?.read).toBe(true);
  });

  it("a question inside a step tells too, and is over when the step goes on", async () => {
    const { runId } = await startRun({ userId: USER });
    const asks = await import("../src/engine/asks");
    const stop = new AbortController();
    const asked = inTenant(() =>
      asks.askPerson(
        runId,
        { kind: "confirm", stepId: "first", title: "Darf ich?", detail: SECRET } as never,
        stop.signal,
      ),
    );
    expect(await until(async () => (await noticesOf(runId)).length === 1)).toBe(true);
    const [row] = await noticesOf(runId);
    expect(row?.waitKey).toMatch(/^ask:/);
    expect(row?.detail).toBeNull();
    stop.abort();
    await asked;
    await deliver();
    expect(mails).not.toHaveBeenCalled();
    expect(await noticesOf(runId)).toHaveLength(0);
  });

  it("a run's end tells, with no mail for a test run", async () => {
    const { runId } = await startRun({ userId: USER, mode: "test" });
    await toSecondPage(runId);
    await deliver();
    expect(mails).not.toHaveBeenCalled();
    expect(await inTenant(() => notices.listNotices(USER))).toHaveLength(1);
  });

  it("a channel's run is told in its channel, an autopilot's nowhere", async () => {
    const run = {
      id: "r",
      wizardId: "w",
      userId: null,
      visitorId: "v",
      runner: null,
      unattended: false,
      impersonatedBy: null,
      startedBy: null,
    };
    await inTenant(async () => {
      expect(await notices.noticeFor({ ...run, runner: "whatsapp" }, "needs_you")).toBeNull();
      expect(await notices.noticeFor({ ...run, unattended: true }, "needs_you")).toBeNull();
      expect(await notices.noticeFor({ ...run, impersonatedBy: "a" }, "needs_you")).toBeNull();
    });
  });

  it("without the switch: only a started run has a word, and a run's device hears at once", async () => {
    process.env.FEATURES = "durableRuns=off";
    const { runId } = await startRun({ userId: USER });
    await push.setPushDevice(runId, { token: "12345678", platform: "ios", lang: "de" });
    await toSecondPage(runId);
    expect(await noticesOf(runId)).toHaveLength(0);
    expect(await until(() => pushes.mock.calls.length === 1)).toBe(true);
    await deliver();
    expect(mails).not.toHaveBeenCalled();
  });
});

describe("who is told, and how", () => {
  it("a member by bell and mail, by their id: the address is the Manage-App's to know", async () => {
    const { runId, wizardId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    await deliver();
    expect(mails).toHaveBeenCalledTimes(1);
    const mail = mails.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mail).toMatchObject({
      kind: "waiting",
      wizard: "Angebot nachfassen",
      tenantId: T,
      to: { userId: USER },
      lang: "de",
    });
    // A member signs in: their link carries no ticket.
    expect(mail.url).toBe(`http://localhost:5181/studio/edit/${wizardId}?run=${runId}`);
    expect(await inTenant(() => notices.listNotices(USER))).toHaveLength(1);
    expect(await inTenant(() => notices.listNotices(OTHER))).toHaveLength(0);
  });

  it("a visitor by the address they left, with no bell", async () => {
    const { runId } = await startRun({ visitorId: "v-mail" });
    await toSecondPage(runId, { iban: SECRET, email: "gast@example.test" });
    await deliver();
    expect(mails.mock.calls[0]?.[0]).toMatchObject({ to: { email: "gast@example.test" } });
    expect(await inTenant(() => notices.listNotices(USER))).toHaveLength(0);
    // Delivered, a visitor's row has nothing left to do.
    expect(await noticesOf(runId)).toHaveLength(0);
  });

  it("an address that wasn't left for this gets no mail, whoever's it is", async () => {
    const { runId } = await startRun({ visitorId: "v-customer" });
    await toSecondPage(runId, { iban: SECRET, kunde: "kundin@example.test" });
    await deliver();
    expect(mails).not.toHaveBeenCalled();
    expect(await noticesOf(runId)).toHaveLength(0);
  });

  it("a visitor who left no address gets no mail", async () => {
    const { runId } = await startRun({ visitorId: "v-none" });
    await toSecondPage(runId);
    await deliver();
    expect(mails).not.toHaveBeenCalled();
    expect(await noticesOf(runId)).toHaveLength(0);
  });

  it("a visitor by push on the device they gave the run", async () => {
    const { runId } = await startRun({ visitorId: "v-push" });
    await push.setPushDevice(runId, { token: "abcdefgh", platform: "android", lang: "en" });
    await toSecondPage(runId);
    await deliver();
    expect(pushes).toHaveBeenCalledTimes(1);
    expect(pushes.mock.calls[0]?.[0]).toMatchObject({
      device: { token: "abcdefgh", platform: "android" },
      body: "The wizard is waiting for you.",
      data: { runId, kind: "waiting" },
    });
  });

  it("no answer, no result and no question in a mail", async () => {
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    await inTenant(() => runner.submitPage(runId, "second", { more: "GEHEIM" }));
    expect(await until(async () => (await statusOf(runId)) === "done")).toBe(true);
    await deliver();
    expect(mails.mock.calls.length).toBeGreaterThan(0);
    for (const [call] of mails.mock.calls) {
      const sent = JSON.stringify(call);
      expect(sent).not.toContain(SECRET);
      expect(sent).not.toContain("GEHEIM");
      expect(sent).not.toContain("Noch eine Frage");
      expect(Object.keys(call).sort()).toEqual(
        ["key", "kind", "lang", "tenantId", "to", "url", "wizard"].sort(),
      );
    }
  });

  it("a failed run's error stays in the bell, out of the mail", async () => {
    const { runId } = await startRun({ userId: USER });
    await inTenant(async () => {
      const [row] = await client.db.query.run.findMany({
        where: eq(client.schema.run.id, runId),
      });
      await client.db.batch([
        ...notices.noticeWrites(
          {
            kind: "failed",
            wizardId: row?.wizardId as string,
            runId,
            userId: USER,
            detail: SECRET,
            shown: false,
            dueAt: new Date(),
          },
          eq(client.schema.run.id, runId),
        ),
      ]);
    });
    await deliver();
    expect(JSON.stringify(mails.mock.calls)).not.toContain(SECRET);
    expect((await inTenant(() => notices.listNotices(USER)))[0]?.detail).toBe(SECRET);
  });
});

describe("the Manage-App's answers", () => {
  it("copes with a Manage-App without the route: no mail, no more tries, the bell stays", async () => {
    mails.mockImplementation(async () => {
      throw new manage.ManageError(404, "not_found", "Not found.");
    });
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    await deliver();
    await deliver(inMinutes(120));
    expect(mails).toHaveBeenCalledTimes(1);
    expect(await inTenant(() => notices.listNotices(USER))).toHaveLength(1);
    expect((await noticesOf(runId))[0]?.dueAt).toBeNull();
  });

  it("a limit is an answer too", async () => {
    mails.mockImplementation(async () => {
      throw new manage.ManageError(429, "rate_limited", "Too many.");
    });
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    await deliver();
    await deliver(inMinutes(120));
    expect(mails).toHaveBeenCalledTimes(1);
  });

  it("a Manage-App out of reach gets tried again, and given up on after a while", async () => {
    mails.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    const { runId } = await startRun({ userId: USER });
    await toSecondPage(runId);
    let at = Date.now();
    for (let i = 0; i < 10; i++) {
      await deliver(new Date(at));
      at += 90 * 60_000;
    }
    expect(mails).toHaveBeenCalledTimes(6);
    expect((await noticesOf(runId))[0]?.dueAt).toBeNull();
  });

  it("a run still waits when no notice can be delivered: a status never hangs on one", async () => {
    pushes.mockImplementation(async () => {
      throw new manage.ManageError(404, "not_found", "Not found.");
    });
    const { runId } = await startRun({ userId: USER });
    await push.setPushDevice(runId, { token: "12345678", platform: "ios", lang: "de" });
    await toSecondPage(runId);
    await deliver();
    expect(await statusOf(runId)).toBe("waiting_input");
    expect(mails).toHaveBeenCalledTimes(1);
  });
});

describe("the link in a visitor's mail", () => {
  const api = (runId: string, path: string, rt: string, method = "POST") =>
    app.fetch(
      new Request(
        `http://localhost:5181/api/runs/${runId}${path}?rt=${encodeURIComponent(rt)}`,
        method === "GET"
          ? {}
          : {
              method,
              headers: { "content-type": "application/json", origin: "https://elsewhere.test" },
              body: "{}",
            },
      ),
    );

  async function mailedTicket(runId: string) {
    await toSecondPage(runId, { iban: SECRET, email: "gast@example.test" });
    await deliver();
    const { url } = mails.mock.calls.at(-1)?.[0] as { url: string };
    return new URL(url).searchParams.get("rt") as string;
  }

  it("lasts as long as the run is kept", async () => {
    const { runId } = await startRun({ visitorId: "v-long" });
    const ticket = await mailedTicket(runId);
    const row = await inTenant(() =>
      client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }),
    );
    expect(Number(ticket.split(".")[0])).toBe(
      Math.floor((row?.expiresAt?.getTime() as number) / 1000),
    );
    expect(signing.runWaitTicketValid(runId, ticket)).toBe(true);
    expect(signing.runWaitTicketValid("another-run", ticket)).toBe(false);
    expect(signing.runTicketValid(runId, ticket)).toBe(false);
  });

  it("reads the run and answers it, and does nothing else", async () => {
    const { runId } = await startRun({ visitorId: "v-narrow" });
    const ticket = await mailedTicket(runId);
    expect((await api(runId, "", ticket, "GET")).status).toBe(200);
    for (const path of [
      "/cancel",
      "/retry",
      "/talk",
      "/transcribe",
      "/share",
      "/share/jobs",
      "/notify",
      "/feedback",
      "/device",
      "/lists/l/rows",
      "/connections/c/credentials/x",
    ]) {
      expect([path, (await api(runId, path, ticket)).status]).toEqual([path, 404]);
    }
    // These two say "not waiting" to anyone they refuse.
    expect((await api(runId, "/browser/act", ticket)).status).toBe(409);
    expect((await api(runId, "/browser/seat", ticket)).status).toBe(409);
    expect((await api(runId, "/browser/seat", ticket, "GET")).status).toBe(404);
    expect((await api(runId, "/store", ticket, "DELETE")).status).toBe(404);
    expect((await api(runId, "/outputs/first", ticket, "PUT")).status).toBe(404);
    expect(await statusOf(runId)).toBe("waiting_input");
    const answered = await app.fetch(
      new Request(
        `http://localhost:5181/api/runs/${runId}/pages/second?rt=${encodeURIComponent(ticket)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { more: "x" } }),
        },
      ),
    );
    expect(answered.status).toBe(200);
  });

  it("opens no door for other websites, as the widget's ticket does", async () => {
    const { runId } = await startRun({ visitorId: "v-cors" });
    const ticket = await mailedTicket(runId);
    const res = await app.fetch(
      new Request(`http://localhost:5181/api/runs/${runId}?rt=${encodeURIComponent(ticket)}`, {
        headers: { origin: "https://elsewhere.test" },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).not.toBe("https://elsewhere.test");
  });

  it("a mail about the end only reads", async () => {
    const { runId } = await startRun({ visitorId: "v-end" });
    await toSecondPage(runId, { iban: SECRET, email: "gast@example.test" });
    await deliver();
    await inTenant(() => runner.submitPage(runId, "second", { more: "x" }));
    expect(await until(async () => (await statusOf(runId)) === "done")).toBe(true);
    await deliver();
    const last = mails.mock.calls.at(-1)?.[0] as { kind: string; url: string };
    expect(last.kind).toBe("done");
    const ticket = new URL(last.url).searchParams.get("rt") as string;
    expect((await api(runId, "", ticket, "GET")).status).toBe(200);
    expect((await api(runId, "/back", ticket)).status).toBe(404);
  });

  it("a ticket past its time opens nothing", async () => {
    const { runId } = await startRun({ visitorId: "v-old" });
    const old = signing.runWaitTicket(runId, new Date(Date.now() - 1000));
    expect((await api(runId, "", old, "GET")).status).toBe(404);
    expect((await api(runId, "/back", old)).status).toBe(404);
  });
});

describe("a reminder", () => {
  const reminding = {
    ...flow,
    steps: [{ ...second, id: "lead", title: "Vorweg" }, { ...second, remind: "1h" }, result],
  };
  const onFirst = { ...flow, steps: [{ ...second, remind: "1h" }, result] };
  const kinds = (rows: { kind: string }[]) => rows.map((n) => n.kind).sort();
  const reachSecond = async (runId: string) => {
    await inTenant(() => runner.submitPage(runId, "lead", { more: "x" }));
    expect(
      await until(async () => {
        const row = await inTenant(() =>
          client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }),
        );
        return row?.status === "waiting_input" && row.cursor === "second";
      }),
    ).toBe(true);
  };

  it("is written with the wait, due at `remind`, on the wait's key", async () => {
    const { runId } = await startRun({ userId: USER }, reminding);
    await reachSecond(runId);
    const row = (await noticesOf(runId)).find((n) => n.kind === "reminder");
    expect(row?.waitKey).toBe("step:second");
    expect(row?.shown).toBe(false);
    const late = (row?.dueAt?.getTime() ?? 0) - Date.now();
    expect(late).toBeGreaterThan(59 * 60_000);
    expect(late).toBeLessThanOrEqual(60 * 60_000);
  });

  it("goes out at its time, once: the bell, one mail, a line in the log", async () => {
    const { runId } = await startRun({ userId: USER }, reminding);
    await reachSecond(runId);
    await deliver();
    expect(mails).toHaveBeenCalledTimes(1);
    mails.mockClear();
    await deliver(inMinutes(30));
    expect(mails).not.toHaveBeenCalled();
    await deliver(inMinutes(61));
    expect(mails).toHaveBeenCalledTimes(1);
    expect(mails.mock.calls[0][0]).toMatchObject({ kind: "waiting" });
    await deliver(inMinutes(62));
    await deliver(inMinutes(200));
    expect(mails).toHaveBeenCalledTimes(1);
    const bell = await inTenant(() => notices.listNotices(USER));
    expect(bell.find((n) => n.kind === "reminder")).toMatchObject({ read: false });
    const log = await inTenant(() =>
      client.db.select().from(client.schema.runEvent).where(eq(client.schema.runEvent.runId, runId)),
    );
    expect(log.filter((e) => e.note?.code === "reminderSent")).toHaveLength(1);
  });

  it("an answer settles it: nobody is reminded, and the bell has nothing", async () => {
    const { runId } = await startRun({ userId: USER }, reminding);
    await reachSecond(runId);
    await inTenant(() => runner.submitPage(runId, "second", { more: "x" }));
    expect(await until(async () => (await statusOf(runId)) === "done")).toBe(true);
    mails.mockClear();
    await deliver(inMinutes(61));
    expect(mails.mock.calls.filter(([m]) => m.kind === "waiting")).toHaveLength(0);
    expect(kinds(await noticesOf(runId))).not.toContain("reminder");
  });

  it("a stop settles it", async () => {
    const { runId } = await startRun({ userId: USER }, reminding);
    await reachSecond(runId);
    await inTenant(() => runner.stopRun(runId, "Ana"));
    mails.mockClear();
    await deliver(inMinutes(61));
    expect(mails).not.toHaveBeenCalled();
    expect(kinds(await noticesOf(runId))).not.toContain("reminder");
  });

  it("while they look it waits; once they have left it goes", async () => {
    const { runId } = await startRun({ userId: USER }, reminding);
    await reachSecond(runId);
    const at = inMinutes(61);
    await client.controlDb
      .update(client.control.runIndex)
      .set({ viewedAt: at })
      .where(eq(client.control.runIndex.runId, runId));
    mails.mockClear();
    await deliver(at);
    expect(mails).not.toHaveBeenCalled();
    await deliver(new Date(at.getTime() + notices.QUIET_MS + 1000));
    expect(mails).toHaveBeenCalledTimes(1);
  });

  it("a first word not yet delivered goes with it: one word, one mail", async () => {
    const { runId } = await startRun({ userId: USER }, reminding);
    await reachSecond(runId);
    // They looked just now, so the first word has been waiting for them to leave.
    const at = inMinutes(61);
    await client.controlDb
      .update(client.control.runIndex)
      .set({ viewedAt: new Date(at.getTime() - notices.LOOKING_MS - 1000) })
      .where(eq(client.control.runIndex.runId, runId));
    await deliver(new Date(at.getTime() + notices.QUIET_MS));
    expect(mails).toHaveBeenCalledTimes(1);
    expect(kinds(await noticesOf(runId))).toEqual(["reminder"]);
  });

  it("each wait has its own, and a new wait replaces the last", async () => {
    const { runId } = await startRun({ userId: USER }, { ...flow, steps: [{ ...first, remind: "1h" }, second, result] });
    const before = (await noticesOf(runId)).filter((n) => n.kind === "reminder");
    expect(before).toHaveLength(1);
    await inTenant(() => runner.submitPage(runId, "first", { iban: "x" }));
    expect(
      await until(async () => {
        const row = await inTenant(() =>
          client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }),
        );
        return row?.status === "waiting_input" && row.cursor === "second";
      }),
    ).toBe(true);
    await inTenant(() => runner.goBack(runId, { userId: USER }));
    const after = (await noticesOf(runId)).filter((n) => n.kind === "reminder");
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(before[0].id);
  });

  it("createRun: whoever opened the first page and left is reminded, and told nothing before", async () => {
    const { runId } = await startRun({ userId: USER }, onFirst);
    expect(kinds(await noticesOf(runId))).toEqual(["reminder"]);
    await deliver();
    expect(mails).not.toHaveBeenCalled();
    await deliver(inMinutes(61));
    expect(mails).toHaveBeenCalledTimes(1);
  });

  it("an autopilot, a channel: nobody here is reminded", async () => {
    const created = { id: nanoid(12), shareToken: nanoid(16) };
    const runId = await inTenant(async () => {
      await client.db.insert(client.schema.wizard).values({
        ...created,
        spaceId: SPACE,
        tenantId: T,
        title: flow.title,
        draft: onFirst as never,
        publishedVersion: 1,
      });
      return runner.createRun({
        wizardId: created.id,
        definition: onFirst as never,
        files: [],
        version: 1,
        mode: "live",
        userId: USER,
        unattended: true,
      });
    });
    expect(await noticesOf(runId)).toHaveLength(0);
  });

  it("with the switch off, no reminder", async () => {
    process.env.FEATURES = "";
    const { runId } = await startRun({ userId: USER }, onFirst);
    expect(await noticesOf(runId)).toHaveLength(0);
  });
});

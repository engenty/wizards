import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Between this runtime's processes: a process without a runner hands a run to one at once, and a
// watcher looks often while the run is at work, so a page another process reached shows quickly.
const dir = mkdtempSync(join(tmpdir(), "wizards-peer-wake-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

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
let wizards: typeof import("../src/services/wizards");
let events: typeof import("../src/engine/events");
let signing: typeof import("../src/secrets/signing");
let app: { fetch: (r: Request) => Promise<Response> };

const T = "local";
const page = (id: string) => ({
  id,
  type: "page",
  title: id,
  fields: [{ id: `${id}_f`, kind: "text", label: "T" }],
});
const def = {
  version: 1,
  title: "Wecken",
  description: "",
  avatar: "round",
  steps: [page("a"), page("b"), { id: "done", type: "result", title: "Fertig", deliverables: [] }],
};

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);
const row = (runId: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }));

async function startRun() {
  return inTenant(async () => {
    const { id: wizardId } = await wizards.createWizard("u", { definition: def as never });
    return runner.createRun({
      wizardId,
      definition: def as never,
      files: [],
      version: null,
      mode: "test",
      userId: "u",
    });
  });
}

const take = (runId: string, tenant: string, ticket: string) =>
  app.fetch(
    new Request(`http://localhost:5181/api/peer/runs/${runId}/take`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
      body: JSON.stringify({ tenant }),
    }),
  );

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  events = await import("../src/engine/events");
  signing = await import("../src/secrets/signing");
  app = (await import("../src/app")).default as never;
}, 60_000);

describe("the peer ticket", () => {
  it("opens the one run of the one tenant, for a minute", () => {
    const ticket = signing.peerTicket("r1", "t1");
    expect(signing.peerTicketValid("r1", "t1", ticket)).toBe(true);
    expect(signing.peerTicketValid("r2", "t1", ticket)).toBe(false);
    expect(signing.peerTicketValid("r1", "t2", ticket)).toBe(false);
    expect(signing.peerTicketValid("r1", "t1", undefined)).toBe(false);
    const [, sig] = ticket.split(".");
    expect(signing.peerTicketValid("r1", "t1", `${Math.floor(Date.now() / 1000) - 1}.${sig}`)).toBe(
      false,
    );
  });
});

describe("POST /api/peer/runs/:id/take", () => {
  it("refuses a request without the ticket", async () => {
    const runId = await startRun();
    expect((await take(runId, T, "nope")).status).toBe(401);
    expect((await take(runId, T, signing.peerTicket(runId, "other"))).status).toBe(401);
  });

  it("takes the run at once in a process that runs runs", async () => {
    const runId = await startRun();
    // As a process without a runner leaves it: running, in the line, nobody on it.
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ status: "running", cursor: "b" })
        .where(eq(client.schema.run.id, runId)),
    );
    const { wakeRun } = await import("../src/tenants/control");
    await wakeRun(runId);
    const res = await take(runId, T, signing.peerTicket(runId, T));
    expect(res.status).toBe(202);
    await vi.waitFor(
      async () => expect(await row(runId)).toMatchObject({ status: "waiting_input", cursor: "b" }),
      { timeout: 3000, interval: 20 },
    );
  });
});

describe("watchRun", () => {
  it("hears another process's write within a few looks while the run is at work", async () => {
    const runId = await startRun();
    const heard: number[] = [];
    const stop = await inTenant(async () => events.watchRun(runId, () => heard.push(Date.now())));
    try {
      // The first look has been; this process changed the run (an answer).
      await new Promise((r) => setTimeout(r, 150));
      events.signalChanged(runId);
      heard.length = 0;
      // Another process writes the row, as a runner reaching the next page does.
      const at = Date.now();
      await inTenant(() =>
        client.db
          .update(client.schema.run)
          .set({ updatedAt: new Date(at + 5) })
          .where(eq(client.schema.run.id, runId)),
      );
      await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0), {
        timeout: 2000,
        interval: 10,
      });
      expect(heard[0] - at).toBeLessThan(400);
    } finally {
      stop();
    }
  });
});

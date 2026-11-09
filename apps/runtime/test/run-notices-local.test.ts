import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A computer on its own: `MANAGE_URL` is empty.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-run-notices-local-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.MANAGE_URL = "";
process.env.FEATURES = "durableRuns=on";

const accountMail = vi.fn(async (_input: Record<string, unknown>) => null as unknown);
vi.mock("../src/auth/account.js", async (original) => ({
  ...(await original<typeof import("../src/auth/account.js")>()),
  accountRunMail: accountMail,
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
let wizards: typeof import("../src/services/wizards");
let notices: typeof import("../src/engine/notices");
const fetched = vi.spyOn(globalThis, "fetch");

const T = "tenant-run-notices-local";
const USER = "local";

const flow = {
  version: 1,
  title: "Mein Wizard",
  description: "",
  avatar: "round",
  steps: [
    {
      id: "first",
      type: "form",
      title: "Erste",
      fields: [{ id: "email", kind: "email", label: "E-Mail", notify: true }],
    },
    {
      id: "second",
      type: "form",
      title: "Zweite",
      fields: [{ id: "more", kind: "text", label: "Mehr" }],
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);

/** A run through the wizard's link, waiting on the second page. */
async function waitingRun() {
  return inTenant(async () => {
    const created = await wizards.createWizard(USER, { definition: flow as never });
    await wizards.publishWizard(USER, created.id);
    const w = await wizards.ownedWizard(USER, created.id);
    const runId = await runner.createRun({
      wizardId: created.id,
      definition: w.draft,
      files: [],
      version: 1,
      mode: "live",
      visitorId: "v",
    });
    await runner.submitPage(runId, "first", { email: "gast@example.test" });
    for (let i = 0; i < 200; i++) {
      const row = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) });
      if (row?.status === "waiting_input" && row.cursor === "second") {
        return runId;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the run did not reach the second page");
  });
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(T);
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  notices = await import("../src/engine/notices");
  runner.startRunner();
}, 60_000);

beforeEach(async () => {
  accountMail.mockClear();
  fetched.mockClear();
  await inTenant(() => client.db.delete(client.schema.notice));
});

describe("a computer on its own", () => {
  it("shows the run in the bell, its one person's also through the wizard's link", async () => {
    const runId = await waitingRun();
    await inTenant(() => notices.deliverNotices());
    const list = await inTenant(() => notices.listNotices(USER));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "needs_you", runId, read: false });
  });

  it("without an account sends no mail and asks nobody", async () => {
    await waitingRun();
    await inTenant(() => notices.deliverNotices());
    expect(accountMail).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/v1/"))).toEqual(
      [],
    );
    // Nothing is left to try.
    const [row] = await inTenant(() => client.db.query.notice.findMany());
    expect(row?.dueAt).toBeNull();
    expect(row?.mailedAt).toBeTruthy();
  });

  it("with an account mails its own address, never the address on the field", async () => {
    accountMail.mockImplementation(async () => ({ sent: true }));
    await waitingRun();
    await inTenant(() => notices.deliverNotices());
    const mail = accountMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mail.kind).toBe("waiting");
    expect(mail.to).toBeUndefined();
    expect(JSON.stringify(mail)).not.toContain("gast@example.test");
    expect(String(mail.url)).toContain("/studio/edit/");
  });
});

describe("a step for the team on a computer", () => {
  it("tells its one person, whoever answered right before and through whichever door", async () => {
    const team = { ...flow.steps[1], who: "team" };
    const asked = { ...flow, steps: [flow.steps[0], team, flow.steps[2]] };
    const runId = await inTenant(async () => {
      const created = await wizards.createWizard(USER, { definition: asked as never });
      await wizards.publishWizard(USER, created.id);
      const id = await runner.createRun({
        wizardId: created.id,
        definition: asked as never,
        files: [],
        version: 1,
        mode: "live",
        visitorId: "v",
        runner: "whatsapp",
      });
      await runner.submitPage(id, "first", {}, { visitorId: "v" });
      return id;
    });
    let told: { visitor: boolean; userId: string | null }[] = [];
    for (let i = 0; i < 200 && !told.length; i++) {
      told = await inTenant(() =>
        client.db.query.notice.findMany({ where: eq(client.schema.notice.runId, runId) }),
      );
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(told.map((n) => [n.visitor, n.userId])).toEqual([[false, null]]);
  });
});

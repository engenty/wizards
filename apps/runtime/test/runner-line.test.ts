import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-line-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

let client: typeof import("../src/db/client");
let control: typeof import("../src/tenants/control");
let asks: typeof import("../src/engine/asks");
let wizards: typeof import("../src/services/wizards");
let env: typeof import("../src/env").env;

const T = "tenant-line";

const definition = {
  version: 1,
  title: "Line",
  description: "",
  avatar: "round",
  steps: [
    { id: "start", type: "page", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

/** A run row with its index entry, in `waiting_input`: nothing drives it. */
async function makeRun(id: string) {
  await client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", { definition });
    await client.db.insert(client.schema.run).values({
      id,
      wizardId: created.id,
      tenantId: T,
      definition: definition as never,
      files: [],
      version: null,
      mode: "test",
      status: "waiting_input",
      cursor: "start",
      state: { values: {}, outputs: {}, history: [], notes: {} },
    });
    await control.indexRun({ runId: id });
  });
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  control = await import("../src/tenants/control");
  asks = await import("../src/engine/asks");
  wizards = await import("../src/services/wizards");
  env = (await import("../src/env")).env;
  for (const id of ["r1", "r2", "r3"]) {
    await makeRun(id);
  }
});

describe("the line in the control database", () => {
  it("a woken run waits for a runner; claimed, it leaves the line", async () => {
    await control.wakeRun("r1");
    expect((await control.waitingRuns()).map((r) => r.runId)).toEqual(["r1"]);
    expect(await control.claimRun("r1", T, 4)).toBe(true);
    expect(await control.waitingRuns()).toEqual([]);
    // Held by this runner: nobody else gets it.
    expect(await control.claimRun("r1", T, 4)).toBe(false);
  });

  it("counts the tenant's held runs against its limit", async () => {
    await control.wakeRun("r2");
    expect(await control.claimRun("r2", T, 1)).toBe(false);
    expect((await control.waitingRuns()).map((r) => r.runId)).toEqual(["r2"]);
    expect(await control.claimRun("r2", T, 2)).toBe(true);
  });

  it("a runner that stops hands its runs back; a silent one loses them", async () => {
    await control.disownRuns();
    expect((await control.waitingRuns()).map((r) => r.runId).sort()).toEqual(["r1", "r2"]);
    expect(await control.claimRun("r1", T, 4)).toBe(true);
    // The owner's heartbeat is old: the run counts as unheld.
    await client.controlDb
      .update(client.control.runIndex)
      .set({ seen: new Date(Date.now() - control.RUNNER_STALE_MS - 1) })
      .where((await import("drizzle-orm")).eq(client.control.runIndex.runId, "r1"));
    expect((await control.waitingRuns()).map((r) => r.runId)).toContain("r1");
    await control.heartbeatRuns(["r1"]);
    expect((await control.waitingRuns()).map((r) => r.runId)).not.toContain("r1");
    await control.restRun("r1");
    await control.restRun("r2");
    expect(await control.waitingRuns()).toEqual([]);
  });

  it("a runner registers under its address and is found as a run's owner", async () => {
    await control.registerRunner();
    await control.wakeRun("r3");
    expect(await control.claimRun("r3", T, 4)).toBe(true);
    // Without RUNNER_URL the web has no address to ask.
    expect(await control.ownerUrl("r3")).toBeNull();
    await client.controlDb
      .update(client.control.runner)
      .set({ url: "http://runner:8891" })
      .where((await import("drizzle-orm")).eq(client.control.runner.id, env.runner.id));
    expect(await control.ownerUrl("r3")).toBe("http://runner:8891");
    await control.forgetRunner();
    expect(await control.ownerUrl("r3")).toBeNull();
    await control.restRun("r3");
  });
});

describe("a question through the run's row", () => {
  it("the answer written by one process reaches the step waiting in another", async () => {
    await client.withTenant(T, async () => {
      const abort = new AbortController();
      const waiting = asks.askPerson(
        "r1",
        { type: "sign_in", stepId: "start", title: "Anmelden", text: "" } as never,
        abort.signal,
      );
      let open = await asks.pendingAsk("r1");
      while (!open) {
        await new Promise((r) => setTimeout(r, 20));
        open = await asks.pendingAsk("r1");
      }
      // A stale id is refused; the open one takes the answer.
      expect(await asks.answerAsk("r1", "nope", { type: "done" })).toBe(false);
      expect(await asks.answerAsk("r1", open.id, { type: "done" })).toBe(true);
      expect(await waiting).toEqual({ type: "done" });
      expect(await asks.pendingAsk("r1")).toBeNull();
    });
  });

  it("an aborted wait is a skip, and a taken run starts with no question", async () => {
    await client.withTenant(T, async () => {
      const abort = new AbortController();
      const waiting = asks.askPerson(
        "r2",
        { type: "sign_in", stepId: "start", title: "Anmelden", text: "" } as never,
        abort.signal,
      );
      while (!(await asks.pendingAsk("r2"))) {
        await new Promise((r) => setTimeout(r, 20));
      }
      abort.abort();
      expect(await waiting).toEqual({ type: "skip" });
      await asks.clearStaleAsk("r2");
      expect(await asks.pendingAsk("r2")).toBeNull();
    });
  });
});

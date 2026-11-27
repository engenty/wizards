import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kernelShell } from "@engenty/wizards-shared/kernel-file";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-kernel-signals-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = "durableRuns=on";
process.env.RUNNER_CLOCK_MS = "100";
process.env.KERNEL_STEPS = "quickjs";

/**
 * Signals by address for a run of version 0.3.0 (docs/plans/kernel.md, C.10): the row a run waits
 * at is found by the signal's name and key, as a wait of the engine's own runs is.
 */
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
  missingConnectionsSaid: async () => [],
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

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let signals: typeof import("../src/engine/signals");
let wizards: typeof import("../src/services/wizards");
let files: typeof import("../src/services/files");

const T = "tenant-kernel-signals";

/** A step that waits for the payment of an order and leaves what the signal brought. */
const paid = (timeout: string) =>
  `export default async (run, ask) => {
  const signal = await ask({ type: "wait", signal: "order.paid", key: run.input.order, fields: ["amount"], timeout: "${timeout}" });
  return { value: { came: signal?.came === true, amount: signal?.data?.amount ?? null } };
};
`;
const input = { fields: [{ id: "order", label: "Order", kind: "text", required: true }] };
const one = {
  version: "0.3.0",
  title: "Paid",
  description: "",
  input,
  start: "paid",
  edges: { paid: ["end"] },
  output: { came: "paid.came", amount: "paid.amount" },
};
const two = {
  ...one,
  start: "first",
  edges: { first: ["second"], second: ["end"] },
  output: { first: "first.amount", second: "second.amount" },
};

type Made = { id: string; files: unknown[]; file: unknown; spaceId: string };

async function wizard(file: unknown, steps: Record<string, string>): Promise<Made> {
  return client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", { definition: kernelShell(file as never) as never });
    await files.seedFiles(created.id, steps);
    return {
      id: created.id,
      files: await files.draftFiles(created.id),
      file,
      spaceId: await runner.spaceIdOf({ wizardId: created.id }),
    };
  });
}
const start = (w: Made, order: string) =>
  client.withTenant(T, () =>
    runner.createRun({ wizardId: w.id, definition: kernelShell(w.file as never) as never, files: w.files as never, version: null, mode: "test", userId: "u", input: { order } }),
  );
const run = (id: string) =>
  client.withTenant(T, () => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }));
const output = async (id: string) => {
  const row = await run(id);
  return (await client.withTenant(T, () => runner.kernelRuns.view(row as never))).output;
};
const waitOf = (id: string) =>
  client.withTenant(T, () => client.db.query.runWait.findFirst({ where: eq(client.schema.runWait.runId, id) }));
const send = (w: Made, order: string, data: Record<string, unknown>, scope?: string) =>
  client.withTenant(T, () =>
    signals.sendSignal({ spaceId: w.spaceId, scope: scope ?? signals.wizardScope(w.id), name: "order.paid", key: order, data, source: "test" }),
  );
/** Waits until the run rests in one of these statuses. */
async function rests(id: string, ...statuses: string[]) {
  for (let i = 0; i < 200; i++) {
    const row = await run(id);
    if (row && statuses.includes(row.status) && !row.driving) {
      return row;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  const row = await run(id);
  throw new Error(`Run ${id} is ${row?.status} (${row?.error ?? "no error"}), not ${statuses.join(" or ")}.`);
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  signals = await import("../src/engine/signals");
  wizards = await import("../src/services/wizards");
  files = await import("../src/services/files");
  runner.startRunner();
});
afterAll(async () => {
  await runner.stopRunner();
});

describe("a run of version 0.3.0 that waits for a signal", () => {
  it("writes its wait where senders look, and a signal for its key ends it", async () => {
    const w = await wizard(one, { "steps/paid.ts": paid("1h") });
    const id = await start(w, "A-100");
    await rests(id, "waiting_signal");
    expect(await waitOf(id)).toMatchObject({ wizardId: w.id, name: "order.paid", key: "a-100", fields: ["amount"] });

    // another order's payment is not this run's
    expect((await send(w, "A-999", { amount: 5 })).runs).toBe(0);
    expect((await send(w, "A-100", { amount: 42 })).runs).toBe(1);
    await rests(id, "done");
    expect(await output(id)).toEqual({ came: true, amount: 42 });
    expect(await waitOf(id)).toBeUndefined();
  });

  it("takes a signal that came before it got to the wait", async () => {
    const w = await wizard(one, { "steps/paid.ts": paid("1h") });
    const before = Date.now();
    const id = await start(w, "B-200");
    // sent for the run alone, after it began: whether it stands at the wait yet does not matter
    await client.withTenant(T, () =>
      signals.sendSignal({ spaceId: w.spaceId, scope: signals.runScope(id), name: "order.paid", key: "B-200", data: { amount: 7 }, source: "test", at: new Date(Math.max(before, Date.now())) }),
    );
    await rests(id, "done");
    expect(await output(id)).toEqual({ came: true, amount: 7 });
  });

  it("is not woken by a signal that lacks the data it names", async () => {
    const w = await wizard(one, { "steps/paid.ts": paid("1h") });
    const id = await start(w, "C-300");
    await rests(id, "waiting_signal");
    expect((await send(w, "C-300", { note: "no amount" })).runs).toBe(0);
    expect((await rests(id, "waiting_signal")).status).toBe("waiting_signal");
    expect((await send(w, "C-300", { amount: 1 })).runs).toBe(1);
    await rests(id, "done");
  });

  it("gives one signal to one wait: the next wait for the same key needs a signal of its own", async () => {
    const step = paid("1h");
    const w = await wizard(two, { "steps/first.ts": step, "steps/second.ts": step });
    const id = await start(w, "D-400");
    await rests(id, "waiting_signal");
    await send(w, "D-400", { amount: 10 });
    // the first wait took it; the second stands and waits
    for (let i = 0; i < 200 && (await run(id))?.cursor !== "second"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const row = await rests(id, "waiting_signal");
    expect(row.cursor).toBe("second");
    expect(await waitOf(id)).toMatchObject({ name: "order.paid", key: "d-400" });
    await send(w, "D-400", { amount: 20 });
    await rests(id, "done");
    expect(await output(id)).toEqual({ first: 10, second: 20 });
  });

  it("takes a signal sent to the run itself, as the test event of a run is", async () => {
    const w = await wizard(one, { "steps/paid.ts": paid("1h") });
    const id = await start(w, "E-500");
    await rests(id, "waiting_signal");
    // data that does not fit is refused before anything is written
    expect(await client.withTenant(T, () => runner.signalRun(id, { data: {}, source: "test" }))).toBeNull();
    // a wait for another name does not take it
    expect(await client.withTenant(T, () => runner.signalRun(id, { data: { amount: 3 }, source: "test", only: "mail.received" }))).toBeNull();
    const sent = await client.withTenant(T, () => runner.signalRun(id, { data: { amount: 3 }, source: "test" }));
    expect(sent?.runs).toBe(1);
    await rests(id, "done");
    expect(await output(id)).toEqual({ came: true, amount: 3 });
  });

  it("drops its wait when the time is over first", async () => {
    const w = await wizard(one, { "steps/paid.ts": paid("1s") });
    const id = await start(w, "F-600");
    await rests(id, "waiting_signal");
    expect(await waitOf(id)).toBeDefined();
    await rests(id, "done");
    expect(await output(id)).toEqual({ came: false, amount: null });
    expect(await waitOf(id)).toBeUndefined();
    // a payment that comes late wakes nothing
    expect((await send(w, "F-600", { amount: 9 })).runs).toBe(0);
  });
});

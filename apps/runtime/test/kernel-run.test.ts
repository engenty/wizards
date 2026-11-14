import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kernelShell } from "@engenty/wizards-shared/kernel-file";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-kernel-run-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = "durableRuns=on,kernel=on";
process.env.RUNNER_CLOCK_MS = "100";

/**
 * A wizard in version 2 through the runtime (docs/plans/kernel.md): made as every wizard is,
 * its step files in its workspace, its runs in the engine's line. The model is a stand-in, as in
 * the other engine tests: what an ask becomes for today's step executors is what is looked at.
 */
const worked: { step: string; type: string; instructions?: string; tools?: unknown; connections?: unknown }[] = [];
const price = { next: [3000] as number[] };
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (
    step: { id: string; type: string; instructions?: string; tools?: unknown; connections?: unknown },
    ctx: { def: { connections?: unknown } },
  ) => {
    worked.push({ step: step.id, type: step.type, instructions: step.instructions, tools: step.tools, connections: ctx.def.connections });
    if (step.id === "offer/tone") {
      return { json: { score: 0.8, why: "Clear." }, at: new Date().toISOString() };
    }
    if (step.type === "tool") {
      return { json: { id: "msg_9" }, at: new Date().toISOString() };
    }
    if (step.id === "work") {
      return { json: { to: "einkauf@nordlicht.example", subject: "Re: Workshop", threadId: "thr_1", draft: "Dear Nordlicht" }, at: new Date().toISOString() };
    }
    if (step.id === "offer") {
      return { json: { text: "An offer", price: price.next.shift() ?? 3000 }, at: new Date().toISOString() };
    }
    return { json: { mail: "A reminder" }, at: new Date().toISOString() };
  },
}));
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
let wizards: typeof import("../src/services/wizards");
let files: typeof import("../src/services/files");
let doors: typeof import("../src/services/runs");

const T = "tenant-kernel-run";
const example = new URL("../../../packages/kernel/examples/offer/", import.meta.url).pathname;
const file = { ...JSON.parse(readFileSync(`${example}wizard.json`, "utf8")) };
const input = { customer: "Nordlicht GmbH", email: "einkauf@nordlicht.example", budget: 4000, items: [{ name: "Workshop", price: 1500, quantity: 2 }] };

/** The offer wizard in a tenant: its definition around the file, its step files in its workspace. */
async function offerWizard(mode: "quickjs" | "native" = "quickjs") {
  process.env.KERNEL_STEPS = mode;
  return client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", { definition: kernelShell(file) as never });
    const seed: Record<string, string> = { "wizard.ts": readFileSync(`${example}wizard.ts`, "utf8").replace("../../src/types.js", "./kernel-types.js") };
    for (const name of readdirSync(`${example}steps`)) {
      seed[`steps/${name}`] = readFileSync(`${example}steps/${name}`, "utf8");
    }
    await files.seedFiles(created.id, seed);
    return { id: created.id, files: await files.draftFiles(created.id) };
  });
}
const start = (w: { id: string; files: unknown[] }, given?: Record<string, unknown>) =>
  client.withTenant(T, () =>
    runner.createRun({
      wizardId: w.id,
      definition: kernelShell(file) as never,
      files: w.files as never,
      version: null,
      mode: "test",
      userId: "u",
      input: given,
    }),
  );
const run = (id: string) =>
  client.withTenant(T, () => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }));
const view = async (id: string) => {
  const row = await run(id);
  return client.withTenant(T, () => runner.kernelRuns.view(row as never));
};
const rowsOf = (id: string) =>
  client.withTenant(T, () =>
    client.db.select().from(client.schema.runRow).where(eq(client.schema.runRow.runId, id)).orderBy(asc(client.schema.runRow.n)),
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
const answer = (id: string, n: number, value: unknown) =>
  client.withTenant(T, () => runner.kernelRuns.answer(id, n, value, "u"));
const waitingRow = async (id: string) => {
  const v = await view(id);
  return v.waiting.at(-1) as { n: number; step: string; type: string };
};

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  files = await import("../src/services/files");
  doors = await import("../src/services/runs");
  runner.startRunner();
});
afterAll(async () => {
  await runner.stopRunner();
});

describe.each(["quickjs", "native"] as const)("a wizard in version 2, its steps run as %s", (mode) => {
  it("runs to the operator's review, and on to its end as each one answers", async () => {
    worked.length = 0;
    price.next = [3000];
    const w = await offerWizard(mode);
    const id = await start(w, input);

    let row = await rests(id, "waiting_input");
    expect(row.cursor).toBe("check");
    expect(worked.map((s) => [s.step, s.type])).toEqual([["offer", "agent"]]);
    expect(worked[0].instructions).toContain("Write an offer for Nordlicht GmbH.");
    expect((await rowsOf(id)).map((r) => [r.n, r.step, r.kind, r.state])).toEqual([
      [0, "offer", "ask", "done"],
      [1, "offer", "left", null],
      [2, "check", "ask", "waiting"],
    ]);

    await answer(id, 2, { approved: true });
    row = await rests(id, "waiting_input");
    expect(row.cursor).toBe("accept");
    await answer(id, (await waitingRow(id)).n, { approved: true });
    row = await rests(id, "waiting_signal");
    expect(row.cursor).toBe("signed");
    expect(row.wakeAt).not.toBeNull();
    await answer(id, (await waitingRow(id)).n, { came: true });

    row = await rests(id, "done");
    const done = await view(id);
    expect(done.output).toEqual({ offer: "An offer", price: 3000, signed: true });
    expect(done.rows.filter((r) => "left" in r).map((r) => r.step)).toEqual(["offer", "check", "accept", "signed"]);
  });

  it("asks for its input first when it is given none", async () => {
    const w = await offerWizard(mode);
    const id = await start(w);
    await rests(id, "waiting_input");
    const first = await waitingRow(id);
    expect(first).toMatchObject({ n: 0, step: "input", type: "form" });
    await expect(answer(id, 0, { customer: "N" })).rejects.toThrow('"email" is missing.');
    await answer(id, 0, input);
    const row = await rests(id, "waiting_input");
    expect(row.cursor).toBe("check");
  });

  it("goes back to an answer and on from there", async () => {
    price.next = [3000, 2800];
    const w = await offerWizard(mode);
    const id = await start(w, input);
    await rests(id, "waiting_input");
    await answer(id, 2, { approved: true });
    await rests(id, "waiting_input");
    // the operator's yes becomes a no: the offer is written again
    await client.withTenant(T, () => runner.kernelRuns.rewind(id, 2, { approved: false, note: "Shorter." }));
    const row = await rests(id, "waiting_input");
    expect(row.cursor).toBe("check");
    const v = await view(id);
    expect(v.rows.filter((r) => "left" in r).map((r) => r.step)).toEqual(["offer", "check", "offer"]);
    expect(String((v.rows[4] as { instructions?: string }).instructions)).toContain("The check step said: Shorter.");
  });

  it("fails on the file's limit, whatever the steps return", async () => {
    price.next = [3000, 3000, 3000, 3000];
    const w = await offerWizard(mode);
    const id = await start(w, input);
    for (let i = 0; i < 3; i++) {
      await rests(id, "waiting_input");
      await answer(id, (await waitingRow(id)).n, { approved: false, note: "No." });
    }
    const row = await rests(id, "failed");
    expect(row.error).toBe('"check" was reached more than 3 times.');
  });
});

it("fails a run whose step does not compile, and says where", async () => {
  process.env.KERNEL_STEPS = "quickjs";
  const w = await client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", { definition: kernelShell({ ...file, start: "bad", edges: { bad: ["end"] }, limits: {}, output: {} }) as never });
    await files.seedFiles(created.id, { "steps/bad.ts": 'import { readFileSync } from "node:fs";\nexport default async () => ({ value: readFileSync("/etc/passwd", "utf8") });\n' });
    return { id: created.id, files: await files.draftFiles(created.id) };
  });
  const id = await client.withTenant(T, () =>
    runner.createRun({ wizardId: w.id, definition: kernelShell({ ...file, start: "bad", edges: { bad: ["end"] }, limits: {}, output: {} }) as never, files: w.files as never, version: null, mode: "test", userId: "u", input: {} }),
  );
  const row = await rests(id, "failed");
  expect(row.error).toContain('steps/bad.ts:1: A step imports files of its own workspace only, not "node:fs".');
});

it("leaves a wizard in version 1 to today's engine", async () => {
  const id = await client.withTenant(T, async () => {
    const def = { version: 1, title: "Old", description: "", avatar: "round", steps: [{ id: "write", type: "agent", title: "Write", instructions: "Do it.", tools: [], output: { format: "text" } }, { id: "done", type: "result", title: "Done", deliverables: [] }] };
    const created = await wizards.createWizard("u", { definition: def as never });
    return runner.createRun({ wizardId: created.id, definition: def as never, files: [], version: null, mode: "test", userId: "u" });
  });
  const row = await rests(id, "waiting_input", "done");
  expect(row.state.kernel).toBeUndefined();
  expect(await rowsOf(id)).toEqual([]);
});

const folder = (name: string) => new URL(`../../../packages/kernel/examples/${name}/`, import.meta.url).pathname;
/** A wizard of the kernel's examples in the tenant, with every code file of its folder. */
async function exampleWizard(name: string, more: Record<string, string> = {}) {
  const at = folder(name);
  const its = JSON.parse(readFileSync(`${at}wizard.json`, "utf8"));
  return client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", { definition: kernelShell(its) as never });
    const seed: Record<string, string> = { ...more };
    for (const dirName of ["steps", "evals/offer", "evals/end"]) {
      try {
        for (const fileName of readdirSync(`${at}${dirName}`)) {
          seed[`${dirName}/${fileName}`] = readFileSync(`${at}${dirName}/${fileName}`, "utf8");
        }
      } catch {
        // the example has no such folder
      }
    }
    await files.seedFiles(created.id, seed);
    const snapshot = await files.draftFiles(created.id);
    return { id: created.id, files: snapshot, file: its };
  });
}
const startOf = (w: { id: string; files: unknown[]; file: unknown }, given?: Record<string, unknown>) =>
  client.withTenant(T, () =>
    runner.createRun({ wizardId: w.id, definition: kernelShell(w.file as never) as never, files: w.files as never, version: null, mode: "test", userId: "u", input: given }),
  );

describe("an action the file sets to ask", () => {
  it("waits for the user's leave as a row, and is done once", async () => {
    process.env.KERNEL_STEPS = "quickjs";
    worked.length = 0;
    const id = await startOf(await exampleWizard("mail"), { customer: "Nordlicht GmbH" });
    await rests(id, "waiting_input");
    // the agent was handed the two reading actions of the connection, and not the send
    const agent = worked.find((s) => s.step === "work");
    expect(agent?.connections).toMatchObject([{ id: "gmail", actions: ["users.threads.list", "users.threads.get"] }]);

    await answer(id, (await waitingRow(id)).n, { approved: true });
    await rests(id, "waiting_input");
    const leave = await waitingRow(id);
    expect(leave).toMatchObject({ type: "approval", step: "send", call: "gmail.users.messages.send" });
    expect(worked.some((s) => s.type === "tool")).toBe(false); // nothing is sent while it is open

    await answer(id, leave.n, { allow: true });
    await rests(id, "done");
    const tool = worked.find((s) => s.type === "tool");
    expect(tool?.connections).toMatchObject([{ id: "gmail", actions: ["users.messages.send"] }]);
    expect((await view(id)).output).toEqual({ sent: "msg_9" });
  });

  it("fails the action, and the run, when the user says no", async () => {
    worked.length = 0;
    const id = await startOf(await exampleWizard("mail"), { customer: "Nordlicht GmbH" });
    await rests(id, "waiting_input");
    await answer(id, (await waitingRow(id)).n, { approved: true });
    await rests(id, "waiting_input");
    await answer(id, (await waitingRow(id)).n, { allow: false });
    const row = await rests(id, "failed");
    expect(row.error).toBe('The user did not allow "gmail.users.messages.send".');
    expect(worked.some((s) => s.type === "tool")).toBe(false);
  });
});

describe("a wait", () => {
  it("leaves every process and is woken by the clock, with a timeout as its answer", async () => {
    const napFile = { version: 2, title: "Nap", description: "", start: "nap", edges: { nap: ["end"] }, output: { woke: "nap.timedOut" } };
    const w = await client.withTenant(T, async () => {
      const created = await wizards.createWizard("u", { definition: kernelShell(napFile as never) as never });
      await files.seedFiles(created.id, { "steps/nap.ts": 'export default async (run, ask) => ({ value: await ask({ type: "wait", timeout: "1s" }) });\n' });
      return { id: created.id, files: await files.draftFiles(created.id), file: napFile };
    });
    const id = await startOf(w, {});
    const slept = await rests(id, "sleeping");
    expect(slept.wakeAt).not.toBeNull();
    await rests(id, "done");
    expect((await view(id)).output).toEqual({ woke: true });
  });
});

describe("evals", () => {
  it("judge a finished run where the runtime is told to, and keep their scores", async () => {
    process.env.KERNEL_EVALS = "1";
    price.next = [3000];
    const id = await startOf(await exampleWizard("offer", { "wizard.ts": "export {};\n" }), input);
    await rests(id, "waiting_input");
    await answer(id, 2, { approved: true });
    await rests(id, "waiting_input");
    await answer(id, (await waitingRow(id)).n, { approved: true });
    await rests(id, "waiting_signal");
    await answer(id, (await waitingRow(id)).n, { came: true });
    await rests(id, "done");
    delete process.env.KERNEL_EVALS;
    // judging follows the run's end: wait for the scores
    let scores: { eval: string; score: number | null }[] = [];
    for (let i = 0; i < 100 && scores.length < 3; i++) {
      scores = await client.withTenant(T, () => client.db.select().from(client.schema.runScore).where(eq(client.schema.runScore.runId, id)));
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(scores.map((s) => [s.eval, s.score]).sort()).toEqual([
      ["end/signed", 1],
      ["offer/tone", 0.8],
      ["offer/within-budget", 1],
    ]);
  });
});

describe("the switch", () => {
  it("refuses a wizard in version 2 while it is off", async () => {
    const features = await import("../src/features");
    const w = await exampleWizard("mail");
    const spy = vi.spyOn(features, "feature").mockImplementation((name: string) => name !== "kernel");
    await expect(startOf(w, {})).rejects.toThrow();
    spy.mockRestore();
  });

  it("says where a file and its step files do not fit", async () => {
    const { validateWizard } = await import("@engenty/wizards-shared/definition");
    const def = kernelShell({ ...file, edges: { ...file.edges, legal: ["check", "offr"] } });
    expect(validateWizard(def, ["steps/offer.ts", "steps/legal.ts", "steps/extra.ts"]).map((i) => i.message)).toEqual(
      expect.arrayContaining([
        'The map names "offr", there is no steps/offr.ts.',
        'The map names "check", there is no steps/check.ts.',
        "No way leads to steps/extra.",
      ]),
    );
  });
});

describe("through the doors every run has", () => {
  /** What an MCP client, or the run's page, does: read the report, answer what it waits for. */
  const report = (id: string) => client.withTenant(T, () => doors.runReport("u", id)) as unknown as Promise<{
    status: string;
    version: number;
    waitingFor: null | { row: number; step: string; form?: string; review?: string; leaveFor?: string; fields?: { id: string }[] };
    rows: { step: string; left?: boolean }[];
    data?: Record<string, unknown>;
  }>;

  it("starts a test run from the draft, asks for the input, and takes the answers as forms and reviews", async () => {
    process.env.KERNEL_STEPS = "quickjs";
    price.next = [3000];
    const w = await exampleWizard("offer", { "wizard.ts": "export {};\n" });
    const { runId } = await client.withTenant(T, () => doors.startTestRun("u", w.id));
    await rests(runId, "waiting_input");

    let seen = await report(runId);
    expect(seen).toMatchObject({ version: 2, status: "waiting_input", waitingFor: { step: "input", form: "input" } });
    expect(seen.waitingFor?.fields?.map((f) => f.id)).toEqual(["customer", "email", "budget", "items"]);

    await client.withTenant(T, () => doors.answerRunForm("u", runId, "input", input));
    await rests(runId, "waiting_input");
    seen = await report(runId);
    expect(seen.waitingFor).toMatchObject({ step: "check", review: "check" });

    await client.withTenant(T, () => doors.reviewRun("u", runId, "check", { type: "decline", note: "Shorter." }));
    await rests(runId, "waiting_input");
    expect((await report(runId)).rows.filter((r) => r.left).map((r) => r.step)).toEqual(["offer", "check", "offer"]);

    await client.withTenant(T, () => doors.reviewRun("u", runId, "check", { type: "accept" }));
    await rests(runId, "waiting_input");
    expect((await report(runId)).waitingFor).toMatchObject({ step: "accept" });

    // back: the operator's yes is asked for again
    await client.withTenant(T, () => doors.controlRun("u", runId, "back"));
    await rests(runId, "waiting_input");
    expect((await report(runId)).waitingFor).toMatchObject({ step: "check" });

    await client.withTenant(T, () => doors.controlRun("u", runId, "cancel"));
    expect((await rests(runId, "cancelled")).status).toBe("cancelled");
  });

  it("answers the leave for an action as a review of its step, and tries a failed ask again", async () => {
    worked.length = 0;
    const id = await startOf(await exampleWizard("mail"), { customer: "Nordlicht GmbH" });
    await rests(id, "waiting_input");
    await client.withTenant(T, () => doors.reviewRun("u", id, "look", { type: "accept" }));
    await rests(id, "waiting_input");
    expect((await report(id)).waitingFor).toMatchObject({ step: "send", review: "send", leaveFor: "gmail.users.messages.send" });
    await client.withTenant(T, () => doors.reviewRun("u", id, "send", { type: "decline" }));
    await rests(id, "failed");

    // try again: the action is asked for again, and so is the user
    await client.withTenant(T, () => doors.controlRun("u", id, "retry"));
    await rests(id, "waiting_input");
    await client.withTenant(T, () => doors.reviewRun("u", id, "send", { type: "accept" }));
    await rests(id, "done");
    expect((await report(id)).data).toEqual({ sent: "msg_9" });
  });

  it("refuses an answer to a page the run does not wait at", async () => {
    const id = await startOf(await exampleWizard("mail"), { customer: "N" });
    await rests(id, "waiting_input");
    await expect(client.withTenant(T, () => doors.answerRunForm("u", id, "input", {}))).rejects.toThrow();
  });
});

describe("the run's page", () => {
  const page = async (id: string) => {
    const row = await run(id);
    return client.withTenant(T, () => runner.runView(row as never, null as never));
  };

  it("shows the input as a form, a review with what it is about, the leave for an action, and the end", async () => {
    process.env.KERNEL_STEPS = "quickjs";
    // started without an input, so it asks for it; the draft's own check would want a real Gmail
    const runId = await startOf(await exampleWizard("mail"));
    await rests(runId, "waiting_input");

    let seen = await page(runId);
    expect(seen.step).toMatchObject({ id: "input", type: "form" });
    expect((seen.step as { fields: { id: string }[] }).fields.map((f) => f.id)).toEqual(["customer"]);

    await client.withTenant(T, () => runner.submitPage(runId, "input", { customer: "Nordlicht GmbH" }, { userId: "u" }));
    await rests(runId, "waiting_input");
    seen = await page(runId);
    expect(seen.step).toMatchObject({ id: "look", type: "review", show: ["work"], approve: true });

    await client.withTenant(T, () => runner.reviewStep(runId, "look", { type: "accept" }, { userId: "u" }));
    await rests(runId, "waiting_input");
    seen = await page(runId);
    expect(seen.step).toMatchObject({ id: "send", type: "review", title: "gmail.users.messages.send", show: ["send__action"] });

    await client.withTenant(T, () => runner.reviewStep(runId, "send", { type: "accept" }, { userId: "u" }));
    await rests(runId, "done");
    seen = await page(runId);
    expect(seen.status).toBe("done");
    expect(seen.step).toMatchObject({ type: "result" });
  });
});

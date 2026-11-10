import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import type { TurnPart } from "@engenty/wizards-shared/run-services";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The run's services inside the runtime (run-services/index.ts): built for a run by its step
 * context, each service called once. The model is scripted per step, nothing reaches the network.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-run-services-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "durableRuns=on";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
/** What the model answers, by the step the call is made for. */
const answers: Record<string, string> = {
  write: "Hello there.",
  doc: "<!doctype html><html><body><h1>Otters</h1></body></html>",
  pick: JSON.stringify({ otters: true }),
};
const modelFor = (step: string) =>
  new MockLanguageModelV3({
    doGenerate: async () =>
      ({
        content: [{ type: "text", text: answers[step] ?? "" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }) as never,
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: answers[step] ?? "" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ] as never[]),
    }),
  });
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async (_cls: string, meta: { stepId?: string } = {}) => ({
    model: modelFor(meta.stepId ?? "-"),
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: true,
  }),
  systemOneAccess: async () => null,
  embeddingModel: async () => null,
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  canSpend: async () => true,
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");

const T = "tenant-run-services";
const USER = "user-run-services";

const definition: WizardDefinition = wizardSchema.parse({
  version: 1,
  title: "Services",
  description: "",
  avatar: "round",
  lists: [{ id: "notes", title: "Notes", columns: [{ id: "title", name: "Title", type: "text" }] }],
  steps: [
    {
      id: "write",
      type: "agent",
      title: "Write",
      instructions: "Write about otters.",
      output: { format: "text" },
      tools: [],
    },
    { id: "doc", type: "generate", title: "Doc", asset: "document", prompt: "A page on otters." },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
});

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
}, 180_000);

vi.setConfig({ testTimeout: 120_000 });

/** A run that is not driven (no runner here), and the context its first step gets. */
const contextOfNewRun = () =>
  client.withTenant(T, async () => {
    const seed = await wizards.createWizard(USER, { definition });
    const id = await runner.createRun({
      wizardId: seed.id,
      definition,
      files: [],
      version: null,
      mode: "test",
      userId: USER,
    });
    const run = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) });
    const ctx = await runner.makeContext(
      run!,
      await runner.loadSpace(run!),
      run!.state,
      new AbortController().signal,
      { stepId: "write" },
    );
    return { run: run!, ctx };
  });

describe("the run's services in the runtime", () => {
  it("are built for a run and answer each call as the runtime's functions do", async () => {
    const { run, ctx } = await contextOfNewRun();
    const { services } = ctx;
    await client.withTenant(T, async () => {
      // models: one streamed turn, a decision, no embedding model here.
      const parts: TurnPart[] = [];
      for await (const part of services.models.turn({
        stepId: "write",
        class: "standard",
        messages: [{ role: "user", content: "Write about otters." }],
      })) {
        parts.push(part);
      }
      expect(parts).toEqual([
        { type: "text", text: "Hello there." },
        {
          type: "finish",
          reason: "stop",
          usage: { inputTokens: 3, outputTokens: 2 },
          model: "test/scripted",
        },
      ]);
      const decision = await services.models.decide({
        stepId: "pick",
        state: "A river with otters.",
        questions: { otters: { type: "noul", instructions: "Are there otters?" } },
      });
      expect(decision).toEqual({ answers: { otters: { type: "noul", noul: 1 } }, source: "llm" });
      expect(await services.models.embed(["otters"])).toBeNull();
      const agent = await services.models.agentModel({ stepId: "write", class: "standard" });
      expect(agent.resolved.ref).toBe("test/scripted");
      expect(agent.model).toBe(agent.resolved.model);

      // tools: the step's tools as descriptors, one called.
      const tools = await services.tools.list("write");
      const write = tools.find((t) => t.name === "list_write");
      expect(write).toMatchObject({ name: "list_write", inputSchema: { type: "object" } });
      expect(await services.tools.list("doc")).toEqual([]);
      const called = await services.tools.call({
        stepId: "write",
        name: "list_write",
        input: { list: "notes", rows: [{ title: "Otters" }] },
        effect: null,
      });
      expect(called).toEqual({ output: { added: 1, updated: 0, deleted: 0 } });

      // data: the row the tool wrote.
      expect(await services.data.counts()).toEqual({ notes: 1 });
      const notes = await services.data.rows("notes");
      expect(notes.rows.map((r) => r.cells.title)).toEqual(["Otters"]);

      // context: what the model is told beside the task.
      const setting = await services.context.forStep("write");
      expect(setting).toMatchObject({ lang: "en", knowledge: expect.any(String), skills: "" });
      expect(setting.date).toMatch(/\d{4}/);
      expect(setting.brand).toEqual(ctx.scope.brand);

      // files: saved, read back, linked.
      const ref = await services.files.save({
        kind: "text",
        mime: "text/plain",
        name: "otters.txt",
        data: "Otters hold hands.",
      });
      const read = await services.files.read(ref.id);
      expect(new TextDecoder().decode(read!.data)).toBe("Otters hold hands.");
      expect(read!.ref).toEqual({ id: ref.id, kind: "text", mime: "text/plain", name: "otters.txt" });
      expect(await services.files.link(ref.id)).toMatch(
        new RegExp(`/api/runs/${run.id}/assets/${ref.id}\\?exp=\\d+&sig=`),
      );

      // steps: a document made whole.
      const doc = definition.steps.find((s) => s.id === "doc");
      const made = await services.steps.run(doc as never);
      expect(made).toMatchObject({ assets: [{ kind: "html", name: "doc.html" }] });

      // people: the run's person hears it is done.
      await services.people.tell({ kind: "done" });
      const told = await client.db.query.notice.findMany({
        where: eq(client.schema.notice.runId, run.id),
      });
      expect(told.map((n) => [n.kind, n.userId])).toEqual([["done", USER]]);
    });
  });
});

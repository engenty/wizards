import type { AgentStep } from "@engenty/wizards-shared/definition";
import type { Decision } from "@engenty/wizards-shared/decision";
import type { ServiceStep } from "@engenty/wizards-shared/run-services";
import {
  type AgentModelFlags,
  type DataStatementRequest,
  type DecideRequest,
  isPending,
  ServiceError,
  type TurnPart,
  type TurnRequest,
} from "@engenty/wizards-shared/run-services";
import type { FlowFailure } from "@engenty/wizards-shared/transition";
import { beforeAll, describe, expect, it } from "vitest";
import { runAgentStep } from "../src/steps/agent.js";
import type { StepContext, StepServices } from "../src/types.js";

/**
 * What every implementation of the run's services does the same (docs/plans/runs-on-their-own.md,
 * "The run's services"): the runtime's own functions (apps/runtime/src/run-services) and the
 * engine's client over HTTP (../src/http-services.ts). `servicesContract` registers the cases;
 * apps/runtime/test/services-contract.test.ts runs them against both.
 *
 * Every call of `RunServices` is made once. The cases run in order on one run: the tool call
 * writes the list row `data.rows` and `data.counts` read after it. Then an agent step's calls
 * (`StepServices` beyond `RunServices`), and whole agent steps run by the engine on them: one
 * whose model calls a tool, one with an entry per list row, one a wizard's agent runs.
 */

/** The run the cases work on, and what its fixture knows of it. */
export interface ContractRun {
  services: StepServices;
  /** The run's step context at a step, with `services`: what its host gives step code. */
  context(stepId: string): Promise<StepContext>;
  /**
   * Step code as its host runs it: the runtime's runner in the run's tenant and for its person;
   * a host that reaches the services over HTTP as it is.
   */
  host<T>(work: () => Promise<T>): Promise<T>;
  /**
   * The failure the run takes a call's error as (`stepFailed`): a `ServiceError`'s own class,
   * anything else as its host sorts it (the runtime's runner: `classifyFailure`).
   */
  sorted(err: unknown): FlowFailure;
  /** A turn the model answers whole: the request, and the parts it streams in order. */
  turn: { request: TurnRequest; parts: TurnPart[] };
  /** A turn the model breaks off: the parts before the break, the failure it ends in, its message. */
  torn: { request: TurnRequest; parts: TurnPart[]; failure: FlowFailure; message: string };
  decide: { request: DecideRequest; answer: Decision };
  /** A step with tools, one of them called with `input` (it adds one row to `list`). */
  tool: { stepId: string; name: string; input: unknown; output: unknown };
  /** A step and what `context.forStep` tells its model, in part. */
  setting: { stepId: string; has: Record<string, unknown> };
  /** A file of the run's tenant that exists. */
  file: { ref: string; name: string; mime: string; text: string };
  /** A file of the workspace the run started with. */
  workspace: { path: string; text: string };
  /** The wizard's database: a table to write one row to and read it back. */
  data: { stepId: string; scope: DataStatementRequest["scope"]; table: string; column: string };
  /** The stored list the tool writes to. */
  list: { id: string };
  /** A step a service does whole, and the kind of file it makes. */
  serviceStep: { step: ServiceStep; kind: string };
  /** A call the service refuses: a list the wizard does not have. */
  refused: { listId: string; failure: FlowFailure; message: string };
  /** Agent steps, and what their scripted model does. */
  agent: {
    /** What the model's loop needs of it. */
    flags: AgentModelFlags;
    /** A step whose tools hold `tool`; called with `input`, it answers what `output` matches. */
    tools: { stepId: string; tool: string; input: unknown; output: Record<string, unknown> };
    /** A step whose model calls a tool once (a row more in `list`), then writes `text`. */
    acting: { stepId: string; tool: string; text: string };
    /** A step with an entry per row of `list`: its text and its table. */
    each: { stepId: string; text: string; rows: Record<string, unknown>[] };
    /** A step a wizard's agent runs: the step as the agent's file has it, its instructions, its text. */
    byAgent: { stepId: string; step: Partial<AgentStep>; instructions: string; text: string };
  };
}

const collect = async (parts: AsyncIterable<TurnPart>) => {
  const seen: TurnPart[] = [];
  for await (const part of parts) {
    seen.push(part);
  }
  return seen;
};

const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** Registers the contract's cases for one implementation, under `name`. */
export function servicesContract(name: string, setup: () => Promise<ContractRun>): void {
  describe(`the run's services: ${name}`, () => {
    let run: ContractRun;
    let s: StepServices;
    beforeAll(async () => {
      run = await setup();
      s = run.services;
    }, 180_000);

    // --- models

    it("streams a turn's parts in order, the finish last", async () => {
      expect(await collect(s.models.turn(run.turn.request))).toEqual(run.turn.parts);
    });

    it("ends a turn the model broke off with its failure, after the parts it had", async () => {
      const seen: TurnPart[] = [];
      const failed = await (async () => {
        for await (const part of s.models.turn(run.torn.request)) {
          seen.push(part);
        }
      })().then(
        () => null,
        (err: unknown) => err,
      );
      expect(seen).toEqual(run.torn.parts);
      expect(failed).toBeInstanceOf(Error);
      expect(run.sorted(failed)).toEqual(run.torn.failure);
      expect((failed as Error).message).toBe(run.torn.message);
    });

    it("decides", async () => {
      expect(await s.models.decide(run.decide.request)).toEqual(run.decide.answer);
    });

    it("embeds nothing when no embedding model is set up", async () => {
      expect(await s.models.embed(["otters"])).toBeNull();
    });

    // --- tools

    it("lists a step's tools and calls one", async () => {
      const tools = await s.tools.list(run.tool.stepId);
      expect(tools.map((t) => t.name)).toContain(run.tool.name);
      for (const t of tools) {
        expect(t).toMatchObject({ name: expect.any(String), inputSchema: expect.any(Object) });
      }
      const answer = await s.tools.call({
        stepId: run.tool.stepId,
        name: run.tool.name,
        input: run.tool.input,
        effect: null,
      });
      expect(isPending(answer)).toBe(false);
      expect(answer).toEqual({ output: run.tool.output });
    });

    // --- context

    it("tells what a step's model reads beside its task, and gets the answers ready", async () => {
      expect(await s.context.forStep(run.setting.stepId)).toMatchObject(run.setting.has);
      expect(await s.context.prepareInputs(run.setting.stepId)).toBeUndefined();
    });

    // --- files

    it("reads a file of the run's tenant with its reference", async () => {
      const found = await s.files.read(run.file.ref);
      expect(found?.ref).toEqual({
        id: run.file.ref,
        kind: expect.any(String),
        mime: run.file.mime,
        name: run.file.name,
      });
      expect(text(found?.data ?? new Uint8Array())).toBe(run.file.text);
    });

    it("reads a file that is not there as null", async () => {
      expect(await s.files.read("no-such-file")).toBeNull();
      expect(await s.files.workspace("no/such/file.txt")).toBeNull();
    });

    it("saves bytes and text, and reads them back the same", async () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 255, ...new TextEncoder().encode(" Otter ü")]);
      const saved = await s.files.save({
        kind: "text",
        mime: "application/octet-stream",
        name: "otter-ü.bin",
        data: bytes,
      });
      expect(saved).toMatchObject({
        kind: "text",
        mime: "application/octet-stream",
        name: "otter-ü.bin",
      });
      expect(Array.from((await s.files.read(saved.id))?.data ?? [])).toEqual(Array.from(bytes));

      const note = await s.files.save({
        kind: "text",
        mime: "text/plain",
        name: "note.txt",
        data: "Otters hold hands. 🦦",
        ai: "generated",
      });
      expect(note).toMatchObject({
        kind: "text",
        mime: "text/plain",
        name: "note.txt",
        ai: "generated",
      });
      expect(text((await s.files.read(note.id))?.data ?? new Uint8Array())).toBe(
        "Otters hold hands. 🦦",
      );
    });

    it("links a file, lists the person's uploads, reads the workspace", async () => {
      const link = await s.files.link(run.file.ref);
      expect(typeof link).toBe("string");
      expect(link).toContain(run.file.ref);
      expect(await s.files.uploads()).toEqual([]);
      expect(text((await s.files.workspace(run.workspace.path)) ?? new Uint8Array())).toBe(
        run.workspace.text,
      );
    });

    // --- data

    it("writes the wizard's database and reads it back", async () => {
      const { stepId, scope, table, column } = run.data;
      const statement = { stepId, scope, by: "wizard" as const };
      expect(
        await s.data.exec({
          ...statement,
          sql: `INSERT INTO ${table} (${column}) VALUES (:value)`,
          params: { value: name },
        }),
      ).toMatchObject({ changes: 1 });
      expect(
        await s.data.query({ ...statement, sql: `SELECT ${column} FROM ${table}` }),
      ).toMatchObject({ columns: [column], rows: [{ [column]: name }], truncated: false });
    });

    it("reads the stored list the tool wrote, and counts it", async () => {
      const { def, rows } = await s.data.rows(run.list.id);
      expect(def.id).toBe(run.list.id);
      expect(rows).toHaveLength(1);
      expect(await s.data.counts()).toEqual({ [run.list.id]: 1 });
    });

    it("refuses a call with a ServiceError of its class", async () => {
      const err = await s.data.rows(run.refused.listId).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).failure).toEqual(run.refused.failure);
      expect((err as ServiceError).message).toBe(run.refused.message);
    });

    // --- steps, people

    it("does a service's step whole", async () => {
      const output = await s.steps.run(run.serviceStep.step);
      expect(isPending(output)).toBe(false);
      expect(output).toMatchObject({ assets: [{ kind: run.serviceStep.kind }] });
    });

    it("tells the run's person", async () => {
      expect(await s.people.tell({ kind: "done" })).toBeUndefined();
    });

    // --- an agent step's calls

    /** The step of the run's definition. */
    const stepOf = (ctx: StepContext, stepId: string) =>
      ctx.def.steps.find((x) => x.id === stepId) as AgentStep;

    it("gives an agent step's model with what its loop needs", async () => {
      const model = await s.models.agentModel({ stepId: run.agent.tools.stepId, class: "standard" });
      expect({
        ownLoop: model.ownLoop,
        takesTools: model.takesTools,
        seesImages: model.seesImages,
      }).toEqual(run.agent.flags);
    });

    it("builds an agent step's tools and calls one in its turn", async () => {
      const { stepId, tool, input, output } = run.agent.tools;
      const ctx = await run.context(stepId);
      const turn = `${ctx.runId}.tools`;
      const answer = await run.host(async () => {
        const model = await s.models.agentModel({ stepId, class: "standard" });
        const set = await s.tools.forStep(stepOf(ctx, stepId), ctx, { model, uploads: [], turn });
        const listed = set.list();
        expect(listed.map((t) => t.name)).toContain(tool);
        for (const t of listed) {
          expect(t).toMatchObject({
            name: expect.any(String),
            description: expect.any(String),
            inputSchema: expect.any(Object),
            mastra: expect.any(Object),
          });
        }
        expect(set.assets).toEqual([]);
        expect(set.sandbox).toBe(false);
        return set.call({ name: tool, input, effect: `${turn}:call-1` });
      });
      expect(answer).toMatchObject({ output });
    });

    it("runs an agent step whose model calls a tool", async () => {
      const { stepId, tool, text } = run.agent.acting;
      const ctx = await run.context(stepId);
      const out = await run.host(() => runAgentStep(stepOf(ctx, stepId), ctx));
      expect(out.text).toBe(text);
      // The tool wrote its row, and the run notes that the step's turn acted.
      expect((await s.data.rows(run.list.id)).rows).toHaveLength(2);
      expect(ctx.state.turn).toMatchObject({ stepId, acted: true });
      const turn = await run.host(() => ctx.turns.load(ctx.state.turn?.id ?? ""));
      expect(turn?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(turn?.messages[2]?.content).toEqual([
        expect.objectContaining({ type: "tool-result", name: tool }),
      ]);
      expect(turn?.end?.closing).toBe(text);
    });

    it("runs an agent step once per entry", async () => {
      const { stepId, text, rows } = run.agent.each;
      const ctx = await run.context(stepId);
      const out = await run.host(() => runAgentStep(stepOf(ctx, stepId), ctx));
      expect(out.text).toBe(text);
      expect(out.json).toEqual({ rows });
    });

    it("runs an agent step as the wizard's agent it names", async () => {
      const { stepId, step, instructions, text } = run.agent.byAgent;
      const ctx = await run.context(stepId);
      const ran = await run.host(() =>
        s.tools.ofAgent({ ...stepOf(ctx, stepId), agent: stepOf(ctx, stepId).agent ?? "" }, ctx),
      );
      expect(ran.step).toMatchObject(step);
      expect(ran.step.agent).toBeUndefined();
      expect(ran.instructions).toBe(instructions);
      const out = await run.host(() => runAgentStep(stepOf(ctx, stepId), ctx));
      expect(out.text).toBe(text);
    });
  });
}

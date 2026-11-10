import type { Decision } from "@engenty/wizards-shared/decision";
import type { ServiceStep } from "@engenty/wizards-shared/run-services";
import {
  type DataStatementRequest,
  type DecideRequest,
  isPending,
  type RunServices,
  ServiceError,
  type TurnPart,
  type TurnRequest,
} from "@engenty/wizards-shared/run-services";
import type { FlowFailure } from "@engenty/wizards-shared/transition";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * What every implementation of the run's services does the same (docs/plans/runs-on-their-own.md,
 * "The run's services"): the runtime's own functions (apps/runtime/src/run-services) and the
 * engine's client over HTTP (../src/http-services.ts). `servicesContract` registers the cases;
 * apps/runtime/test/services-contract.test.ts runs them against both.
 *
 * Every call of `RunServices` is made once. The cases run in order on one run: the tool call
 * writes the list row `data.rows` and `data.counts` read after it.
 */

/** The run the cases work on, and what its fixture knows of it. */
export interface ContractRun {
  services: RunServices;
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
    let s: RunServices;
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
  });
}

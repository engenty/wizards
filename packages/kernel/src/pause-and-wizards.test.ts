import { expect, it } from "vitest";
import { createKernel } from "./kernel.js";
import { memoryStore } from "./memory.js";
import type { AskRow, Step, Wizard, WizardFile } from "./types.js";

/** Pausing a run, and a step that asks another wizard: a run of it answers. */
const one = (only: Step<any, any>, file: Partial<WizardFile> = {}): Wizard => ({
  file: { title: "One", start: "only", edges: { only: ["end"] }, output: { out: "only" }, ...file },
  steps: { only },
});
const form: Step<any, any> = async (_run, ask) => ({ value: await ask({ type: "form" }) });
const asker = (input?: unknown) =>
  one(async (_run, ask) => ({ value: await ask({ type: "wizard", wizard: "child", input }) }), {
    requires: { wizards: ["child"] },
  });
const child = one(async (run, ask) => ({
  value: { got: run.input, said: await ask({ type: "form" }) },
}));
const kernelOf = (wizards: Record<string, Wizard>) => {
  const store = memoryStore();
  return {
    store,
    kernel: createKernel({
      store,
      wizards: (id) => {
        if (!wizards[id]) throw new Error(`There is no wizard "${id}".`);
        return wizards[id];
      },
    }),
  };
};
const rowOf = (rows: unknown[], n: number) => rows[n] as AskRow;

it("holds a paused run: an answer is written, and it moves once resumed", async () => {
  const { kernel } = kernelOf({ one: one(form) });
  const run = await kernel.start("one", {});
  expect((await kernel.pause(run.id)).status).toBe("paused");
  const answered = await kernel.answer(run.id, 0, { name: "Ada" });
  expect(answered.status).toBe("paused");
  expect(rowOf(answered.rows, 0)).toMatchObject({ state: "done", answer: { name: "Ada" } });
  expect((await kernel.move(run.id)).status).toBe("paused");
  const resumed = await kernel.resume(run.id);
  expect(resumed).toMatchObject({ status: "done", output: { out: { name: "Ada" } } });
});

it("does not wake a paused run at a time, and wakes it after it is resumed", async () => {
  let now = 0;
  const store = memoryStore();
  const wizard = one(async (_run, ask) => ({ value: await ask({ type: "form", timeout: "1s" }) }));
  const kernel = createKernel({ store, wizards: () => wizard, now: () => now });
  const run = await kernel.start("one", {});
  expect(run.wakeAt).toBe(1000);
  expect((await kernel.pause(run.id)).wakeAt).toBeUndefined();
  now = 2000;
  expect((await kernel.wake(run.id)).status).toBe("paused");
  const resumed = await kernel.resume(run.id);
  expect(resumed.status).toBe("waiting");
  expect((await kernel.wake(run.id)).output?.out).toEqual({ timedOut: true });
});

it("keeps a rewound run paused", async () => {
  const { kernel } = kernelOf({ one: one(form) });
  const run = await kernel.start("one", {});
  await kernel.answer(run.id, 0, { name: "Ada" });
  // A run that ended is not paused; asked again, it waits.
  expect((await kernel.pause(run.id)).status).toBe("done");
  expect((await kernel.rewind(run.id, 0)).status).toBe("waiting");
  const again = await kernel.start("one", {});
  await kernel.pause(again.id);
  expect((await kernel.rewind(again.id, 0)).status).toBe("paused");
});

it("answers an ask of another wizard with the output of a run of it", async () => {
  const { kernel, store } = kernelOf({ asker: asker({ customer: "Nordlicht" }), child });
  const run = await kernel.start("asker", {});
  expect(run.status).toBe("waiting");
  const row = rowOf(run.rows, 0);
  expect(row).toMatchObject({ type: "wizard", role: "wizard", state: "waiting" });
  const started = await store.load(row.child as string);
  expect(started).toMatchObject({
    wizard: "child",
    input: { customer: "Nordlicht" },
    status: "waiting",
    parent: { run: run.id, row: 0, depth: 1 },
  });
  // A person answers the child's form; the child ends, and the asking run goes on.
  await kernel.answer(row.child as string, 0, { ok: true });
  const done = await kernel.read(run.id);
  expect(done).toMatchObject({
    status: "done",
    output: { out: { out: { got: { customer: "Nordlicht" }, said: { ok: true } } } },
  });
});

it("refuses an answer from outside for an ask of another wizard", async () => {
  const { kernel } = kernelOf({ asker: asker({}), child });
  const run = await kernel.start("asker", {});
  await expect(kernel.answer(run.id, 0, { out: 1 })).rejects.toThrow("answered by the run itself");
});

it("fails an ask of a wizard the file does not name, or one that is not there", async () => {
  const unnamed = one(async (_run, ask) => ({
    value: await ask({ type: "wizard", wizard: "child" }),
  }));
  const { kernel } = kernelOf({ unnamed, child, missing: asker({}) });
  expect(await kernel.start("unnamed", {})).toMatchObject({
    status: "failed",
    error: '"only" reached for "child", which the file does not grant.',
  });
  const { kernel: other } = kernelOf({ asker: asker({}) });
  expect(await other.start("asker", {})).toMatchObject({
    status: "failed",
    error: 'There is no wizard "child".',
  });
});

it("fails the ask when the run it started fails, is stopped, or gets a wrong input", async () => {
  const failing = one(async () => {
    throw new Error("broken");
  });
  const { kernel } = kernelOf({ asker: asker({}), child: failing });
  expect(await kernel.start("asker", {})).toMatchObject({
    status: "failed",
    error: '"child" failed. broken',
  });

  const strict = one(form, {
    input: { fields: [{ id: "customer", kind: "text", required: true }] },
  });
  const { kernel: wrong } = kernelOf({ asker: asker({}), child: strict });
  expect((await wrong.start("asker", {})).error).toBe(
    '"child" cannot start with this input. "customer" is missing.',
  );

  const { kernel: stopping } = kernelOf({ asker: asker({}), child });
  const run = await stopping.start("asker", {});
  await stopping.stop(rowOf(run.rows, 0).child as string);
  expect(await stopping.read(run.id)).toMatchObject({
    status: "failed",
    error: '"child" was stopped.',
  });
});

it("pauses, resumes and stops the run that answers an ask with the run that asked", async () => {
  const { kernel, store } = kernelOf({ asker: asker({}), child });
  const run = await kernel.start("asker", {});
  const id = rowOf(run.rows, 0).child as string;
  await kernel.pause(run.id);
  expect((await store.load(id))?.status).toBe("paused");
  // The child's answer is written while both are paused; nothing moves.
  await kernel.answer(id, 0, { ok: true });
  expect((await store.load(id))?.status).toBe("paused");
  expect((await kernel.resume(run.id)).status).toBe("done");

  const next = await kernel.start("asker", {});
  const second = rowOf(next.rows, 0).child as string;
  await kernel.stop(next.id);
  expect((await store.load(second))?.status).toBe("stopped");
});

it("stops the run of an ask that is asked again, and starts a new one", async () => {
  const { kernel, store } = kernelOf({ asker: asker({}), child });
  const run = await kernel.start("asker", {});
  const first = rowOf(run.rows, 0).child as string;
  const again = await kernel.rewind(run.id, 0);
  const second = rowOf(again.rows, 0).child as string;
  expect(second).not.toBe(first);
  expect((await store.load(first))?.status).toBe("stopped");
  expect((await store.load(second))?.status).toBe("waiting");
});

it("refuses wizards that ask wizards too deep", async () => {
  const self = one(
    async (_run, ask) => ({ value: await ask({ type: "wizard", wizard: "self" }) }),
    {
      requires: { wizards: ["self"] },
    },
  );
  const { kernel } = kernelOf({ self });
  const run = await kernel.start("self", {});
  expect(run).toMatchObject({ status: "failed" });
  expect(run.error).toContain("more than 5 deep");
});

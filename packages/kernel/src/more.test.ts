import { expect, it } from "vitest";
import { createKernel, NeedsLeave } from "./kernel";
import { memoryStore } from "./memory";
import type { AskRow, Battery, Step, Wizard } from "./types";

/** What a run needs beyond asking and answering: trying again, stopping, rows under a row. */
const one = (only: Step<any, any>, file: Partial<Wizard["file"]> = {}): Wizard => ({
  file: { title: "One", start: "only", edges: { only: ["end"] }, output: { out: "only" }, ...file },
  steps: { only },
});
const kernelOf = (wizard: Wizard, batteries: Record<string, Battery> = {}, more = {}) =>
  createKernel({ store: memoryStore(), wizards: () => wizard, batteries, ...more });
const waiting = (rows: unknown[]) =>
  (rows as AskRow[]).findLast((row) => row.state === "waiting") as AskRow;

it("tries an ask again as often as it says, and then fails it", async () => {
  let calls = 0;
  const flaky: Battery = async () => {
    if (++calls < 3) throw new Error("busy");
    return "third time";
  };
  const twice = one(async (_run, ask) => ({ value: await ask({ type: "agent", retries: 2 }) }));
  expect((await kernelOf(twice, { agent: flaky }).start("one", {})).output?.out).toBe("third time");

  calls = 0;
  const once = one(async (_run, ask) => ({ value: await ask({ type: "agent", retries: 1 }) }));
  const failed = await kernelOf(once, { agent: flaky }).start("one", {});
  expect(failed).toMatchObject({ status: "failed", error: "busy" });
  expect((failed.rows[0] as AskRow).tries).toBe(2);
});

it("stops a run where it stands, and nothing moves it again", async () => {
  const kernel = kernelOf(
    one(async (_run, ask) => ({ value: await ask({ type: "form", timeout: "1s" }) })),
  );
  const run = await kernel.start("one", {});
  const stopped = await kernel.stop(run.id);
  expect(stopped).toMatchObject({ status: "stopped", wakeAt: undefined });
  expect((await kernel.wake(run.id)).status).toBe("stopped");
  expect((await kernel.move(run.id)).status).toBe("stopped");
  expect(stopped.rows).toHaveLength(1); // its rows stay
});

it("keeps what a battery notes as rows under its ask, outside the step's own asks", async () => {
  const agent: Battery = async (_row, _run, { note }) => {
    note({ type: "model", answer: "I will look it up." });
    note({ type: "tool", call: "gmail.users.threads.list", answer: { threads: 1 } });
    return "done";
  };
  const twoAsks = one(async (_run, ask) => {
    const first = await ask({ type: "agent" });
    const second = await ask({ type: "form" });
    return { value: [first, second] };
  });
  const kernel = kernelOf(twoAsks, { agent });
  let run = await kernel.start("one", {});
  expect(run.rows.map((row) => [(row as AskRow).type, (row as AskRow).parent])).toEqual([
    ["agent", undefined],
    ["model", 0],
    ["tool", 0],
    ["form", undefined],
  ]);
  run = await kernel.answer(run.id, 3, "yes"); // the step runs again: its second ask is still row 3
  expect(run.output?.out).toEqual(["done", "yes"]);
});

it("asks the user when the one who answers says the action needs leave", async () => {
  const done: unknown[] = [];
  const careful: Battery = async (row) => {
    const allowed = done.length > 0 || (row.tries ?? 0) > 1;
    if (!allowed) throw new NeedsLeave();
    done.push(row.input);
    return { ok: true };
  };
  // the file allows it outright; the space's rules, behind the battery, do not
  const wizard = one(
    async (_run, ask) => ({
      value: await ask({ type: "tool", call: "crm.delete", input: { id: 7 } }),
    }),
    {
      connections: { crm: { delete: "allow" } },
    },
  );
  const kernel = kernelOf(wizard, { tool: careful });
  let run = await kernel.start("one", {});
  expect(waiting(run.rows)).toMatchObject({ type: "approval", call: "crm.delete", approves: 0 });
  expect(done).toEqual([]);
  run = await kernel.answer(run.id, waiting(run.rows).n, { allow: true });
  expect(run).toMatchObject({ status: "done", output: { out: { ok: true } } });
  expect(done).toEqual([{ id: 7 }]);
});

it("writes an answer without moving, for a host with a line of its own", async () => {
  const kernel = kernelOf(one(async (_run, ask) => ({ value: await ask({ type: "form" }) })));
  const run = await kernel.start("one", {});
  const kept = await kernel.record(run.id, 0, "later");
  expect(kept).toMatchObject({ status: "waiting", cursor: "only" });
  expect((kept.rows[0] as AskRow).state).toBe("done");
  expect(await kernel.move(run.id)).toMatchObject({ status: "done", output: { out: "later" } });
});

it("checks an answer with the host's own check of fields", async () => {
  const check = (fields: AskRow["fields"], value: unknown) =>
    fields?.some((f) => f.kind === "number" && typeof (value as any)?.[f.id] !== "number")
      ? "Not a number."
      : undefined;
  const kernel = kernelOf(
    one(async (_run, ask) => ({
      value: await ask({ type: "form", fields: [{ id: "n", kind: "number" }] }),
    })),
    {},
    { check },
  );
  const run = await kernel.start("one", {});
  await expect(kernel.answer(run.id, 0, { n: "seven" })).rejects.toThrow("Not a number.");
  expect((await kernel.answer(run.id, 0, { n: 7 })).status).toBe("done");
});

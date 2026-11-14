import { expect, it } from "vitest";
import { check } from "./check";
import { lacking } from "./grant";
import { createKernel } from "./kernel";
import { memoryStore } from "./memory";
import type { AskRow, Battery, Step, Wizard } from "./types";

/** A mail wizard: an agent reads the threads, a person looks at the draft, a step sends it. */
const mail = (steps: Record<string, Step<any, any>> = {}): Wizard => ({
  file: {
    title: "Mail",
    requires: { models: ["standard"], tools: ["http.request"], hosts: ["api.example.com"] },
    connections: { gmail: { search_threads: "allow", read_thread: "allow", send: "ask" } },
    start: "work",
    edges: { work: ["look"], look: ["send"], send: ["end"] },
    output: { sent: "send.id" },
  },
  steps: {
    work: async (_run, ask) => ({
      value: await ask({
        type: "agent",
        model: "standard",
        instructions: "Find the last thread and draft an answer.",
        tools: ["gmail.search_threads", "gmail.read_thread"],
      }),
    }),
    look: async (_run, ask) => ({
      value: await ask({ type: "review", show: ["work"], approve: true }),
    }),
    send: async (run, ask) => ({
      value: await ask({ type: "tool", call: "gmail.send", input: { body: run.steps.work.draft } }),
    }),
    ...steps,
  },
});

const sent: unknown[] = [];
const batteries: Record<string, Battery> = {
  agent: async () => ({ draft: "Dear Nordlicht" }),
  tool: async (row: AskRow) => {
    sent.push(row.input);
    return { id: `sent-${sent.length}` };
  },
};
const kernelOf = (wizard: Wizard, has?: Parameters<typeof createKernel>[0]["has"]) =>
  createKernel({ store: memoryStore(), wizards: () => wizard, batteries, has });
const waiting = (rows: unknown[]) =>
  (rows as AskRow[]).findLast((row) => row.state === "waiting") as AskRow;

it("asks the user before an action that is set to ask, and only then does it", async () => {
  sent.length = 0;
  const kernel = kernelOf(mail());
  let run = await kernel.start("mail", {});
  run = await kernel.answer(run.id, waiting(run.rows).n, { approved: true }); // the review

  const leave = waiting(run.rows);
  expect(leave).toMatchObject({
    type: "approval",
    role: "user",
    call: "gmail.send",
    input: { body: "Dear Nordlicht" },
  });
  expect(sent).toEqual([]); // nothing is sent while the question is open

  run = await kernel.answer(run.id, leave.n, { allow: true });
  expect(run).toMatchObject({ status: "done", output: { sent: "sent-1" } });
  expect(sent).toEqual([{ body: "Dear Nordlicht" }]);
});

it("fails the action when the user says no", async () => {
  sent.length = 0;
  const kernel = kernelOf(mail());
  let run = await kernel.start("mail", {});
  run = await kernel.answer(run.id, waiting(run.rows).n, { approved: true });
  run = await kernel.answer(run.id, waiting(run.rows).n, { allow: false });
  expect(run).toMatchObject({ status: "failed", error: 'The user did not allow "gmail.send".' });
  expect(sent).toEqual([]);
});

it("holds an ask to the file: an action, a model class, a tool and a host it does not list", async () => {
  const reached = async (ask: Record<string, unknown>) => {
    const wizard = mail({ work: async (_run, call) => ({ value: await call(ask as never) }) });
    return (await kernelOf(wizard).start("mail", {})).error;
  };
  const no = (name: string) => `"work" reached for "${name}", which the file does not grant.`;
  expect(await reached({ type: "agent", tools: ["gmail.delete_thread"] })).toBe(
    no("gmail.delete_thread"),
  );
  expect(await reached({ type: "agent", model: "frontier" })).toBe(no("frontier"));
  expect(await reached({ type: "tool", call: "sandbox.run" })).toBe(no("sandbox.run"));
  expect(
    await reached({ type: "tool", call: "http.request", input: { url: "https://evil.example/x" } }),
  ).toBe(no("evil.example"));
  expect(
    await reached({
      type: "tool",
      call: "http.request",
      input: { url: "https://api.example.com/x" },
    }),
  ).toBeUndefined();
});

it("keeps the grant a run started with, whatever the file says later", async () => {
  let wizard = mail();
  const kernel = createKernel({ store: memoryStore(), wizards: () => wizard, batteries });
  const run = await kernel.start("mail", {});
  expect(run.grant?.connections.gmail.send).toBe("ask");
  wizard = { ...wizard, file: { ...wizard.file, connections: { gmail: { send: "allow" } } } };
  const next = await kernel.answer(run.id, waiting(run.rows).n, { approved: true });
  expect(waiting(next.rows)).toMatchObject({ type: "approval" }); // still asks
});

it("refuses a wizard before its start when the host lacks what it requires", async () => {
  const has = { models: ["standard"], tools: [], connections: ["slack"], roles: [] };
  expect(lacking(mail().file, has)).toEqual(['the tool "http.request"', 'the connection "gmail"']);
  await expect(kernelOf(mail(), has).start("mail", {})).rejects.toThrow(
    'This wizard cannot run here. It lacks the tool "http.request", the connection "gmail".',
  );
  const enough = {
    models: ["standard", "frontier"],
    tools: ["http.request"],
    connections: ["gmail"],
  };
  expect((await kernelOf(mail(), enough).start("mail", {})).status).toBe("waiting");
});

it("lists what the file declares and no run asked for", async () => {
  const { unused } = await check(mail(), [
    {
      name: "sent",
      input: {},
      answers: [
        { work: { draft: "Dear" } },
        { look: { approved: true } },
        { send: { allow: true } },
        { send: { id: "1" } },
      ],
    },
  ]);
  expect(unused).toEqual(["requires.tools: http.request"]);
});

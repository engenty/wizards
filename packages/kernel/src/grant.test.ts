import { beforeAll, expect, it } from "vitest";
import { check } from "./check.js";
import { lacking } from "./grant.js";
import { createKernel } from "./kernel.js";
import { loadWizard } from "./load.js";
import { memoryStore } from "./memory.js";
import type { AskRow, Battery, Step, Wizard } from "./types.js";

/** The mail wizard: an agent reads the threads, a person looks at the draft, a step sends it. */
let base: Wizard;
beforeAll(async () => {
  base = await loadWizard(new URL("../examples/mail/", import.meta.url).pathname);
});

/** The same wizard with more in its file, for the asks that reach past it, and other steps. */
const mail = (steps: Record<string, Step<any, any>> = {}): Wizard => ({
  file: {
    ...base.file,
    requires: { models: ["standard"], tools: ["http.request"], hosts: ["api.example.com"] },
  },
  steps: { ...base.steps, ...steps },
});

const sent: unknown[] = [];
const batteries: Record<string, Battery> = {
  agent: async () => ({
    to: "einkauf@nordlicht.example",
    subject: "Re: Workshop",
    threadId: "thr_1",
    draft: "Dear Nordlicht",
  }),
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
    call: "gmail.users.messages.send",
    input: { userId: "me", body: { threadId: "thr_1" } },
  });
  expect(sent).toEqual([]); // nothing is sent while the question is open

  run = await kernel.answer(run.id, leave.n, { allow: true });
  expect(run).toMatchObject({ status: "done", output: { sent: "sent-1" } });
  expect(sent).toMatchObject([{ userId: "me", body: { threadId: "thr_1" } }]);
});

it("takes no answer for the action itself while it waits for the user's leave", async () => {
  sent.length = 0;
  const kernel = kernelOf(mail());
  let run = await kernel.start("mail", {});
  run = await kernel.answer(run.id, waiting(run.rows).n, { approved: true });
  const leave = waiting(run.rows);
  const action = leave.approves as number;
  expect(run.rows[action]).toMatchObject({ type: "tool", state: "waiting" });

  await expect(kernel.answer(run.id, action, { id: "made-up" })).rejects.toThrow(
    `Row ${action} waits for the user's leave. Answer row ${leave.n}.`,
  );
  await expect(kernel.rewind(run.id, action, { id: "made-up" })).rejects.toThrow(
    `Row ${action} waits for the user's leave.`,
  );
  run = await kernel.answer(run.id, leave.n, { allow: true });
  expect(run).toMatchObject({ status: "done", output: { sent: "sent-1" } });
  expect(sent).toHaveLength(1);
});

it("fails the action when the user says no", async () => {
  sent.length = 0;
  const kernel = kernelOf(mail());
  let run = await kernel.start("mail", {});
  run = await kernel.answer(run.id, waiting(run.rows).n, { approved: true });
  run = await kernel.answer(run.id, waiting(run.rows).n, { allow: false });
  expect(run).toMatchObject({
    status: "failed",
    error: 'The user did not allow "gmail.users.messages.send".',
  });
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
  expect(run.grant?.connections.gmail["users.messages.send"]).toBe("ask");
  wizard = {
    ...wizard,
    file: { ...wizard.file, connections: { gmail: { "users.messages.send": "allow" } } },
  };
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

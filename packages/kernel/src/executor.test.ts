import { openApiPlugin } from "@executor-js/plugin-openapi";
import { convertGoogleDiscoveryToOpenApi } from "@executor-js/plugin-openapi/providers/google";
import { createExecutor } from "@executor-js/sdk";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { type Emulated, emulate } from "./emulate.js";
import { type Executor, executorBatteries, hostOf, type Model, stricterThere } from "./executor.js";
import { googleDescription, googleDiscoveryUrl } from "./google.js";
import { createKernel } from "./kernel.js";
import { loadWizard } from "./load.js";
import { memoryStore } from "./memory.js";
import type { AskRow, Run, Wizard } from "./types.js";

/**
 * The mail wizard against a Gmail that keeps state: executor's emulator of Google, reached
 * through an executor that was given Gmail's own API description (the copy kept in `src/data/google/`,
 * so the test needs no network) and a token. The only stand-in left is the model, a few lines that
 * read the thread and write a draft.
 */
let google: Emulated;
let executor: Executor & { close(): Promise<void> };
let wizard: Wizard;
const bind = { gmail: "tools.gmail.org.me" };
const vault = new Map<string, string>();

const calls = () => google.calls("gmail.");

beforeAll(async () => {
  google = await emulate("google", {
    seed: {
      users: [{ email: "me@engenty.example", name: "Me" }],
      messages: [
        {
          id: "msg_1",
          user_email: "me@engenty.example",
          from: "einkauf@nordlicht.example",
          to: "me@engenty.example",
          subject: "Workshop im Januar",
          body_text: "Can you send us an offer for two workshop days?",
          label_ids: ["INBOX", "UNREAD"],
        },
      ],
    },
  });
  const token = await google.token("me@engenty.example");

  // Gmail's own description of its API, turned into OpenAPI.
  const gmail = await Effect.runPromise(
    convertGoogleDiscoveryToOpenApi({
      discoveryUrl: googleDiscoveryUrl("gmail"),
      documentText: googleDescription("gmail"),
    }),
  );

  const made = await createExecutor({
    onElicitation: "accept-all",
    providers: [
      {
        key: "default" as never,
        writable: true,
        get: (id) => Effect.sync(() => vault.get(id) ?? null),
        set: (id, value) => Effect.sync(() => void vault.set(id, value)),
        delete: (id) => Effect.sync(() => void vault.delete(id)),
      },
    ],
    plugins: [openApiPlugin()] as const,
  });
  await (
    made as unknown as { openapi: { addSpec(config: unknown): Promise<unknown> } }
  ).openapi.addSpec({
    spec: { kind: "blob", value: gmail.specText },
    slug: "gmail",
    baseUrl: google.url,
    authenticationTemplate: [
      {
        slug: "token",
        type: "apiKey",
        headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
      },
    ],
  });
  await made.connections.create({
    owner: "org",
    name: "me" as never,
    integration: "gmail" as never,
    template: "token" as never,
    value: token,
  });
  executor = made as unknown as typeof executor;
  wizard = await loadWizard(new URL("../examples/mail/", import.meta.url).pathname);
}, 60_000);

beforeEach(() => google.reset());
afterAll(async () => {
  await executor?.close();
  await google?.close();
});

/** The model's part: find the thread, read it, write an answer. */
const model: Model = async (_row, call) => {
  const { threads } = await call("gmail.users.threads.list", { userId: "me", q: "from:nordlicht" });
  const thread = await call("gmail.users.threads.get", { userId: "me", id: threads[0].id });
  const { headers, body } = thread.messages[0].payload;
  const header = (name: string) => headers.find((h: { name: string }) => h.name === name).value;
  const asked = Buffer.from(body.data, "base64url").toString();
  return {
    to: header("From"),
    subject: `Re: ${header("Subject")}`,
    threadId: thread.id,
    draft: `Dear Nordlicht,\n\nyou asked: "${asked}"\nThe offer follows today.`,
  };
};

const kernelWith = async (using: Model = model, of: Wizard = wizard) =>
  createKernel({
    store: memoryStore(),
    wizards: () => of,
    batteries: executorBatteries({ executor, bind, model: using }),
    has: await hostOf(executor, { models: ["standard"] }),
  });
const waiting = (run: Run) =>
  (run.rows as AskRow[]).findLast((row) => row.state === "waiting") as AskRow;

it("reads the thread, waits for the user, and sends the answer into the same thread", async () => {
  const kernel = await kernelWith();
  let run = await kernel.start("mail", { customer: "Nordlicht GmbH" });
  expect(run.rows[0]).toMatchObject({
    state: "done",
    answer: { to: "einkauf@nordlicht.example", subject: "Re: Workshop im Januar" },
  });
  expect(await calls()).toEqual(["gmail.users.threads.list", "gmail.users.threads.get"]);

  run = await kernel.answer(run.id, waiting(run).n, { approved: true }, "user");
  expect(waiting(run)).toMatchObject({ type: "approval", call: "gmail.users.messages.send" });
  expect(await calls()).toHaveLength(2); // nothing is sent while the question is open

  run = await kernel.answer(run.id, waiting(run).n, { allow: true }, "user");
  expect(run.status).toBe("done");
  expect(await calls()).toEqual([
    "gmail.users.threads.list",
    "gmail.users.threads.get",
    "gmail.users.messages.send",
  ]);

  // The emulator's Gmail now holds the answer, in the customer's thread.
  const token = [...vault.values()][0];
  const thread = await google.get(
    `/gmail/v1/users/me/threads/${(run.rows[0] as AskRow & { answer: any }).answer.threadId}`,
    token,
  );
  expect(thread.messages).toHaveLength(2);
  const sent = thread.messages[1];
  expect(sent.id).toBe(run.output?.sent);
  expect(sent.labelIds).toContain("SENT");
  expect(sent.payload.headers.find((h: { name: string }) => h.name === "To").value).toBe(
    "einkauf@nordlicht.example",
  );
  expect(Buffer.from(sent.payload.body.data, "base64url").toString()).toContain(
    "The offer follows today.",
  );
});

it("sends nothing when the user says no", async () => {
  const kernel = await kernelWith();
  let run = await kernel.start("mail", { customer: "Nordlicht GmbH" });
  run = await kernel.answer(run.id, waiting(run).n, { approved: true });
  run = await kernel.answer(run.id, waiting(run).n, { allow: false });
  expect(run).toMatchObject({
    status: "failed",
    error: 'The user did not allow "gmail.users.messages.send".',
  });
  expect(await calls()).not.toContain("gmail.users.messages.send");
});

it("keeps an agent to the actions its ask handed it", async () => {
  const eager: Model = async (_row, call) =>
    call("gmail.users.messages.send", { userId: "me", body: { raw: "" } });
  const run = await (await kernelWith(eager)).start("mail", { customer: "Nordlicht GmbH" });
  expect(run).toMatchObject({
    status: "failed",
    error: 'The agent was not handed "gmail.users.messages.send".',
  });
  expect(await calls()).toEqual([]);
});

it("never shows a step or a row the token", async () => {
  const kernel = await kernelWith();
  let run = await kernel.start("mail", { customer: "Nordlicht GmbH" });
  run = await kernel.answer(run.id, waiting(run).n, { approved: true });
  run = await kernel.answer(run.id, waiting(run).n, { allow: true });
  const token = [...vault.values()][0];
  expect(token).toMatch(/^emu_google_/);
  expect(JSON.stringify(run)).not.toContain(token);
  expect(JSON.stringify(await google.get("/_emulate/ledger"))).not.toContain(token); // the emulator redacts it too
});

it("fails the action when Gmail fails, and sends once when the row is asked again", async () => {
  const kernel = await kernelWith();
  let run = await kernel.start("mail", { customer: "Nordlicht GmbH" });
  run = await kernel.answer(run.id, waiting(run).n, { approved: true });
  await google.fail(
    { method: "POST", pathPattern: "/gmail/v1/users/*/messages/send" },
    { status: 503, body: { error: { code: 503, message: "Backend Error" } } },
  );
  run = await kernel.answer(run.id, waiting(run).n, { allow: true });
  expect(run.status).toBe("failed");
  expect(run.error).toContain("gmail.users.messages.send failed");

  const failed = (run.rows as AskRow[]).find(
    (row) => row.call === "gmail.users.messages.send" && row.type === "tool",
  ) as AskRow;
  run = await kernel.rewind(run.id, failed.n); // ask that row again: the user is asked again, too
  expect(waiting(run)).toMatchObject({ type: "approval" });
  run = await kernel.answer(run.id, waiting(run).n, { allow: true });
  expect(run.status).toBe("done");
  const token = [...vault.values()][0];
  const { messages } = await google.get("/gmail/v1/users/me/messages?labelIds=SENT", token);
  expect(messages).toHaveLength(1);
});

it("refuses a wizard whose connection the executor does not have", async () => {
  const slack: Wizard = {
    ...wizard,
    file: { ...wizard.file, connections: { slack: { "chat.postMessage": "allow" } } },
  };
  await expect((await kernelWith(model, slack)).start("mail", {})).rejects.toThrow(
    'This wizard cannot run here. It lacks the connection "slack".',
  );
});

it("finds where the executor's own policy is stricter than the file", async () => {
  expect(await stricterThere(wizard.file, executor, bind)).toEqual([]);
  const loose = {
    ...wizard.file,
    connections: { gmail: { "users.messages.send": "allow" as const } },
  };
  expect(await stricterThere(loose, executor, bind)).toEqual([
    "gmail.users.messages.send: require_approval",
  ]);
});

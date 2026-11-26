import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Emulated, emulate } from "@engenty/wizards-kernel/emulate";
import { kernelShell } from "@engenty/wizards-shared/kernel-file";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-kernel-executor-"));
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
process.env.KERNEL_STEPS = "quickjs";

/**
 * The mail wizard of the kernel's examples through the runtime (docs/plans/kernel.md, items 15
 * and 17): its Gmail is executor's emulator, its account one the runtime keeps for the person,
 * and every call goes through the broker, which hands executor the account. The model is the one
 * stand-in: it uses the tools the agent ask is given, as a model would.
 */
vi.mock("../src/engine/steps.js", async (original) => {
  const real = await original<typeof import("../src/engine/steps.js")>();
  return {
    ...real,
    runAutomaticStep: async (step: { type: string }, ctx: never) => {
      if (step.type !== "agent") {
        return real.runAutomaticStep(step as never, ctx);
      }
      const { connectorTools } = await import("../src/tools/connector.js");
      const { FileKeeper } = await import("../src/tools/shared.js");
      const tools = await connectorTools(step as never, ctx, new FileKeeper(ctx, []));
      handed.push(...Object.keys(tools));
      const call = async (action: string, input: unknown) => {
        const out = await tools.gmail_call.execute({ action, input }, {});
        if (out.error) {
          throw new Error(out.error);
        }
        return JSON.parse(out.result);
      };
      const { threads } = await call("users.threads.list", { userId: "me", q: "from:nordlicht" });
      const thread = await call("users.threads.get", { userId: "me", id: threads[0].id });
      const { headers, body } = thread.messages[0].payload;
      const header = (name: string) => headers.find((h: { name: string }) => h.name === name).value;
      const asked = Buffer.from(body.data, "base64url").toString();
      const draft = {
        to: header("From"),
        subject: `Re: ${header("Subject")}`,
        threadId: thread.id,
        draft: `Dear Nordlicht,\n\nyou asked: "${asked}"\nThe offer follows today.`,
      };
      return { json: draft, at: new Date().toISOString() };
    },
  };
});
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
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

const handed: string[] = [];
let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let files: typeof import("../src/services/files");
let executor: typeof import("../src/kernel/executor");
let google: Emulated;
let token = "";
let gmailAccount = "";

const T = "tenant-kernel-executor";
const USER = "u-mail";
const example = new URL("../../../packages/kernel/examples/mail/", import.meta.url).pathname;
const file = JSON.parse(readFileSync(`${example}wizard.json`, "utf8"));

/**
 * The wizard as it is installed here: the file names its connection `gmail`, and the runtime's
 * connector for Gmail is `google-gmail`.
 */
const definition = () => {
  const shell = kernelShell(file) as { connections: { id: string; connector?: string }[] };
  return {
    ...shell,
    connections: shell.connections.map((c) => (c.id === "gmail" ? { ...c, connector: "google-gmail" } : c)),
  };
};

async function mailWizard() {
  return client.withTenant(T, async () => {
    const created = await wizards.createWizard(USER, { definition: definition() as never });
    const seed: Record<string, string> = {};
    for (const name of readdirSync(`${example}steps`)) {
      seed[`steps/${name}`] = readFileSync(`${example}steps/${name}`, "utf8");
    }
    await files.seedFiles(created.id, seed);
    // The person chose their Gmail for this wizard, as at a sign-in from its run.
    const own = await import("../src/connectors/person-connections");
    await own.remember(created.id, "gmail", `u:${USER}`, { kind: "person", row: { id: gmailAccount } });
    return { id: created.id, files: await files.draftFiles(created.id) };
  });
}
const start = async () => {
  const w = await mailWizard();
  return client.withTenant(T, () =>
    runner.createRun({
      wizardId: w.id,
      definition: definition() as never,
      files: w.files as never,
      version: null,
      mode: "test",
      userId: USER,
      input: { customer: "Nordlicht GmbH" },
    }),
  );
};
const run = (id: string) =>
  client.withTenant(T, () => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }));
const view = async (id: string) => client.withTenant(T, async () => runner.kernelRuns.view((await run(id)) as never));
async function rests(id: string, ...statuses: string[]) {
  for (let i = 0; i < 400; i++) {
    const row = await run(id);
    if (row && statuses.includes(row.status) && !row.driving) {
      return row;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  const row = await run(id);
  throw new Error(`Run ${id} is ${row?.status} (${row?.error ?? "no error"}), not ${statuses.join(" or ")}.`);
}
const waiting = async (id: string) => (await view(id)).waiting.at(-1) as { n: number; type: string; call?: string };
const answer = (id: string, n: number, value: unknown) =>
  client.withTenant(T, () => runner.kernelRuns.answer(id, n, value, USER));
const logOf = (id: string) =>
  client.withTenant(T, () => client.db.select().from(client.schema.brokerLog).where(eq(client.schema.brokerLog.runId, id)));

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
  token = await google.token("me@engenty.example");
  executor = await import("../src/kernel/executor");
  await executor.reachExecutorAt("google-gmail", google.url);
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  files = await import("../src/services/files");
  const own = await import("../src/connectors/person-connections");
  // The person's own Gmail, as the runtime keeps it after a sign-in.
  gmailAccount = await client.withTenant(T, async () => {
    const row = await own.saveConnection(`u:${USER}`, "google-gmail", "me@engenty.example", {
      accessToken: token,
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    });
    return row.id;
  });
  runner.startRunner();
}, 60_000);
beforeEach(async () => {
  handed.length = 0;
  await google.reset();
});
afterAll(async () => {
  await executor?.reachExecutorAt("google-gmail", null);
  await google?.close();
});

describe("the mail wizard in the runtime", () => {
  it("reads the thread, waits for the user, and sends the answer into the same thread", async () => {
    const id = await start();
    await rests(id, "waiting_input");
    // the agent was handed the two reads, as one connection's tools, and not the send
    expect(handed).toEqual(["gmail_actions", "gmail_call"]);
    expect(await google.calls("gmail.")).toEqual(["gmail.users.threads.list", "gmail.users.threads.get"]);

    await answer(id, (await waiting(id)).n, { approved: true });
    await rests(id, "waiting_input");
    expect(await waiting(id)).toMatchObject({ type: "approval", call: "gmail.users.messages.send" });
    expect(await google.calls("gmail.")).toHaveLength(2); // nothing is sent while the question is open

    await answer(id, (await waiting(id)).n, { allow: true });
    await rests(id, "done");
    expect(await google.calls("gmail.")).toEqual([
      "gmail.users.threads.list",
      "gmail.users.threads.get",
      "gmail.users.messages.send",
    ]);

    // The emulator's Gmail now holds the answer, in the customer's thread.
    const sentId = (await view(id)).output?.sent as string;
    const { threadId } = await google.get(`/gmail/v1/users/me/messages/${sentId}`, token);
    const thread = await google.get(`/gmail/v1/users/me/threads/${threadId}`, token);
    expect(thread.messages.map((m: { id: string }) => m.id)).toEqual(["msg_1", sentId]);
    const sent = thread.messages[1];
    expect(sent.labelIds).toContain("SENT");
    expect(sent.payload.headers.find((h: { name: string }) => h.name === "To").value).toBe("einkauf@nordlicht.example");

    // Every call went through the broker: one line each, the send as a write.
    const lines = await logOf(id);
    expect(lines.map((l) => [l.actionId, l.kind, l.result])).toEqual(
      expect.arrayContaining([
        ["users.threads.list", "read", "ok"],
        ["users.threads.get", "read", "ok"],
        ["users.messages.send", "write", "ok"],
      ]),
    );
  });

  it("never shows a row, the run or the log the token", async () => {
    const id = await start();
    await rests(id, "waiting_input");
    await answer(id, (await waiting(id)).n, { approved: true });
    await rests(id, "waiting_input");
    await answer(id, (await waiting(id)).n, { allow: true });
    await rests(id, "done");
    expect(token).toMatch(/^emu_google_/);
    expect(JSON.stringify(await run(id))).not.toContain(token);
    expect(JSON.stringify(await view(id))).not.toContain(token);
    expect(JSON.stringify(await logOf(id))).not.toContain(token);
  });

  it("fails the send when Gmail fails, and the broker logs it", async () => {
    const id = await start();
    await rests(id, "waiting_input");
    await answer(id, (await waiting(id)).n, { approved: true });
    await rests(id, "waiting_input");
    await google.fail(
      { method: "POST", pathPattern: "/gmail/v1/users/*/messages/send" },
      { status: 503, body: { error: { code: 503, message: "Backend Error" } } },
    );
    await answer(id, (await waiting(id)).n, { allow: true });
    const row = await rests(id, "failed");
    expect(row.error).toContain("google-gmail.users.messages.send failed");
    expect(row.error).toContain("503");
    const send = (await logOf(id)).find((l) => l.actionId === "users.messages.send");
    expect(send?.result).toBe("Error");
  });
});

describe("which names executor serves", () => {
  it("only those the connector has no action for, and that the service has", async () => {
    const { builtinConnector } = await import("../src/connectors/builtin.js");
    const gmail = builtinConnector("google-gmail");
    const actions = await executor.executorActions(gmail as never, {
      actions: ["search_threads", "users.threads.list", "users.messages.delete", "no.such.thing"],
    });
    expect(actions.map((a) => [a.id, a.group])).toEqual([
      ["users.messages.delete", "destructive"],
      ["users.threads.list", "read"],
    ]);
    expect(await executor.executorActions(builtinConnector("hubspot") as never, { actions: ["x"] })).toEqual([]);
  });
});

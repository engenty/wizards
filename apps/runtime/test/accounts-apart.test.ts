import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Only the broker opens a connected account (docs/plans/runs-on-their-own.md, 7.1). This process
 * is a runner with `ACCOUNTS_PUBLIC_KEY` alone: it seals the team's Slack when an admin signs
 * in, can't open it, and still completes a run that posts there, because the post is the
 * broker's (accounts-apart-broker.test.ts, a process of its own with `ACCOUNTS_KEY`, on the same
 * data folder, asked at `RUN_SERVICES_URL`).
 */
const pair = generateKeyPairSync("x25519");
const jwk = pair.privateKey.export({ format: "jwk" }) as { d: string; x: string };
const DIR = mkdtempSync(join(tmpdir(), "wizards-accounts-apart-"));
const shared = { DATA_DIR: DIR, APP_SECRET: "accounts-apart" };
Object.assign(process.env, shared);
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = "durableRuns=on,runServices=on";
process.env.RUNNER_CLOCK_MS = "100";
process.env.ACCOUNTS_KEY = "";
process.env.ACCOUNTS_PUBLIC_KEY = jwk.x;
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

// The admin's sign-in tries the key here; the post itself is the broker's.
vi.mock("../src/engenty/connections-slack/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-slack/connector")>();
  return {
    ...mod,
    slackConnector: {
      ...mod.slackConnector,
      auth: {
        kind: "api_key",
        apiKey: {
          fields: [{ key: "access_token", label: "Token", secret: true }],
          verify: async () => ({ label: "Firma / bot" }),
        },
      },
      actions: mod.slackConnector.actions.map((action) =>
        action.id === "post_message"
          ? {
              ...action,
              handler: async () => {
                throw new Error("posted from the runner's process");
              },
            }
          : action,
      ),
    },
  };
});

/** A port nothing listens on now. */
function freePort(): Promise<number> {
  return new Promise((done, failed) => {
    const server = createServer();
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

async function until(ok: () => boolean | Promise<boolean>, ms: number) {
  const stop = Date.now() + ms;
  while (!(await ok()) && Date.now() < stop) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return ok();
}

const TENANT = "local";
let broker: ReturnType<typeof spawn> | null = null;
let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let connection = "";
/** The service a plugin's request reaches: it answers with the authorization it got. */
const service = createHttpServer((req, res) => {
  res.writeHead(201, { "content-type": "text/plain", "x-seen": req.method ?? "" });
  res.end(`auth=${req.headers.authorization ?? ""}`);
});

const brokerSaid = () =>
  existsSync(join(DIR, "broker.log")) ? readFileSync(join(DIR, "broker.log"), "utf8") : "";

beforeAll(async () => {
  const port = await freePort();
  await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
  process.env.RUN_SERVICES_URL = `http://127.0.0.1:${port}`;
  process.env.BROKER_URL = `http://127.0.0.1:${port}`;
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  const log = openSync(join(DIR, "broker.log"), "a");
  broker = spawn(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "test/accounts-apart-broker.test.ts",
      "--pool=forks",
      "--maxWorkers=1",
      "--reporter=dot",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...shared,
        ACCOUNTS_BROKER_PORT: String(port),
        ACCOUNTS_KEY: jwk.d,
        ACCOUNTS_REQUEST_ORIGIN: origin,
        RUN_SERVICES_URL: "",
        BROKER_URL: "",
      },
      stdio: ["ignore", log, log],
      detached: true,
    },
  );
  expect(await until(() => existsSync(join(DIR, "broker-ready")), 120_000), brokerSaid()).toBe(
    true,
  );
  runner = await import("../src/engine/runner");
  runner.startRunner();
}, 150_000);

afterAll(async () => {
  service.close();
  await runner?.stopRunner();
  writeFileSync(join(DIR, "stop"), "");
  await until(() => broker?.exitCode !== null, 20_000);
  if (broker && broker.exitCode === null && broker.pid) {
    process.kill(-broker.pid, "SIGKILL");
  }
});

describe("a runner without the accounts' private key", () => {
  it("seals the space's sign-in and can't open it", { timeout: 30_000 }, async () => {
    const spaces = await import("../src/services/spaces");
    const connections = await import("../src/connectors/space-connections");
    const accounts = await import("../src/secrets/accounts");
    expect(accounts.opensAccounts()).toBe(false);
    const row = await client.withTenant(TENANT, async () => {
      const space = (await spaces.createSpace("local", "Vertrieb")).id;
      const made = await connections.createSpaceConnection("local", space, {
        connectorId: "slack",
        name: "Team",
        signIn: "space",
        audience: "all",
        rules: { read: "allow", write: "allow", destructive: "deny", send: "allow" },
        actions: [],
      });
      await connections.signInWithCredentials(made.id, { as: "space" }, { access_token: "xoxb-7" });
      return client.db.query.spaceConnection.findFirst({
        where: eq(client.schema.spaceConnection.id, made.id),
      });
    });
    connection = row?.id ?? "";
    expect(row?.secret?.startsWith("v2.")).toBe(true);
    expect(() => accounts.unsealAccount(row?.secret ?? "")).toThrow(/opened by the broker/);
  });

  it("completes a run that posts through the connection", { timeout: 90_000 }, async () => {
    const wizards = await import("../src/services/wizards");
    const definition = {
      version: 1,
      title: "Anfrage",
      description: "",
      avatar: "round",
      connections: [{ id: "team", spaceConnection: connection, title: "Slack" }],
      steps: [
        {
          id: "tell",
          type: "tool",
          title: "Team informieren",
          call: {
            connection: "team",
            action: "post_message",
            input: { channel: "C0TEAM", text: "Neue Anfrage" },
          },
        },
        { id: "done", type: "result", title: "Fertig", deliverables: [] },
      ],
    };
    const row = await client.withTenant(TENANT, () =>
      client.db.query.spaceConnection.findFirst({
        where: eq(client.schema.spaceConnection.id, connection),
      }),
    );
    const id = await client.withTenant(TENANT, async () => {
      const made = await wizards.createWizard("local", {
        definition: definition as never,
        spaceId: row?.spaceId,
      });
      return runner.createRun({
        wizardId: made.id,
        definition: definition as never,
        files: [],
        version: null,
        mode: "test",
        userId: "local",
      });
    });
    const status = async () =>
      (
        await client.withTenant(TENANT, () =>
          client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }),
        )
      )?.status;
    const ended = await until(
      async () => ["done", "failed"].includes((await status()) ?? ""),
      60_000,
    );
    const events = await client.withTenant(TENANT, () =>
      client.db.query.runEvent.findMany({ where: eq(client.schema.runEvent.runId, id) }),
    );
    const said = `${JSON.stringify(events.map((e) => e.data))}\n--- broker\n${brokerSaid()}`;
    expect(ended, said).toBe(true);
    expect(await status(), said).toBe("done");
    const posts = readFileSync(join(DIR, "posts"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // An API key's connector gets the keys as typed, as JSON (connectors/space-connections.ts).
    expect(posts).toEqual([
      { channel: "C0TEAM", text: "Neue Anfrage", token: JSON.stringify({ access_token: "xoxb-7" }) },
    ]);
  });
});

describe("a connection call from a process without the key", () => {
  /** The team's Slack as the runner's process knows it: its row and connector. */
  async function slackHere() {
    const connections = await import("../src/connectors/space-connections");
    return client.withTenant(TENANT, async () => {
      const row = await connections.spaceConnectionById(connection);
      return { row, connector: await connections.connectorOfRow(row) };
    });
  }
  const posted = () =>
    readFileSync(join(DIR, "posts"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { text: string });

  it("is made by the broker, as a Work chat's call", { timeout: 30_000 }, async () => {
    const { brokerCall } = await import("../src/broker/call");
    const { row, connector } = await slackHere();
    const out = await client.withTenant(TENANT, () =>
      brokerCall({
        who: { kind: "person", id: "local" },
        where: { chatId: "chat-1", spaceId: row.spaceId },
        connection: { kind: "space_connection", row, connector },
        action: { id: "post_message" },
        input: { channel: "C0TEAM", text: "Aus dem Chat" },
        ctx: { confirmed: true },
      }),
    );
    expect(out).toMatchObject({ ok: true, account: { label: "Firma / bot" } });
    expect(posted().at(-1)?.text).toBe("Aus dem Chat");
    // The broker wrote the call's line, with the chat it came from.
    const lines = await client.withTenant(TENANT, () =>
      client.db.query.brokerLog.findMany({
        where: eq(client.schema.brokerLog.chatId, "chat-1"),
      }),
    );
    expect(lines.map((l) => [l.actionId, l.outcome, l.result])).toEqual([
      ["post_message", "allow", "ok"],
    ]);
  });

  it("asks the person in the caller's process, and the broker acts on the answer", {
    timeout: 30_000,
  }, async () => {
    const { brokerCall } = await import("../src/broker/call");
    const connections = await import("../src/connectors/space-connections");
    const space = (await slackHere()).row.spaceId;
    // A Slack each person signs in to, „Nachfragen“ for sending: the person is asked.
    const { row, connector } = await client.withTenant(TENANT, async () => {
      const made = await connections.createSpaceConnection("local", space, {
        connectorId: "slack",
        name: "Meins",
        signIn: "person",
        audience: "all",
        rules: { read: "allow", write: "ask", destructive: "deny", send: "ask" },
        actions: [],
      });
      await connections.signInWithCredentials(
        made.id,
        { as: "person", userId: "local", role: "member" },
        { access_token: "xoxp-own" },
      );
      const row = await connections.spaceConnectionById(made.id);
      return { row, connector: await connections.connectorOfRow(row) };
    });
    const asked: string[] = [];
    const call = (answer: "done" | "skip", text: string, allowed = new Set<string>()) =>
      client.withTenant(TENANT, () =>
        brokerCall({
          who: { kind: "person", id: "local" },
          where: { chatId: "chat-2", spaceId: space },
          connection: { kind: "space_connection", row, connector },
          action: { id: "post_message" },
          input: { channel: "C0OWN", text },
          ctx: {
            allowed,
            ask: async (ask) => {
              asked.push(ask.kind);
              return answer === "done" ? { type: "done", remember: true } : { type: "skip" };
            },
          },
        }),
      );
    expect(await call("skip", "Nein")).toMatchObject({ ok: false, refused: "declined" });
    expect(posted().map((p) => p.text)).not.toContain("Nein");
    const allowed = new Set<string>();
    expect(await call("done", "Ja", allowed)).toMatchObject({ ok: true });
    // The person's own sign-in, opened by the broker.
    expect(posted().at(-1)).toMatchObject({
      text: "Ja",
      token: JSON.stringify({ access_token: "xoxp-own" }),
    });
    expect(asked).toEqual(["confirm", "confirm"]);
    // „Für den Rest erlauben“ comes back to the caller's set.
    expect([...allowed]).toEqual([`${row.id}:post_message`]);
  });

  it("refuses to send code that would run with the account", async () => {
    const { brokerCall } = await import("../src/broker/call");
    const { row, connector } = await slackHere();
    await expect(
      client.withTenant(TENANT, () =>
        brokerCall({
          who: { kind: "admin", id: "local" },
          where: { spaceId: row.spaceId },
          connection: { kind: "space_connection", row, connector },
          action: { id: "list_tools", kind: "read" },
          input: {},
          handler: async (account) => account.ctx.accessToken,
        }),
      ),
    ).rejects.toThrow(/can't go to the broker/);
  });
});

describe("named calls from a process without the key", () => {
  async function slackHere() {
    const connections = await import("../src/connectors/space-connections");
    return client.withTenant(TENANT, async () => {
      const row = await connections.spaceConnectionById(connection);
      return { row, connector: await connections.connectorOfRow(row) };
    });
  }

  it("says whose account is there, without opening it here", async () => {
    const { brokerConnected } = await import("../src/broker/call");
    const { row, connector } = await slackHere();
    const found = await client.withTenant(TENANT, () =>
      brokerConnected({ kind: "space_connection", row, connector }),
    );
    expect(found).toMatchObject({ label: "Firma / bot", connector: { id: "slack" } });
  });

  it("reads the mailbox's stream, and a pull that found nothing leaves no line", {
    timeout: 30_000,
  }, async () => {
    const { brokerPullStream, brokerReadMessage } = await import("../src/broker/call");
    // An admin agreed that the mailbox is read for nobody in particular.
    await client.withTenant(TENANT, () =>
      client.db
        .update(client.schema.spaceConnection)
        .set({ autonomousMode: "read_only" })
        .where(eq(client.schema.spaceConnection.id, connection)),
    );
    const { row, connector } = await slackHere();
    const held = { kind: "space_connection" as const, row, connector };
    const token = JSON.stringify({ access_token: "xoxb-7" });
    const first = await client.withTenant(TENANT, () =>
      brokerPullStream({ connection: held, cursor: null, since: new Date(0), limit: 5 }),
    );
    expect(first).toMatchObject({
      ok: true,
      result: { nextCursor: "c1", items: [{ subject: `read with ${token}` }] },
    });
    const empty = await client.withTenant(TENANT, () =>
      brokerPullStream({ connection: held, cursor: "c1", since: new Date(0), limit: 5 }),
    );
    expect(empty).toMatchObject({ ok: true, result: { items: [] } });
    const one = await client.withTenant(TENANT, () =>
      brokerReadMessage({ connection: held, message: "m1" }),
    );
    expect(one).toMatchObject({ ok: true, result: { provider_message_id: "m1" } });
    const lines = await client.withTenant(TENANT, () =>
      client.db.query.brokerLog.findMany({
        where: eq(client.schema.brokerLog.connectionId, connection),
      }),
    );
    expect(lines.filter((l) => l.actionId === "pull_stream")).toHaveLength(1);
    expect(lines.filter((l) => l.actionId === "read_message")).toHaveLength(1);
  });

  it("sends a plugin's own request, signed by the broker", { timeout: 30_000 }, async () => {
    const { brokerCall, requestWire, responseOf } = await import("../src/broker/index");
    const { row, connector } = await slackHere();
    const address = service.address() as { port: number };
    const out = await client.withTenant(TENANT, async () =>
      brokerCall<import("../src/broker/index").ResponseWire>({
        who: { kind: "plugin", id: "crm" },
        where: { spaceId: row.spaceId },
        connection: { kind: "space_connection", row, connector },
        action: { id: "request", kind: "write" },
        input: { method: "POST", url: `http://127.0.0.1:${address.port}/contacts` },
        named: {
          name: "request",
          request: await requestWire({
            url: `http://127.0.0.1:${address.port}/contacts`,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Kim" }),
          }),
        },
      }),
    );
    expect(out.ok).toBe(true);
    const res = responseOf((out as { result: import("../src/broker/index").ResponseWire }).result);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-seen")).toBe("POST");
    expect(await res.text()).toBe(`auth=Bearer ${JSON.stringify({ access_token: "xoxb-7" })}`);
  });
});

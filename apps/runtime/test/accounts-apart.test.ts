import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
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

const brokerSaid = () =>
  existsSync(join(DIR, "broker.log")) ? readFileSync(join(DIR, "broker.log"), "utf8") : "";

beforeAll(async () => {
  const port = await freePort();
  process.env.RUN_SERVICES_URL = `http://127.0.0.1:${port}`;
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
        RUN_SERVICES_URL: "",
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

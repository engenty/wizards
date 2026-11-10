import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { beforeAll, describe, expect, it } from "vitest";

// The wizard's database from inside the sandbox (docs/plans/wizard-data.md, step 5): a command
// posts a statement to the runtime with the run's token, and it goes through the broker as the
// model's. Nothing of the database goes into the VM.

const dir = mkdtempSync(join(tmpdir(), "wizards-sandbox-data-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.SANDBOX_DATA_URL = "https://runtime.example.com";
delete process.env.FEATURES;

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let wizardId = "";
let client: typeof import("../src/db/client");
let door: typeof import("../src/sandbox/data");
let files: WorkspaceFile[] = [];

const url = (path: string) => `http://localhost:5181${path}`;
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);

const def = {
  version: 1,
  title: "Data",
  description: "",
  avatar: "round",
  data: { scope: "shared", schema: "data/schema.sql" },
  steps: [{ id: "end", type: "result", title: "Done", deliverables: [] }],
} as unknown as WizardDefinition;

/** A step of a run, as far as the door needs it: a guest's by visitor id, else the owner's. */
function stepOf(runId: string, holder: string, definition: WizardDefinition = def) {
  const guest = !holder.startsWith("u:");
  return {
    runId,
    tenantId: "local",
    holder: guest
      ? { kind: "guest" as const, id: holder.slice(2) }
      : { kind: "person" as const, id: holder.slice(2), role: "owner" as const },
    test: false,
    stepId: "work",
    def: definition,
    files,
    store: { wizardId, holder },
    space: { id: spaceId, name: "Space" },
    dataSpace: { id: spaceId, name: "Space" },
    signal: new AbortController().signal,
    emit: async () => undefined,
  } as never;
}

/** Opens the run's door as its step, inside the tenant, as a step does. */
const open = (runId: string, holder: string, definition?: WizardDefinition) =>
  local(() => door.openSandboxData(stepOf(runId, holder, definition)));

/** What a command in the VM sends: the address and token from its environment. */
function post(runId: string, action: string, body: unknown, token?: string) {
  const env = door.sandboxDataEnv(runId);
  const path = new URL(env.WIZARD_DATA_URL ?? `https://x/api/sandbox/data/${runId}`).pathname;
  return app.fetch(
    new Request(url(`${path}/${action}`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token ?? env.WIZARD_DATA_TOKEN ?? "none"}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

const logOf = (runId: string) =>
  local(() =>
    client.db.query.brokerLog.findMany({
      where: (t, { and, eq }) => and(eq(t.connectionId, `data:${wizardId}`), eq(t.runId, runId)),
    }),
  );

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
  const made = await app.fetch(
    new Request(url("/api/studio/wizards"), {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: JSON.stringify({ spaceId }),
    }),
  );
  wizardId = ((await made.json()) as { id: string }).id;
  door = await import("../src/sandbox/data");
  const { putBlob } = await import("../src/files/blobs");
  const schema = Buffer.from("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);");
  files = [
    {
      path: "data/schema.sql",
      hash: await local(() => putBlob(schema)),
      mime: "application/sql",
      size: schema.length,
    },
  ];
}, 300_000);

describe("the sandbox's way to the wizard's database", () => {
  it("is in a command's environment only where the wizard keeps data", async () => {
    await open("run-none", "u:local", { ...def, data: undefined });
    expect(door.sandboxDataEnv("run-none")).toEqual({});
    await open("run-a", "u:local");
    const env = door.sandboxDataEnv("run-a");
    expect(env.WIZARD_DATA_URL).toBe("https://runtime.example.com/api/sandbox/data/run-a");
    expect(env.WIZARD_DATA_TOKEN).toMatch(/^[\w-]{32}$/);
    expect(door.sandboxDataHost()).toBe("runtime.example.com");
  });

  it("keeps the run's token from step to step", async () => {
    const before = door.sandboxDataEnv("run-a").WIZARD_DATA_TOKEN;
    await open("run-a", "u:local");
    expect(door.sandboxDataEnv("run-a").WIZARD_DATA_TOKEN).toBe(before);
  });

  it("writes and reads through the broker, one line of the log per statement", async () => {
    const written = await post("run-a", "exec", {
      sql: "INSERT INTO notes (text) VALUES (:text)",
      params: { text: "from the sandbox" },
      scope: "shared",
    });
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({ changes: 1, lastId: 1 });
    const read = await post("run-a", "query", { sql: "SELECT text FROM notes", scope: "shared" });
    expect(await read.json()).toEqual({
      columns: ["text"],
      rows: [{ text: "from the sandbox" }],
      truncated: false,
    });
    const log = await logOf("run-a");
    expect(log.map((l) => [l.actionId, l.kind, l.outcome])).toEqual([
      ["sandbox:db.exec", "write", "allow"],
      ["sandbox:db.query", "read", "allow"],
    ]);
    expect(log[0].inputSummary).not.toContain("from the sandbox");
  });

  it("refuses another token, a statement past the database and a write in /query", async () => {
    const stranger = await post("run-a", "query", { sql: "SELECT 1" }, "not-the-token");
    expect(stranger.status).toBe(401);
    const attach = await post("run-a", "exec", { sql: "ATTACH DATABASE 'x.db' AS x" });
    expect(attach.status).toBe(400);
    const write = await post("run-a", "query", { sql: "DELETE FROM notes" });
    expect(write.status).toBe(400);
    const empty = await post("run-a", "query", { params: {} });
    expect(empty.status).toBe(400);
  });

  it("keeps a guest's sandbox out of the shared database, and lets it reach the guest's own", async () => {
    await open("run-guest", "v:eve");
    const shared = await post("run-guest", "query", { sql: "SELECT * FROM notes", scope: "shared" });
    expect(shared.status).toBe(403);
    const own = await post("run-guest", "exec", { sql: "INSERT INTO notes (text) VALUES ('mine')" });
    expect(own.status).toBe(200);
    const read = await post("run-guest", "query", { sql: "SELECT text FROM notes" });
    expect((await read.json()).rows).toEqual([{ text: "mine" }]);
    expect((await logOf("run-guest")).map((l) => [l.whoKind, l.actionId, l.outcome])).toEqual([
      ["guest", "sandbox:db.query", "deny"],
      ["guest", "sandbox:db.exec", "allow"],
      ["guest", "sandbox:db.query", "allow"],
    ]);
  });

  it("is shut when the run stops running", async () => {
    const token = door.sandboxDataEnv("run-a").WIZARD_DATA_TOKEN;
    door.closeSandboxData("run-a");
    expect(door.sandboxDataEnv("run-a")).toEqual({});
    const late = await post("run-a", "query", { sql: "SELECT 1" }, token);
    expect(late.status).toBe(404);
  });

  it("goes into every command of the run's sandbox", async () => {
    const { RunResources } = await import("../src/engine/resources");
    const seen: (Record<string, string> | undefined)[] = [];
    const sandbox = {
      capabilities: { commands: [], network: "", uses: "", workdir: "/workspace" },
      exec: async (_command: string, options: { env?: Record<string, string> } = {}) => {
        seen.push(options.env);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      writeFile: async () => undefined,
      readFile: async () => new Uint8Array(),
      destroy: async () => undefined,
    };
    const resources = new RunResources("run-b");
    Object.assign(resources, {
      engine: { name: "fake", ready: () => true, capabilities: () => sandbox.capabilities, create: () => sandbox },
    });
    await open("run-b", "u:local");
    await resources.sandboxHandle().exec("true", { env: { OWN: "1" } });
    expect(seen[0]).toMatchObject({
      OWN: "1",
      WIZARD_DATA_URL: "https://runtime.example.com/api/sandbox/data/run-b",
    });
    await resources.release();
    expect(door.sandboxDataEnv("run-b")).toEqual({});
  });
});

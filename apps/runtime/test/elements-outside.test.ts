import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";

// The space's elements for outside clients (docs/plans/modular.md, phase 2): MCP tools and API
// calls made from the catalogue's specs, behind their scopes, acting as the token's person, in a
// space checked against the token (I2), each call a line of the broker's log with the client.

const dir = mkdtempSync(join(tmpdir(), "wizards-elements-outside-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.SANDBOX = "off";
delete process.env.FEATURES;

const MCP_URL = "http://localhost:5181/api/mcp";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let key: string;
let cookie = "";
let spaceId = "";
let db: typeof import("../src/db/client");

const local = <T>(fn: () => T | Promise<T>) => db.withTenant("local", fn);
const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`http://localhost:5181${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

async function connect(): Promise<Client> {
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (url, init) => Promise.resolve(app.fetch(new Request(url, init))),
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Plain text.
  }
  return { isError: Boolean(res.isError), body };
}

beforeAll(async () => {
  db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb("local");
  const { createLocalKey } = await import("../src/auth/keys");
  key = (await createLocalKey("Claude Code")).key;
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request("http://localhost:5181/api/local/enter?k=test-key"));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
  const data = await import("../src/services/space-data");
  await local(() => data.createPage("local", spaceId, { title: "Akten", markdown: "Maier hat zwei Akten." }));
  const made = await app.fetch(
    new Request(`http://localhost:5181/api/studio/spaces/${spaceId}/skills`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: JSON.stringify({ name: "tonalitaet", description: "So schreiben wir.", body: "# Tonalität\n\nPer du." }),
    }),
  );
  const skill = (await made.json()) as { id: string };
  await app.fetch(
    new Request(`http://localhost:5181/api/studio/skills/${skill.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: JSON.stringify({ mode: "demand" }),
    }),
  );
}, 60_000);

describe("MCP", () => {
  it("lists the elements as tools beside the authoring ones, each with its hints", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "space_search",
        "space_list",
        "page_read",
        "skill_list",
        "skill_load",
        "skill_read",
        "wizard_list",
        "wizard_run",
        "run_command",
        "create_wizard",
      ]),
    );
    const search = tools.find((t) => t.name === "space_search");
    expect(search?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(Object.keys((search?.inputSchema as any).properties)).toEqual(
      expect.arrayContaining(["query", "spaceId"]),
    );
  });

  it("reads a space's skill as the token's person, and the log names the client (I6)", async () => {
    const client = await connect();
    const listed = await call(client, "skill_list", { spaceId });
    expect(listed.body.skills.map((k: any) => k.name)).toContain("tonalitaet");
    const loaded = await call(client, "skill_load", { spaceId, name: "tonalitaet" });
    expect(loaded.isError).toBe(false);
    expect(loaded.body.instructions).toContain("Per du.");
    const { eq } = await import("drizzle-orm");
    const rows = await local(() =>
      db.db.query.brokerLog.findMany({ where: eq(db.schema.brokerLog.actionId, "skill_load") }),
    );
    expect(rows.at(-1)).toMatchObject({ client: "Claude Code", outcome: "allow", whoId: "local" });
  });

  it("refuses a space the token does not reach (I2)", async () => {
    const client = await connect();
    const out = await call(client, "skill_list", { spaceId: "elsewhere" });
    expect(out.isError).toBe(true);
  });

  it("says when a call has nothing to work on: no sandbox here", async () => {
    const client = await connect();
    const out = await call(client, "run_command", { spaceId, command: "ls" });
    expect(out.isError).toBe(true);
    expect(out.body.error).toContain("not open");
  });
});

describe("the API", () => {
  it("lists the calls a token may make, with their inputs as JSON Schema", async () => {
    const res = await api("GET", `/api/v1/spaces/${spaceId}/elements`);
    expect(res.status).toBe(200);
    const { calls } = (await res.json()) as any;
    const load = calls.find((k: any) => k.name === "skill_load");
    expect(load).toMatchObject({ scope: "elements:read" });
    expect(load.input.properties.name.type).toBe("string");
  });

  it("makes a call as the token's person, the client from its header", async () => {
    const res = await api(
      "POST",
      `/api/v1/spaces/${spaceId}/elements/skill_load`,
      { input: { name: "tonalitaet" } },
      { "x-wizards-client": "my-app" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result.instructions).toContain("Per du.");
    const { eq } = await import("drizzle-orm");
    const row = await local(() =>
      db.db.query.brokerLog.findFirst({ where: eq(db.schema.brokerLog.client, "my-app") }),
    );
    expect(row).toMatchObject({ actionId: "skill_load", outcome: "allow" });
  });

  it("refuses a space the token does not reach, and an unknown call (I2)", async () => {
    expect((await api("POST", "/api/v1/spaces/elsewhere/elements/skill_list", {})).status).toBe(404);
    expect((await api("POST", `/api/v1/spaces/${spaceId}/elements/drop_tables`, {})).status).toBe(404);
  });
});

describe("the same elements everywhere", () => {
  it("an outside client gets exactly the element tools a Work chat gets the same person", async () => {
    const { ELEMENT_TOOL_NAMES } = await import("../src/elements/specs");
    const { outsideTools } = await import("../src/elements/outside");
    const { toolToRun } = await import("../src/services/work-ai");
    await local(async () => {
      const outside = await outsideTools(
        { userId: "local", role: "owner", client: "Claude Code", tenantId: "local", scopes: ["data:read", "elements:read", "elements:run"] },
        spaceId,
        new AbortController().signal,
      );
      const signal = new AbortController().signal;
      const work: string[] = [];
      // A Work chat has one tool per connection action; outside clients have connection_list and
      // connection_call over the same actions.
      const names = ELEMENT_TOOL_NAMES.filter((n) => !n.startsWith("connection_"));
      for (const name of names) {
        if (await toolToRun({ id: spaceId, name: "Test" }, "local", name, signal, { chatId: "c1", byAdmin: false })) {
          work.push(name);
        }
      }
      const outsideNames = Object.keys(outside).filter((n) => (names as readonly string[]).includes(n));
      expect(outsideNames.sort()).toEqual(work.sort());
      expect(work).toEqual(expect.arrayContaining(["space_search", "skill_load", "wizard_run"]));
    });
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

// A client that only uses a space (`data:read`, `elements:read`, `elements:run`, as a
// wizards.bot home gets): it runs a space's wizard with `wizard_run`, sees it in the flow widget
// and answers its pages to the end, without the authoring scopes.

const dir = mkdtempSync(join(tmpdir(), "wizards-mcp-runs-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.SANDBOX = "off";
delete process.env.FEATURES;

const USE_TOKEN = "tok-use";

vi.mock("../src/mcp/auth.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/mcp/auth.js")>();
  return {
    ...real,
    authenticate: async (request: Request) => {
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (token !== "tok-use") {
        return real.authenticate(request);
      }
      const scopes = ["data:read", "elements:read", "elements:run"];
      return {
        token,
        clientId: "wizards-bot",
        scopes,
        extra: { userId: "local", role: "owner", tenantId: "local", client: "wizards.bot", scopes },
      };
    },
  };
});

const MCP_URL = "http://localhost:5181/api/mcp";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let key = "";
let wizardId = "";

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (url, init) => Promise.resolve(app.fetch(new Request(url, init))),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** A client on protocol 2026-07-28 that shows forms: it answers each page as `answer` says. */
async function connectAsking(
  token: string,
  answer: (request: { message: string; requestedSchema?: any; mode?: string }) => any,
  asked: unknown[],
): Promise<Client> {
  const client = new Client(
    { name: "vitest-home", version: "1.0.0" },
    {
      capabilities: { elicitation: { form: {}, url: {} } },
      versionNegotiation: { mode: "auto" },
    },
  );
  client.setRequestHandler("elicitation/create", async (request: any) => {
    asked.push(request.params);
    return answer(request.params);
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (url, init) => Promise.resolve(app.fetch(new Request(url, init))),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
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
  return { isError: Boolean(res.isError), body, raw: res };
}

beforeAll(async () => {
  const db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb("local");
  const { createLocalKey } = await import("../src/auth/keys");
  key = (await createLocalKey("Studio")).key;
  app = (await import("../src/app")).default;
  const spaces = await import("../src/services/spaces");
  const spaceId = (await db.withTenant("local", () => spaces.defaultSpace("local"))).id;
  const res = await app.fetch(
    new Request("http://localhost:5181/api/v1/wizards/import", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        spaceId,
        publish: true,
        definition: {
          version: 1,
          title: "Besuch",
          description: "Bucht einen Besuch.",
          avatar: "round",
          steps: [
            {
              id: "who",
              type: "form",
              title: "Wer kommt",
              fields: [{ id: "name", kind: "text", label: "Name" }],
            },
            {
              id: "bring",
              type: "form",
              title: "Mitbringen",
              fields: [{ id: "what", kind: "text", label: "Was?" }],
            },
            { id: "done", type: "result", title: "Danke", deliverables: [] },
          ],
        },
      }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { wizardId?: string; id?: string };
  wizardId = body.wizardId ?? body.id ?? "";
}, 60_000);

describe("a client that uses a space", () => {
  it("gets the run tools beside the elements, and none of the authoring tools", async () => {
    const client = await connect(USE_TOKEN);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "wizard_list",
        "wizard_run",
        "get_run",
        "answer_form",
        "review_step",
        "answer_ask",
        "answer_question",
        "control_run",
      ]),
    );
    for (const authoring of ["create_wizard", "run_wizard", "publish_wizard", "write_file"]) {
      expect(names).not.toContain(authoring);
    }
  });

  it("wizard_run opens the flow widget", async () => {
    const client = await connect(USE_TOKEN);
    const run = (await client.listTools()).tools.find((t) => t.name === "wizard_run");
    expect((run?._meta as any)?.ui?.resourceUri).toMatch(/^ui:\/\/engenty-wizards\/flow-/);
    expect(run?.description).toContain("answer_form");
  });

  it("runs a wizard from its first page to the end", async () => {
    const client = await connect(USE_TOKEN);
    const started = await call(client, "wizard_run", {
      wizardId,
      answers: { name: "Lena" },
      waitSeconds: 5,
    });
    expect(started.isError, JSON.stringify(started.body)).toBe(false);
    expect(started.body.waitingFor?.form).toBe("bring");
    expect((started.raw.structuredContent as any)?.runId).toBe(started.body.runId);
    const view = (started.raw._meta as any)?.["engenty/flow"];
    expect(view?.wizard?.id).toBe(wizardId);
    expect(view?.runtime?.ticket).toBeTruthy();

    const done = await call(client, "answer_form", {
      runId: started.body.runId,
      stepId: "bring",
      values: { what: "Ausweis" },
      waitSeconds: 5,
    });
    expect(done.isError, JSON.stringify(done.body)).toBe(false);
    expect(done.body.status).toBe("done");
  });

  it("asks a client that shows forms each page itself, and the answers go into the run", async () => {
    const asked: any[] = [];
    const client = await connectAsking(
      USE_TOKEN,
      (request) => ({
        action: "accept",
        content: request.requestedSchema?.properties?.name ? { name: "Lena" } : { what: "Ausweis" },
      }),
      asked,
    );
    const done = await call(client, "wizard_run", { wizardId, waitSeconds: 5 });
    expect(done.isError, JSON.stringify(done.body)).toBe(false);
    expect(done.body.status).toBe("done");
    expect(asked.map((a) => a.message)).toEqual(["Wer kommt", "Mitbringen"]);
    expect(asked[0].requestedSchema.properties.name).toMatchObject({ type: "string", title: "Name" });
    expect((done.raw._meta as any)?.["engenty/flow"]?.run?.status).toBe("done");
  });

  it("leaves the run waiting when the person puts a page off", async () => {
    const client = await connectAsking(USE_TOKEN, () => ({ action: "cancel" }), []);
    const left = await call(client, "wizard_run", { wizardId, waitSeconds: 5 });
    expect(left.isError, JSON.stringify(left.body)).toBe(false);
    expect(left.body).toMatchObject({ status: "waiting_input", unanswered: true });
    expect(left.body.waitingFor?.form).toBe("who");
  });

  it("follows a run as a task: input_required with its pages, completed with its report", async () => {
    let id = 0;
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const res = await app.fetch(
        new Request(MCP_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${USE_TOKEN}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        }),
      );
      return ((await res.json()) as any).result;
    };
    const tasks = {
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { "io.modelcontextprotocol/tasks": {} },
        elicitation: { form: {} },
      },
    };
    const handle = await rpc("tools/call", {
      name: "wizard_run",
      arguments: { wizardId },
      _meta: tasks,
    });
    expect(handle).toMatchObject({ resultType: "task", status: "input_required" });
    const taskId = handle.taskId;

    const first = await rpc("tasks/get", { taskId });
    expect(first.status).toBe("input_required");
    const firstKey = Object.keys(first.inputRequests)[0];
    expect(first.inputRequests[firstKey]).toMatchObject({
      method: "elicitation/create",
      params: { message: "Wer kommt" },
    });
    await rpc("tasks/update", {
      taskId,
      inputResponses: { [firstKey]: { action: "accept", content: { name: "Lena" } } },
    });
    let next = await rpc("tasks/get", { taskId });
    for (let i = 0; i < 20 && next.status === "working"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      next = await rpc("tasks/get", { taskId });
    }
    const nextKey = Object.keys(next.inputRequests ?? {})[0];
    // Each page has a key of its own over the task's life.
    expect(nextKey).not.toBe(firstKey);
    expect(next.inputRequests[nextKey].params.message).toBe("Mitbringen");
    await rpc("tasks/update", {
      taskId,
      inputResponses: { [nextKey]: { action: "accept", content: { what: "Ausweis" } } },
    });
    let done = await rpc("tasks/get", { taskId });
    for (let i = 0; i < 20 && done.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      done = await rpc("tasks/get", { taskId });
    }
    expect(done.status).toBe("completed");
    expect(done.result._meta["engenty/flow"].run.status).toBe("done");

    expect(await rpc("tasks/get", { taskId: "nope" })).toBeUndefined();
  });

  it("cancels a run followed as a task", async () => {
    const res = await app.fetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${USE_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "wizard_run",
            arguments: { wizardId },
            _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } } },
          },
        }),
      }),
    );
    const { taskId } = ((await res.json()) as any).result;
    const cancel = await app.fetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${USE_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/cancel", params: { taskId } }),
      }),
    );
    expect(((await cancel.json()) as any).result.status).toBe("cancelled");
  });
});

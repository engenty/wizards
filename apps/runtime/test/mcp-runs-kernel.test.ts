import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { kernelShell } from "@engenty/wizards-shared/kernel-file";
import { beforeAll, describe, expect, it, vi } from "vitest";

// A run of a wizard in version 0.3.0 through the MCP door (docs/plans/kernel.md, C.10 and C.11), as
// a wizards.bot home uses it: its pages as questions the calling app shows, the run as a task, and
// the tools that answer a page by its step.

const dir = mkdtempSync(join(tmpdir(), "wizards-mcp-runs-kernel-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.SANDBOX = "off";
process.env.FEATURES = "kernel=on";
process.env.KERNEL_STEPS = "quickjs";

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
let wizardId = "";

/** A visit: who comes is the file's first page, what they bring is a step's form, then a review. */
const file = {
  version: "0.3.0",
  title: "Besuch",
  description: "Bucht einen Besuch.",
  input: { fields: [{ id: "name", label: "Name", kind: "text", required: true }] },
  start: "bring",
  edges: { bring: ["check"], check: ["end"] },
  output: { what: "bring.what", ok: "check.approved" },
};
const steps = {
  "steps/bring.ts": `export default async (run, ask) => ({
  value: await ask({ type: "form", title: "Mitbringen", fields: [{ id: "what", label: "Was?", kind: "text", required: true }] }),
});
`,
  "steps/check.ts": `export default async (run, ask) => ({
  value: await ask({ type: "review", title: "Stimmt das?", show: ["bring"], approve: true }),
});
`,
};

const transport = (token: string) =>
  new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) => Promise.resolve(app.fetch(new Request(url, init))),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(transport(token));
  return client;
}

/** A client on protocol 2026-07-28 that shows forms: it answers each page as `answer` says. */
async function connectAsking(
  token: string,
  answer: (request: { message: string; requestedSchema?: any }) => any,
  asked: any[],
): Promise<Client> {
  const client = new Client(
    { name: "vitest-home", version: "1.0.0" },
    { capabilities: { elicitation: { form: {}, url: {} } }, versionNegotiation: { mode: "auto" } },
  );
  client.setRequestHandler("elicitation/create", async (request: any) => {
    asked.push(request.params);
    return answer(request.params);
  });
  await client.connect(transport(token));
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

/** What a person says to each page, by what the page asks. */
const said = (request: { requestedSchema?: any }) => {
  const asks = request.requestedSchema?.properties ?? {};
  return {
    action: "accept",
    content: asks.name ? { name: "Lena" } : asks.what ? { what: "Ausweis" } : { decision: "accept" },
  };
};

beforeAll(async () => {
  const db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb("local");
  const { createLocalKey } = await import("../src/auth/keys");
  const key = (await createLocalKey("Studio")).key;
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
        definition: kernelShell(file as never),
        files: Object.entries(steps).map(([path, text]) => ({ path, data: Buffer.from(text).toString("base64") })),
      }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { wizardId?: string; id?: string };
  wizardId = body.wizardId ?? body.id ?? "";
}, 60_000);

describe("a run of version 0.3.0 for a client that uses a space", () => {
  it("is answered page by page with the tools every run has", async () => {
    const client = await connect(USE_TOKEN);
    const started = await call(client, "wizard_run", { wizardId, answers: { name: "Lena" }, waitSeconds: 5 });
    expect(started.isError, JSON.stringify(started.body)).toBe(false);
    expect(started.body.waitingFor).toMatchObject({ form: "bring", title: "Mitbringen" });
    expect(started.body.waitingFor.fields[0]).toMatchObject({ id: "what", label: "Was?", inChat: true });

    const next = await call(client, "answer_form", { runId: started.body.runId, stepId: "bring", values: { what: "Ausweis" }, waitSeconds: 5 });
    expect(next.isError, JSON.stringify(next.body)).toBe(false);
    expect(next.body.waitingFor).toMatchObject({ review: "check", approve: true });
    // what the review shows is in the report, as for every run
    expect(next.body.outputs.find((o: any) => o.stepId === "bring")).toBeTruthy();

    const done = await call(client, "review_step", { runId: started.body.runId, stepId: "check", action: { type: "accept" }, waitSeconds: 5 });
    expect(done.isError, JSON.stringify(done.body)).toBe(false);
    expect(done.body).toMatchObject({ status: "done", version: "0.3.0", data: { what: "Ausweis", ok: true } });
  });

  it("asks a client that shows forms each page itself, a review too", async () => {
    const asked: any[] = [];
    const client = await connectAsking(USE_TOKEN, said, asked);
    const done = await call(client, "wizard_run", { wizardId, waitSeconds: 5 });
    expect(done.isError, JSON.stringify(done.body)).toBe(false);
    expect(done.body.status).toBe("done");
    expect(asked.map((a) => a.message.split("\n")[0])).toEqual(["Besuch", "Mitbringen", "Stimmt das?"]);
    expect(asked[0].requestedSchema.properties.name).toMatchObject({ type: "string", title: "Name" });
    expect(asked[2].requestedSchema.properties.decision.oneOf.map((o: any) => o.const)).toEqual(["accept", "decline"]);
    expect(done.body.data).toEqual({ what: "Ausweis", ok: true });
  });

  it("is followed as a task: input_required with each page, completed with its report", async () => {
    let id = 0;
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const res = await app.fetch(
        new Request(MCP_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${USE_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
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
    const handle = await rpc("tools/call", { name: "wizard_run", arguments: { wizardId }, _meta: tasks });
    // The run begins in the line: its first page is there a moment after the handle.
    expect(handle.resultType).toBe("task");
    expect(["working", "input_required"]).toContain(handle.status);
    const taskId = handle.taskId;

    const messages: string[] = [];
    let task = await rpc("tasks/get", { taskId });
    for (let page = 0; page < 3; page++) {
      for (let i = 0; i < 50 && task.status === "working"; i++) {
        await new Promise((r) => setTimeout(r, 100));
        task = await rpc("tasks/get", { taskId });
      }
      expect(task.status, JSON.stringify(task)).toBe("input_required");
      const key = Object.keys(task.inputRequests)[0];
      const request = task.inputRequests[key];
      messages.push(String(request.params.message).split("\n")[0]);
      await rpc("tasks/update", { taskId, inputResponses: { [key]: said(request.params) } });
      task = await rpc("tasks/get", { taskId });
    }
    for (let i = 0; i < 50 && task.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      task = await rpc("tasks/get", { taskId });
    }
    expect(messages).toEqual(["Besuch", "Mitbringen", "Stimmt das?"]);
    expect(task.status).toBe("completed");
    expect(task.result._meta["engenty/flow"].run.status).toBe("done");
  });
});

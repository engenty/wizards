import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Approvals in a Work chat: a plugin's tool that reaches past the space (or isn't marked) is held
// when the AI calls it; Approve runs the stored call once and the AI goes on with its result;
// Deny doesn't run it; a decision counts once; the bell lists what waits.

const dir = mkdtempSync(join(tmpdir(), "wizards-work-approvals-"));
const pluginsDir = join(dir, "plugins");
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = pluginsDir;
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "workMode=on";

function put(path: string, content: string) {
  const file = join(pluginsDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
put("mailer/engenty.plugin.json", JSON.stringify({ id: "mailer", name: "Mailer", version: "0.1.0" }));
put(
  "mailer/src/plugin.ts",
  `import { definePlugin } from "@engenty/wizards/plugin";
import { z } from "zod";

const sent = ((globalThis as any).__mails ??= []);
const seen = ((globalThis as any).__ctx ??= []);
const slow = ((globalThis as any).__slow ??= { open: null });

export default definePlugin(({ server }) => {
  server.registerAssistantTool({
    name: "send_mail",
    description: "Sends a mail.",
    risk: "outside",
    inputSchema: z.object({ to: z.string(), text: z.string() }),
    execute: async ({ to, text }, ctx) => {
      sent.push({ to, text });
      seen.push({ tenantId: ctx.tenantId, space: ctx.space.id, userId: ctx.userId, aborted: ctx.signal.aborted });
      return { sent: to };
    },
  });
  server.registerAssistantTool({
    name: "note",
    description: "Notes something in the space.",
    risk: "space",
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => ({ noted: text }),
  });
  server.registerAssistantTool({
    name: "slow",
    description: "Takes its time.",
    risk: "read",
    inputSchema: z.object({}),
    execute: () => new Promise((resolve) => { slow.open = () => resolve({ late: true }); }),
  });
  server.registerAssistantTool({
    name: "unmarked",
    description: "Says nothing of what it does.",
    inputSchema: z.object({}),
    execute: async () => ({ ran: true }),
  });
});
`,
);
const mails = () => ((globalThis as any).__mails ?? []) as { to: string }[];

// A connection of the space (A7): HubSpot, played by a stub with a read and a write.
const hubspot: { action: string; input: unknown; token: string }[] = [];
vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const action = (id: string, group: "read" | "write", summary: string) => ({
    id,
    group,
    summary,
    description: summary,
    inputSchema: z.object({ email: z.string().optional() }),
    handler: async (input: unknown, ctx: { accessToken: string }) => {
      hubspot.push({ action: id, input, token: ctx.accessToken });
      return { done: id, contacts: [{ id: "7" }] };
    },
  });
  return {
    ...mod,
    hubspotConnector: {
      ...mod.hubspotConnector,
      auth: {
        kind: "api_key",
        apiKey: {
          fields: [{ key: "access_token", label: "Token", secret: true }],
          verify: async () => ({ label: "HubSpot" }),
        },
      },
      actions: [action("list_contacts", "read", "List contacts"), action("create_contact", "write", "Create a contact")],
    },
  };
});
const contexts = () => ((globalThis as any).__ctx ?? []) as Record<string, unknown>[];

const usage = { inputTokens: { total: 120, noCache: 120 }, outputTokens: { total: 8, text: 8 } };
const say = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
let calls = 0;
const callTool = (name: string, input: unknown) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `c-${name}-${++calls}`, toolName: name, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const script: unknown[][] = [];
const prompts: string[] = [];
const model = new MockLanguageModelV3({
  doStream: async (options: any) => {
    prompts.push(JSON.stringify(options.prompt));
    const next = script.shift();
    if (!next) {
      throw new Error("The script has no more answers.");
    }
    return { stream: convertArrayToReadableStream(next as never[]) };
  },
});
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  chatModel: async () => ({ model, ref: "test/scripted", vendor: "test", gateway: false, metered: true }),
}));
vi.mock("../src/agents/subscription.js", async (original) => ({
  ...(await original<typeof import("../src/agents/subscription.js")>()),
  chatTurnWay: async () => "openai",
}));

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";

const url = (path: string) => `http://localhost:5181${path}`;
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(`/api/studio/work${path}`), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const json = async (res: Response | Promise<Response>) => {
  const r = await res;
  expect(r.status, await r.clone().text()).toBeLessThan(300);
  return r.json() as Promise<any>;
};
async function chunks(res: Response): Promise<any[]> {
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  return (await res.text())
    .split("\n\n")
    .map((block) => block.replace(/^data: /, "").trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}
const newChat = async () => (await json(send("POST", "/chats", { spaceId }))).id as string;
/** A turn in which the AI calls the tool and then says it waits. */
async function held(id: string, tool: string, input: unknown) {
  script.push(callTool(tool, input), say("Ich warte auf die Freigabe."));
  const seen = await chunks(await send("POST", `/chats/${id}/messages`, { text: "Mach es.", ask: true }));
  const output = seen.find((c) => c.type === "tool-output-available")?.output;
  return output as { approval: string; status: string };
}

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  const loader = await import("../src/plugins/loader");
  await loader.loadPlugins();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await client.withTenant("local", () => spaces.defaultSpace("local"))).id;
}, 60_000);

describe("approvals in a Work chat", () => {
  it("holds a call that reaches past the space, and runs it once when approved", async () => {
    const id = await newChat();
    const output = await held(id, "mailer_send_mail", { to: "huber@example.com", text: "Termin" });
    expect(output).toMatchObject({ status: "waiting", approval: expect.any(String) });
    expect(mails()).toEqual([]);
    const read = await json(send("GET", `/chats/${id}`));
    expect(read.approvals).toEqual([
      expect.objectContaining({ id: output.approval, toolName: "mailer_send_mail", state: "pending", askedBy: "local" }),
    ]);
    expect((await json(send("GET", "/approvals"))).approvals.map((a: any) => a.id)).toContain(output.approval);

    script.push(say("Die Mail ist raus."));
    const goesOn = await chunks(
      await send("POST", `/chats/${id}/approvals/${output.approval}`, { approve: true }),
    );
    expect(goesOn.some((c) => c.type === "text-delta" && c.delta === "Die Mail ist raus.")).toBe(true);
    expect(mails()).toEqual([{ to: "huber@example.com", text: "Termin" }]);
    // It ran as the plugin's own tool: with its tenant, space and the person the turn was for.
    expect(contexts().at(-1)).toEqual({ tenantId: "local", space: spaceId, userId: "local", aborted: false });
    expect(prompts.at(-1)).toContain("approved mailer_send_mail");

    // Twice is once: the second click finds it decided.
    expect((await send("POST", `/chats/${id}/approvals/${output.approval}`, { approve: true })).status).toBe(409);
    expect(mails()).toHaveLength(1);
    const after = await json(send("GET", `/chats/${id}`));
    expect(after.approvals[0]).toMatchObject({ state: "approved", output: { sent: "huber@example.com" } });
    expect((await json(send("GET", "/approvals"))).approvals.map((a: any) => a.id)).not.toContain(output.approval);
  });

  it("doesn't run a denied call, and tells the AI", async () => {
    const id = await newChat();
    const before = mails().length;
    const output = await held(id, "mailer_send_mail", { to: "lang@example.com", text: "Absage" });
    script.push(say("Gut, keine Mail."));
    await chunks(await send("POST", `/chats/${id}/approvals/${output.approval}`, { approve: false }));
    expect(mails()).toHaveLength(before);
    expect(prompts.at(-1)).toContain("denied mailer_send_mail");
    expect((await json(send("GET", `/chats/${id}`))).approvals[0].state).toBe("denied");
  });

  it("runs a tool that changes only the space without asking, and holds an unmarked one", async () => {
    const id = await newChat();
    script.push(callTool("mailer_note", { text: "Rückruf" }), say("Notiert."));
    const seen = await chunks(await send("POST", `/chats/${id}/messages`, { text: "Notier das.", ask: true }));
    expect(seen.find((c) => c.type === "tool-output-available")?.output).toEqual({ noted: "Rückruf" });
    const output = await held(id, "mailer_unmarked", {});
    expect(output.status).toBe("waiting");
  });

  it("doesn't run held arguments that no longer fit the tool", async () => {
    const id = await newChat();
    const client = await import("../src/db/client");
    const { holdCall } = await import("../src/services/work-approvals");
    const held = await client.withTenant("local", () =>
      holdCall({ chatId: id, userId: "local" }, "mailer_send_mail", { to: 42 }),
    );
    const before = mails().length;
    script.push(say("Das ging schief."));
    await chunks(await send("POST", `/chats/${id}/approvals/${held}`, { approve: true }));
    expect(mails()).toHaveLength(before);
    const read = await json(send("GET", `/chats/${id}`));
    expect(read.approvals.find((a: any) => a.id === held)).toMatchObject({ state: "failed" });
    expect(prompts.at(-1)).toContain("but it failed");
  });

  it("leaves no tool call without a result after Stop, for the next turn", async () => {
    const id = await newChat();
    script.push(callTool("mailer_slow", {}));
    const before = prompts.length;
    const turn = send("POST", `/chats/${id}/messages`, { text: "Dauert.", ask: true });
    await vi.waitFor(() => expect((globalThis as any).__slow.open).toBeTypeOf("function"));
    await json(send("POST", `/chats/${id}/stop`));
    (globalThis as any).__slow.open();
    (globalThis as any).__slow.open = null;
    await (await turn).text();
    script.push(say("Weiter."));
    await chunks(await send("POST", `/chats/${id}/messages`, { text: "Und jetzt?", ask: true }));
    expect(prompts.length).toBe(before + 2);
    const prompt = JSON.parse(prompts.at(-1) ?? "[]") as { role: string; content: any[] }[];
    const calls = prompt.flatMap((m) =>
      m.role === "assistant" ? m.content.filter((c) => c.type === "tool-call").map((c) => c.toolCallId) : [],
    );
    const results = prompt.flatMap((m) =>
      m.role === "tool" ? m.content.filter((c) => c.type === "tool-result").map((c) => c.toolCallId) : [],
    );
    // A stopped step is either left out of the thread or kept with its result (Mastra 1.80):
    // never a call without a result. The person's message stays.
    expect(calls.filter((c) => !results.includes(c))).toEqual([]);
    expect(prompts.at(-1)).toContain("Dauert.");
  });
});

describe("a connection of the space in a Work chat (A7)", () => {
  let connection = "";
  const RULES = { read: "allow", write: "ask", destructive: "deny", send: "ask" } as const;

  beforeAll(async () => {
    const client = await import("../src/db/client");
    const service = await import("../src/connectors/space-connections");
    const row = await client.withTenant("local", () =>
      service.createSpaceConnection("local", spaceId, {
        connectorId: "hubspot",
        name: "Vertrieb",
        signIn: "space",
        audience: "members",
        rules: RULES,
        actions: [],
      }),
    );
    connection = row.id;
    await client.withTenant("local", () =>
      service.signInWithCredentials(connection, { as: "space" }, { access_token: "pat-local-1" }),
    );
  });

  it("reads through it at once, as the person in the chat", async () => {
    const id = await newChat();
    script.push(callTool(`hubspot_${connection}_list_contacts`, {}), say("Sieben Kontakte."));
    const seen = await chunks(await send("POST", `/chats/${id}/messages`, { text: "Wie viele Kontakte?", ask: true }));
    const output = seen.find((c) => c.type === "tool-output-available")?.output as { result: string };
    expect(output.result).toContain("contacts");
    expect(hubspot.at(-1)).toMatchObject({ action: "list_contacts", token: expect.stringContaining("pat-local-1") });
    const read = await json(send("GET", `/chats/${id}`));
    expect(read.tools[`hubspot_${connection}_create_contact`]).toEqual({ plugin: "Vertrieb", tool: "Create a contact", label: null });
  });

  it("holds a write as a confirmed action, then again for the admins, and an admin's yes runs it", async () => {
    hubspot.length = 0;
    const id = await newChat();
    const first = await held(id, `hubspot_${connection}_create_contact`, { email: "neu@example.com" });
    expect(first.status).toBe("waiting");
    expect(hubspot).toEqual([]);
    const read = await json(send("GET", `/chats/${id}`));
    expect(read.approvals).toEqual([
      expect.objectContaining({ id: first.approval, heldFor: "asker", state: "pending", input: { email: "neu@example.com" } }),
    ]);

    // The person confirms: the rule says „Mit Freigabe“, so the call waits for the admins.
    script.push(say("Die Admins müssen noch freigeben."));
    await chunks(await send("POST", `/chats/${id}/approvals/${first.approval}`, { approve: true }));
    expect(hubspot).toEqual([]);
    expect(prompts.at(-1)).toContain("waits for them");
    const after = await json(send("GET", `/chats/${id}`));
    const second = after.approvals.find((a: any) => a.id !== first.approval);
    expect(after.approvals.find((a: any) => a.id === first.approval)).toMatchObject({
      state: "approved",
      output: { approval: second.id, status: "waiting" },
    });
    expect(second).toMatchObject({
      toolName: `hubspot_${connection}_create_contact`,
      heldFor: "admins",
      state: "pending",
      askedBy: "local",
      input: { email: "neu@example.com" },
    });
    expect((await json(send("GET", "/approvals"))).approvals.map((a: any) => a.id)).toContain(second.id);

    // The owner approves: it runs once, as the person who asked.
    script.push(say("Angelegt."));
    await chunks(await send("POST", `/chats/${id}/approvals/${second.id}`, { approve: true }));
    expect(hubspot).toEqual([{ action: "create_contact", input: { email: "neu@example.com" }, token: expect.stringContaining("pat-local-1") }]);
    expect(prompts.at(-1)).toContain("ran once");
    const done = await json(send("GET", `/chats/${id}`));
    expect(done.approvals.find((a: any) => a.id === second.id)).toMatchObject({
      state: "approved",
      output: { result: expect.stringContaining("create_contact") },
    });
  });

  it("marks a confirmed action the rule denies as failed, with the reason", async () => {
    hubspot.length = 0;
    const client = await import("../src/db/client");
    const service = await import("../src/connectors/space-connections");
    await client.withTenant("local", () =>
      service.updateSpaceConnection("local", connection, { rules: { ...RULES, write: "deny" } }),
    );
    const id = await newChat();
    const first = await held(id, `hubspot_${connection}_create_contact`, { email: "nein@example.com" });
    script.push(say("Das darf ich hier nicht."));
    await chunks(await send("POST", `/chats/${id}/approvals/${first.approval}`, { approve: true }));
    expect(hubspot).toEqual([]);
    expect(prompts.at(-1)).toContain("but it failed");
    expect((await json(send("GET", `/chats/${id}`))).approvals[0]).toMatchObject({
      state: "failed",
      output: { error: expect.stringContaining("do not allow this action") },
    });
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

export default definePlugin(({ server }) => {
  server.registerAssistantTool({
    name: "send_mail",
    description: "Sends a mail.",
    risk: "outside",
    inputSchema: z.object({ to: z.string(), text: z.string() }),
    execute: async ({ to, text }) => {
      sent.push({ to, text });
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
    name: "unmarked",
    description: "Says nothing of what it does.",
    inputSchema: z.object({}),
    execute: async () => ({ ran: true }),
  });
});
`,
);
const mails = () => ((globalThis as any).__mails ?? []) as { to: string }[];

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
  const projects = await import("../src/services/projects");
  spaceId = (await client.withTenant("local", () => projects.defaultProject("local"))).id;
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
});

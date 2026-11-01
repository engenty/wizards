import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The firm's AI in the client portal (docs/plans/client-portal.md, phase 1): every message a
// client writes asks it, it answers as the client with a client's tools only (the client space's
// Knowledge, the wizards opened to clients, views), and the chat gives its views and the runs it
// started back as cards. A scripted model answers and keeps the tools it was offered.

const dir = mkdtempSync(join(tmpdir(), "wizards-client-ai-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "clientSpaces=on,workMode=on";

const PEOPLE = vi.hoisted(
  () =>
    ({
      "tok-wagner": { userId: "wagner", role: "client", name: "Sabine", email: "w@wagner.at" },
      "tok-berger": { userId: "berger", role: "client", name: "Thomas", email: "b@berger.at" },
    }) as Record<string, { userId: string; role: string; name: string; email: string }>,
);

vi.mock("../src/mcp/auth.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/mcp/auth.js")>();
  return {
    ...real,
    authenticate: async (request: Request) => {
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const person = PEOPLE[token];
      if (!person) {
        return real.authenticate(request);
      }
      const scopes = ["data:read", "elements:read", "elements:run"];
      return {
        token,
        clientId: "wizards-portal",
        scopes,
        extra: { ...person, tenantId: "local", client: "Portal", scopes },
      };
    },
  };
});

const usage = { inputTokens: { total: 120, noCache: 120 }, outputTokens: { total: 8, text: 8 } };
const say = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
const callTool = (id: string, name: string, input: unknown) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const script: unknown[][] = [];
/** The tools each step of the model was offered, by name. */
const offered: string[][] = [];
const model = new MockLanguageModelV3({
  doStream: async (options: any) => {
    offered.push((options.tools ?? []).map((t: { name: string }) => t.name));
    const next = script.shift();
    if (!next) {
      throw new Error("The script has no more answers.");
    }
    return { stream: convertArrayToReadableStream(next as never[]) };
  },
});
// A model that can search the web: a turn of the firm's people gets web search, a client's not.
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  chatModel: async () => ({
    model,
    ref: "anthropic/scripted",
    vendor: "anthropic",
    gateway: false,
    metered: true,
  }),
}));
vi.mock("../src/agents/subscription.js", async (original) => ({
  ...(await original<typeof import("../src/agents/subscription.js")>()),
  chatTurnWay: async () => "anthropic",
}));

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let wagner = "";
let wizardId = "";
let db: typeof import("../src/db/client");

const local = <T>(fn: () => T | Promise<T>) => db.withTenant("local", fn);

const studio = async (method: string, path: string, body?: unknown) => {
  const res = await app.fetch(
    new Request(`http://localhost:5181${path}`, {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return res;
};

async function call(token: string, name: string, space?: string, input: unknown = {}) {
  const path = space ? `/api/v1/client/spaces/${space}/${name}` : `/api/v1/client/${name}`;
  const res = await app.fetch(
    new Request(`http://localhost:5181${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ input }),
    }),
  );
  const body = (await res.json()) as any;
  return { status: res.status, body, result: body.result };
}

/** The chat as the client reads it, once the AI has answered. */
async function answered(token: string, chatId: string) {
  for (let i = 0; i < 100; i++) {
    const { result } = await call(token, "chat_messages", undefined, { chatId });
    if (!result.chat.answering && result.messages.some((m: any) => m.author.kind === "ai")) {
      return result;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("The AI didn't answer.");
}

/** What only the firm's people get: no client's turn is offered any of these. */
const NOT_FOR_CLIENTS = [
  "web_search",
  "run_command",
  "skill_list",
  "skill_load",
  "skill_read",
  "connection_list",
  "connection_call",
];

beforeAll(async () => {
  db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb("local");
  const { createLocalKey } = await import("../src/auth/keys");
  const key = (await createLocalKey("Studio")).key;
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request("http://localhost:5181/api/local/enter?k=test-key"));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
  const res = await app.fetch(
    new Request("http://localhost:5181/api/v1/wizards/import", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        spaceId,
        publish: true,
        definition: {
          version: 1,
          title: "Briefing schreiben",
          description: "Aus deiner Idee wird ein Briefing.",
          avatar: "drop",
          steps: [
            {
              id: "start",
              type: "page",
              title: "Idee",
              fields: [{ id: "what", kind: "textarea", label: "Worum geht es?" }],
            },
            { id: "done", type: "result", title: "Danke", deliverables: [] },
          ],
        },
      }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  const imported = (await res.json()) as any;
  wizardId = imported.wizardId ?? imported.id;
  wagner = (
    (await (
      await studio("POST", `/api/studio/spaces/${spaceId}/clients`, { name: "Wagner GmbH" })
    ).json()) as any
  ).id;
  await studio("PUT", `/api/studio/spaces/${wagner}/members/wagner`, { role: "client" });
  await studio("PUT", `/api/studio/spaces/${spaceId}/open-to-clients`, {
    kind: "wizard",
    id: wizardId,
    open: true,
  });
  const data = await import("../src/services/space-data");
  await local(() =>
    data.createPage("local", wagner, { title: "Markenregeln", markdown: "Kurze Sätze." }),
  );
}, 60_000);

describe("the firm's AI in the client portal", () => {
  it("lists each wizard with its engenty and its steps", async () => {
    const { result } = await call("tok-wagner", "wizards", wagner);
    expect(result).toEqual([
      expect.objectContaining({ id: wizardId, avatar: "drop", steps: 2 }),
    ]);
  });

  it("answers every message, with a client's tools only", async () => {
    script.push(say("Kurze Sätze, sagen die Markenregeln."));
    const before = offered.length;
    const posted = await call("tok-wagner", "chat_post", wagner, { text: "Wie schreiben wir?" });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const read = await answered("tok-wagner", posted.result.chatId);
    expect(read.messages.map((m: any) => [m.author.kind, m.text])).toEqual([
      ["person", "Wie schreiben wir?"],
      ["ai", "Kurze Sätze, sagen die Markenregeln."],
    ]);
    const tools = offered[before];
    expect(tools).toEqual(expect.arrayContaining(["space_search", "wizard_run", "show_view"]));
    for (const name of NOT_FOR_CLIENTS) {
      expect(tools).not.toContain(name);
    }
    expect(
      tools.every((t) =>
        ["space_search", "space_list", "page_read", "table_read", "space_document"]
          .concat(["wizard_list", "wizard_run", "show_view"])
          .includes(t),
      ),
    ).toBe(true);
  });

  it("gives the firm's people their full turn in the same client space", async () => {
    script.push(say("Hallo."));
    const before = offered.length;
    const chat = (await (
      await studio("POST", "/api/studio/work/chats", { spaceId: wagner })
    ).json()) as any;
    const res = await studio("POST", `/api/studio/work/chats/${chat.id}/messages`, {
      text: "Hallo?",
      ask: true,
    });
    await res.text();
    expect(offered[before]).toContain("web_search");
  });

  it("starts a wizard in the client space and shows it and its views as cards, in order", async () => {
    const view = {
      title: "Nächste Schritte",
      data: {},
      components: [
        { id: "root", component: "Column", children: ["note"] },
        { id: "note", component: "Text", text: "Das Briefing ist fertig." },
      ],
    };
    script.push(
      callTool("r1", "wizard_run", { wizardId, answers: { what: "Messestand" }, waitSeconds: 10 }),
      callTool("v1", "show_view", view),
      say("Hier ist dein Briefing."),
    );
    const posted = await call("tok-wagner", "chat_post", wagner, { text: "Briefing Messestand" });
    const read = await answered("tok-wagner", posted.result.chatId);
    const cards = read.messages.flatMap((m: any) => m.parts.filter((p: any) => p.kind !== "text"));
    const run = cards.find((c: any) => c.kind === "run");
    expect(run).toMatchObject({ title: "Briefing schreiben", avatar: "drop", wizardId });
    expect(cards.find((c: any) => c.kind === "view")).toMatchObject({
      title: "Nächste Schritte",
      components: view.components,
    });
    const ai = read.messages.find((m: any) => m.author.kind === "ai");
    expect(ai.parts.map((p: any) => p.kind)).toEqual(["run", "view", "text"]);
    const { eq } = await import("drizzle-orm");
    const row = await local(() =>
      db.db.query.run.findFirst({ where: eq(db.schema.run.id, run.runId) }),
    );
    expect(row).toMatchObject({ clientSpaceId: wagner, userId: "wagner" });
    expect((await call("tok-wagner", "run_open", undefined, { runId: run.runId })).status).toBe(
      200,
    );
    // Another client finds neither the chat nor the run.
    const other = await call("tok-berger", "chat_messages", undefined, {
      chatId: posted.result.chatId,
    });
    expect(other.status).toBe(404);
    expect((await call("tok-berger", "run_open", undefined, { runId: run.runId })).status).toBe(
      404,
    );
  });
});

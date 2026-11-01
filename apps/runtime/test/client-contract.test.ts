import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The client contract (docs/plans/client-portal.md): a client of the organization reaches their
// own client spaces through `/api/v1/client`, as the token says and never as the call says. A
// client sees nothing of another client, nothing of the firm's setup, the firm's Knowledge and
// wizards only where opened to clients, and a run the firm makes only once it is shared.

const dir = mkdtempSync(join(tmpdir(), "wizards-client-contract-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "clientSpaces=on";

// Tokens of the Manage-App, as the portal would hold them: two clients and a member of the firm.
const PEOPLE = vi.hoisted(
  () =>
    ({
      "tok-wagner": { userId: "wagner", role: "client", name: "Wagner", email: "w@wagner.at" },
      "tok-berger": { userId: "berger", role: "client", name: "Berger", email: "b@berger.at" },
      "tok-anna": { userId: "anna", role: "member", name: "Anna", email: "anna@firma.at" },
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

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let key = "";
let spaceId = "";
let wagner = "";
let berger = "";
const wizards: Record<string, string> = {};
const pages: Record<string, string> = {};
const files_: { id?: string } = {};
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
  return res.json() as Promise<any>;
};

const api = (token: string, method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://localhost:5181${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

/** One call of the contract: its result, or the status it was refused with. */
async function call(token: string, name: string, space?: string, input: unknown = {}) {
  const path = space ? `/api/v1/client/spaces/${space}/${name}` : `/api/v1/client/${name}`;
  const res = await api(token, "POST", path, { input });
  const body = (await res.json()) as any;
  return { status: res.status, body, result: body.result };
}

beforeAll(async () => {
  db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb("local");
  const { createLocalKey } = await import("../src/auth/keys");
  key = (await createLocalKey("Studio")).key;
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request("http://localhost:5181/api/local/enter?k=test-key"));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
  const data = await import("../src/services/space-data");
  for (const [k, title, markdown] of [
    ["internal", "Honorare", "Unser Stundensatz für Wagner ist 180 Euro."],
    ["open", "Ablauf", "So läuft eine Beratung bei uns ab: drei Termine."],
  ]) {
    pages[k] = (await local(() => data.createPage("local", spaceId, { title, markdown }))).id;
  }
  for (const [k, title] of [
    ["open", "Angebotsanfrage"],
    ["internal", "Interne Kalkulation"],
  ]) {
    const res = await api(key, "POST", "/api/v1/wizards/import", {
      spaceId,
      publish: true,
      definition: {
        version: 1,
        title,
        description: "Fragt, was gebraucht wird.",
        avatar: "round",
        steps: [
          {
            id: "start",
            type: "page",
            title: "Anfrage",
            fields: [{ id: "what", kind: "textarea", label: "Worum geht es?" }],
          },
          { id: "done", type: "result", title: "Danke", deliverables: [] },
        ],
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    wizards[k] = ((await res.json()) as any).wizardId ?? ((await res.json()) as any).id;
  }
  wagner = (await studio("POST", `/api/studio/spaces/${spaceId}/clients`, { name: "Wagner GmbH" })).id;
  berger = (await studio("POST", `/api/studio/spaces/${spaceId}/clients`, { name: "Berger & Söhne" })).id;
  await studio("PUT", `/api/studio/spaces/${wagner}/members/wagner`, { role: "client" });
  await studio("PUT", `/api/studio/spaces/${berger}/members/berger`, { role: "client" });
  await studio("PUT", `/api/studio/spaces/${spaceId}/open-to-clients`, { kind: "page", id: pages.open, open: true });
  await studio("PUT", `/api/studio/spaces/${spaceId}/open-to-clients`, { kind: "wizard", id: wizards.open, open: true });
  await local(() => data.createPage("local", wagner, { title: "Unterlagen Wagner", markdown: "Vertrag liegt bei." }));
}, 60_000);

describe("the client contract", () => {
  it("lists its calls with their inputs as JSON Schema", async () => {
    const res = await app.fetch(new Request("http://localhost:5181/api/v1/client"));
    const { calls } = (await res.json()) as any;
    const names = calls.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(["me", "spaces", "for_you", "wizard_start", "chat_post", "files"]));
    const start = calls.find((c: any) => c.name === "wizard_start");
    expect(start).toMatchObject({ scope: "elements:run", path: "/api/v1/client/spaces/{spaceId}/wizard_start" });
    expect(start.input.properties.wizardId).toBeTruthy();
  });

  it("is for clients only: the firm's people and keys are turned away", async () => {
    expect((await call("tok-anna", "spaces")).body.code).toBe("clients_only");
    expect((await call(key, "spaces")).status).toBe(403);
  });

  it("gives a client their own client spaces with the firm's brand, and no address made of a name", async () => {
    const { result } = await call("tok-wagner", "spaces");
    expect(result).toEqual([
      expect.objectContaining({ id: wagner, name: "Wagner GmbH", firm: expect.objectContaining({ brand: expect.any(Object) }) }),
    ]);
    expect(result[0].slug).toBeUndefined();
    expect((await call("tok-berger", "spaces")).result.map((s: any) => s.id)).toEqual([berger]);
    expect((await call("tok-wagner", "me")).result.person).toMatchObject({ id: "wagner" });
  });

  it("refuses another client's space and the firm's space (I2)", async () => {
    for (const space of [berger, spaceId, "nowhere"]) {
      expect((await call("tok-wagner", "for_you", space)).status).toBe(404);
      expect((await call("tok-wagner", "files", space)).status).toBe(404);
    }
  });

  it("offers only the wizards opened to clients", async () => {
    const { result } = await call("tok-wagner", "wizards", wagner);
    expect(result.map((w: any) => w.title)).toEqual(["Angebotsanfrage"]);
    expect((await call("tok-wagner", "wizard_start", wagner, { wizardId: wizards.internal })).status).toBe(403);
  });

  it("starts a wizard into the client space: the run is the client space's, its ticket opens it", async () => {
    const started = await call("tok-wagner", "wizard_start", wagner, { wizardId: wizards.open });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const { runId, ticket } = started.result;
    const { eq } = await import("drizzle-orm");
    const run = await local(() => db.db.query.run.findFirst({ where: eq(db.schema.run.id, runId) }));
    expect(run).toMatchObject({ clientSpaceId: wagner, userId: "wagner", expiresAt: null });
    // Its data is the client space's, its setup the parent's.
    const runner = await import("../src/engine/runner");
    const ctx = await local(async () =>
      runner.makeContext(run as any, await runner.loadSpace(run as any), run!.state, new AbortController().signal),
    );
    expect(ctx.dataSpace.id).toBe(wagner);
    expect(ctx.space.id).toBe(spaceId);
    // Waiting on its first page, it is the client's to do.
    expect((await call("tok-wagner", "for_you", wagner)).result.waiting.map((r: any) => r.runId)).toEqual([runId]);
    const view = await app.fetch(new Request(`http://localhost:5181/api/runs/${runId}?rt=${ticket}`));
    expect(view.status).toBe(200);
    // Another client neither sees it nor opens it.
    expect((await call("tok-wagner", "run_open", undefined, { runId })).result).toMatchObject({ runId, spaceId: wagner });
    expect((await call("tok-berger", "run_open", undefined, { runId })).status).toBe(404);
    expect((await call("tok-berger", "for_you", berger)).result.waiting).toEqual([]);
  });

  it("keeps the firm's run in a client space internal until it is shared on purpose", async () => {
    const runs = await import("../src/services/runs");
    const { runId } = await local(() => runs.startRun("local", wizards.internal, {}, { clientSpaceId: wagner }));
    const { eq } = await import("drizzle-orm");
    await local(() => db.db.update(db.schema.run).set({ status: "done" }).where(eq(db.schema.run.id, runId)));
    expect((await call("tok-wagner", "results", wagner)).result).toEqual([]);
    expect((await call("tok-wagner", "run_open", undefined, { runId })).status).toBe(404);
    // The firm's results of the client space show it, the parent's do not.
    const inClient = await studio("GET", `/api/studio/spaces/${wagner}/results`);
    expect(inClient.runs).toEqual([expect.objectContaining({ id: runId, clientShared: false })]);
    expect((await studio("GET", `/api/studio/spaces/${spaceId}/results`)).runs).toEqual([]);
    await studio("PUT", `/api/studio/runs/${runId}/client-share`, { shared: true });
    const { result } = await call("tok-wagner", "results", wagner);
    expect(result).toEqual([expect.objectContaining({ runId, mine: false, title: "Interne Kalkulation" })]);
    expect((await call("tok-wagner", "for_you", wagner)).result.shared.map((r: any) => r.runId)).toEqual([runId]);
    expect((await call("tok-wagner", "run_open", undefined, { runId })).status).toBe(200);
    expect((await call("tok-berger", "results", berger)).result).toEqual([]);
  });

  it("reads the firm's Knowledge only where it is opened to clients", async () => {
    const read = (token: string, path: string) =>
      api(token, "POST", `/api/v1/spaces/${wagner}/elements/page_read`, { input: { path } });
    expect(((await (await read("tok-wagner", "pages/unterlagen-wagner")).json()) as any).result.page).toContain("Vertrag");
    expect(((await (await read("tok-wagner", "pages/ablauf")).json()) as any).result.page).toContain("drei Termine");
    const internal = await read("tok-wagner", "pages/honorare");
    expect(internal.status).toBe(403);
    expect(await internal.text()).not.toContain("180");
    expect((await read("tok-berger", "pages/unterlagen-wagner")).status).not.toBe(200);
  });

  it("keeps shared lists apart per client space", async () => {
    const { sharedTable } = await import("../src/store/shared-lists");
    const def = { id: "anfragen", title: "Anfragen", columns: [{ id: "name", name: "Name", type: "text" as const }], shared: true };
    const [mine, theirs, firm] = await local(() =>
      Promise.all([
        sharedTable({ wizardId: wizards.open, holder: "u:wagner", clientSpaceId: wagner }, def),
        sharedTable({ wizardId: wizards.open, holder: "u:berger", clientSpaceId: berger }, def),
        sharedTable({ wizardId: wizards.open, holder: "u:local" }, def),
      ]),
    );
    expect([mine.spaceId, theirs.spaceId, firm.spaceId]).toEqual([wagner, berger, spaceId]);
  });

  it("chats with the firm: a client sees their own chats, never the firm's internal ones", async () => {
    const posted = await call("tok-wagner", "chat_post", wagner, { text: "Wann ist der nächste Termin?" });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const { chatId } = posted.result;
    const work = await import("../src/services/work-chats");
    const owner = { id: "local", tenantId: "local", role: "owner" as const, name: "Anna", email: "" };
    await local(() => work.createChat(owner, { spaceId: wagner, title: "Intern: Honorar" }));
    const chats = (await call("tok-wagner", "chats", wagner)).result;
    expect(chats.map((c: any) => c.id)).toEqual([chatId]);
    const read = (await call("tok-wagner", "chat_messages", undefined, { chatId })).result;
    expect(read.spaceId).toBe(wagner);
    expect(read.messages).toEqual([expect.objectContaining({ text: "Wann ist der nächste Termin?", author: expect.objectContaining({ me: true }) })]);
    expect((await call("tok-berger", "chat_messages", undefined, { chatId })).status).toBe(404);
    expect((await call("tok-berger", "chats", berger)).result).toEqual([]);
  });

  it("hands out the client space's files, to that client only", async () => {
    const files = await import("../src/services/space-files");
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    const row = await local(() => files.addSpaceFile(wagner, { kind: "asset", name: "plan.png", mime: "image/png", data: png }));
    const listed = (await call("tok-wagner", "files", wagner)).result;
    expect(listed.map((f: any) => f.name)).toContain("plan.png");
    const got = await api("tok-wagner", "GET", `/api/v1/client/files/${row.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect((await api("tok-berger", "GET", `/api/v1/client/files/${row.id}`)).status).toBe(404);
    expect((await call("tok-wagner", "file", undefined, { fileId: row.id })).result).toMatchObject({ spaceId: wagner, file: { name: "plan.png" } });
    files_.id = row.id;
    expect((await call("tok-berger", "files", berger)).result).toEqual([]);
  });

  it("answers a foreign item exactly as a missing one: the same status and body", async () => {
    const { eq } = await import("drizzle-orm");
    const runs = await local(() => db.db.query.run.findMany({ where: eq(db.schema.run.clientSpaceId, wagner) }));
    const chats = await local(() => db.db.query.chat.findMany({ where: eq(db.schema.chat.spaceId, wagner) }));
    const pairs: [string, string | undefined, Record<string, string>, Record<string, string>][] = [
      ["for_you", wagner, {}, {}],
      ["files", wagner, {}, {}],
      ["run_open", undefined, { runId: runs[0].id }, { runId: "nothing-here-1" }],
      ["chat_messages", undefined, { chatId: chats[0].id }, { chatId: "nothing-here-2" }],
      ["file", undefined, { fileId: files_.id ?? "" }, { fileId: "nothing-here-3" }],
    ];
    for (const [name, space, foreign, missing] of pairs) {
      const a = await call("tok-berger", name, space, foreign);
      const b = await call("tok-berger", name, space ? "nothing-here-0" : undefined, missing);
      expect([name, a.status]).toEqual([name, 404]);
      expect(a.body).toEqual(b.body);
    }
    const a = await api("tok-berger", "GET", `/api/v1/client/files/${files_.id}`);
    const b = await api("tok-berger", "GET", "/api/v1/client/files/nothing-here-4");
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
  });

  it("keeps `portal` out of a public space's addresses", async () => {
    const res = await app.fetch(
      new Request(`http://localhost:5181/api/studio/spaces/${spaceId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
        body: JSON.stringify({ page: { on: false, slug: "portal", title: "Kanzlei", lang: "de", wizards: [], examples: {} } }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("client portal");
  });
});

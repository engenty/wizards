import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * What a member learns of a space whose Studio is closed to them without asking for it
 * (docs/plans/capabilities.md, "Who sees the place"): nothing of its Studio. The live stream
 * names no change of it, the sync lists and names no such space, and a turn of Goose there has
 * no space. An owner and a member of one organization, a space open to members and one closed.
 */

// HubSpot without HubSpot: a key that needs no check, one read.
vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
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
      actions: [
        {
          id: "list_contacts",
          group: "read",
          summary: "List contacts",
          description: "List contacts",
          inputSchema: z.object({}),
          handler: async () => ({ contacts: [] }),
        },
      ],
    },
  };
});

/** What a turn of Goose gave its model: the instructions, the tools, the messages. */
interface Turn {
  instructions: string;
  tools: Record<string, { execute?: (input: unknown, context?: unknown) => Promise<unknown> }>;
  messages: { role: string; content: string }[];
  /** What the tools that read without a question answered within the turn, as text. */
  answers: Record<string, string>;
}
const turns: Turn[] = [];
const ASKED = ["wizards", "runs", "usage", "authoring_guide"];

// Goose without a model: the agent keeps what it was given, calls the tools that read without a
// question as the model would (inside the turn, as its person), and says nothing.
vi.mock("../src/agents/space-agent", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/agents/space-agent")>();
  return {
    ...mod,
    spaceAgent: (options: { instructions: string; tools: Turn["tools"] }) => ({
      stream: async (messages: Turn["messages"]) => {
        const answers: Turn["answers"] = {};
        for (const name of ASKED) {
          answers[name] = JSON.stringify(await options.tools[name]?.execute?.({}, {}));
        }
        turns.push({ instructions: options.instructions, tools: options.tools, messages, answers });
        return { fullStream: (async function* () {})(), totalUsage: Promise.resolve(undefined) };
      },
    }),
  };
});

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

const RUNTIME = "http://localhost:5181";
const SERVICE_KEY = "wzr_test_service_key";
const TENANT = "tenant-c";
let issuer = "";
/** The runs the Manage-App booked this month, for Goose's `usage`. */
let booked: { runId: string; credits: number }[] = [];

function token(claims: Record<string, unknown>, aud: string) {
  return new SignJWT({ scope: "openid wizards:read wizards:write wizards:publish runs:test", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setExpirationTime("10m")
    .sign(privateKey);
}

// A stand-in Manage-App: sign-in, and the organization with an owner (o) and a member (m).
const manage: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", issuer);
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  if (url.pathname === "/.well-known/openid-configuration") {
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    });
  }
  if (url.pathname === "/jwks") {
    return json({ keys: [jwk] });
  }
  if (url.pathname === "/token") {
    const who = new URLSearchParams(raw).get("code") === "code-m" ? "m" : "o";
    return json({
      access_token: await token(
        {
          sub: `user-${who}`,
          tenant: TENANT,
          role: who === "m" ? "member" : "owner",
          name: `User ${who.toUpperCase()}`,
          email: `${who}@test.local`,
          azp: "wizards-runtime-test",
        },
        new URLSearchParams(raw).get("resource") ?? RUNTIME,
      ),
      refresh_token: `refresh-${who}`,
      expires_in: 600,
    });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  if (url.pathname === `/v1/tenants/${TENANT}/members`) {
    return json({
      members: [
        { userId: "user-o", name: "User O", email: "o@test.local", image: null, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" },
        { userId: "user-m", name: "User M", email: "m@test.local", image: null, role: "member", joinedAt: "2026-10-02T00:00:00.000Z" },
      ],
      invitations: [],
      seats: { limit: 5, taken: 2 },
    });
  }
  if (url.pathname === `/v1/tenants/${TENANT}/usage`) {
    return json({ months: [{ month: "2026-11", credits: 12, runs: booked }] });
  }
  if (url.pathname === `/v1/tenants/${TENANT}`) {
    return json({
      id: TENANT,
      name: TENANT,
      status: "active",
      balanceCredits: 500,
      plan: { id: "team", name: "Team" },
      limits: { concurrentRuns: 2, projects: null, members: 5 },
      features: {},
      db: null,
    });
  }
  if (url.pathname === "/v1/grants/check") {
    return json({ active: true });
  }
  if (/^\/v1\/users\/[^/]+$/.test(url.pathname)) {
    return json({ id: url.pathname.split("/").pop(), features: {}, admin: false, tenants: [] });
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-members-studio-closed-"));
process.env.APP_URL = RUNTIME;
process.env.MANAGE_URL = issuer;
process.env.GATEWAY_URL = issuer;
process.env.MANAGE_CLIENT_ID = "wizards-runtime-test";
process.env.MANAGE_CLIENT_SECRET = "secret";
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;
process.env.PLUGINS_WATCH = "0";
process.env.FEATURES = ["capabilities", "broker", "liveChanges", "skills"].map((name) => `${name}=on`).join(",");

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

async function signIn(code: string): Promise<string> {
  const login = await app.fetch(new Request(`${RUNTIME}/api/auth/login?return=%2Fstudio`));
  const authorize = new URL(login.headers.get("location") ?? "");
  const callback = await app.fetch(
    new Request(`${RUNTIME}/api/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`, {
      headers: { cookie: cookieOf(login, "wz_oauth") },
    }),
  );
  return cookieOf(callback, "wz_session");
}

const send = (method: string, path: string, cookie: string, body?: unknown) =>
  app.fetch(
    new Request(`${RUNTIME}${path}`, {
      method,
      headers: { cookie, "content-type": "application/json", "accept-language": "en" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const get = (path: string, cookie: string) => send("GET", path, cookie);
/** A write of the owner's that must work, and its answer. */
async function made<T = { id: string }>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, owner, body);
  expect(res.status, `${method} ${path}`).toBe(200);
  return (await res.json()) as T;
}

/** An access token of the Manage-App for an AI app or an install, as the owner (o) or the member (m). */
const bearer = async (who: "o" | "m") =>
  `Bearer ${await token(
    { sub: `user-${who}`, tenant: TENANT, role: who === "m" ? "member" : "owner", azp: "claude-code" },
    `${RUNTIME}/api/mcp`,
  )}`;
const v1 = async (who: "o" | "m", path: string, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`${RUNTIME}/api/v1${path}`, {
      headers: { authorization: await bearer(who), "accept-language": "en", ...headers },
    }),
  );

/** An open stream (SSE): what it sent so far, and its `changes` events. */
function listen(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      text += decoder.decode(value, { stream: true });
    }
  })().catch(() => undefined);
  const changes = <T>() =>
    text
      .split("\n\n")
      .slice(0, -1)
      .filter((block) => block.includes("event: changes"))
      .map((block) => JSON.parse((block.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6)) as T);
  return {
    text: () => text,
    changes,
    until: async (met: () => boolean, ms = 10_000) => {
      const end = Date.now() + ms;
      while (!met() && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(met()).toBe(true);
    },
    close: () => reader.cancel(),
  };
}

let owner = "";
let member = "";
let open = "";
let closed = "";
let openWizard = "";
let closedWizard = "";

const inTenant = async <T>(role: "owner" | "member", fn: () => Promise<T>): Promise<T> => {
  const { withTenant } = await import("../src/db/client");
  const { asRole } = await import("../src/services/access");
  return withTenant(TENANT, () => asRole(role, fn));
};

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  app = (await import("../src/app")).default;
  owner = await signIn("code-o");
  member = await signIn("code-m");
  // The first space is made on the first look and opened to members; the second stays closed.
  [{ id: open }] = (await (await get("/api/studio/spaces", owner)).json()) as { id: string }[];
  await made("PATCH", `/api/studio/spaces/${open}`, { name: "Marketing", membersStudio: true });
  ({ id: closed } = await made("POST", "/api/studio/spaces", { name: "Geschäftsführung" }));
  ({ id: openWizard } = await made("POST", "/api/studio/wizards", { spaceId: open }));
  ({ id: closedWizard } = await made("POST", "/api/studio/wizards", { spaceId: closed }));
}, 60_000);

afterAll(() => {
  manage.close();
  delete process.env.FEATURES;
});

describe("the live stream", () => {
  type Change = { kind: string; op: string; item: string; spaceId: string | null; view?: unknown };
  const heardBy = (stream: ReturnType<typeof listen>) => stream.changes<{ items: Change[] }>().flatMap((e) => e.items);

  it("names nothing of the Studio of a closed space to a member; what Work reads stays", async () => {
    const theirs = listen(await get("/api/studio/live", member));
    const admins = listen(await get("/api/studio/live", owner));
    await theirs.until(() => theirs.text().includes("event: hello"));
    await admins.until(() => admins.text().includes("event: hello"));

    // The owner works in the closed space's Studio: every kind it alone shows.
    const table = await made("POST", `/api/studio/spaces/${closed}/tables`, { title: "Gehälter" });
    const row = await made("POST", `/api/studio/tables/${table.id}/rows`, { cells: {} });
    const page = await made("POST", `/api/studio/spaces/${closed}/pages`, { title: "Strategie 2027" });
    const category = await made("POST", `/api/studio/spaces/${closed}/categories`, { name: "Standort", type: "choice" });
    const skill = await made("POST", `/api/studio/spaces/${closed}/skills`, { name: "abschluss", description: "Den Jahresabschluss lesen" });
    const wizard = await made("POST", "/api/studio/wizards", { spaceId: closed });
    await made("PUT", "/api/studio/presence", { kind: "wizard", item: closedWizard, tab: "t1", state: "editing" });
    // The same in the open space, and there last: once it is heard, the rest was on its way before.
    const theirTable = await made("POST", `/api/studio/spaces/${open}/tables`, { title: "Leads" });
    await made("PUT", "/api/studio/presence", { kind: "wizard", item: openWizard, tab: "t1", state: "editing" });
    // What goes with its owner: the rows of a table, a wizard's files and build chat.
    await made("DELETE", `/api/studio/tables/${table.id}`);
    await made("DELETE", `/api/studio/wizards/${wizard.id}`);
    // What Work reads in every space: the space itself.
    await made("PATCH", `/api/studio/spaces/${closed}`, { name: "Geschäftsleitung" });
    const last = await made("POST", `/api/studio/spaces/${open}/pages`, { title: "Kampagne" });

    await admins.until(() => heardBy(admins).some((x) => x.item === last.id));
    await theirs.until(() => heardBy(theirs).some((x) => x.item === last.id));
    await theirs.close();
    await admins.close();

    // The owner heard all of it, so there was something to hear.
    const studio = [table.id, row.id, page.id, category.id, skill.id, wizard.id, `wizard:${closedWizard}`];
    const all = heardBy(admins);
    for (const id of [...studio, closed]) {
      expect(all.some((x) => x.item === id), id).toBe(true);
    }
    expect(new Set(all.filter((x) => studio.includes(x.item)).map((x) => x.kind))).toEqual(
      new Set(["table", "row", "page", "category", "skill", "wizard", "presence"]),
    );
    expect(all.some((x) => x.item === table.id && x.op === "del")).toBe(true);

    // The member: of the closed space only that the space itself changed.
    const mine = heardBy(theirs);
    expect(mine.filter((x) => x.spaceId === closed).map((x) => `${x.kind} ${x.item}`)).toEqual([`space ${closed}`]);
    expect(mine.find((x) => x.kind === "space" && x.item === closed)?.view).toMatchObject({ studio: false });
    for (const id of [table.id, row.id, page.id, category.id, skill.id, wizard.id, closedWizard]) {
      expect(theirs.text(), id).not.toContain(id);
    }
    // Nothing without a space either: what went with a deleted table or wizard names no one's.
    expect(mine.filter((x) => !x.spaceId && x.kind !== "presence")).toEqual([]);
    // The open space's Studio is theirs, with the views.
    expect(mine.find((x) => x.item === theirTable.id)?.view).toMatchObject({ id: theirTable.id });
    expect(mine.find((x) => x.item === `wizard:${openWizard}`)?.view).toEqual([
      expect.objectContaining({ who: "user-o", state: "editing" }),
    ]);
  }, 40_000);

  it("refuses a member who is in a closed space's item, asked for through the studio API", async () => {
    const refused = await get(`/api/studio/presence/wizard/${closedWizard}`, member);
    expect(refused.status).toBe(403);
    expect((await get(`/api/studio/presence/wizard/${openWizard}`, member)).status).toBe(200);
    expect(Object.keys((await (await get("/api/studio/presence/wizard", member)).json()) as object)).toEqual([openWizard]);
    expect(Object.keys((await (await get("/api/studio/presence/wizard", owner)).json()) as object).sort()).toEqual(
      [openWizard, closedWizard].sort(),
    );
  });
});

describe("the sync's listing", () => {
  type Overview = { role: string; spaces: { id: string }[] };

  it("GET /sync lists a member's install the spaces open to members; an admin's every space", async () => {
    const theirs = (await (await v1("m", "/sync")).json()) as Overview;
    expect(theirs.role).toBe("member");
    expect(theirs.spaces.map((s) => s.id)).toEqual([open]);
    const admins = (await (await v1("o", "/sync")).json()) as Overview;
    // The admin's own Mein Space comes with the organization's spaces; the member's does not.
    const listed = (await (await get("/api/studio/spaces", owner)).json()) as { id: string; personal?: boolean }[];
    const mine = listed.find((s) => s.personal)?.id;
    expect(admins.spaces.map((s) => s.id).filter((id) => id !== mine)).toEqual([open, closed]);
    expect(admins.spaces).toHaveLength(mine ? 3 : 2);
    // Someone else's Mein Space refuses the pull, an admin's too.
    const theirOwn = ((await (await get("/api/studio/spaces", member)).json()) as { id: string; personal?: boolean }[]).find(
      (s) => s.personal,
    )?.id;
    expect(theirOwn).toBeDefined();
    const again = (await (await v1("o", "/sync")).json()) as Overview;
    expect(again.spaces.map((s) => s.id)).not.toContain(theirOwn);
    expect((await v1("o", `/sync/spaces/${theirOwn}/changes`)).status).toBe(404);
    // What the listing left out refuses the pull, as before.
    expect((await v1("m", `/sync/spaces/${closed}/changes`)).status).toBe(403);
    expect((await v1("o", `/sync/spaces/${closed}/changes`)).status).toBe(200);
  });

  it("GET /sync/live names a member's install no closed space; an admin's install hears it", async () => {
    type Named = { spaces: string[] };
    const theirs = listen(await v1("m", "/sync/live", { "x-wizards-install": "install-m" }));
    const admins = listen(await v1("o", "/sync/live", { "x-wizards-install": "install-o" }));
    await theirs.until(() => theirs.text().includes("event: hello"));
    await admins.until(() => admins.text().includes("event: hello"));
    await made("POST", `/api/studio/spaces/${closed}/pages`, { title: "Budget" });
    await made("PATCH", `/api/studio/spaces/${closed}`, { name: "Geschäftsführung" });
    await made("POST", `/api/studio/spaces/${open}/pages`, { title: "Newsletter" });
    const named = (stream: ReturnType<typeof listen>) => stream.changes<Named>().flatMap((e) => e.spaces);
    await admins.until(() => named(admins).includes(open));
    await theirs.until(() => named(theirs).includes(open));
    await theirs.close();
    await admins.close();
    expect(named(admins)).toContain(closed);
    expect(theirs.text()).not.toContain(closed);
  }, 30_000);
});

describe("a turn of Goose", () => {
  /** One turn (`POST /assistant/turn`) to its end; what the model was given. */
  async function turn(cookie: string, spaceId: string): Promise<Turn> {
    const before = turns.length;
    const res = await send("POST", "/api/studio/assistant/turn", cookie, {
      message: "Was weißt du über diesen Space?",
      spaceId,
      page: { route: "/space/knowledge", title: "Space / Knowledge" },
      tools: [],
      lang: "en",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text, text).toContain("event: done");
    expect(turns.length).toBe(before + 1);
    return turns[before];
  }
  const said = (t: Turn) => [t.instructions, ...t.messages.map((m) => m.content)].join("\n");

  /** Tools that are there with a space and never without one: its Knowledge, its skills. */
  const SPACE_TOOLS = ["space_search", "space_list", "page_read", "skill_list", "skill_load", "skill_read"];
  const connections: string[] = [];

  beforeAll(async () => {
    // Both spaces hold the same: a profile, Knowledge, a skill, a sign-in of the member's.
    for (const [spaceId, word] of [
      [open, "Aprikose"],
      [closed, "Zwetschke"],
    ]) {
      await made("PATCH", `/api/studio/spaces/${spaceId}`, {
        brand: { name: `${word} GmbH`, about: `Über ${word}.` },
        facts: [{ key: "umsatz", label: "Umsatz", value: `${word} 4,2 Mio.` }],
      });
      await made("POST", `/api/studio/spaces/${spaceId}/pages`, { title: `${word}-Plan`, markdown: `${word} geheim.` });
      await made("POST", `/api/studio/spaces/${spaceId}/skills`, {
        name: `${word.toLowerCase()}-skill`,
        description: `${word} prüfen`,
      });
      const service = await import("../src/connectors/space-connections");
      const row = await inTenant("owner", () =>
        service.createSpaceConnection("user-o", spaceId, {
          connectorId: "hubspot",
          name: `${word} HubSpot`,
          signIn: "person",
          audience: "members",
          rules: { read: "allow", write: "ask", destructive: "deny", send: "ask" },
          actions: [],
        }),
      );
      await inTenant("member", () =>
        service.signInWithCredentials(row.id, { as: "person", userId: "user-m", role: "member" }, { access_token: "pat-m" }),
      );
      connections.push(row.id);
    }
    // A run of each space's wizard, booked by the Manage-App.
    const { db, schema } = await import("../src/db/client");
    await inTenant("owner", async () => {
      for (const [wizardId, title] of [
        [openWizard, "Aprikose-Wizard"],
        [closedWizard, "Zwetschke-Wizard"],
      ]) {
        const { eq } = await import("drizzle-orm");
        await db.update(schema.wizard).set({ title }).where(eq(schema.wizard.id, wizardId));
        const wizard = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, wizardId) });
        await db.insert(schema.run).values({
          id: `run-${wizardId}`,
          wizardId,
          tenantId: TENANT,
          definition: wizard?.draft as never,
          mode: "live",
          status: "done",
          cursor: null,
          state: { values: {} } as never,
        });
      }
    });
    booked = [
      { runId: `run-${openWizard}`, credits: 5 },
      { runId: `run-${closedWizard}`, credits: 7 },
    ];
  }, 60_000);

  it("has the space where its Studio is open to the member", async () => {
    const t = await turn(member, open);
    expect(Object.keys(t.tools)).toEqual(expect.arrayContaining(SPACE_TOOLS));
    expect(Object.keys(t.tools).some((name) => name.includes(connections[0]))).toBe(true);
    expect(said(t)).toContain("aprikose-skill");
    expect(t.answers.wizards).toContain("Aprikose-Wizard");
  });

  it("has no space where its Studio is closed to the member: no Wissen, skills, tools or sign-ins of it", async () => {
    const t = await turn(member, closed);
    const names = Object.keys(t.tools);
    // No tool of a space, of its plugins, of its connections.
    for (const name of SPACE_TOOLS) {
      expect(names, name).not.toContain(name);
    }
    expect(names.some((name) => name.includes(connections[1]))).toBe(false);
    expect(names.some((name) => /^(set_|add_|update_|write_|propose_|take_|list_sources)/.test(name))).toBe(false);
    // The member's sign-in in the open space is theirs wherever they are.
    expect(names.some((name) => name.includes(connections[0]))).toBe(true);
    // Nothing of the space in what the model reads: not its name, profile, skills or Knowledge.
    const text = said(t);
    expect(text).toContain("No space is open.");
    for (const word of ["Zwetschke", "zwetschke", "Geschäftsführung", closed]) {
      expect(text, word).not.toContain(word);
    }
    for (const tool of Object.values(t.tools)) {
      expect(JSON.stringify(tool), "a tool's description").not.toMatch(/zwetschke/i);
    }
    // What its tools answer: no wizards or runs of the space, no connection of it in the guide.
    expect(t.answers.wizards).toContain("No space is open.");
    expect(t.answers.runs).toContain("No space is open.");
    expect(t.answers.authoring_guide).not.toMatch(/zwetschke/i);
    // The organization's use: the closed space's wizards under one line without their names.
    expect(t.answers.usage).toContain("Aprikose-Wizard");
    expect(t.answers.usage).not.toContain("Zwetschke");
    expect(t.answers.usage).toContain("closed to you");
  });

  it("has the closed space for its admins", async () => {
    const t = await turn(owner, closed);
    expect(Object.keys(t.tools)).toEqual(expect.arrayContaining([...SPACE_TOOLS, "set_profile"]));
    expect(said(t)).toContain("Zwetschke GmbH");
    expect(t.answers.usage).toContain("Zwetschke-Wizard");
  });
});

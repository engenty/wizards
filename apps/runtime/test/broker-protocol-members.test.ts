import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Fähigkeiten › Protokoll for a member (docs/plans/capabilities.md, "Decided on 2026-11-05"): a
 * member reads their own lines, the admins all. Their own: what they called (an AI step of their
 * run calls as them), what Goose called for them, and the fixed steps of a run held for them.
 * What they called as an admin, before they were a member, is an admin's line. The query narrows to
 * them, so a page, a cursor, a filter and a search count no one else's; another person's line
 * is a line that is not there. „Was darf …?“ stays the admins', and a space whose Studio is
 * closed to members stays closed. HubSpot is played by a stub.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-broker-protocol-members-"));
process.env.APP_URL = "http://localhost:5181";

vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const action = (id: string, group: "read" | "write", summary: string) => ({
    id,
    group,
    summary,
    description: summary,
    inputSchema: z.object({ email: z.string().optional() }),
    handler: async () => ({ done: id }),
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
      actions: [
        action("list_contacts", "read", "List contacts"),
        action("create_contact", "write", "Create a contact"),
      ],
    },
  };
});

vi.mock("../src/manage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async () => ({ limits: { build: true, projects: null } }),
  tenantMembers: async () => ({
    members: [
      { userId: "user-a", role: "owner", email: "a@firma.at", name: "Anna" },
      { userId: "user-j", role: "member", email: "j@firma.at", name: "Julia" },
      { userId: "user-m", role: "member", email: "m@firma.at", name: "Max" },
    ],
    invitations: [],
    seats: { limit: null, taken: 3 },
  }),
  postBrokerReport: async () => ({ ok: true }),
}));

let client: typeof import("../src/db/client");
let log: typeof import("../src/broker/log");
let access: typeof import("../src/services/access");
/** Open to members. */
let space: string;
/** Its Studio is the admins' alone. */
let closed: string;
/** For the space's members. */
let connection: string;
/** For its admins. */
let adminsOnly: string;
let wizardId: string;

const TENANT = "tenant-pm";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const people = {
  owner: { id: "user-a", role: "owner" as const, tenantId: TENANT, name: "Anna", email: "a@firma.at" },
  julia: { id: "user-j", role: "member" as const, tenantId: TENANT, name: "Julia", email: "j@firma.at" },
  max: { id: "user-m", role: "member" as const, tenantId: TENANT, name: "Max", email: "m@firma.at" },
};

const SAME = new Date("2026-11-03T10:00:00.000Z");
const at = (hour: number) => new Date(`2026-11-02T${String(hour).padStart(2, "0")}:00:00.000Z`);

/** A line as the broker writes it; Julia's own read unless the row says otherwise. */
function line(when: Date, row: Partial<Parameters<typeof log.writeLog>[0]> = {}) {
  return inTenant(() =>
    log.writeLog({
      at: when,
      durationMs: 3,
      whoKind: "person",
      whoId: "user-j",
      runId: null,
      stepId: null,
      chatId: null,
      wizardId: null,
      spaceId: space,
      connectionId: connection,
      actionId: "list_contacts",
      kind: "read",
      inputSummary: log.summarizeInput({ email: "kunde@firma.at" }),
      outcome: "allow",
      rule: "rules.read",
      reason: "The connection's rule: reading allowed.",
      result: "ok",
      resultSize: 12,
      ...row,
    }),
  );
}

const maxOnly = () => log.summarizeInput({ email: "geheim-max@firma.at" });

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  log = await import("../src/broker/log");
  access = await import("../src/services/access");
  const spaces = await import("../src/services/spaces");
  const service = await import("../src/connectors/space-connections");
  const wizards = await import("../src/services/wizards");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
  closed = (await inTenant(() => spaces.createSpace("user-a", "Leitung"))).id;
  await inTenant(() =>
    client.db.update(client.schema.space).set({ membersStudio: true }).where(eq(client.schema.space.id, space)),
  );
  const connect = (name: string, audience: "members" | "admins") =>
    inTenant(() =>
      service.createSpaceConnection("user-a", space, {
        connectorId: "hubspot",
        name,
        signIn: "space",
        audience,
        rules: { read: "allow", write: "ask", destructive: "deny", send: "deny" },
        actions: [],
      }),
    );
  connection = (await connect("HubSpot Vertrieb", "members")).id;
  adminsOnly = (await connect("HubSpot Leitung", "admins")).id;
  const definition = {
    version: 1,
    title: "Torten-Anfrage",
    description: "Anfragen",
    avatar: "dome",
    steps: [
      { id: "start", type: "page", title: "Du", fields: [{ id: "email", kind: "text", label: "Mail" }] },
      { id: "done", type: "result", title: "Fertig", deliverables: [] },
    ],
  };
  wizardId = (await inTenant(() => wizards.createWizard("user-a", { definition } as never))).id;
  const run = (id: string, userId: string | null) =>
    inTenant(() =>
      client.db.insert(client.schema.run).values({
        id,
        wizardId,
        tenantId: TENANT,
        definition: definition as never,
        files: [],
        grant: { connections: { hub: ["list_contacts"] }, hosts: ["api.example.org"], tools: [] },
        version: null,
        mode: "live",
        userId,
        visitorId: userId ? null : "visitor-1",
        status: "done",
        cursor: "done",
        state: { values: {}, outputs: {}, history: [], notes: {} },
      }),
    );
  await run("run-j", "user-j");
  await run("run-m", "user-m");
  await run("run-g", null);
  const step = { whoKind: "step", whoId: "call-hub", wizardId, connectionId: "hub", rule: "grant" };

  // Julia's eight: three of one millisecond, Goose for her, a fixed step and an AI step of her
  // run, a refused read on the admins' connection, and a call of hers in a run that is Max's.
  for (let i = 0; i < 3; i++) {
    await line(SAME);
  }
  await line(at(20), { whoKind: "goose" });
  await line(at(19), { ...step, runId: "run-j" });
  await line(at(18), { runId: "run-j", wizardId });
  await line(at(17), {
    connectionId: adminsOnly,
    outcome: "deny",
    rule: "audience",
    reason: "The connection is for the space's admins.",
    result: "denied",
  });
  await line(at(16), { runId: "run-m", wizardId });
  // Everyone else's, between hers: Max, Goose for Max, his run's fixed step, a guest and the
  // step of the guest's run, Anna, a plugin, a changed rule, and what Julia called as an admin.
  await line(SAME, { whoId: "user-m", inputSummary: maxOnly() });
  await line(SAME, { whoId: "user-m", inputSummary: maxOnly() });
  await line(new Date(at(20).getTime() + 1), { whoKind: "goose", whoId: "user-m", inputSummary: maxOnly() });
  await line(new Date(at(19).getTime() + 1), { ...step, runId: "run-m", inputSummary: maxOnly() });
  await line(new Date(at(18).getTime() + 1), {
    whoKind: "guest",
    whoId: "visitor-1",
    runId: "run-g",
    actionId: "create_contact",
    kind: "write",
    outcome: "deny",
    rule: "audience",
    reason: "The connection is for the space's members.",
    result: "denied",
  });
  await line(new Date(at(17).getTime() + 1), { ...step, runId: "run-g" });
  await line(new Date(at(16).getTime() + 1), { whoKind: "admin", whoId: "user-a", connectionId: adminsOnly });
  await line(at(15), { whoKind: "plugin", whoId: "shop" });
  await line(at(13), { whoKind: "admin", whoId: "user-j", connectionId: adminsOnly });
  await inTenant(() =>
    log.logRuleChange({
      userId: "user-a",
      spaceId: space,
      connectionId: adminsOnly,
      summary: { audience: "admins" },
      reason: "The audience changed.",
    }),
  );
  // And one of Julia's in the space whose Studio is closed to her.
  await line(at(14), { spaceId: closed });
}, 60_000);

/** How many lines the space holds, and how many of them are Julia's. */
const ALL = 18;
const HERS = 8;

type App = { fetch: (req: Request) => Response | Promise<Response> };
const url = (path: string) => `http://localhost:5181/api/studio${path}`;

/** The broker's routes behind the gate the app puts before the studio API. */
async function appAs(who: keyof typeof people): Promise<App> {
  const { brokerRoutes } = await import("../src/routes/broker");
  const { membersStudioGate } = await import("../src/services/members-studio");
  const { ServiceError } = await import("../src/services/errors");
  const user = people[who];
  return new Hono<{ Variables: { user: typeof user } }>()
    .onError((err, c) =>
      err instanceof ServiceError ? c.json(err.toJSON(), err.status) : c.json({ error: String(err) }, 500),
    )
    .use("*", async (c, next) => {
      c.set("user", user);
      await client.withTenant(TENANT, () => access.asRole(user.role, next));
    })
    .use("/api/studio/*", membersStudioGate)
    .route("/api/studio", brokerRoutes as never);
}
const get = async (app: App, path: string) => {
  const res = await app.fetch(new Request(url(path)));
  return { status: res.status, body: (await res.json()) as any };
};

type Line = {
  id: string;
  who: { kind: string; id: string | null; name: string | null; for?: { id: string | null; name: string | null } };
  runId: string | null;
  connectionId: string;
  connectionName: string | null;
  connectorName: string | null;
  actionName: string | null;
  input: { sample?: string | null };
};
const linesOf = async (app: App, query = ""): Promise<Line[]> =>
  (await get(app, `/spaces/${space}/broker/log${query}`)).body.lines;

/** Whose line it is: the caller, or whom the step's run is held for. */
const ownerOf = (l: Line) => (l.who.kind === "step" ? (l.who.for?.id ?? null) : l.who.id);

describe("the Protokoll for a member", () => {
  it("lists their own lines only: their calls, Goose's for them, the lines of their runs", async () => {
    const lines = await linesOf(await appAs("julia"));
    expect(lines).toHaveLength(HERS);
    expect(lines.map((l) => l.who.kind).sort()).toEqual(
      ["goose", "person", "person", "person", "person", "person", "person", "step"].sort(),
    );
    expect(new Set(lines.map(ownerOf))).toEqual(new Set(["user-j"]));
    // A fixed step of her run is hers, and says so.
    const step = lines.find((l) => l.who.kind === "step");
    expect(step).toMatchObject({ runId: "run-j", who: { for: { kind: "person", id: "user-j", name: "Julia" } } });
    // No name but hers, and nothing of what the others sent.
    const text = JSON.stringify(lines);
    expect(text).not.toMatch(/Max|Anna|user-m|user-a|visitor-1|geheim-max|shop|"admin"/);
    // Max sees his own four, and none of hers: not even her call in his run.
    const his = await linesOf(await appAs("max"));
    expect(his).toHaveLength(4);
    expect(new Set(his.map(ownerOf))).toEqual(new Set(["user-m"]));
  });

  it("names the connections open to them; one for the admins stays without its name", async () => {
    const refused = (lines: Line[]) => lines.find((l) => l.connectionId === adminsOnly && l.who.id === "user-j");
    expect(refused(await linesOf(await appAs("julia")))).toMatchObject({
      connectionName: null,
      connectorName: null,
      actionName: null,
    });
    expect(refused(await linesOf(await appAs("owner")))).toMatchObject({
      connectionName: "HubSpot Leitung",
      connectorName: "HubSpot",
      actionName: "List contacts",
    });
    // By its name she finds nothing, by the name of one open to her she does.
    const julia = await appAs("julia");
    expect(await linesOf(julia, "?q=Leitung")).toHaveLength(0);
    expect(await linesOf(julia, "?q=HubSpot%20Vertrieb")).toHaveLength(6);
  });

  it("does not read another person's line by its id: it is a line that is not there", async () => {
    const owner = await appAs("owner");
    const julia = await appAs("julia");
    const all = await linesOf(owner);
    const missing = await get(julia, `/spaces/${space}/broker/log/nope`);
    expect(missing.status).toBe(404);
    for (const other of all.filter((l) => ownerOf(l) !== "user-j")) {
      const res = await get(julia, `/spaces/${space}/broker/log/${other.id}`);
      expect(res.status, `${other.who.kind} ${other.who.id}`).toBe(404);
      expect(res.body).toEqual(missing.body);
    }
    // Her own opens, with what her run was allowed.
    const hers = await linesOf(julia);
    for (const own of hers) {
      expect((await get(julia, `/spaces/${space}/broker/log/${own.id}`)).status).toBe(200);
    }
    const step = hers.find((l) => l.who.kind === "step") as Line;
    const detail = await get(julia, `/spaces/${space}/broker/log/${step.id}`);
    expect(detail.body.run).toMatchObject({
      id: "run-j",
      grant: { actions: ["list_contacts"], hosts: ["api.example.org"] },
    });
    // A call of hers in a run held for Max: the line is hers, what his run was allowed is not.
    const inHis = hers.find((l) => l.runId === "run-m") as Line;
    const guarded = await get(julia, `/spaces/${space}/broker/log/${inHis.id}`);
    expect(guarded.status).toBe(200);
    expect(guarded.body.run).toBeNull();
    expect((await get(owner, `/spaces/${space}/broker/log/${inHis.id}`)).body.run).toMatchObject({ id: "run-m" });
  });

  it("counts no one else's lines in a search, a filter or a page", async () => {
    const julia = await appAs("julia");
    const owner = await appAs("owner");
    // What only Max sent, his name, the others' ids: nothing. The admin finds them.
    for (const q of ["geheim-max", "Max", "Anna", "user-m", "visitor-1", "shop", "change_rules"]) {
      const res = await get(julia, `/spaces/${space}/broker/log?q=${q}`);
      expect(res.body, q).toEqual({ lines: [], next: null });
      expect((await linesOf(owner, `?q=${q}`)).length, q).toBeGreaterThan(0);
    }
    // A search that fits everyone's lines gives hers.
    expect(await linesOf(julia, "?q=list_contacts")).toHaveLength(HERS);
    expect(await linesOf(julia, "?q=julia")).toHaveLength(HERS - 1);
    // The filters by who offer her nobody else.
    for (const who of ["guest", "admin", "plugin"]) {
      expect(await linesOf(julia, `?who=${who}`), who).toHaveLength(0);
    }
    expect(await linesOf(julia, "?who=step")).toHaveLength(1);
    expect(await linesOf(julia, "?who=goose")).toHaveLength(1);
    expect(await linesOf(julia, "?who=person")).toHaveLength(HERS - 2);
    expect(await linesOf(julia, "?critical=true")).toHaveLength(0);
    expect(await linesOf(julia, "?refused=true")).toHaveLength(1);
    expect(await linesOf(julia, `?connection=${adminsOnly}`)).toHaveLength(1);

    // Page by page: every page is full of her lines until they end, however many of the others'
    // lie between them, and the cursor after her last line leads nowhere.
    const whole = await linesOf(julia);
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    for (let page = 0; page < 10; page++) {
      const res: { body: { lines: Line[]; next: string | null } } = await get(
        julia,
        `/spaces/${space}/broker/log?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      sizes.push(res.body.lines.length);
      seen.push(...res.body.lines.map((l) => l.id));
      cursor = res.body.next;
      if (!cursor) {
        break;
      }
    }
    expect(sizes).toEqual([3, 3, 2]);
    expect(seen).toEqual(whole.map((l) => l.id));
    // A cursor made of another person's line: still only her lines after it.
    const all = await linesOf(owner);
    const others = all.find((l) => l.who.id === "user-m" && l.who.kind === "goose") as Line & { at: string };
    const after = await linesOf(julia, `?cursor=${new Date(others.at).getTime()}.${others.id}`);
    expect(new Set(after.map(ownerOf))).toEqual(new Set(["user-j"]));
    expect(after.length).toBeLessThan(HERS);
  });

  it("shows an admin every line, as before", async () => {
    const owner = await appAs("owner");
    const all = await linesOf(owner);
    expect(all).toHaveLength(ALL);
    expect(new Set(all.map((l) => l.who.kind))).toEqual(
      new Set(["person", "goose", "step", "guest", "admin", "plugin"]),
    );
    expect(new Set(all.map((l) => l.who.name).filter(Boolean))).toEqual(new Set(["Julia", "Max", "Anna"]));
    expect(all.filter((l) => l.who.kind === "admin")).toHaveLength(3);
    expect(await linesOf(owner, "?q=Max")).toHaveLength(4);
    expect(await linesOf(owner, "?who=guest")).toHaveLength(1);
    const his = all.find((l) => l.who.kind === "step" && l.runId === "run-m") as Line;
    const detail = await get(owner, `/spaces/${space}/broker/log/${his.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.line.who.for).toMatchObject({ kind: "person", id: "user-m", name: "Max" });
    expect(detail.body.run).toMatchObject({ id: "run-m" });
  });

  it("keeps „Was darf …?“ and what it picks from for the admins", async () => {
    const julia = await appAs("julia");
    const ask = `broker/ask?who=person&resource=${connection}&action=list_contacts`;
    for (const path of ["broker/choices", ask]) {
      expect((await get(julia, `/spaces/${space}/${path}`)).status, path).toBe(403);
      expect((await get(await appAs("owner"), `/spaces/${space}/${path}`)).status, path).toBe(200);
    }
  });

  it("stays closed in a space whose Studio is closed to members", async () => {
    const owner = await appAs("owner");
    const julia = await appAs("julia");
    const there = (await get(owner, `/spaces/${closed}/broker/log`)).body.lines as Line[];
    expect(there).toHaveLength(1);
    expect(there[0]?.who).toMatchObject({ kind: "person", id: "user-j" });
    // Her own line, and still not hers to read there.
    for (const path of ["broker/log", `broker/log/${there[0]?.id}`, "broker/choices"]) {
      expect((await get(julia, `/spaces/${closed}/${path}`)).status, path).toBe(403);
    }
    // Nor does the open space's log hold the closed one's line.
    expect((await linesOf(julia)).map((l) => l.id)).not.toContain(there[0]?.id);
  });
});

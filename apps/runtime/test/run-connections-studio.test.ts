import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSchema } from "@engenty/wizards-shared/starts";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Connections in a run, step 4 (docs/plans/run-connections.md): the wizard's needs on its page in
 * the studio, the space's choice for runs nobody watches, the check that refuses such a run
 * without it, and the person's own connections under menu › „Verbindungen“.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-run-connections-studio-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "web";

/** Whether the runtime is a managed one: there a member is refused what is the admins'. */
const mode = vi.hoisted(() => ({ managed: false }));
vi.mock("../src/manage.js", async (original) => {
  const mod = await original<typeof import("../src/manage.js")>();
  return {
    ...mod,
    get managed() {
      return mode.managed;
    },
  };
});
// No step runs here: the runs only have to begin.
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: () => new Promise(() => {}),
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
  canSpend: async () => true,
}));

let client: typeof import("../src/db/client");
let own: typeof import("../src/connectors/person-connections");
let choice: typeof import("../src/connectors/space-choice");
let signIns: typeof import("../src/connectors/person-sign-ins");
let requirements: typeof import("../src/engine/requirements");
let access: typeof import("../src/services/access");
let wizards: typeof import("../src/services/wizards");
let starts: typeof import("../src/engine/starts");
let crypto: typeof import("../src/secrets/crypto");

const TENANT = "tenant-rcs";
const USER = "user-rcs";
const MEMBER = "member-rcs";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const asMember = <T>(fn: () => Promise<T>) => inTenant(() => access.asRole("member", fn));

/** A wizard whose every run calls HubSpot. */
const definition = {
  version: 1,
  title: "Leads",
  description: "Leads from HubSpot",
  avatar: "dome",
  connections: [{ id: "hub", connector: "hubspot" }],
  steps: [
    {
      id: "contacts",
      type: "tool",
      title: "Kontakte holen",
      call: { connection: "hub", action: "list_contacts", input: {} },
    },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
};

let space = "";

const switchOn = () => {
  process.env.FEATURES = "runConnections=on";
};
afterEach(() => {
  delete process.env.FEATURES;
  mode.managed = false;
});

/** A connection of the space that signs in as the space. */
async function spaceConnection(audience: "all" | "members" = "all") {
  const id = `sc-${Math.random().toString(36).slice(2, 10)}`;
  await inTenant(() =>
    client.db.insert(client.schema.spaceConnection).values({
      id,
      spaceId: space,
      connectorId: "hubspot",
      name: "HubSpot Vertrieb",
      label: `crm-${id}@firma.at`,
      signIn: "space",
      audience,
      rules: { read: "allow", write: "ask", destructive: "never", send: "ask" } as never,
      secret: crypto.seal({ access_token: "space" }),
    }),
  );
  return id;
}

async function newWizard(title = "Leads") {
  return inTenant(async () => {
    const w = await wizards.createWizard(USER, { definition: { ...definition, title } as never });
    await wizards.publishWizard(USER, w.id);
    return wizards.ownedWizard(USER, w.id);
  });
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  own = await import("../src/connectors/person-connections");
  choice = await import("../src/connectors/space-choice");
  signIns = await import("../src/connectors/person-sign-ins");
  requirements = await import("../src/engine/requirements");
  access = await import("../src/services/access");
  wizards = await import("../src/services/wizards");
  starts = await import("../src/engine/starts");
  crypto = await import("../src/secrets/crypto");
  const spaces = await import("../src/services/spaces");
  space = (await inTenant(() => spaces.createSpace(USER, "Vertrieb"))).id;
}, 300_000);

describe("the wizard's needs in the studio", () => {
  it("say the service, its steps and how it resolves; an admin also sees the space's choice", async () => {
    switchOn();
    const w = await newWizard();
    const sc = await spaceConnection();
    const [admin] = await inTenant(() =>
      choice.wizardNeeds(w, { userId: USER, admin: true }, "en"),
    );
    expect(admin).toMatchObject({
      id: "hub",
      name: "HubSpot",
      steps: [{ id: "contacts", title: "Kontakte holen" }],
      unavoidable: true,
      here: { state: "only", account: { id: sc, owner: "space" } },
      space: { chosen: null, options: [{ id: sc, owner: "space", label: expect.any(String) }] },
    });
    const [member] = await inTenant(() =>
      choice.wizardNeeds(w, { userId: MEMBER, admin: false }, "en"),
    );
    expect(member.steps).toEqual(admin.steps);
    expect(member.space).toBeUndefined();
  });

  it("leave the space's choice out without runConnections", async () => {
    const w = await newWizard();
    const [need] = await inTenant(() => choice.wizardNeeds(w, { userId: USER, admin: true }, "en"));
    expect(need.space).toBeUndefined();
    expect(need.here).toEqual({ state: "connect" });
  });

  it("are the admins' to choose and clear for the space", async () => {
    switchOn();
    const w = await newWizard();
    const sc = await spaceConnection();
    mode.managed = true;
    await expect(asMember(() => choice.chooseForSpace(w, "hub", sc))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(asMember(() => choice.clearForSpace(w, "hub"))).rejects.toMatchObject({
      code: "forbidden",
    });
    await inTenant(() => access.asRole("admin", () => choice.chooseForSpace(w, "hub", sc)));
    const [chosen] = await inTenant(() => choice.wizardNeeds(w, { userId: USER, admin: true }, "en"));
    expect(chosen.space?.chosen).toBe(sc);
    // A connection of the space that a run nobody watches can't use is not offered.
    const members = await spaceConnection("members");
    await expect(
      inTenant(() => access.asRole("admin", () => choice.chooseForSpace(w, "hub", members))),
    ).rejects.toMatchObject({ code: "not_found" });
    await inTenant(() => access.asRole("admin", () => choice.clearForSpace(w, "hub")));
    const [cleared] = await inTenant(() => choice.wizardNeeds(w, { userId: USER, admin: true }, "en"));
    expect(cleared.space?.chosen).toBeNull();
  });
});

describe("a start nobody watches", () => {
  const start = (owner?: string) =>
    startSchema.parse({
      id: `s-${Math.random().toString(36).slice(2, 8)}`,
      kind: "schedule",
      schedule: { every: "week", weekday: 1, time: "09:00", tz: "Europe/Vienna" },
      ...(owner ? { owner } : {}),
    });
  const event = { kind: "schedule" as const, at: new Date().toISOString() };

  it("is refused without the space's choice, and starts with it", async () => {
    switchOn();
    const w = await newWizard();
    const sc = await spaceConnection();
    const said = await inTenant(() =>
      requirements.unwatchedConnectionsSaid(w.draft, { wizardId: w.id, holder: "r:" }, space),
    );
    expect(said).toMatchObject([
      { id: "hub", blocking: true, steps: [{ id: "contacts" }], problem: { code: "unwatchedNeedsChoice" } },
    ]);
    await expect(inTenant(() => starts.startFrom(w, start(), event))).rejects.toThrow(
      /Nobody is there to connect HubSpot/,
    );
    await inTenant(() => choice.chooseForSpace(w, "hub", sc));
    const runId = await inTenant(() => starts.startFrom(w, start(), event));
    const run = await inTenant(() =>
      client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }),
    );
    expect(run?.userId).toBeNull();
  });

  it("is not checked for a start with an owner, nor without runConnections", async () => {
    const w = await newWizard();
    expect(
      await inTenant(() =>
        requirements.unwatchedConnectionsSaid(w.draft, { wizardId: w.id, holder: "r:" }, space),
      ),
    ).toEqual([]);
    switchOn();
    expect(
      await inTenant(() =>
        requirements.unwatchedConnectionsSaid(w.draft, { wizardId: w.id, holder: `u:${USER}` }, space),
      ),
    ).toEqual([]);
    await expect(inTenant(() => starts.startFrom(w, start(USER), event))).resolves.toEqual(
      expect.any(String),
    );
  });
});

describe("the person's own connections", () => {
  it("are listed with the wizards that chose them, and disconnect with every choice", async () => {
    const a = await newWizard("Angebote");
    const b = await newWizard("Berichte");
    const row = await inTenant(() =>
      own.saveConnection(`u:${USER}`, "hubspot", "me@firma.at", { access_token: "mine" }),
    );
    for (const w of [a, b]) {
      await inTenant(() => own.remember(w.id, "hub", `u:${USER}`, { kind: "person", row }));
    }
    const user = { id: USER, role: "owner" } as never;
    const listed = await inTenant(() => signIns.personSignIns(user));
    expect(listed.own).toEqual([
      {
        id: row.id,
        connectorId: "hubspot",
        connectorName: "HubSpot",
        label: "me@firma.at",
        createdAt: expect.any(String),
        wizards: [
          { id: a.id, title: "Angebote" },
          { id: b.id, title: "Berichte" },
        ],
      },
    ]);
    // Someone else's connection is not theirs to disconnect.
    await expect(
      inTenant(() => signIns.disconnectOwn({ id: MEMBER, role: "member" } as never, row.id)),
    ).rejects.toMatchObject({ code: "not_found" });
    await inTenant(() => signIns.disconnectOwn(user, row.id));
    expect((await inTenant(() => signIns.personSignIns(user))).own).toEqual([]);
    const left = await inTenant(() =>
      client.db.query.connectionChoice.findMany({
        where: eq(client.schema.connectionChoice.holder, `u:${USER}`),
      }),
    );
    expect(left).toEqual([]);
  });
});

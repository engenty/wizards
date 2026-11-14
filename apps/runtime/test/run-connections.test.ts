import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Connections in a run (docs/plans/run-connections.md, steps 1 and 2): one store of accounts
 * with an owner, the remembered choice, and the lookup a run reads through.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-run-connections-"));
process.env.APP_URL = "http://localhost:5181";

let client: typeof import("../src/db/client");
let connectors: typeof import("../src/connectors/index");
let own: typeof import("../src/connectors/person-connections");
let account: typeof import("../src/broker/account");
let store: typeof import("../src/store/index");
let crypto: typeof import("../src/secrets/crypto");

const TENANT = "tenant-rc";
const USER = "user-rc";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);

const definition = {
  version: 1,
  title: "Leads",
  description: "Leads into HubSpot",
  avatar: "dome",
  steps: [
    { id: "start", type: "form", title: "You", fields: [{ id: "email", kind: "text", label: "Mail" }] },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
};

const hub = { id: "hub", connector: "hubspot" };
const mail = { id: "mail", kind: "mail" as const };
const gmail = { id: "gmail", connector: "google-gmail" };
const tokens = (token: string) => ({
  accessToken: token,
  refreshToken: null,
  expiresAt: null,
  scopes: [],
});

let space = "";
let clientA = "";
let clientB = "";
const wizards: Record<string, string> = {};
const person = (wizard: string, clientSpaceId?: string) => ({
  wizardId: wizards[wizard],
  holder: `u:${USER}`,
  ...(clientSpaceId ? { clientSpaceId } : {}),
});

const switchOn = () => {
  process.env.FEATURES = "runConnections=on";
};
afterEach(() => {
  delete process.env.FEATURES;
});

/** A connection of a space that signs in as the space. */
async function spaceConnection(spaceId: string, audience: "all" | "members" | "admins" = "all") {
  const id = `sc-${Math.random().toString(36).slice(2, 10)}`;
  await inTenant(() =>
    client.db.insert(client.schema.spaceConnection).values({
      id,
      spaceId,
      connectorId: "hubspot",
      name: `HubSpot ${spaceId}`,
      label: `crm@${spaceId}`,
      signIn: "space",
      audience,
      rules: { read: "allow", write: "ask", destructive: "never", send: "ask" } as never,
      secret: crypto.seal(tokens(`space-${spaceId}`)),
    }),
  );
  return id;
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  connectors = await import("../src/connectors/index");
  own = await import("../src/connectors/person-connections");
  account = await import("../src/broker/account");
  store = await import("../src/store/index");
  crypto = await import("../src/secrets/crypto");
  const spaces = await import("../src/services/spaces");
  const service = await import("../src/services/wizards");
  space = (await inTenant(() => spaces.createSpace(USER, "Vertrieb"))).id;
  for (const name of ["a", "b", "c", "m", "n", "old", "older", "guest", "start"]) {
    wizards[name] = (await inTenant(() => service.createWizard(USER, { definition }))).id;
  }
  // Two client spaces under it: the open version makes none, so they are written as they are.
  clientA = "client-a";
  clientB = "client-b";
  for (const id of [clientA, clientB]) {
    await inTenant(() =>
      client.db
        .insert(client.schema.space)
        .values({ id, tenantId: TENANT, name: id, kind: "client", parentId: space }),
    );
  }
}, 300_000);

describe("the lookup", () => {
  it("finds none where nothing is connected", async () => {
    const found = await inTenant(() => own.connectionsFor(person("a"), space, hub));
    expect(found).toEqual({ candidates: [], chosen: null, by: null });
    const [view] = await inTenant(() => connectors.connectionViews([hub], person("a"), space));
    expect(view.account).toBeNull();
  });

  it("uses what a run connected, remembered as the wizard's choice", async () => {
    await inTenant(() => connectors.keepAccount(person("a"), "hub", "hubspot", "me@firma.at", tokens("t-1")));
    const found = await inTenant(() => own.connectionsFor(person("a"), space, hub));
    expect(found.by).toBe("choice");
    expect(found.chosen).toMatchObject({ kind: "person", row: { holder: `u:${USER}`, label: "me@firma.at" } });
    const [view] = await inTenant(() => connectors.connectionViews([hub], person("a"), space));
    expect(view.account).toMatchObject({ connector: "hubspot", label: "me@firma.at" });
    const held = await inTenant(() => account.wizardAccount(person("a"), hub, space));
    expect(held?.ctx.accessToken).toBe("t-1");
  });

  it("reaches another wizard only with runConnections, as the only candidate, and remembers it", async () => {
    expect((await inTenant(() => own.connectionsFor(person("b"), space, hub))).chosen).toBeNull();
    switchOn();
    const found = await inTenant(() => own.connectionsFor(person("b"), space, hub));
    expect(found.by).toBe("only");
    const held = await inTenant(() => account.wizardAccount(person("b"), hub, space));
    expect(held?.label).toBe("me@firma.at");
    delete process.env.FEATURES;
    // Used once, it stays the wizard's choice with the switch off.
    expect((await inTenant(() => own.connectionsFor(person("b"), space, hub))).by).toBe("choice");
  });

  it("chooses none among several until one is remembered", async () => {
    switchOn();
    await inTenant(() => own.saveConnection(`u:${USER}`, "hubspot", "other@firma.at", tokens("t-2")));
    const found = await inTenant(() => own.connectionsFor(person("c"), space, hub));
    expect(found.candidates).toHaveLength(2);
    expect(found.chosen).toBeNull();
    const [view] = await inTenant(() => connectors.connectionViews([hub], person("c"), space));
    expect(view.account).toBeNull();
    const other = found.candidates.find((c) => c.row.label === "other@firma.at");
    await inTenant(() => own.remember(wizards.c, "hub", `u:${USER}`, other as never));
    const again = await inTenant(() => own.connectionsFor(person("c"), space, hub));
    expect(again).toMatchObject({ by: "choice", chosen: { row: { label: "other@firma.at" } } });
  });

  it("forgets on disconnect, and keeps an account another wizard uses", async () => {
    await inTenant(() => connectors.disconnect(person("a"), "hub"));
    expect((await inTenant(() => own.connectionsFor(person("a"), space, hub))).chosen).toBeNull();
    // Wizard b chose it as well: it stays.
    expect((await inTenant(() => own.connectionsFor(person("b"), space, hub))).chosen?.row.label).toBe(
      "me@firma.at",
    );
    await inTenant(() => connectors.disconnect(person("b"), "hub"));
    const left = await inTenant(() =>
      client.db.query.personConnection.findMany({
        where: eq(client.schema.personConnection.holder, `u:${USER}`),
      }),
    );
    expect(left.map((r) => r.label)).toEqual(["other@firma.at"]);
  });

  it("serves kind mail and the service's connector with one account per address", async () => {
    await inTenant(() => connectors.keepAccount(person("m"), "mail", "mail-gmail", "c@gmail.com", tokens("g-1")));
    switchOn();
    const found = await inTenant(() => own.connectionsFor(person("n"), space, gmail));
    expect(found.chosen).toMatchObject({ connector: { id: "google-gmail" }, row: { connectorId: "mail-gmail" } });
    // Signing in to the same address through the other connector keeps one account.
    const again = await inTenant(() => own.saveConnection(`u:${USER}`, "google-gmail", "c@gmail.com", tokens("g-2")));
    expect(again.id).toBe(found.chosen?.row.id);
    const viewed = await inTenant(() => connectors.connectionViews([mail], person("m"), space));
    expect(viewed[0].account).toMatchObject({ connector: "mail-gmail", label: "c@gmail.com" });
  });
});

describe("the space's connections", () => {
  it("are offered with runConnections, in the space the run is in", async () => {
    const parent = await spaceConnection(space);
    const ofA = await spaceConnection(clientA);
    await spaceConnection(clientB);
    expect(
      (await inTenant(() => own.connectionsFor(person("c"), space, hub))).candidates.filter((c) => c.kind === "space"),
    ).toEqual([]);
    switchOn();
    const inParent = await inTenant(() => own.connectionsFor(person("c"), space, hub));
    expect(inParent.candidates.filter((c) => c.kind === "space").map((c) => c.row.id)).toEqual([parent]);
    // A client space's run sees its own, never the parent's or another client's.
    const inClient = await inTenant(() => own.connectionsFor(person("c", clientA), space, hub));
    expect(inClient.candidates.filter((c) => c.kind === "space").map((c) => c.row.id)).toEqual([ofA]);
  });

  it("keep their audience", async () => {
    const admins = await spaceConnection(clientB, "admins");
    switchOn();
    const guest = { wizardId: wizards.guest, holder: "v:ann", clientSpaceId: clientB };
    const ids = (await inTenant(() => own.connectionsFor(guest, space, hub))).candidates.map((c) => c.row.id);
    expect(ids).not.toContain(admins);
    // The organization's owner is an admin of every space.
    const mine = (await inTenant(() => own.connectionsFor(person("c", clientB), space, hub))).candidates;
    expect(mine.map((c) => c.row.id)).toContain(admins);
  });

  it("hold the broker's call under the space's rules", async () => {
    switchOn();
    const scope = { wizardId: wizards.start, holder: "r:run-1", clientSpaceId: clientA };
    const held = await inTenant(() =>
      account.heldConnection({ kind: "store_secret", def: hub, scope, spaceId: space }),
    );
    expect(held).toMatchObject({ kind: "space_connection", row: { spaceId: clientA } });
    // The only candidate, once used, is the wizard's choice.
    expect((await inTenant(() => own.connectionsFor(scope, space, hub))).by).toBe("choice");
  });

  it("serve a run nobody watches by the space's choice", async () => {
    switchOn();
    const two = await spaceConnection(clientA);
    const scope = { wizardId: wizards.start, holder: "r:run-2", clientSpaceId: clientA };
    expect((await inTenant(() => own.connectionsFor(scope, space, hub))).chosen).toBeNull();
    await inTenant(() =>
      own.remember(wizards.start, "hub", own.spaceHolder(clientA), { kind: "space", row: { id: two } }),
    );
    expect((await inTenant(() => own.connectionsFor(scope, space, hub))).chosen?.row.id).toBe(two);
  });
});

describe("a guest's account", () => {
  it("stays with the visitor and goes with their store", async () => {
    const ann = { wizardId: wizards.guest, holder: "v:ann" };
    const bob = { wizardId: wizards.guest, holder: "v:bob" };
    await inTenant(() => connectors.keepAccount(ann, "hub", "hubspot", "ann@web.de", tokens("v-1")));
    switchOn();
    expect((await inTenant(() => own.connectionsFor(ann, space, hub))).chosen?.row.label).toBe("ann@web.de");
    const bobs = (await inTenant(() => own.connectionsFor(bob, space, hub))).candidates;
    expect(bobs.filter((c) => c.kind === "person")).toEqual([]);
    await inTenant(() => store.clearStore(ann));
    const left = await inTenant(() =>
      client.db.query.personConnection.findMany({ where: eq(client.schema.personConnection.holder, "v:ann") }),
    );
    expect(left).toEqual([]);
  });
});

describe("wizards move-connections", () => {
  it("makes each kept account a connection with a choice, once", async () => {
    const { moveTenantConnections: move } = await import("../src/cli/move-connections");
    const kept = (wizard: string, holder: string, slot: string, provider: string, label: string, token: string) =>
      client.db.insert(client.schema.storeSecret).values({
        id: `${wizard}-${holder}-${slot}`,
        wizardId: wizards[wizard],
        holder,
        slot,
        provider,
        label,
        data: crypto.seal(tokens(token)),
      });
    await inTenant(async () => {
      await kept("old", "u:mover", "connection:hub", "hubspot", "crm@firma.at", "old-1");
      await kept("older", "u:mover", "connection:hub", "hubspot", "crm@firma.at", "old-2");
      await kept("old", "u:mover", "connection:mail", "mail-gmail", "m@gmail.com", "old-3");
      await kept("older", "u:mover", "connection:share:drive", "google-gmail", "m@gmail.com", "old-4");
      await kept("old", "v:visitor", "connection:hub", "hubspot", "crm@firma.at", "old-5");
      await kept("old", "u:mover", "browser", "browser", "Browser-Anmeldungen", "cookies");
    });

    const dry = await inTenant(() => move(true));
    expect(dry).toEqual({ accounts: 3, reused: 0, choices: 5 });
    expect(await inTenant(() => client.db.query.personConnection.findMany({
      where: eq(client.schema.personConnection.holder, "u:mover"),
    }))).toEqual([]);

    expect(await inTenant(() => move(false))).toEqual({ accounts: 3, reused: 0, choices: 5 });
    const mover = await inTenant(() =>
      client.db.query.personConnection.findMany({ where: eq(client.schema.personConnection.holder, "u:mover") }),
    );
    expect(mover.map((r) => r.label).sort()).toEqual(["crm@firma.at", "m@gmail.com"]);
    const secrets = await inTenant(() => client.db.query.storeSecret.findMany());
    expect(secrets.map((s) => s.slot)).toEqual(["browser"]);
    expect(await inTenant(() => move(false))).toEqual({ accounts: 0, reused: 0, choices: 0 });

    // An existing wizard's run still finds its account, and what the wizard keeps lists it.
    const scope = { wizardId: wizards.old, holder: "u:mover" };
    const held = await inTenant(() => account.wizardAccount(scope, hub, space));
    // Two wizards kept the same account: one connection, with the newer of the two secrets.
    expect(["old-1", "old-2"]).toContain(held?.ctx.accessToken);
    const share = await inTenant(() =>
      account.wizardAccount({ wizardId: wizards.older, holder: "u:mover" }, { id: "share:drive", connector: "google-gmail" }, space),
    );
    expect(share?.label).toBe("m@gmail.com");
    const listed = await inTenant(() => store.listSecrets(scope));
    expect(listed.map((s) => s.slot).sort()).toEqual(["browser", "connection:hub", "connection:mail"]);
  });
});

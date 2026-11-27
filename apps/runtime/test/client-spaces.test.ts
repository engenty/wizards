import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Client spaces (docs/plans/org-spaces.md): a client is a client space beside the team spaces
// under the organization's root; its client's people are in it, a team space and the root take
// none. A client works with the client space's data and runs its wizards; of the root they read
// only what was opened to clients; they reach only their client spaces. Migrations 0076 and 0077
// moved client spaces of before beside the team spaces.

const dir = mkdtempSync(join(tmpdir(), "wizards-client-spaces-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "clientSpaces=on,orgSpaces=on";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let rootId = "";
const shared = "wagner-space";
const pages: Record<string, string> = {};
let db: typeof import("../src/db/client");

const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://localhost:5181${path}`, {
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
const local = <T>(fn: () => T | Promise<T>) => db.withTenant("local", fn);

/** A caller of the catalogue in the shared space, as a client or as the firm. */
async function caller(userId: string, role: "client" | "member") {
  const { personCaller } = await import("../src/elements/caller");
  return personCaller({
    space: { id: shared, name: "Wagner GmbH" },
    userId,
    role,
    signal: new AbortController().signal,
  });
}

beforeAll(async () => {
  db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request("http://localhost:5181/api/local/enter?k=test-key"));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  rootId = (await local(() => spaces.defaultSpace("local"))).id;
  // A local install makes one space; a client space and a team space under the root, written
  // here directly.
  await local(() =>
    db.db.insert(db.schema.space).values([
      { id: shared, tenantId: "local", name: "Wagner GmbH", brand: {}, parentId: rootId, kind: "client" },
      { id: "team", tenantId: "local", name: "Lohnverrechnung", brand: {}, parentId: rootId },
    ]),
  );
  const data = await import("../src/services/space-data");
  for (const [key, space, title, markdown] of [
    ["internal", rootId, "Honorare", "Unser Stundensatz für Wagner ist 180 Euro."],
    ["open", rootId, "Ablauf", "So läuft eine Beratung bei uns ab: drei Termine."],
    ["theirs", shared, "Unterlagen Wagner", "Vertrag liegt bei."],
  ]) {
    pages[key] = (await local(() => data.createPage("local", space, { title, markdown }))).id;
  }
}, 60_000);

describe("client spaces", () => {
  it("take their client's people; a team space and the root take none", async () => {
    await json(send("PUT", `/api/studio/spaces/${shared}/members/wagner`, { role: "client" }));
    const { members } = await json(send("GET", `/api/studio/spaces/${shared}/members`));
    expect(members).toEqual([expect.objectContaining({ userId: "wagner", role: "client" })]);
    for (const space of [rootId, "team"]) {
      expect(
        (await send("PUT", `/api/studio/spaces/${space}/members/wagner`, { role: "client" })).status,
      ).toBe(404);
    }
  });

  it("seed their clients with the client space's data and wizards, never its setup", async () => {
    const rwx = await import("../src/broker/rwx");
    const client = [{ kind: "role" as const, id: "client" }];
    await local(async () => {
      const page = { kind: "page" as const, id: pages.theirs };
      expect((await rwx.decide(shared, client, page, "w")).ok).toBe(true);
      expect((await rwx.decide(shared, client, { kind: "wizard", id: "w" }, "x")).ok).toBe(true);
      expect((await rwx.decide(shared, client, { kind: "setup", id: shared }, "w")).ok).toBe(false);
      // The space's own seed is there too: its admins and members work as before.
      expect((await rwx.decide(shared, [{ kind: "role", id: "admin" }], page, "w")).ok).toBe(true);
      expect((await rwx.decide(rootId, client, page, "r")).ok).toBe(false);
    });
  });

  it("read their own Knowledge and of the root's what was opened to clients; the firm all", async () => {
    await json(send("PUT", `/api/studio/spaces/${rootId}/open-to-clients`, { kind: "page", id: pages.open, open: true }));
    const { open } = await json(send("GET", `/api/studio/spaces/${rootId}/open-to-clients`));
    expect(open.page).toEqual([pages.open]);
    const { elementTools } = await import("../src/elements/catalogue");
    await local(async () => {
      const client = await elementTools(await caller("wagner", "client"), { knowledge: true });
      expect((await client.page_read.execute({ path: "pages/unterlagen-wagner" })).page).toContain("Vertrag");
      expect((await client.page_read.execute({ path: "pages/ablauf" })).page).toContain("drei Termine");
      const internal = await client.page_read.execute({ path: "pages/honorare" });
      expect(internal).toMatchObject({ error: expect.stringContaining("permission") });
      expect(JSON.stringify(internal)).not.toContain("180");
      const firm = await elementTools(await caller("anna", "member"), { knowledge: true });
      expect((await firm.page_read.execute({ path: "pages/honorare" })).page).toContain("180");
    });
  });

  it("are all a client reaches: their own, never the root or a team space", async () => {
    const spaces = await import("../src/services/spaces");
    const { asRole } = await import("../src/services/access");
    await local(() =>
      asRole("client", async () => {
        expect((await spaces.listSpaces("wagner")).map((s) => s.id)).toEqual([shared]);
        expect((await spaces.defaultSpace("wagner")).id).toBe(shared);
        await expect(spaces.ownedSpace("wagner", rootId)).rejects.toThrow();
        await expect(spaces.ownedSpace("wagner", "team")).rejects.toThrow();
        await expect(spaces.ownedSpace("huber", shared)).rejects.toThrow();
      }),
    );
  });

  it("are invited by address in the cloud only, and taken in at their first sign-in", async () => {
    // A local install has no accounts to invite.
    expect(
      (await send("POST", `/api/studio/spaces/${shared}/invite`, { email: "x@wagner.at" })).status,
    ).toBe(400);
    const clients = await import("../src/services/client-spaces");
    await local(async () => {
      await db.db.insert(db.schema.spaceMember).values({
        id: "pending1",
        tenantId: "local",
        spaceId: shared,
        userId: null,
        email: "eva@wagner.at",
        role: "client",
        addedBy: "local",
      });
      await clients.claimClientInvites("eva", "Eva@Wagner.at");
      const row = await db.db.query.spaceMember.findFirst({
        where: (m, { eq }) => eq(m.id, "pending1"),
      });
      expect(row).toMatchObject({ userId: "eva", email: "eva@wagner.at" });
    });
    const { members } = await json(send("GET", `/api/studio/spaces/${shared}/members`));
    expect(members).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: "eva", role: "client" })]),
    );
  });

  it("give a client's token no authoring tools, only the elements", async () => {
    const { registerTools } = await import("../src/mcp/tools");
    const { registerElementTools } = await import("../src/mcp/elements");
    const names: string[] = [];
    const server = { registerTool: (name: string) => names.push(name) } as never;
    const who = {
      userId: "eva",
      tenantId: "local",
      role: "client",
      client: "Claude",
      scopes: ["wizards:read", "wizards:write", "data:read", "elements:read"],
    } as never;
    registerTools(server, who);
    expect(names).toEqual([]);
    registerElementTools(server, who);
    expect(names).toEqual(expect.arrayContaining(["space_search", "skill_load"]));
    expect(names).not.toContain("create_wizard");
  });

  it("are not there while either switch is off", async () => {
    for (const off of ["clientSpaces=off,orgSpaces=on", "clientSpaces=on,orgSpaces=off"]) {
      process.env.FEATURES = off;
      expect(
        (await send("PUT", `/api/studio/spaces/${shared}/members/huber`, { role: "client" })).status,
      ).toBe(404);
      expect((await send("GET", `/api/studio/spaces/${shared}/open-to-clients`)).status).toBe(404);
    }
    process.env.FEATURES = "clientSpaces=on,orgSpaces=on";
  });

  it("are made with „Kund:in anlegen“ beside the team spaces, outside the plan's number", async () => {
    const res = await json(send("POST", "/api/studio/spaces", { name: "Berger & Söhne", kind: "client" }));
    const row = await local(() => db.db.query.space.findFirst({ where: (s, { eq }) => eq(s.id, res.id) }));
    expect(row).toMatchObject({ kind: "client", parentId: rootId, brandFrom: "root" });
    const spaces = await import("../src/services/spaces");
    const listed = await local(() => spaces.listSpaces("local"));
    expect(listed.find((s) => s.id === res.id)).toMatchObject({ kind: "client" });
  });

  it("migrations 0076 and 0077 put a client space of before beside the team spaces", async () => {
    const { sql } = await import("drizzle-orm");
    await local(async () => {
      await db.db.run(
        sql`INSERT INTO space (id, tenant_id, name, brand, kind, parent_id) VALUES ('old-client', 'local', 'Huber', '{}', 'client', ${shared})`,
      );
      await db.db.insert(db.schema.spaceMember).values({
        id: "huber1",
        tenantId: "local",
        spaceId: "old-client",
        userId: "huber",
        role: "client",
        addedBy: "local",
      });
      for (const name of ["0076_clients_in_spaces", "0077_client_spaces_at_root"]) {
        const migration = readFileSync(
          join(import.meta.dirname, `../src/db/migrations/tenant/${name}.sql`),
          "utf8",
        );
        for (const statement of migration.split("--> statement-breakpoint")) {
          await db.db.run(sql.raw(statement));
        }
      }
      const row = await db.db.query.space.findFirst({ where: (s, { eq }) => eq(s.id, "old-client") });
      expect(row).toMatchObject({ kind: "client", parentId: rootId, brandFrom: "root", access: "all" });
      // A client space without its people yet stays one; a team space without clients too.
      await db.db.run(
        sql`INSERT INTO space (id, tenant_id, name, brand, kind, parent_id) VALUES ('empty-client', 'local', 'Gruber', '{}', 'client', 'team')`,
      );
      for (const name of ["0076_clients_in_spaces", "0077_client_spaces_at_root"]) {
        const migration = readFileSync(
          join(import.meta.dirname, `../src/db/migrations/tenant/${name}.sql`),
          "utf8",
        );
        for (const statement of migration.split("--> statement-breakpoint")) {
          await db.db.run(sql.raw(statement));
        }
      }
      const empty = await db.db.query.space.findFirst({ where: (s, { eq }) => eq(s.id, "empty-client") });
      expect(empty).toMatchObject({ kind: "client", parentId: rootId });
      const team = await db.db.query.space.findFirst({ where: (s, { eq }) => eq(s.id, "team") });
      expect(team).toMatchObject({ kind: "space" });
      const member = await db.db.query.spaceMember.findFirst({
        where: (m, { eq }) => eq(m.id, "huber1"),
      });
      expect(member).toMatchObject({ spaceId: "old-client", role: "client" });
    });
  });
});

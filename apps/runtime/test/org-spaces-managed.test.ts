import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Mein Space in the cloud (docs/plans/org-spaces.md): an organization alone has its root as its
// one space; from its second person on (member or invited), each person has a Mein Space that
// nobody else reaches. A stand-in Manage-App answers two organizations: one person, and a team.

const SERVICE_KEY = "wzr_test_service_key";
const SOLO = "tenant-solo";
const TEAM = "tenant-team";

const person = (userId: string, role: string) => ({
  userId,
  name: userId,
  email: `${userId}@test.local`,
  image: null,
  role,
  joinedAt: "2026-10-01T00:00:00.000Z",
});

const manage: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://manage");
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  for await (const _ of req) {
    // drained
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  if (url.pathname === `/v1/tenants/${SOLO}/members`) {
    // One person; a client does not count.
    return json({
      members: [person("max", "owner"), person("wagner", "client")],
      invitations: [],
      seats: { limit: 1, taken: 1 },
    });
  }
  if (url.pathname === `/v1/tenants/${TEAM}/members`) {
    // The owner, and someone invited: two people.
    return json({
      members: [person("max", "owner")],
      invitations: [{ id: "i1", email: "anna@test.local", role: "member", expiresAt: "2026-12-01T00:00:00.000Z" }],
      seats: { limit: 5, taken: 2 },
    });
  }
  const tenant = url.pathname.match(/^\/v1\/tenants\/([^/]+)$/)?.[1];
  if (tenant) {
    return json({
      id: tenant,
      name: tenant === TEAM ? "Steuerberatung Fuchs" : "Team Max",
      status: "active",
      balanceCredits: 500,
      plan: { id: tenant === TEAM ? "team" : "free", name: tenant === TEAM ? "Team" : "Free" },
      limits: { concurrentRuns: 2, projects: null, members: tenant === TEAM ? 5 : 1, build: true },
      features: {},
      db: null,
    });
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
const issuer = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-org-spaces-managed-"));
process.env.APP_URL = "http://localhost:5181";
process.env.MANAGE_URL = issuer;
process.env.GATEWAY_URL = issuer;
process.env.MANAGE_CLIENT_ID = "wizards-runtime-test";
process.env.MANAGE_CLIENT_SECRET = "secret";
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "orgSpaces=on";

let db: typeof import("../src/db/client");
let spaces: typeof import("../src/services/spaces");

beforeAll(async () => {
  db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb(SOLO);
  await db.openTenantDb(TEAM);
  spaces = await import("../src/services/spaces");
}, 60_000);

afterAll(() => {
  manage.close();
});

describe("Mein Space in the cloud", () => {
  it("gives an organization of one person its root and nothing else", async () => {
    const listed = await db.withTenant(SOLO, () => spaces.listSpaces("max"));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ root: true, personal: false });
  });

  it("gives each person of a team a Mein Space only they reach", async () => {
    const max = await db.withTenant(TEAM, () => spaces.listSpaces("max"));
    expect(max.map((s) => [s.root, s.personal])).toEqual([
      [true, false],
      [false, true],
    ]);
    const anna = await db.withTenant(TEAM, () => spaces.listSpaces("anna"));
    expect(anna.filter((s) => s.personal)).toHaveLength(1);
    const maxOwn = max.find((s) => s.personal)?.id ?? "";
    expect(anna.map((s) => s.id)).not.toContain(maxOwn);
    await expect(db.withTenant(TEAM, () => spaces.ownedSpace("anna", maxOwn))).rejects.toThrow();
  });

  it("makes a computer's space the person's Mein Space in a team", async () => {
    await db.withTenant(TEAM, () =>
      db.db.insert(db.schema.space).values({ id: "laptop", tenantId: TEAM, name: "Mein Computer", brand: {} }),
    );
    await db.withTenant(TEAM, () => spaces.placeArrivingSpace("laptop", "hans"));
    const row = await db.withTenant(TEAM, () =>
      db.db.query.space.findFirst({ where: (s, { eq }) => eq(s.id, "laptop") }),
    );
    const root = await db.withTenant(TEAM, () => spaces.rootSpace());
    expect(row).toMatchObject({ kind: "personal", parentId: root?.id });
    expect((await db.withTenant(TEAM, () => spaces.ownedSpace("hans", "laptop"))).id).toBe("laptop");
  });
});

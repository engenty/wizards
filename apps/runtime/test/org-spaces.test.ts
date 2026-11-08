import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Organization, spaces and folders (docs/plans/org-spaces.md): the oldest space is the
// organization's root; every other space sits under it; a person's Mein Space is theirs alone.

const dir = mkdtempSync(join(tmpdir(), "wizards-org-spaces-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "orgSpaces=on,clientSpaces=on";
process.env.LIMIT_SPACES = "8";

let db: typeof import("../src/db/client");
let spaces: typeof import("../src/services/spaces");
const local = <T>(fn: () => T | Promise<T>) => db.withTenant("local", fn);

beforeAll(async () => {
  db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb("local");
  spaces = await import("../src/services/spaces");
}, 60_000);

describe("the organization's spaces", () => {
  it("lists the first space as the root, alone at first", async () => {
    const listed = await local(() => spaces.listSpaces("local"));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ root: true, personal: false, parentId: null, clients: 0 });
  });

  it("makes a new space under the root", async () => {
    const { id } = await local(() => spaces.createSpace("local", "Jahresabschlüsse"));
    const root = await local(() => spaces.rootSpace());
    const listed = await local(() => spaces.listSpaces("local"));
    expect(listed.map((s) => s.id)).toEqual([root?.id, id]);
    expect(listed[1]).toMatchObject({ parentId: root?.id, root: false });
  });

  it("puts a space made before the switch under the root, once", async () => {
    await local(() =>
      db.db.insert(db.schema.space).values({ id: "older", tenantId: "local", name: "Lohn", brand: {} }),
    );
    const root = await local(() => spaces.rootSpace());
    const listed = await local(() => spaces.listSpaces("local"));
    expect(listed.find((s) => s.id === "older")).toMatchObject({ parentId: root?.id });
    expect(listed[0].id).toBe(root?.id);
  });

  it("keeps Mein Space to its person: nobody else reaches it", async () => {
    const root = await local(() => spaces.rootSpace());
    if (!root) {
      throw new Error("no root");
    }
    const mine = await local(() => spaces.personalSpace("anna", root));
    expect(mine).toMatchObject({ kind: "personal", parentId: root.id });
    // Asked again, the same space.
    expect((await local(() => spaces.personalSpace("anna", root))).id).toBe(mine.id);
    expect((await local(() => spaces.ownedSpace("anna", mine.id))).id).toBe(mine.id);
    await expect(local(() => spaces.ownedSpace("max", mine.id))).rejects.toThrow();
    // Not in another person's list.
    const listed = await local(() => spaces.listSpaces("max"));
    expect(listed.map((s) => s.id)).not.toContain(mine.id);
  });

  it("lets a space under the root read the root's Wissen, and the root not the space's", async () => {
    const root = await local(() => spaces.rootSpace());
    if (!root) {
      throw new Error("no root");
    }
    const { id: child } = await local(() => spaces.createSpace("local", "Gründung"));
    const data = await import("../src/services/space-data");
    await local(() => data.createPage("local", root.id, { title: "Preisliste", markdown: "Erstberatung 120 Euro." }));
    await local(() => data.createPage("local", child, { title: "Notizen", markdown: "Nur für die Gründung." }));
    const { personCaller } = await import("../src/elements/caller");
    const { elementTools } = await import("../src/elements/catalogue");
    await local(async () => {
      const inChild = await elementTools(
        await personCaller({ space: { id: child, name: "Gründung" }, userId: "anna", role: "member", signal: new AbortController().signal }),
        { knowledge: true },
      );
      expect((await inChild.page_read.execute({ path: "pages/preisliste" })).page).toContain("120 Euro");
      expect((await inChild.page_read.execute({ path: "pages/notizen" })).page).toContain("Gründung");
      const inRoot = await elementTools(
        await personCaller({ space: { id: root.id, name: root.name }, userId: "anna", role: "member", signal: new AbortController().signal }),
        { knowledge: true },
      );
      const missing = await inRoot.page_read.execute({ path: "pages/notizen" });
      expect(JSON.stringify(missing)).not.toContain("Nur für die Gründung");
    });
  });

  it("shares a space under the root with a Kund:in, who then reaches it and nothing else", async () => {
    const { id: shared } = await local(() => spaces.createSpace("local", "Wagner GmbH"));
    const clients = await import("../src/services/client-spaces");
    await local(() => clients.addSpaceMember("local", shared, { userId: "wagner", role: "client" }));
    const rwx = await import("../src/broker/rwx");
    const { asRole } = await import("../src/services/access");
    await local(async () => {
      expect(
        (await rwx.decide(shared, [{ kind: "role", id: "client" }], { kind: "page", id: "p" }, "w")).ok,
      ).toBe(true);
      await asRole("client", async () => {
        expect((await spaces.listSpaces("wagner")).map((s) => s.id)).toEqual([shared]);
        const root = await spaces.rootSpace();
        await expect(spaces.ownedSpace("wagner", root?.id ?? "")).rejects.toThrow();
      });
    });
    const listed = await local(() => spaces.listSpaces("local"));
    expect(listed.find((s) => s.id === shared)).toMatchObject({ clients: 1 });
    // The root and Mein Space are not shared this way.
    const root = await local(() => spaces.rootSpace());
    await expect(
      local(() => clients.addSpaceMember("local", root?.id ?? "", { userId: "wagner", role: "client" })),
    ).rejects.toThrow();
  });

  it("puts a computer's space under a root that holds something", async () => {
    await local(() =>
      db.db.insert(db.schema.space).values({ id: "laptop1", tenantId: "local", name: "Mein Computer", brand: {} }),
    );
    await local(() => spaces.placeArrivingSpace("laptop1", "local"));
    const root = await local(() => spaces.rootSpace());
    const row = await local(() => db.db.query.space.findFirst({ where: (sp, { eq }) => eq(sp.id, "laptop1") }));
    expect(row).toMatchObject({ parentId: root?.id, kind: "space" });
  });

  it("makes a computer's space the root of an organization alone, in place of an empty one", async () => {
    await db.openTenantDb("solo");
    const solo = <T>(fn: () => T | Promise<T>) => db.withTenant("solo", fn);
    const [empty] = await solo(() => spaces.listSpaces("solo"));
    await solo(() =>
      db.db.insert(db.schema.space).values({ id: "laptop2", tenantId: "solo", name: "Mein Computer", brand: {} }),
    );
    await solo(() => spaces.placeArrivingSpace("laptop2", "solo"));
    expect((await solo(() => spaces.rootSpace()))?.id).toBe("laptop2");
    const gone = await solo(() => db.db.query.space.findFirst({ where: (sp, { eq }) => eq(sp.id, empty.id) }));
    expect(gone).toBeUndefined();
  });

  it("does not count Mein Space against the number of spaces", async () => {
    const before = (await local(() => spaces.listSpaces("local"))).filter((s) => !s.personal);
    expect(before.length).toBe(6);
  });
});

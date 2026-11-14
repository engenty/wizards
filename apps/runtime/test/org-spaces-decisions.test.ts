import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The open points of docs/plans/org-spaces.md, decided on 2026-11-08: who sees a new space, a
// space's brand and Info taken from the organization or its own, and what counts against the
// plan's number of spaces.

const dir = mkdtempSync(join(tmpdir(), "wizards-org-decisions-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "orgSpaces=on,clientSpaces=on";
process.env.LIMIT_SPACES = "3";

let db: typeof import("../src/db/client");
let spaces: typeof import("../src/services/spaces");
let members: typeof import("../src/services/client-spaces");
const local = <T>(fn: () => T | Promise<T>) => db.withTenant("local", fn);

async function root() {
  const found = await local(() => spaces.rootSpace());
  if (!found) {
    throw new Error("no root");
  }
  return found;
}

const row = (id: string) =>
  local(() => db.db.query.space.findFirst({ where: (s, { eq }) => eq(s.id, id) }));

beforeAll(async () => {
  db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb("local");
  spaces = await import("../src/services/spaces");
  members = await import("../src/services/client-spaces");
  await local(() => spaces.listSpaces("local"));
}, 60_000);

describe("who sees a space", () => {
  it("shows a space shared with chosen people only to them", async () => {
    const { id } = await local(() => spaces.createSpace("local", "Übernahme", "members"));
    expect((await local(() => spaces.listSpaces("local"))).map((s) => s.id)).toContain(id);
    expect((await local(() => spaces.listSpaces("max"))).map((s) => s.id)).not.toContain(id);
    await expect(local(() => spaces.ownedSpace("max", id))).rejects.toThrow();

    await local(() => members.addSpaceMember("local", id, { userId: "max", role: "member" }));
    expect((await local(() => spaces.listSpaces("max"))).map((s) => s.id)).toContain(id);
    await local(() => members.removeSpaceMember("local", id, "max"));
    expect((await local(() => spaces.listSpaces("max"))).map((s) => s.id)).not.toContain(id);

    // Opened to everyone later, in Teilen.
    await local(() => spaces.updateSpace("local", id, { access: "all" }));
    expect((await local(() => spaces.listSpaces("max"))).map((s) => s.id)).toContain(id);
  });

  it("keeps the root open to everyone", async () => {
    const r = await root();
    await expect(
      local(() => spaces.updateSpace("local", r.id, { access: "members" })),
    ).rejects.toThrow();
  });
});

describe("brand and Info", () => {
  it("gives a new space the organization's, kept in step until it takes its own", async () => {
    const r = await root();
    const facts = [{ key: "telefon", label: "Telefon", value: "0662 12 34" }];
    await local(() =>
      spaces.updateSpace("local", r.id, { brand: { name: "Kanzlei Fuchs" }, facts }),
    );
    const { id } = await local(() => spaces.createSpace("local", "Gründungen"));
    expect(await row(id)).toMatchObject({ brandFrom: "root", brand: { name: "Kanzlei Fuchs" }, facts });

    // The organization changes its title: the space changes with it.
    await local(() => spaces.updateSpace("local", r.id, { brand: { name: "Fuchs & Partner" } }));
    expect((await row(id))?.brand.name).toBe("Fuchs & Partner");

    // Changed by hand, the space's brand is its own and stays when the organization's changes.
    await local(() => spaces.updateSpace("local", id, { brand: { name: "Gründerservice" } }));
    expect(await row(id)).toMatchObject({ brandFrom: "own", brand: { name: "Gründerservice" } });
    await local(() => spaces.updateSpace("local", r.id, { brand: { name: "Fuchs Steuerberatung" } }));
    expect((await row(id))?.brand.name).toBe("Gründerservice");

    // Taken from the organization again: the organization's as it is now.
    await local(() => spaces.updateSpace("local", id, { brandFrom: "root" }));
    expect(await row(id)).toMatchObject({
      brandFrom: "root",
      brand: { name: "Fuchs Steuerberatung" },
    });
  });

  it("shows the organization's logo in a space that takes its brand", async () => {
    const r = await root();
    await local(() =>
      db.db.insert(db.schema.spaceFile).values({
        id: "logo1",
        tenantId: "local",
        spaceId: r.id,
        name: "logo.svg",
        mime: "image/svg+xml",
        size: 10,
        kind: "logo",
        status: "ready",
      } as typeof db.schema.spaceFile.$inferInsert),
    );
    const taking = (await local(() => spaces.listSpaces("local"))).find(
      (s) => !s.root && s.brandFrom === "root",
    );
    const { mainLogoId } = await import("../src/services/brand");
    expect(await local(() => mainLogoId(taking?.id ?? ""))).toBe("logo1");
  });
});

describe("the number of spaces", () => {
  it("counts the root and team spaces, not client spaces", async () => {
    // The root and two team spaces: the plan's three.
    await expect(local(() => spaces.createSpace("local", "Lohn"))).rejects.toThrow();
    const { id } = await local(() => spaces.createSpace("local", "Wagner GmbH", "all", "client"));
    expect((await local(() => spaces.listSpaces("local"))).map((s) => s.id)).toContain(id);
    // A team space is still one too many.
    await expect(local(() => spaces.createSpace("local", "Lohn"))).rejects.toThrow();
  });
});

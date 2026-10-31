import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Client spaces (docs/plans/client-spaces.md): a space's clients, each in a client space under
// it, kept out of the space menu, seeded with rules for its clients; Knowledge read through to
// the space, where a client reads only what the space opened to clients; a client reaches only
// the client spaces they are in.

const dir = mkdtempSync(join(tmpdir(), "wizards-client-spaces-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "clientSpaces=on";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let clientId = "";
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

/** A caller of the catalogue in the client space, as a client or as the firm. */
async function caller(userId: string, role: "client" | "member") {
  const { personCaller } = await import("../src/elements/caller");
  return personCaller({
    space: { id: clientId, name: "Wagner GmbH" },
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
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
  const data = await import("../src/services/space-data");
  for (const [key, title, markdown] of [
    ["internal", "Honorare", "Unser Stundensatz für Wagner ist 180 Euro."],
    ["open", "Ablauf", "So läuft eine Beratung bei uns ab: drei Termine."],
  ]) {
    pages[key] = (await local(() => data.createPage("local", spaceId, { title, markdown }))).id;
  }
}, 60_000);

describe("client spaces", () => {
  it("are made under a space and stay out of the space list", async () => {
    clientId = (await json(send("POST", `/api/studio/spaces/${spaceId}/clients`, { name: "Wagner GmbH" }))).id;
    const { clients } = await json(send("GET", `/api/studio/spaces/${spaceId}/clients`));
    expect(clients).toEqual([expect.objectContaining({ id: clientId, name: "Wagner GmbH", clients: 0 })]);
    const spaces = await import("../src/services/spaces");
    const listed = await local(() => spaces.listSpaces("local"));
    expect(listed.map((s) => s.id)).not.toContain(clientId);
    // A client space holds no client spaces.
    expect((await send("POST", `/api/studio/spaces/${clientId}/clients`, { name: "x" })).status).toBe(404);
  });

  it("are seeded with rules for their clients; the space has none for them", async () => {
    const rwx = await import("../src/broker/rwx");
    await local(async () => {
      const page = { kind: "page" as const, id: "p" };
      expect((await rwx.decide(clientId, [{ kind: "role", id: "client" }], page, "w")).ok).toBe(true);
      expect((await rwx.decide(clientId, [{ kind: "role", id: "client" }], { kind: "setup", id: clientId }, "w")).ok).toBe(false);
      expect((await rwx.decide(spaceId, [{ kind: "role", id: "client" }], page, "r")).ok).toBe(false);
    });
  });

  it("read the space's Knowledge: a client only what is open to clients, the firm all of it", async () => {
    const data = await import("../src/services/space-data");
    await local(() => data.createPage("local", clientId, { title: "Unterlagen Wagner", markdown: "Vertrag liegt bei." }));
    await json(send("PUT", `/api/studio/spaces/${spaceId}/open-to-clients`, { kind: "page", id: pages.open, open: true }));
    const { open } = await json(send("GET", `/api/studio/spaces/${spaceId}/open-to-clients`));
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

  it("are all a client reaches: their own, never the space", async () => {
    await json(send("PUT", `/api/studio/spaces/${clientId}/members/wagner`, { role: "client" }));
    const { members } = await json(send("GET", `/api/studio/spaces/${clientId}/members`));
    expect(members).toEqual([expect.objectContaining({ userId: "wagner", role: "client" })]);
    const spaces = await import("../src/services/spaces");
    const { asRole } = await import("../src/services/access");
    await local(() =>
      asRole("client", async () => {
        expect((await spaces.listSpaces("wagner")).map((s) => s.id)).toEqual([clientId]);
        expect((await spaces.defaultSpace("wagner")).id).toBe(clientId);
        await expect(spaces.ownedSpace("wagner", spaceId)).rejects.toThrow();
        await expect(spaces.ownedSpace("huber", clientId)).rejects.toThrow();
      }),
    );
  });

  it("go with their space", async () => {
    // A local install makes one space; the cloud's second one, written here directly.
    await local(() =>
      db.db.insert(db.schema.space).values({ id: "steuern", tenantId: "local", name: "Steuern", brand: {} }),
    );
    const sub = (await json(send("POST", "/api/studio/spaces/steuern/clients", { name: "Huber" }))).id;
    const spaces = await import("../src/services/spaces");
    await local(() => spaces.removeSpace("steuern"));
    const row = await local(() =>
      db.db.query.space.findFirst({ where: (s, { eq }) => eq(s.id, sub) }),
    );
    expect(row).toBeUndefined();
  });

  it("are not there while the switch is off", async () => {
    process.env.FEATURES = "clientSpaces=off";
    expect((await send("GET", `/api/studio/spaces/${spaceId}/clients`)).status).toBe(404);
    process.env.FEATURES = "clientSpaces=on";
  });
});

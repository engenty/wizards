import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-tenants-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");
let files: typeof import("../src/services/files");
let projects: typeof import("../src/services/projects");

const A = "tenant-a";
const B = "tenant-b";

const definition = {
  version: 1,
  title: "Geheimer Wizard",
  description: "Nur für A",
  avatar: "round",
  steps: [
    {
      id: "start",
      type: "page",
      title: "Start",
      fields: [{ id: "name", kind: "text", label: "Name" }],
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

let wizardId: string;
let shareToken: string;

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  wizards = await import("../src/services/wizards");
  files = await import("../src/services/files");
  projects = await import("../src/services/projects");
  app = (await import("../src/app")).default;
  await client.withTenant(A, async () => {
    const created = await wizards.createWizard("user-a", { definition });
    wizardId = created.id;
    await files.writeFile("user-a", wizardId, "data/secret.json", '{"secret":true}');
    await wizards.publishWizard("user-a", wizardId);
    shareToken = (await wizards.ownedWizard("user-a", wizardId)).shareToken;
  });
}, 60_000);

describe("tenants", () => {
  it("keeps each tenant in its own database", () => {
    expect(existsSync(join(dir, "tenants", `${A}.db`))).toBe(true);
    expect(existsSync(join(dir, "tenants", `${B}.db`))).toBe(false);
  });

  it("shows another tenant nothing", async () => {
    await client.withTenant(B, async () => {
      expect(await wizards.listWizards("user-b")).toEqual([]);
      await expect(wizards.ownedWizard("user-b", wizardId)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(files.readFile("user-b", wizardId, "data/secret.json")).rejects.toMatchObject({
        code: "not_found",
      });
      // The same user id in another tenant owns nothing there either.
      await expect(wizards.ownedWizard("user-a", wizardId)).rejects.toMatchObject({
        code: "not_found",
      });
      const own = await projects.listProjects("user-b");
      expect(own).toHaveLength(1);
      expect(own[0].wizardCount).toBe(0);
    });
    expect(existsSync(join(dir, "tenants", `${B}.db`))).toBe(true);
  });

  it("names a tenant's first space in the language of whoever opens the studio first", async () => {
    await client.withTenant("tenant-de", async () => {
      const [first] = await projects.listProjects("user-de", "de");
      expect(first.name).toBe("Mein Computer");
      // Once it exists, a later request in another language doesn't rename it.
      expect((await projects.listProjects("user-de", "en"))[0].name).toBe("Mein Computer");
    });
    await client.withTenant("tenant-en", async () => {
      expect((await projects.listProjects("user-en", "en"))[0].name).toBe("My computer");
    });
  });

  it("stores a tenant's files under the tenant's own prefix", () => {
    expect(existsSync(join(dir, "objects", "t", A, "blobs"))).toBe(true);
    expect(existsSync(join(dir, "objects", "t", B, "blobs"))).toBe(false);
  });

  it("refuses tenant tables outside a tenant", async () => {
    await expect(
      (async () => client.db.query.wizard.findMany())(),
    ).rejects.toThrow(/No tenant in context/);
  });

  it("finds the tenant of a public link, and only of a real one", async () => {
    const found = await app.fetch(
      new Request(`http://localhost:5181/api/public/wizards/${shareToken}`),
    );
    expect(found.status).toBe(200);
    expect(((await found.json()) as { title: string }).title).toBe("Geheimer Wizard");
    const unknown = await app.fetch(
      new Request("http://localhost:5181/api/public/wizards/not-a-token"),
    );
    expect(unknown.status).toBe(404);
  });

  it("starts a visitor's run in the wizard's tenant and finds it again by its id", async () => {
    const started = await app.fetch(
      new Request(`http://localhost:5181/api/public/wizards/${shareToken}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5181" },
        body: "{}",
      }),
    );
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };
    const cookie = started.headers.get("set-cookie")?.split(";")[0] ?? "";
    const view = await app.fetch(
      new Request(`http://localhost:5181/api/runs/${runId}`, { headers: { cookie } }),
    );
    expect(view.status).toBe(200);
    // Without the visitor's cookie the run is nobody's.
    const stranger = await app.fetch(new Request(`http://localhost:5181/api/runs/${runId}`));
    expect(stranger.status).toBe(404);
    await client.withTenant(B, async () => {
      const row = await client.db.query.run.findFirst();
      expect(row).toBeUndefined();
    });
  });

  it("forgets a deleted wizard's public link", async () => {
    await client.withTenant(A, () => wizards.deleteWizard("user-a", wizardId));
    const gone = await app.fetch(
      new Request(`http://localhost:5181/api/public/wizards/${shareToken}`),
    );
    expect(gone.status).toBe(404);
  });
});

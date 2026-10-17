import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-clients-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");
let clients: typeof import("../src/clients");

const definition = {
  version: 1,
  title: "Anfrage",
  description: "Eine Frage",
  avatar: "dome",
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

let token: string;

const start = (headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`http://localhost:5181/api/public/wizards/${token}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    }),
  );

const clientOfRun = async (runId: string) =>
  client.withTenant("tenant-a", async () => {
    const row = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) });
    return row?.client;
  });

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  wizards = await import("../src/services/wizards");
  clients = await import("../src/clients");
  app = (await import("../src/app")).default;
  await client.withTenant("tenant-a", async () => {
    const id = (await wizards.createWizard("user-a", { definition })).id;
    await wizards.publishWizard("user-a", id);
    token = (await wizards.ownedWizard("user-a", id)).shareToken;
  });
}, 60_000);

afterEach(() => clients.setClientList(null));

describe("the client that starts a run", () => {
  it("is kept on the run: web, app, or a registered id; a malformed one is nothing", async () => {
    for (const [header, kept] of [
      ["web", "web"],
      ["APP", "app"],
      ["acme-crm", "acme-crm"],
      ["Not An Id!", null],
    ] as const) {
      const res = await start({ "x-wizards-client": header });
      expect(res.status).toBe(200);
      const { runId } = (await res.json()) as { runId: string };
      expect(await clientOfRun(runId)).toBe(kept);
    }
    const bare = await start();
    expect(bare.status).toBe(200);
    expect(await clientOfRun(((await bare.json()) as { runId: string }).runId)).toBeNull();
  });

  it("is never refused where there is no list: a runtime that runs alone", () => {
    expect(clients.clientRefused("anything")).toBeNull();
    expect(clients.clientRefused(null)).toBeNull();
  });

  it("follows the list: revoked and unknown ids are refused, caps count per hour", async () => {
    clients.setClientList({
      clients: [
        { id: "web", name: "The runner", runsPerHour: null, revoked: false },
        { id: "gone", name: "A revoked partner", runsPerHour: null, revoked: true },
        { id: "small", name: "A capped partner", runsPerHour: 2, revoked: false },
      ],
      unknown: { allow: false, runsPerHour: null },
    });
    expect((await start({ "x-wizards-client": "web" })).status).toBe(200);
    const revoked = await start({ "x-wizards-client": "gone" });
    expect(revoked.status).toBe(403);
    expect(((await revoked.json()) as { code: string }).code).toBe("client_refused");
    expect((await start({ "x-wizards-client": "stranger" })).status).toBe(403);
    expect((await start()).status).toBe(403);
    expect((await start({ "x-wizards-client": "small" })).status).toBe(200);
    expect((await start({ "x-wizards-client": "small" })).status).toBe(200);
    const capped = await start({ "x-wizards-client": "small" });
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { code: string }).code).toBe("client_limit");
  });

  it("lets unknown ids run under the public cap when the list says so", async () => {
    clients.setClientList({ clients: [], unknown: { allow: true, runsPerHour: 1 } });
    expect((await start({ "x-wizards-client": "newcomer" })).status).toBe(200);
    expect((await start({ "x-wizards-client": "newcomer" })).status).toBe(429);
  });

  it("reads the Manage-App's list and refuses a shape it does not know", () => {
    const list = clients.parseClientList({
      clients: [{ id: "app", runsPerHour: 100 }, { id: "x", name: "X", revoked: true }],
      unknown: { allow: false },
    });
    expect(list.clients).toEqual([
      { id: "app", name: "app", runsPerHour: 100, revoked: false },
      { id: "x", name: "X", runsPerHour: null, revoked: true },
    ]);
    expect(list.unknown).toEqual({ allow: false, runsPerHour: null });
    expect(() => clients.parseClientList({})).toThrow();
    expect(() => clients.parseClientList({ clients: [{ id: "Bad Id" }] })).toThrow();
  });
});

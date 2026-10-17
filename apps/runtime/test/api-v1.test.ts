import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// What the WordPress plugin calls with a key: /api/v1/me, /wizards, /runs, /space, /plugins.
// A stand-in Manage-App knows two tenants: one on Pro with the contacts plugin, one on Free.

const RUNTIME = "http://localhost:5182";
const SERVICE_KEY = "wzr_test_service_key";
let issuer = "";

const TENANTS: Record<string, unknown> = {
  "tenant-pro": {
    id: "tenant-pro",
    name: "Elektro Huber",
    status: "active",
    balanceCredits: 500,
    plan: { id: "pro", name: "Pro" },
    limits: { concurrentRuns: 2, projects: 5, build: true, members: 1 },
    modules: ["contacts"],
    features: {},
    db: null,
  },
  "tenant-free": {
    id: "tenant-free",
    name: "Frei",
    status: "active",
    balanceCredits: 50,
    plan: { id: "free", name: "Free" },
    limits: { concurrentRuns: 2, projects: 1, build: false, members: 1 },
    modules: [],
    features: {},
    db: null,
  },
};

const KEYS: Record<string, unknown> = {
  wz_pro: { valid: true, keyId: "kp", name: "WordPress", userId: "user-p", userName: "Petra Huber", tenantId: "tenant-pro", role: "owner" },
  wz_free: { valid: true, keyId: "kf", name: "WordPress", userId: "user-f", userName: "Fritz", tenantId: "tenant-free", role: "owner" },
};

const manage: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", issuer);
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  if (url.pathname === "/.well-known/openid-configuration") {
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    });
  }
  if (url.pathname === "/jwks") {
    return json({ keys: [] });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  const tenant = url.pathname.match(/^\/v1\/tenants\/([^/]+)$/)?.[1];
  if (tenant) {
    return TENANTS[tenant] ? json(TENANTS[tenant]) : json({ error: "not found" }, 404);
  }
  if (url.pathname === "/v1/keys/verify") {
    return json(KEYS[JSON.parse(raw).key] ?? { valid: false });
  }
  if (url.pathname === "/v1/reservations") {
    return json({ id: "res-1" });
  }
  if (url.pathname === "/v1/reservations/release") {
    return json({ ok: true });
  }
  if (url.pathname.startsWith("/v1/runs/")) {
    return json({ credits: 0, steps: {} });
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

const dir = mkdtempSync(join(tmpdir(), "wizards-api-v1-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = RUNTIME;
process.env.MANAGE_URL = issuer;
process.env.GATEWAY_URL = issuer;
process.env.MANAGE_CLIENT_ID = "wizards-runtime-test";
process.env.MANAGE_CLIENT_SECRET = "secret";
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;
process.env.MARKETPLACE_URL = "off";

// Two plugins as the cloud has them: contacts in the Pro plan, appointments in none here.
const plugins = join(dir, "plugins");
mkdirSync(plugins);
for (const id of ["contacts", "appointments"]) {
  writeFileSync(
    join(plugins, `${id}.ts`),
    `export default (wizards: any) => {
  wizards.server.registerHttpRoute({ method: "GET", path: "/", handler: ({ user, query }: any) => ({ plugin: "${id}", tenant: user.tenantId, by: user.name, q: query.get("q") }) });
  wizards.server.registerHttpRoute({ method: "POST", path: "/", role: "admin", handler: () => ({ made: true }) });
};
`,
  );
}
process.env.PLUGINS_DIR = plugins;
process.env.PLUGINS_DEFAULT = "";
process.env.PLUGINS_WATCH = "0";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;

const call = (key: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.fetch(
    new Request(`${RUNTIME}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-api-key": key,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );

const WIZARD = {
  version: 1,
  title: "Angebotsanfrage",
  description: "Fragt, was gebraucht wird.",
  avatar: "round",
  steps: [
    {
      id: "start",
      type: "page",
      title: "Anfrage",
      fields: [
        { id: "name", kind: "text", label: "Name" },
        { id: "mail", kind: "email", label: "E-Mail" },
        { id: "what", kind: "textarea", label: "Worum geht es?" },
      ],
    },
    { id: "done", type: "result", title: "Danke", deliverables: [] },
  ],
};

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await (await import("../src/plugins/loader")).loadPlugins();
  app = (await import("../src/app")).default;
}, 60_000);

afterAll(() => manage.close());

describe("the API a website's plugin calls", () => {
  let token = "";
  let runId = "";

  it("says who a key acts for and what the plan has", async () => {
    const pro = (await (await call("wz_pro", "/api/v1/me")).json()) as any;
    expect(pro).toMatchObject({
      user: { id: "user-p", name: "Petra Huber", role: "owner" },
      tenant: { id: "tenant-pro", name: "Elektro Huber", plan: { id: "pro" } },
      build: true,
      plugins: ["contacts"],
      missing: ["appointments"],
      urls: { embed: `${RUNTIME}/embed.js`, upgrade: `${issuer}/billing?upgrade=pro` },
    });
    expect(pro.scopes).toContain("runs:read");
    const free = (await (await call("wz_free", "/api/v1/me")).json()) as any;
    expect(free).toMatchObject({ build: false, plugins: [], missing: ["contacts", "appointments"], spaces: [] });
    expect((await call("wz_nobody", "/api/v1/me")).status).toBe(401);
  });

  it("calls a plugin of the plan as the key's person, and refuses one the plan lacks", async () => {
    const list = await call("wz_pro", "/api/v1/plugins/contacts/?q=huber");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ plugin: "contacts", tenant: "tenant-pro", by: "Petra Huber", q: "huber" });
    const made = await call("wz_pro", "/api/v1/plugins/contacts/", { method: "POST", body: {} });
    expect(await made.json()).toEqual({ made: true });
    for (const [key, id] of [
      ["wz_pro", "appointments"],
      ["wz_free", "contacts"],
      ["wz_free", "appointments"],
    ]) {
      const refused = await call(key, `/api/v1/plugins/${id}/`);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "plugin", plugin: id });
    }
    expect((await call("wz_pro", "/api/v1/plugins/nothing/")).status).toBe(404);
  });

  it("lists the wizards with what a website embeds them by", async () => {
    const imported = await call("wz_pro", "/api/v1/wizards/import", {
      method: "POST",
      body: { publish: true, definition: WIZARD },
    });
    expect(imported.status).toBe(200);
    const { wizards } = (await (await call("wz_pro", "/api/v1/wizards")).json()) as any;
    expect(wizards).toHaveLength(1);
    expect(wizards[0]).toMatchObject({
      title: "Angebotsanfrage",
      published: true,
      publishedVersion: 1,
      available: true,
      plugins: [],
      standalone: { fit: "full", missing: [], optional: [], needs: [], without: [] },
    });
    expect(wizards[0].code).toMatch(/^[A-Z0-9]+$/);
    token = wizards[0].token;
    expect(wizards[0].shareUrl).toBe(`${RUNTIME}/w/${token}`);
  });

  it("hands the published wizard over as a package a website runs on its own", async () => {
    const { wizards } = (await (await call("wz_pro", "/api/v1/wizards")).json()) as any;
    const res = await call("wz_pro", `/api/v1/wizards/${wizards[0].id}/package`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.engenty.wizard+zip");
    expect(res.headers.get("content-disposition")).toContain('filename="angebotsanfrage.wizard"');
    const { unzipSync, strFromU8 } = await import("fflate");
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(entries["wizard.json"]));
    expect(manifest).toMatchObject({ format: "engenty-wizard", version: 1 });
    expect(manifest.definition.title).toBe("Angebotsanfrage");
    // Another tenant has no such wizard; a draft is not handed over.
    expect((await call("wz_free", `/api/v1/wizards/${wizards[0].id}/package`)).status).toBe(404);
  });

  it("lists what visitors left, with the page they started on and their answers", async () => {
    const started = await app.fetch(
      new Request(`${RUNTIME}/api/public/wizards/${token}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-wizards-visitor": "visitor-1" },
        body: JSON.stringify({ embedded: true, origin: "https://huber.example/kontakt#form" }),
      }),
    );
    expect(started.status).toBe(200);
    runId = ((await started.json()) as { runId: string }).runId;
    const answered = await app.fetch(
      new Request(`${RUNTIME}/api/runs/${runId}/pages/start`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-wizards-visitor": "visitor-1" },
        body: JSON.stringify({ values: { name: "Anna Berger", mail: "anna@example.com", what: "Wallbox" } }),
      }),
    );
    expect(answered.status).toBe(200);
    // The run reaches its result in the background.
    let list: any = null;
    for (let i = 0; i < 50; i++) {
      list = await (await call("wz_pro", "/api/v1/runs")).json();
      if (list.runs.length) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(list).toMatchObject({ total: 1, page: 1, pages: 1 });
    expect(list.runs[0]).toMatchObject({
      id: runId,
      wizard: "Angebotsanfrage",
      status: "done",
      origin: "https://huber.example/kontakt",
      email: "anna@example.com",
      summary: "Anna Berger · anna@example.com · Wallbox",
    });
    const one = (await (await call("wz_pro", `/api/v1/runs/${runId}`)).json()) as any;
    expect(one.answers).toEqual([
      { label: "Name", kind: "text", value: "Anna Berger" },
      { label: "E-Mail", kind: "email", value: "anna@example.com" },
      { label: "Worum geht es?", kind: "textarea", value: "Wallbox" },
    ]);
    expect(one.origin).toBe("https://huber.example/kontakt");
    expect((await (await call("wz_pro", "/api/v1/runs?q=wallbox")).json()).total).toBe(1);
    expect((await (await call("wz_pro", "/api/v1/runs?q=nichts")).json()).total).toBe(0);
    // Another tenant reads none of it.
    expect((await call("wz_free", `/api/v1/runs/${runId}`)).status).toBe(404);
  });

  it("reads a website into the space: details where it has none, pages into Knowledge", async () => {
    const started = await call("wz_pro", "/api/v1/space/site", {
      method: "POST",
      body: {
        url: "https://huber.example",
        name: "Elektro Huber GmbH",
        tagline: "Ihr Elektriker in Graz",
        facts: [{ label: "E-Mail", value: "office@huber.example" }],
        colors: [{ name: "Primär", value: "#E0531B" }],
        pages: [
          { key: "page:2", title: "Impressum", role: "imprint", url: "https://huber.example/impressum", markdown: "Elektro Huber GmbH, Hauptplatz 1, 8010 Graz" },
          { key: "page:3", title: "Leistungen", url: "https://huber.example/leistungen", markdown: "Wallboxen, Photovoltaik, Smart Home." },
        ],
        assist: false,
      },
    });
    expect(started.status).toBe(200);
    let job = (await started.json()) as any;
    for (let i = 0; i < 50 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = await (await call("wz_pro", `/api/v1/space/site/${job.id}`)).json();
    }
    expect(job).toMatchObject({ status: "done", pages: 2 });
    expect(job.space).toMatchObject({
      title: "Elektro Huber GmbH",
      about: "Ihr Elektriker in Graz",
      colors: [{ name: "Primär", value: "#e0531b" }],
      facts: [
        { label: "E-Mail", value: "office@huber.example" },
        { label: "Website", value: "https://huber.example" },
      ],
      knowledge: { pages: 2 },
      writable: true,
    });
    // Read again with a page less: what the admin set stays, the page gone from the site goes.
    const again = await call("wz_pro", "/api/v1/space/site", {
      method: "POST",
      body: { url: "https://huber.example", name: "Anders", pages: [{ key: "page:3", title: "Leistungen", markdown: "Wallboxen." }], assist: false },
    });
    job = await again.json();
    for (let i = 0; i < 50 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = await (await call("wz_pro", `/api/v1/space/site/${job.id}`)).json();
    }
    expect(job.space).toMatchObject({ title: "Elektro Huber GmbH", knowledge: { pages: 1 } });
  });

  it("tells a plan that builds nothing here that it does not", async () => {
    const res = await call("wz_free", "/api/v1/space/site", {
      method: "POST",
      body: { url: "https://frei.example", pages: [] },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "read_only" });
    const space = await call("wz_free", "/api/v1/space");
    expect(space.status).toBe(403);
    expect((await (await call("wz_free", "/api/v1/wizards")).json()).wizards).toEqual([]);
  });
});

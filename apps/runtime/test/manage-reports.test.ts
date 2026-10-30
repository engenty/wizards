import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A stand-in Manage-App that keeps what the runtime reports for the admin app
// (docs/plans/wizards-admin.md in the Manage repository): the team's wizards, each run's turns,
// the feedback at a run's end and the bug reports; its tenant answer carries holds.
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

const RUNTIME = "http://localhost:5181";
const SERVICE_KEY = "wzr_test_service_key";
const TENANT = "tenant-reports";
let issuer = "";

const sent: { path: string; method: string; body: any }[] = [];
let holds: { page: null; wizards: { id: string; reason: string }[] } = { page: null, wizards: [] };

function token(tenant: string, aud = RUNTIME) {
  return new SignJWT({
    scope: "openid wizards:read wizards:write wizards:publish runs:test",
    sub: `user-${tenant}`,
    tenant,
    role: "owner",
    name: `User ${tenant}`,
    email: `${tenant}@test.local`,
    azp: "wizards-desktop",
  })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setExpirationTime("10m")
    .sign(privateKey);
}

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
    return json({ keys: [jwk] });
  }
  if (url.pathname === "/token") {
    const form = new URLSearchParams(raw);
    return json({
      access_token: await token(form.get("code") ?? TENANT, form.get("resource") ?? RUNTIME),
      refresh_token: "refresh",
      expires_in: 600,
    });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  if (url.pathname === "/v1/grants/check") {
    return json({ active: true });
  }
  if (/^\/v1\/(wizards|runs|feedback|pages)\/[^/]+$/.test(url.pathname) || url.pathname === "/v1/bug-reports") {
    sent.push({ path: url.pathname, method: req.method ?? "", body: raw ? JSON.parse(raw) : null });
    return json(url.pathname === "/v1/bug-reports" ? { id: "bug-1" } : { ok: true, url: issuer });
  }
  if (url.pathname.startsWith("/v1/reservations")) {
    return json({ ok: true });
  }
  if (url.pathname.startsWith("/v1/runs/") && url.pathname.endsWith("/usage")) {
    return json({ credits: 0, steps: {} });
  }
  const tenant = url.pathname.match(/^\/v1\/tenants\/([^/]+)$/)?.[1];
  if (tenant) {
    return json({
      id: tenant,
      name: "Reports Team",
      slug: "reports",
      status: "active",
      balanceCredits: 500,
      limits: { concurrentRuns: 2, projects: 3, build: true },
      db: null,
      holds,
    });
  }
  if (url.pathname === "/v1/models") {
    const text = { model: "test/model", kind: "text", inputCreditsPerMTok: 1, outputCreditsPerMTok: 1 };
    return json({
      markup: 2,
      classes: { classifier: text, standard: text, high: text, highest: text, video: null },
      webSearchCredits: 2,
    });
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-reports-"));
process.env.APP_URL = RUNTIME;
process.env.MANAGE_URL = issuer;
process.env.GATEWAY_URL = issuer;
process.env.MANAGE_CLIENT_ID = "wizards-runtime-test";
process.env.MANAGE_CLIENT_SECRET = "secret";
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;
process.env.MARKETPLACE_URL = "off";
process.env.SANDBOX = "off";
process.env.PLUGINS_WATCH = "0";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

async function signIn(tenant: string): Promise<string> {
  const login = await app.fetch(new Request(`${RUNTIME}/api/auth/login?return=/`));
  const authorize = new URL(login.headers.get("location") ?? "");
  const callback = await app.fetch(
    new Request(
      `${RUNTIME}/api/auth/callback?code=${tenant}&state=${authorize.searchParams.get("state")}`,
      { headers: { cookie: cookieOf(login, "wz_oauth") } },
    ),
  );
  return cookieOf(callback, "wz_session");
}

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const res = await app.fetch(
    new Request(`${RUNTIME}${path}`, {
      method,
      headers: {
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        origin: RUNTIME,
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
  return { res, status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** A wizard that asks one thing and hands it back: a run needs no model. */
const definition = {
  version: 1,
  title: "Kurz notiert",
  description: "Eine Notiz, sonst nichts.",
  avatar: "drop",
  lang: "de",
  steps: [
    {
      id: "note",
      type: "page",
      title: "Notiz",
      fields: [{ id: "text", kind: "text", label: "Notiz", required: true }],
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

const settle = async () => {
  const { wizardsSettled } = await import("../src/services/manage-reports");
  await wizardsSettled();
  // A run's turn goes out on its own, a moment after the answer.
  await new Promise((r) => setTimeout(r, 150));
};

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await (await import("../src/plugins/loader")).loadPlugins();
  app = (await import("../src/app")).default;
}, 60_000);

afterAll(() => manage.close());

describe("what the runtime reports to the admin app", () => {
  let cookie = "";
  let wizard = "";
  let shareToken = "";
  let runId = "";
  let visitor = "";

  it("sends the team's wizards on a creation and on a publish", async () => {
    cookie = await signIn(TENANT);
    const [project] = (await call("GET", "/api/studio/projects", { cookie })).body;
    wizard = (await call("POST", "/api/studio/wizards", { cookie, body: { projectId: project.id } }))
      .body.id;
    await settle();
    const created = sent.filter((s) => s.path === `/v1/wizards/${TENANT}`).at(-1)?.body;
    expect(created.wizards).toEqual([
      expect.objectContaining({ id: wizard, published: false, template: null, runUrl: null }),
    ]);
    const current = (await call("GET", `/api/studio/wizards/${wizard}`, { cookie })).body;
    const draft = await call("PUT", `/api/studio/wizards/${wizard}/draft`, {
      cookie,
      body: { definition, baseRevision: current.revision },
    });
    expect(draft.status).toBe(200);
    const published = await call("POST", `/api/studio/wizards/${wizard}/publish`, { cookie });
    expect(published.status).toBe(200);
    shareToken = new URL(published.body.shareUrl).pathname.split("/").at(-1)!;
    await settle();
    const after = sent.filter((s) => s.path === `/v1/wizards/${TENANT}`).at(-1)?.body;
    expect(after.wizards[0]).toMatchObject({
      id: wizard,
      title: "Kurz notiert",
      published: true,
      runUrl: `${RUNTIME}/w/${shareToken}`,
      steps: 2,
      effort: expect.objectContaining({ fields: 1 }),
      outline: [
        { title: "Notiz", by: "you" },
        { title: "Fertig", by: "ai" },
      ],
      deliverables: [],
    });
  });

  it("reports a run's turns as it goes", async () => {
    const started = await call("POST", `/api/public/wizards/${shareToken}/runs`, { body: {} });
    expect(started.status).toBe(200);
    runId = started.body.runId;
    visitor = cookieOf(started.res, "wz_vid");
    await settle();
    const turns = sent.filter((s) => s.path === `/v1/runs/${TENANT}` && s.body.runId === runId);
    expect(turns[0].body).toMatchObject({ wizardId: wizard, via: "link", state: "waiting" });
  });

  it("takes the feedback at a run's end and sends it on", async () => {
    // Not over yet: no feedback.
    const early = await call("POST", `/api/runs/${runId}/feedback`, {
      cookie: visitor,
      body: { good: true },
    });
    expect(early.status).toBe(409);
    const { withTenant, db, schema } = await import("../src/db/client");
    const { eq } = await import("drizzle-orm");
    await withTenant(TENANT, () =>
      db.update(schema.run).set({ status: "done" }).where(eq(schema.run.id, runId)),
    );
    const res = await call("POST", `/api/runs/${runId}/feedback`, {
      cookie: visitor,
      body: { good: false, comment: "Zu lang" },
    });
    expect(res.status).toBe(200);
    expect(sent.find((s) => s.path === `/v1/feedback/${TENANT}`)?.body).toMatchObject({
      runId,
      wizardId: wizard,
      good: false,
      comment: "Zu lang",
    });
  });

  it("sends a bug report with the run's team and wizard", async () => {
    const res = await call("POST", "/api/bug-reports", {
      body: {
        where: "run",
        url: `${RUNTIME}/w/${shareToken}`,
        runId: runId,
        comment: "The button does nothing",
        logs: ["error boom"],
      },
    });
    expect(res.body).toEqual({ ok: true, sent: true, id: "bug-1" });
    expect(sent.find((s) => s.path === "/v1/bug-reports")?.body).toMatchObject({
      tenantId: TENANT,
      wizardId: wizard,
      runId,
      comment: "The button does nothing",
    });
  });

  it("starts no run of a held wizard", async () => {
    holds = { page: null, wizards: [{ id: wizard, reason: "Too expensive" }] };
    const { forgetTenant } = await import("../src/manage");
    forgetTenant(TENANT);
    const res = await call("POST", `/api/public/wizards/${shareToken}/runs`, { body: {} });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/paused/);
    holds = { page: null, wizards: [] };
    forgetTenant(TENANT);
    expect((await call("POST", `/api/public/wizards/${shareToken}/runs`, { body: {} })).status).toBe(200);
  });
});

describe("the catalog's featured entries", () => {
  it("puts the featured first, and leaves a search in its order", async () => {
    const { featuredFirst } = await import("../src/services/marketplace");
    const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra }) as any;
    const page = {
      entries: [entry("plain"), entry("featured-a", { featured: true }), entry("featured-b", { featured: true })],
      total: 3,
      all: 3,
      facets: {},
      offline: false,
      unavailable: [],
    } as any;
    const ids = (p: { entries: { id: string }[] }) => p.entries.map((e) => e.id);
    expect(ids(featuredFirst(page, {}))).toEqual(["featured-a", "featured-b", "plain"]);
    expect(ids(featuredFirst(page, { q: "invoice" }))).toEqual(["plain", "featured-a", "featured-b"]);
  });
});

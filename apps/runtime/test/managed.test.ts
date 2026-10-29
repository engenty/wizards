import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A stand-in Manage-App: OIDC discovery, JWKS, a token endpoint and the /v1 API of the contract.
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

const RUNTIME = "http://localhost:5181";
const SERVICE_KEY = "wzr_test_service_key";
const balances: Record<string, number> = { "tenant-a": 500, "tenant-b": 0 };
const reservations: { tenantId: string; runId: string; credits: number }[] = [];
const numberRequests: { tenantId: string; body: any }[] = [];
/** What the studio's first visit sent about an organization. */
const profiles: { tenantId: string; body: any }[] = [];
/** What the studio asked the Manage-App to change about a tenant's people. */
const memberCalls: { method: string; path: string; body: any }[] = [];
const channelUsage: { tenantId: string; body: any }[] = [];
// The Manage-App fails on tenant B's plan while this is set.
// Tenant B on a model tier, while a test sets one.
let tierOfB: Record<string, unknown> | null = null;
let tenantBDown = false;
// The Manage-App refuses reservations for visitors' runs while this is set (its guest budget).
let guestFull = false;
let issuer = "";

function token(claims: Record<string, unknown>, aud: string) {
  return new SignJWT({ scope: "openid wizards:read wizards:write wizards:publish runs:test", ...claims })
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
    const code = form.get("code");
    // code-m: a member of tenant A, who edits but neither makes nor deletes.
    const who = code === "code-b" ? "b" : code === "code-m" ? "m" : "a";
    return json({
      access_token: await token(
        {
          sub: `user-${who}`,
          tenant: who === "m" ? "tenant-a" : `tenant-${who}`,
          role: who === "m" ? "member" : "owner",
          name: `User ${who.toUpperCase()}`,
          email: `${who}@test.local`,
          azp: "wizards-runtime-test",
        },
        form.get("resource") ?? RUNTIME,
      ),
      refresh_token: `refresh-${who}`,
      expires_in: 600,
    });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  if (/^\/v1\/tenants\/[^/]+\/(invitations|members)(\/[^/]+)?$/.test(url.pathname) && req.method !== "GET") {
    const body = raw ? JSON.parse(raw) : {};
    memberCalls.push({ method: req.method ?? "", path: url.pathname, body });
    if (body.actorId === "user-m") {
      return json({ error: "Not allowed.", code: "forbidden" }, 403);
    }
    return json(
      url.pathname.endsWith("/invitations")
        ? { invitation: { id: "inv-2", email: body.email, role: body.role, expiresAt: "2026-10-30T00:00:00.000Z" } }
        : { ok: true },
    );
  }
  if (/^\/v1\/tenants\/[^/]+\/model-policy$/.test(url.pathname) && req.method === "PUT") {
    const body = JSON.parse(raw);
    memberCalls.push({ method: "PUT", path: url.pathname, body });
    return json({ modelPolicy: body.modelPolicy });
  }
  if (/^\/v1\/users\/[^/]+(\/connections|\/computers)?(\/[^/]+)?$/.test(url.pathname) && req.method !== "GET") {
    memberCalls.push({ method: req.method ?? "", path: url.pathname, body: raw ? JSON.parse(raw) : null });
    return json(req.method === "PATCH" ? { name: JSON.parse(raw).name } : { ok: true });
  }
  if (/^\/v1\/users\/[^/]+\/connections$/.test(url.pathname)) {
    memberCalls.push({ method: "GET", path: url.pathname, body: null });
    return json({ apps: [{ id: "consent-1", name: "Claude Code" }], computers: [] });
  }
  if (/^\/v1\/tenants\/[^/]+\/(billing|invoices)(\/|$)/.test(url.pathname)) {
    memberCalls.push({ method: req.method ?? "", path: url.pathname + url.search, body: null });
    if (url.pathname.endsWith("/pdf")) {
      return json({ url: "https://stripe.test/invoice.pdf" });
    }
    if (url.pathname.endsWith("/activity")) {
      return json({ entries: [{ id: 7, kind: "start", credits: 500 }] });
    }
    return json({ balanceCredits: 500, canBuy: true, invoices: [] });
  }
  if (/^\/v1\/tenants\/[^/]+\/(address|domains|keys)(\/|$)/.test(url.pathname)) {
    memberCalls.push({ method: req.method ?? "", path: url.pathname + url.search, body: raw ? JSON.parse(raw) : null });
    if (url.pathname.endsWith("/keys") && req.method === "POST") {
      return json({ id: "key-1", name: "Export", key: "wz_secret" });
    }
    if (url.pathname.endsWith("/keys")) {
      return json({ keys: [{ id: "key-1", name: "Export", start: "wz_s", createdAt: "2026-10-01T00:00:00.000Z", lastRequest: null }] });
    }
    if (url.pathname.endsWith("/address/check")) {
      return json({ ok: false, code: "taken" });
    }
    return json({ ok: true });
  }
  const members = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/members$/)?.[1];
  if (members) {
    return json({
      members: [
        { userId: "user-a", name: "User A", email: "a@test.local", image: null, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" },
        { userId: "user-m", name: "User M", email: "m@test.local", image: null, role: "member", joinedAt: "2026-10-02T00:00:00.000Z" },
      ],
      invitations: [{ id: "inv-1", email: "x@test.local", role: "member", expiresAt: "2026-10-20T00:00:00.000Z" }],
      seats: { limit: 5, taken: 3 },
    });
  }
  const profile = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/profile$/)?.[1];
  if (profile && req.method === "PUT") {
    profiles.push({ tenantId: profile, body: JSON.parse(raw) });
    return json({ ok: true });
  }
  // Tenant A has its number for texts and calls; tenant B asks for one.
  const channels = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/channels(\/requests|\/usage)?$/);
  if (channels) {
    const [, id, sub] = channels;
    if (sub === "/usage") {
      const body = JSON.parse(raw);
      channelUsage.push({ tenantId: id, body });
      return json({ credits: body.quantity * 10 });
    }
    if (sub === "/requests") {
      if (id === "tenant-a") {
        return json({ error: "The organization has its number.", code: "has_number" }, 409);
      }
      numberRequests.push({ tenantId: id, body: JSON.parse(raw) });
      return json({ request: { id: "req-1", country: "AT", wish: null, email: "b@test.local", createdAt: "2026-10-14T00:00:00.000Z" } });
    }
    return json({
      number:
        id === "tenant-a"
          ? { id: "n1", number: "+4318008081", country: "AT", kinds: ["sms", "call"], providerRef: "PN1", since: "2026-10-01T00:00:00.000Z" }
          : null,
      request: null,
      shared: [{ number: "+436600000000", country: "AT", kinds: ["whatsapp"] }],
      allowed: id === "tenant-a",
    });
  }
  // User A is in two organizations: their own and tenant A.
  const person = url.pathname.match(/^\/v1\/users\/([^/]+)$/)?.[1];
  if (person) {
    return json({
      id: person,
      features: {},
      admin: false,
      tenants:
        person === "user-a"
          ? [
              { id: "tenant-own", name: "User A", slug: "user-a", role: "owner", personal: true, plan: { id: "free", name: "Free" } },
              { id: "tenant-a", name: "tenant-a", slug: "tenant-a", role: "owner", personal: false, plan: { id: "team", name: "Team" } },
            ]
          : [],
    });
  }
  const tenant = url.pathname.match(/^\/v1\/tenants\/([^/]+)$/)?.[1];
  if (tenant) {
    if (tenantBDown && tenant === "tenant-b") {
      return json({ error: "down", code: "unavailable" }, 503);
    }
    return json({
      id: tenant,
      name: tenant,
      status: "active",
      balanceCredits: balances[tenant] ?? 0,
      // Tenant A is on a plan without a limit of spaces and without own keys.
      plan: tenant === "tenant-a" ? { id: "team", name: "Team" } : { id: "free", name: "Free" },
      limits: tenant === "tenant-a" ? { concurrentRuns: 2, projects: null, members: 5 } : { concurrentRuns: 2 },
      // The plugins this tenant has switched on, besides the runtime's PLUGINS_DEFAULT.
      ...(tenant === "tenant-a" ? { modules: ["teams", "not-installed"] } : {}),
      features: tenant === "tenant-a" ? { ownKeys: false } : tierOfB && tenant === "tenant-b" ? { modelTiers: true } : {},
      ...(tierOfB && tenant === "tenant-b" ? tierOfB : {}),
      db: null,
    });
  }
  if (url.pathname === "/v1/grants/check") {
    // The person disconnected this one on the account page.
    const { clientId } = JSON.parse(raw);
    return json({ active: clientId !== "disconnected-app" });
  }
  if (url.pathname === "/v1/keys/verify") {
    const { key } = JSON.parse(raw);
    return json(
      key === "wz_key_of_b"
        ? { valid: true, keyId: "kb", name: "Script", userId: "user-b", userName: "User B", tenantId: "tenant-b", role: "owner" }
        : { valid: false },
    );
  }
  if (url.pathname === "/v1/reservations") {
    const body = JSON.parse(raw);
    reservations.push(body);
    if (body.guest && guestFull) {
      return json({ error: "The guest budget is used up.", code: "guest_budget" }, 429);
    }
    return json({ id: `res-${reservations.length}` });
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

const dir = mkdtempSync(join(tmpdir(), "wizards-managed-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = RUNTIME;
process.env.MANAGE_URL = issuer;
process.env.GATEWAY_URL = issuer;
process.env.MANAGE_CLIENT_ID = "wizards-runtime-test";
process.env.MANAGE_CLIENT_SECRET = "secret";
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;

// Three plugins: one every tenant has, one the Manage-App lists for tenant A, one nobody has.
// The one every tenant has also reads the tenant's numbers and has a route for all tenants.
const plugins = join(dir, "plugins");
mkdirSync(plugins);
writeFileSync(
  join(plugins, "basics.ts"),
  `export default (wizards: any) => {
  const { server } = wizards;
  server.registerHttpRoute({ method: "GET", path: "/", handler: ({ user }: any) => ({ plugin: "basics", tenant: user.tenantId }) });
  server.registerHttpRoute({
    method: "GET",
    path: "/channels",
    handler: async () => ({ channels: await server.channels.get(), ref: await server.publicRef(), shared: server.sharedUrl("/hook") }),
  });
  server.registerHttpRoute({
    method: "POST",
    path: "/channels/request",
    handler: ({ user }: any) => server.channels.request({ userId: user.id, country: "at", lang: "de" }),
  });
  server.registerHttpRoute({
    method: "POST",
    path: "/channels/book",
    handler: () => server.channels.book({ kind: "sms", quantity: 2, key: "SM1", runId: "run-1" }),
  });
  server.registerHttpRoute({
    method: "POST",
    path: "/claims/:how",
    handler: async ({ params, json }: any) => {
      const { key } = await json();
      const done = await server.claims[params.how](key);
      return { done: done ?? null, mine: await server.claims.mine(key), holder: await server.claims.holder(key) };
    },
  });
  server.registerSharedRoute({
    method: "POST",
    path: "/hook",
    handler: async (request: any) => {
      const { ref } = await request.request.json();
      return request.inTenant(ref, async () => ({ number: (await server.channels.get())?.number?.number ?? null }));
    },
  });
};
`,
);
for (const id of ["teams", "spaces"]) {
  writeFileSync(
    join(plugins, `${id}.ts`),
    `export default (wizards: any) => {
  wizards.server.registerHttpRoute({ method: "GET", path: "/", handler: ({ user }: any) => ({ plugin: "${id}", tenant: user.tenantId }) });
};
`,
  );
}
process.env.PLUGINS_DIR = plugins;
process.env.PLUGINS_DEFAULT = "basics";
process.env.PLUGINS_WATCH = "0";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

/** Walks the sign-in a browser would: /login → (Manage-App) → /callback → session cookie. */
async function signIn(code: string): Promise<string> {
  const callback = await walkSignIn(code, "/studio/settings");
  expect(callback.headers.get("location")).toBe("/studio/settings");
  return cookieOf(callback, "wz_session");
}

/** The callback's answer to a sign-in that asked to come back to `back`. */
async function walkSignIn(code: string, back: string): Promise<Response> {
  const login = await app.fetch(
    new Request(`${RUNTIME}/api/auth/login?return=${encodeURIComponent(back)}`),
  );
  expect(login.status).toBe(302);
  const authorize = new URL(login.headers.get("location") ?? "");
  expect(authorize.origin).toBe(issuer);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("resource")).toBe(RUNTIME);
  const callback = await app.fetch(
    new Request(
      `${RUNTIME}/api/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`,
      { headers: { cookie: cookieOf(login, "wz_oauth") } },
    ),
  );
  expect(callback.status).toBe(302);
  return callback;
}

const get = (path: string, cookie: string) =>
  app.fetch(new Request(`${RUNTIME}${path}`, { headers: { cookie } }));
const post = (path: string, cookie: string, body: unknown) =>
  app.fetch(
    new Request(`${RUNTIME}${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await (await import("../src/plugins/loader")).loadPlugins();
  app = (await import("../src/app")).default;
}, 60_000);

afterAll(() => manage.close());

describe("a runtime of a Manage-App", () => {
  let a = "";
  let b = "";
  let wizardOfA = "";

  it("asks the organization once, the person once, and greets everyone else", async () => {
    const { writeSetting, deleteSetting } = await import("../src/settings");
    const mode = async (cookie: string) =>
      ((await (await get("/api/studio/me", cookie)).json()) as { onboarding: string | null }).onboarding;
    // Tenant B's owner is new to the studio, and nobody has set tenant B up.
    const b = await signIn("code-b");
    expect(await mode(b)).toBe("full");
    // Known from another organization: only tenant B's questions.
    await writeSetting("onboarding:person:user-b", { doneAt: "2026-10-01" });
    expect(await mode(b)).toBe("organization");
    expect((await post("/api/studio/onboarding/done", b, {})).status).toBe(200);
    expect(await mode(b)).toBeNull();
    // A member of tenant A gets the one page that says where they are, once.
    const m = await signIn("code-m");
    expect(await mode(m)).toBe("welcome");
    await post("/api/studio/onboarding/done", m, {});
    expect(await mode(m)).toBeNull();
    // The member's visit set no mark for the organization: its owner is still asked.
    const { readSetting } = await import("../src/settings");
    expect(await readSetting("onboarding:tenant-a")).toBeNull();
    await deleteSetting("onboarding:person:user-b");
  });

  it("signs people in there and takes user, tenant and role from the token", async () => {
    a = await signIn("code-a");
    b = await signIn("code-b");
    const me = (await (await get("/api/studio/me", a)).json()) as any;
    expect(me).toMatchObject({
      user: { id: "user-a", name: "User A" },
      tenant: { id: "tenant-a", role: "owner", name: "tenant-a", plan: { id: "team", name: "Team" } },
      features: { ownKeys: false },
      limits: { projects: null, build: true, create: true, members: 5 },
      mode: "managed",
      credits: 500,
      manageUrl: issuer,
      organizations: [
        { id: "tenant-own", slug: "user-a", personal: true },
        { id: "tenant-a", slug: "tenant-a", role: "owner", plan: { id: "team", name: "Team" } },
      ],
      mayCreateOrganization: false,
    });
    expect((await get("/api/studio/me", "")).status).toBe(401);
  });

  it("lets a member edit wizards, not make or delete them; shows the organization as the Manage-App keeps it", async () => {
    const m = await signIn("code-m");
    const me = (await (await get("/api/studio/me", m)).json()) as any;
    expect(me.tenant).toMatchObject({ id: "tenant-a", role: "member" });
    expect(me.limits.create).toBe(false);
    const [project] = (await (await get("/api/studio/projects", m)).json()) as { id: string }[];
    // Making: refused for a wizard, a space, a copy; by every door.
    const made = await post("/api/studio/wizards", m, { projectId: project.id });
    expect(made.status).toBe(403);
    expect(await made.json()).toMatchObject({
      code: "forbidden",
      error: expect.stringContaining("Only organization admins"),
    });
    // A reader whose English is British reads it spelt their way.
    const british = await app.fetch(
      new Request(`${RUNTIME}/api/studio/wizards`, {
        method: "POST",
        headers: { cookie: m, "content-type": "application/json", "accept-language": "en-GB,en;q=0.8" },
        body: JSON.stringify({ projectId: project.id }),
      }),
    );
    expect(((await british.json()) as { error: string }).error).toContain("Only organisation admins");
    expect((await post("/api/studio/projects", m, { name: "Neu" })).status).toBe(403);
    // A wizard the owner made: the member edits it, copies and deletes it not.
    const w = (await (await post("/api/studio/wizards", a, { projectId: project.id })).json()) as { id: string };
    expect((await post(`/api/studio/wizards/${w.id}/duplicate`, m, {})).status).toBe(403);
    expect(
      (await app.fetch(new Request(`${RUNTIME}/api/studio/wizards/${w.id}`, { method: "DELETE", headers: { cookie: m } }))).status,
    ).toBe(403);
    // Editing: the draft of a wizard that is there.
    const state = (await (await get(`/api/studio/wizards/${w.id}`, m)).json()) as { draft: unknown; revision: number };
    const edited = await app.fetch(
      new Request(`${RUNTIME}/api/studio/wizards/${w.id}/draft`, {
        method: "PUT",
        headers: { cookie: m, "content-type": "application/json" },
        body: JSON.stringify({ definition: state.draft, baseRevision: state.revision }),
      }),
    );
    expect(edited.status).toBe(200);
    // The owner still makes.
    expect((await post("/api/studio/wizards", a, { projectId: project.id })).status).toBe(200);
    // The organization page: people, invitations and places, from the Manage-App.
    const organization = (await (await get("/api/studio/organization", m)).json()) as any;
    expect(organization).toMatchObject({
      members: [{ userId: "user-a", role: "owner" }, { userId: "user-m", role: "member" }],
      invitations: [{ email: "x@test.local" }],
      seats: { limit: 5, taken: 3 },
      plan: { id: "team" },
      manageUrl: issuer,
      canManage: false,
    });
    expect(((await (await get("/api/studio/organization", a)).json()) as any).canManage).toBe(true);

    // People are invited, given roles and removed for the person signed in: the Manage-App
    // decides with their id, and its refusal comes back with its code.
    const send = (method: string, path: string, cookie: string, body?: unknown) =>
      app.fetch(
        new Request(`${RUNTIME}/api/studio/organization${path}`, {
          method,
          headers: { cookie, "content-type": "application/json", "accept-language": "en" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const invited = await send("POST", "/invitations", a, { email: "new@test.local", role: "admin" });
    expect(await invited.json()).toMatchObject({ invitation: { email: "new@test.local", role: "admin" } });
    expect((await send("PATCH", "/members/user-m", a, { role: "admin" })).status).toBe(200);
    expect((await send("DELETE", "/invitations/inv-1", a)).status).toBe(200);
    expect((await send("DELETE", "/members/user-m", a)).status).toBe(200);
    const refused = await send("POST", "/invitations", m, { email: "y@test.local" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "forbidden" });
    expect(memberCalls).toEqual([
      { method: "POST", path: "/v1/tenants/tenant-a/invitations", body: { actorId: "user-a", email: "new@test.local", role: "admin", lang: "en" } },
      { method: "PATCH", path: "/v1/tenants/tenant-a/members/user-m", body: { actorId: "user-a", role: "admin" } },
      { method: "DELETE", path: "/v1/tenants/tenant-a/invitations/inv-1", body: { actorId: "user-a" } },
      { method: "DELETE", path: "/v1/tenants/tenant-a/members/user-m", body: { actorId: "user-a" } },
      { method: "POST", path: "/v1/tenants/tenant-a/invitations", body: { actorId: "user-m", email: "y@test.local", role: "member", lang: "en" } },
    ]);

    // The address, own domains and API keys go the same way, for the person signed in.
    memberCalls.length = 0;
    expect(await (await send("GET", "/keys", m)).json()).toMatchObject({ keys: [{ id: "key-1" }] });
    expect(await (await send("POST", "/keys", m, { name: "Export" })).json()).toEqual({ id: "key-1", name: "Export", key: "wz_secret" });
    expect((await send("DELETE", "/keys/key-1", m)).status).toBe(200);
    expect(await (await send("GET", "/address/check?slug=acme", a)).json()).toEqual({ ok: false, code: "taken" });
    expect((await send("PUT", "/address", a, { slug: "acme" })).status).toBe(200);
    expect((await send("POST", "/domains", a, { domain: "acme.de" })).status).toBe(200);
    expect(memberCalls).toEqual([
      { method: "GET", path: "/v1/tenants/tenant-a/keys?actorId=user-m", body: null },
      { method: "POST", path: "/v1/tenants/tenant-a/keys", body: { actorId: "user-m", name: "Export" } },
      { method: "DELETE", path: "/v1/tenants/tenant-a/keys/key-1", body: { actorId: "user-m" } },
      { method: "GET", path: "/v1/tenants/tenant-a/address/check?slug=acme", body: null },
      { method: "PUT", path: "/v1/tenants/tenant-a/address", body: { actorId: "user-a", slug: "acme" } },
      { method: "POST", path: "/v1/tenants/tenant-a/domains", body: { actorId: "user-a", domain: "acme.de" } },
    ]);

    // Guthaben, Verbrauch and Rechnungen read the billing view; an invoice's PDF lies at Stripe.
    memberCalls.length = 0;
    expect(await (await send("GET", "/billing", m)).json()).toMatchObject({ balanceCredits: 500 });
    expect(await (await send("GET", "/billing/activity?limit=20&before=9", m)).json()).toEqual({
      entries: [{ id: 7, kind: "start", credits: 500 }],
    });
    const pdf = await send("GET", "/invoices/in_1/pdf", a);
    expect(pdf.status).toBe(302);
    expect(pdf.headers.get("location")).toBe("https://stripe.test/invoice.pdf");
    // Konto: the name and the connections are the person's, in every organization.
    const renamed = await app.fetch(
      new Request(`${RUNTIME}/api/studio/person/name`, {
        method: "PUT",
        headers: { cookie: m, "content-type": "application/json" },
        body: JSON.stringify({ name: "Mona Member" }),
      }),
    );
    expect(await renamed.json()).toEqual({ name: "Mona Member" });
    expect(((await (await get("/api/studio/me", m)).json()) as any).user.name).toBe("Mona Member");
    expect(await (await get("/api/studio/person/connections", m)).json()).toMatchObject({
      apps: [{ id: "consent-1" }],
    });
    const off = await app.fetch(
      new Request(`${RUNTIME}/api/studio/person/connections/consent-1`, { method: "DELETE", headers: { cookie: m } }),
    );
    expect(off.status).toBe(200);
    expect(memberCalls.slice(-3)).toEqual([
      { method: "PATCH", path: "/v1/users/user-m", body: { name: "Mona Member" } },
      { method: "GET", path: "/v1/users/user-m/connections", body: null },
      { method: "DELETE", path: "/v1/users/user-m/connections/consent-1", body: null },
    ]);
    memberCalls.splice(-3);
    expect(memberCalls.map((call) => call.path)).toEqual([
      "/v1/tenants/tenant-a/billing?actorId=user-m",
      "/v1/tenants/tenant-a/billing/activity?actorId=user-m&before=9&limit=20",
      "/v1/tenants/tenant-a/invoices/in_1/pdf?actorId=user-a",
    ]);
  });

  it("refuses own API keys where the plan has none, and lists its plugins to the Manage-App", async () => {
    const put = (body: unknown, cookie: string) =>
      app.fetch(
        new Request(`${RUNTIME}/api/studio/models`, {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const withKey = await put({ keys: { openai: "sk-test" } }, a);
    expect(withKey.status).toBe(403);
    expect(await withKey.json()).toMatchObject({ code: "plan" });
    // Tenant B's plan says nothing about keys: it keeps them.
    expect((await put({ keys: { openai: "sk-test" } }, b)).status).toBe(200);
    // When the Manage-App can't say what tenant B's plan holds, own keys wait; the rest is saved.
    const { forgetTenant } = await import("../src/manage");
    tenantBDown = true;
    forgetTenant("tenant-b");
    try {
      const unchecked = await put({ keys: { openai: "sk-test" } }, b);
      expect(unchecked.status).toBe(503);
      expect(await unchecked.json()).toMatchObject({ code: "manage_unavailable" });
      expect((await put({}, b)).status).toBe(200);
    } finally {
      tenantBDown = false;
      forgetTenant("tenant-b");
    }
    // A tier without own keys refuses them, whatever the plan says; so does the admins' policy.
    const rules = { regions: ["eu"], zdr: true, noTraining: true, search: false, decisions: false };
    try {
      tierOfB = { tier: { id: "eu-sovereign", name: "EU Sovereign", locked: true, rules: { ...rules, ownKeys: false }, classes: {} } };
      forgetTenant("tenant-b");
      const inTier = await put({ keys: { openai: "sk-test" } }, b);
      expect(inTier.status).toBe(403);
      expect(await inTier.json()).toMatchObject({ code: "tier" });
      expect((await put({}, b)).status).toBe(200);
      tierOfB = {
        tier: { id: "eu-private", name: "EU Private", locked: true, rules: { ...rules, ownKeys: true }, classes: {} },
        modelPolicy: { ownKeys: false },
      };
      forgetTenant("tenant-b");
      expect(await (await put({ keys: { openai: "sk-test" } }, b)).json()).toMatchObject({ code: "tier" });
      // The admins' policy goes to the Manage-App; what the tier rules out stays off.
      const open = { models: null, default: null, effortCap: null, efforts: null };
      const policy = {
        way: "C",
        purposes: { wizard: { ...open, models: ["standard"] }, assistant: open, work: open },
        credits: true,
        ownKeys: true,
        subscriptions: true,
        localModels: true,
        apps: { local: true, subscriptions: true },
        masking: true,
      };
      const saved = await app.fetch(
        new Request(`${RUNTIME}/api/studio/model-policy`, {
          method: "PUT",
          headers: { cookie: b, "content-type": "application/json" },
          body: JSON.stringify(policy),
        }),
      );
      expect(saved.status).toBe(200);
      expect(memberCalls.at(-1)).toMatchObject({
        path: "/v1/tenants/tenant-b/model-policy",
        body: {
          actorId: "user-b",
          modelPolicy: { way: "C", ownKeys: true, subscriptions: false, apps: { subscriptions: false } },
        },
      });
      memberCalls.pop();
    } finally {
      tierOfB = null;
      forgetTenant("tenant-b");
    }
    const plugins = await app.fetch(
      new Request(`${RUNTIME}/api/internal/plugins`, { headers: { authorization: `Bearer ${SERVICE_KEY}` } }),
    );
    expect(plugins.status).toBe(200);
    expect(((await plugins.json()) as { plugins: { id: string }[] }).plugins.map((p) => p.id).sort()).toEqual([
      "basics",
      "spaces",
      "teams",
    ]);
    expect((await app.fetch(new Request(`${RUNTIME}/api/internal/plugins`))).status).toBe(401);
  });

  it("gives each tenant its own studio", async () => {
    const [project] = (await (await get("/api/studio/projects", a)).json()) as { id: string }[];
    const created = await post("/api/studio/wizards", a, { projectId: project.id });
    wizardOfA = ((await created.json()) as { id: string }).id;
    expect((await get(`/api/studio/wizards/${wizardOfA}`, a)).status).toBe(200);
    // The other tenant's session finds nothing under that id, and lists none.
    expect((await get(`/api/studio/wizards/${wizardOfA}`, b)).status).toBe(404);
    const [projectB] = (await (await get("/api/studio/projects", b)).json()) as { id: string; wizardCount: number }[];
    expect(projectB.id).not.toBe(project.id);
    expect(projectB.wizardCount).toBe(0);
  });

  it("gives a tenant the plugins switched on for it, and never reloads one", async () => {
    const listed = async (cookie: string) =>
      ((await (await get("/api/studio/plugins", cookie)).json()) as { plugins: { id: string }[]; canReload: boolean });
    const ofA = await listed(a);
    expect(ofA.plugins.map((p) => p.id).sort()).toEqual(["basics", "teams"]);
    expect(ofA.canReload).toBe(false);
    expect((await listed(b)).plugins.map((p) => p.id)).toEqual(["basics"]);
    expect(await (await get("/api/studio/plugins/teams", a)).json()).toEqual({
      plugin: "teams",
      tenant: "tenant-a",
    });
    expect((await get("/api/studio/plugins/teams", b)).status).toBe(404);
    expect((await get("/api/studio/plugins/spaces", a)).status).toBe(404);
    expect((await get("/api/studio/plugins/basics", b)).status).toBe(200);
    // A reload would hit every tenant of the runtime.
    expect((await post("/api/studio/plugins/-/reload", a, {})).status).toBe(403);
    expect((await post("/api/studio/plugins/-/reload/teams", a, {})).status).toBe(403);
    expect((await get("/api/studio/plugins/-/events", a)).status).toBe(404);
  });

  it("gives a plugin the tenant's numbers, books what they carry, and enters a tenant from a shared route by its ref", async () => {
    const ofA = (await (await get("/api/studio/plugins/basics/channels", a)).json()) as any;
    expect(ofA.channels).toEqual({
      number: { number: "+4318008081", country: "AT", kinds: ["sms", "call"], providerRef: "PN1" },
      request: null,
      shared: [{ number: "+436600000000", country: "AT", kinds: ["whatsapp"] }],
      allowed: true,
    });
    expect(ofA.shared).toBe(`${RUNTIME}/api/public/plugins/basics/shared/hook`);
    expect(ofA.ref).toMatch(/^[\w-]{24}$/);
    const ofB = (await (await get("/api/studio/plugins/basics/channels", b)).json()) as any;
    expect(ofB.channels).toMatchObject({ number: null, allowed: false });
    expect(ofB.ref).not.toBe(ofA.ref);
    // Asking: refused as the Manage-App refuses, passed on with its code.
    const refused = await post("/api/studio/plugins/basics/channels/request", a, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "has_number" });
    const asked = await post("/api/studio/plugins/basics/channels/request", b, {});
    expect(await asked.json()).toMatchObject({ id: "req-1", country: "AT" });
    expect(numberRequests).toEqual([
      { tenantId: "tenant-b", body: { userId: "user-b", country: "AT", wish: null, lang: "de" } },
    ]);
    // Booking: the quantity goes, the Manage-App prices it.
    expect(await (await post("/api/studio/plugins/basics/channels/book", a, {})).json()).toEqual({ credits: 20 });
    expect(channelUsage).toEqual([
      { tenantId: "tenant-a", body: { kind: "sms", quantity: 2, idempotencyKey: "SM1", runId: "run-1" } },
    ]);
    // The shared route: one address, the tenant by the ref the call carries.
    const hook = (ref: string) =>
      app.fetch(new Request(ofA.shared, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref }) }));
    expect(await (await hook(ofA.ref)).json()).toEqual({ number: "+4318008081" });
    expect(await (await hook(ofB.ref)).json()).toEqual({ number: null });
    const unknown = await hook("x".repeat(24));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "not_found" });
    expect((await app.fetch(new Request(`${RUNTIME}/api/public/plugins/basics/shared/other`, { method: "POST" }))).status).toBe(404);
  });

  it("lets a plugin hold keys across tenants, each for one at a time", async () => {
    const claim = async (cookie: string, how: string, key: string) =>
      (await (await post(`/api/studio/plugins/basics/claims/${how}`, cookie, { key })).json()) as any;
    const refA = ((await (await get("/api/studio/plugins/basics/channels", a)).json()) as any).ref;
    const refB = ((await (await get("/api/studio/plugins/basics/channels", b)).json()) as any).ref;
    // Taken: the first one keeps it.
    expect(await claim(a, "take", "kw:zähler")).toEqual({ done: true, mine: true, holder: refA });
    expect(await claim(b, "take", "kw:zähler")).toEqual({ done: false, mine: false, holder: refA });
    // Put: the last one has it. Dropped only by the one that holds it.
    expect(await claim(b, "put", "sender:4366012345")).toMatchObject({ mine: true, holder: refB });
    expect(await claim(a, "put", "sender:4366012345")).toMatchObject({ mine: true, holder: refA });
    expect(await claim(b, "drop", "sender:4366012345")).toMatchObject({ holder: refA });
    expect(await claim(a, "drop", "sender:4366012345")).toMatchObject({ holder: null, mine: false });
    expect((await post("/api/studio/plugins/basics/claims/take", a, { key: "" })).status).toBe(400);
  });

  it("refuses a test run without credits and reserves credits with them", async () => {
    const [projectB] = (await (await get("/api/studio/projects", b)).json()) as { id: string }[];
    const wb = ((await (await post("/api/studio/wizards", b, { projectId: projectB.id })).json()) as { id: string }).id;
    const broke = await post(`/api/studio/wizards/${wb}/test-runs`, b, {});
    expect(broke.status).toBe(402);
    const ok = await post(`/api/studio/wizards/${wizardOfA}/test-runs`, a, {});
    expect(ok.status).toBe(200);
  });

  it("tells the Manage-App when a visitor starts a run, and says so when its budget is used up", async () => {
    const { reserveForRun } = await import("../src/credits/credits");
    const { withTenant } = await import("../src/db/client");
    reservations.length = 0;
    expect(await withTenant("tenant-a", () => reserveForRun("run-member", 5))).toBe(true);
    expect(await withTenant("tenant-a", () => reserveForRun("run-guest", 5, true))).toBe(true);
    expect(reservations.map((r: any) => [r.runId, r.guest ?? false])).toEqual([
      ["run-member", false],
      ["run-guest", true],
    ]);
    guestFull = true;
    expect(await withTenant("tenant-a", () => reserveForRun("run-guest-2", 5, true))).toBe("guest_budget");
    // A member's run is not held to the visitors' budget.
    expect(await withTenant("tenant-a", () => reserveForRun("run-member-2", 5))).toBe(true);
    guestFull = false;
  });

  it("accepts the Manage-App's tokens and keys on the MCP endpoint, in the token's tenant", async () => {
    const list = (authorization: string) =>
      app.fetch(
        new Request(`${RUNTIME}/api/mcp`, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "list_wizards", arguments: {} },
          }),
        }),
      );
    const asA = await list(
      `Bearer ${await token({ sub: "user-a", tenant: "tenant-a", role: "owner", azp: "claude-code" }, `${RUNTIME}/api/mcp`)}`,
    );
    expect(asA.status).toBe(200);
    const listed = await asA.text();
    expect(listed).toContain(wizardOfA);
    // Each wizard names its space and where the space comes from: ids are not for the person.
    expect(listed).toMatch(/spaceFrom\\?":\\?"here/);
    const asB = await list("Bearer wz_key_of_b");
    expect(asB.status).toBe(200);
    expect(await asB.text()).not.toContain(wizardOfA);
    // A token for another audience, an unknown key and no token are all turned away.
    const wrongAudience = await list(
      `Bearer ${await token({ sub: "user-a", tenant: "tenant-a" }, "https://elsewhere.example")}`,
    );
    expect(wrongAudience.status).toBe(401);
    expect((await list("Bearer wz_unknown")).status).toBe(401);
    // A token still signed and unexpired, of an app the person disconnected: its grant is gone.
    const disconnected = await list(
      `Bearer ${await token({ sub: "user-a", tenant: "tenant-a", role: "owner", azp: "disconnected-app" }, `${RUNTIME}/api/mcp`)}`,
    );
    expect(disconnected.status).toBe(401);
    const meta = await app.fetch(
      new Request(`${RUNTIME}/.well-known/oauth-protected-resource/api/mcp`),
    );
    expect(await meta.json()).toMatchObject({
      resource: `${RUNTIME}/api/mcp`,
      authorization_servers: [issuer],
    });
  });

  it("imports and publishes a wizard through the API", async () => {
    const res = await app.fetch(
      new Request(`${RUNTIME}/api/v1/wizards/import`, {
        method: "POST",
        headers: { authorization: "Bearer wz_key_of_b", "content-type": "application/json" },
        body: JSON.stringify({
          publish: true,
          definition: {
            version: 1,
            title: "Aus der Desktop-App",
            description: "",
            avatar: "round",
            steps: [
              { id: "start", type: "page", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
              { id: "done", type: "result", title: "Fertig", deliverables: [] },
            ],
          },
          files: [{ path: "data/a.json", data: Buffer.from("{}").toString("base64") }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wizardId: string; shareUrl: string; version: number };
    expect(body.version).toBe(1);
    const token_ = body.shareUrl.split("/w/")[1];
    const open = await app.fetch(new Request(`${RUNTIME}/api/public/wizards/${token_}`));
    // Tenant B has no credits: the link exists but cannot start runs.
    expect(((await open.json()) as { title: string; available: boolean })).toMatchObject({
      title: "Aus der Desktop-App",
      available: false,
    });
  });

  it("hands a sign-in from the system browser to the desktop app's window, once", async () => {
    // The app's window asks; the sign-in then runs in another browser.
    const start = await app.fetch(
      new Request(`${RUNTIME}/api/auth/desktop/start`, { method: "POST" }),
    );
    const windowCookie = cookieOf(start, "wz_desktop");
    const { url } = (await start.json()) as { url: string };
    const login = await app.fetch(new Request(url));
    const authorize = new URL(login.headers.get("location") ?? "");
    const callback = await app.fetch(
      new Request(
        `${RUNTIME}/api/auth/callback?code=code-a&state=${authorize.searchParams.get("state")}`,
        { headers: { cookie: cookieOf(login, "wz_oauth") } },
      ),
    );
    // The browser gets no session, only the link back into the app.
    expect(cookieOf(callback, "wz_session")).toBe("");
    const code = (await callback.text()).match(/engenty-wizards:\/\/signin\?code=([^"]+)"/)?.[1];
    expect(code).toBeTruthy();
    const handoff = (cookie: string) =>
      app.fetch(new Request(`${RUNTIME}/api/auth/handoff?code=${code}`, { headers: { cookie } }));
    // A window that did not ask (some web page sent the link) gets nothing.
    const stranger = await handoff("");
    expect(cookieOf(stranger, "wz_session")).toBe("");
    const mine = await handoff(windowCookie);
    const session = cookieOf(mine, "wz_session");
    expect(session).not.toBe("");
    expect((await get("/api/studio/me", session)).status).toBe(200);
    // The code works once.
    expect(cookieOf(await handoff(windowCookie), "wz_session")).toBe("");
  });

  it("returns from a sign-in into the studio or a public wizard, never elsewhere", async () => {
    const back = async (path: string) =>
      (await walkSignIn("code-a", path)).headers.get("location");
    expect(await back("/studio/new?starter=quiz")).toBe("/studio/new?starter=quiz");
    expect(await back("/studio")).toBe("/studio");
    expect(await back("/w/abc")).toBe("/w/abc");
    expect(await back("/s/abc")).toBe("/s/abc");
    for (const outside of ["/", "/new", "/studio-x", "//evil.example", "/\\evil.example"]) {
      expect(await back(outside)).toBe("/studio/");
    }
  });

  it("names the organization a switch asks for, and nothing that is not an address", async () => {
    const hint = async (organization: string) =>
      new URL(
        (
          await app.fetch(
            new Request(`${RUNTIME}/api/auth/login?return=/studio/&organization=${encodeURIComponent(organization)}`),
          )
        ).headers.get("location") ?? "",
      ).searchParams.get("organization");
    expect(await hint("tenant-a")).toBe("tenant-a");
    expect(await hint("a b")).toBeNull();
    expect(await hint("x".repeat(101))).toBeNull();
  });

  it("starts a sign-in again, once, when its state stayed in another browser", async () => {
    // The e-mail link opened on the phone: the code comes back without this browser's state.
    const elsewhere = await app.fetch(
      new Request(`${RUNTIME}/api/auth/callback?code=code-a&state=from-the-laptop`),
    );
    expect(elsewhere.status).toBe(302);
    const again = new URL(elsewhere.headers.get("location") ?? "", RUNTIME);
    expect(again.pathname).toBe("/api/auth/login");
    expect(again.searchParams.get("again")).toBe("1");
    // The second try carries its mark through the Manage-App …
    const login = await app.fetch(new Request(`${RUNTIME}${again.pathname}${again.search}`));
    const state = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect(state.startsWith("again.")).toBe(true);
    // … and goes through like any sign-in.
    const through = await app.fetch(
      new Request(`${RUNTIME}/api/auth/callback?code=code-a&state=${state}`, {
        headers: { cookie: cookieOf(login, "wz_oauth") },
      }),
    );
    expect(through.headers.get("location")).toBe("/studio/");
    expect(cookieOf(through, "wz_session")).not.toBe("");
    // Without its state a second time, it ends instead of going round.
    const twice = await app.fetch(
      new Request(`${RUNTIME}/api/auth/callback?code=code-a&state=${state}`),
    );
    expect(twice.headers.get("location")).toBe("/studio/?signin=failed");
  });

  it("takes a guest's wish along to the account's sign-in page", async () => {
    const login = await app.fetch(
      new Request(`${RUNTIME}/api/auth/login?return=/studio/new&wish=${encodeURIComponent("Ein Quiz")}`),
    );
    expect(new URL(login.headers.get("location") ?? "").searchParams.get("wish")).toBe("Ein Quiz");
    const long = await app.fetch(
      new Request(`${RUNTIME}/api/auth/login?return=/studio/new&wish=${"x".repeat(2000)}`),
    );
    expect(
      new URL(long.headers.get("location") ?? "").searchParams.get("wish")?.length,
    ).toBe(600);
  });

  it("offers an organization's addresses to its admins, and keeps profiles as facts", async () => {
    const owner = await signIn("code-a");
    const member = await signIn("code-m");
    // No model can search in the test, and test.local has no site: nothing is found.
    const found = await post("/api/studio/onboarding/find", owner, { name: "tenant-a" });
    expect(await found.json()).toEqual({ addresses: [] });
    expect((await post("/api/studio/onboarding/find", member, { name: "x" })).status).toBe(403);
    const [space] = (await (await get("/api/studio/projects", owner)).json()) as { id: string }[];
    const read = await post(`/api/studio/projects/${space.id}/website`, owner, {
      urls: ["instagram.com/baeckerei.huber", "https://www.linkedin.com/company/huber"],
    });
    expect(await read.json()).toBeNull();
    const after = (await (await get("/api/studio/projects", owner)).json()) as {
      id: string;
      facts: { label: string; value: string }[];
    }[];
    expect(after.find((p) => p.id === space.id)?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Instagram", value: "https://instagram.com/baeckerei.huber" }),
        expect.objectContaining({ label: "LinkedIn" }),
      ]),
    );
  });

  it("hands what an organization says about itself to the Manage-App, from its owner only", async () => {
    const owner = await signIn("code-a");
    const put = (cookie: string, body: unknown) =>
      app.fetch(
        new Request(`${RUNTIME}/api/studio/organization/profile`, {
          method: "PUT",
          headers: { cookie, "content-type": "application/json", origin: RUNTIME },
          body: JSON.stringify(body),
        }),
      );
    const res = await put(owner, { kind: "small", size: "2-9", sector: "Tischlerei" });
    expect(res.status).toBe(200);
    expect(profiles.at(-1)).toMatchObject({
      tenantId: "tenant-a",
      body: { userId: "user-a", kind: "small", size: "2-9", sector: "Tischlerei" },
    });
    expect((await put(owner, { kind: "nonsense" })).status).toBe(400);
  });

  it("signs out here and names where the account's sign-in ends", async () => {
    const session = await signIn("code-a");
    const res = await post("/api/auth/sign-out", session, {});
    expect(await res.json()).toEqual({ ok: true, account: `${issuer}/api/sign-out` });
    expect((await get("/api/studio/me", session)).status).toBe(401);
  });

  it("suspends and deletes a tenant when the Manage-App says so", async () => {
    const tell = (id: string, action: string, key = SERVICE_KEY) =>
      app.fetch(
        new Request(`${RUNTIME}/api/internal/tenants/${id}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ action }),
        }),
      );
    expect((await tell("tenant-a", "suspend", "wrong")).status).toBe(401);
    expect((await tell("tenant-a", "suspend")).status).toBe(200);
    expect((await get("/api/studio/me", a)).status).toBe(403);
    expect((await tell("tenant-a", "resume")).status).toBe(200);
    expect((await get("/api/studio/me", a)).status).toBe(200);
    expect((await tell("tenant-a", "delete")).status).toBe(200);
    const projects = (await (await get("/api/studio/projects", a)).json()) as { wizardCount: number }[];
    expect(projects[0].wizardCount).toBe(0);
  });
});

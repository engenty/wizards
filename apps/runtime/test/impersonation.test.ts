import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A stand-in Manage-App whose tokens for `code-imp…` name an admin signed in as Vera (`act`).
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

const RUNTIME = "http://localhost:5181";
const SERVICE_KEY = "wzr_test_service_key";
const UNTIL = Math.floor(Date.now() / 1000) + 3600;
/** What the runtime asked the Manage-App to change. */
const changes: { method: string; path: string }[] = [];
let issuer = "";

function token(claims: Record<string, unknown>, aud: string, expiresIn: string) {
  return new SignJWT({ scope: "openid wizards:read wizards:write wizards:publish runs:test", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

const vera = { sub: "user-v", tenant: "tenant-v", role: "owner", name: "Vera Team", email: "vera@test.local" };
const act = { sub: "user-admin", email: "admin@test.local", until: UNTIL };

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
    const code = form.get("code") ?? "";
    const refresh = form.get("refresh_token") ?? "";
    // The sign-in as Vera is over: the Manage-App refuses the refresh.
    if (refresh === "refresh-ended") {
      return json({ error: "invalid_grant", error_description: "The sign-in as this person has ended." }, 400);
    }
    // A renewal that comes back without the admin.
    if (refresh === "refresh-plain") {
      return json({ access_token: await token(vera, RUNTIME, "10m"), refresh_token: "refresh-plain", expires_in: 600 });
    }
    // code-imp-short: a token that runs out at once, so the next request renews it.
    const short = code.startsWith("code-imp-short");
    return json({
      access_token: await token(
        code.startsWith("code-imp") ? { ...vera, act } : vera,
        form.get("resource") ?? RUNTIME,
        short ? "2s" : "10m",
      ),
      refresh_token: code === "code-imp-short-ended" ? "refresh-ended" : code === "code-imp-short-plain" ? "refresh-plain" : "refresh-v",
      expires_in: short ? 2 : 600,
    });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  if (req.method !== "GET" && !url.pathname.startsWith("/v1/reservations") && !url.pathname.startsWith("/v1/runs/")) {
    changes.push({ method: req.method ?? "", path: url.pathname });
  }
  if (/^\/v1\/tenants\/[^/]+\/keys$/.test(url.pathname)) {
    return json(req.method === "POST" ? { id: "key-1", name: "Export", key: "wz_secret" } : { keys: [] });
  }
  if (/^\/v1\/users\/[^/]+$/.test(url.pathname)) {
    return json(req.method === "PATCH" ? { name: "x" } : { id: "user-v", features: {}, admin: false, tenants: [] });
  }
  const tenant = url.pathname.match(/^\/v1\/tenants\/([^/]+)$/)?.[1];
  if (tenant) {
    return json({
      id: tenant,
      name: "Vera's team",
      status: "active",
      balanceCredits: 500,
      plan: { id: "free", name: "Free" },
      limits: { concurrentRuns: 2 },
      features: {},
      db: null,
    });
  }
  if (url.pathname === "/v1/reservations") {
    return json({ id: "res-1" });
  }
  if (url.pathname.startsWith("/v1/runs/")) {
    return json({ credits: 0, steps: {} });
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-impersonation-"));
process.env.APP_URL = RUNTIME;
process.env.MANAGE_URL = issuer;
process.env.GATEWAY_URL = issuer;
process.env.MANAGE_CLIENT_ID = "wizards-runtime-test";
process.env.MANAGE_CLIENT_SECRET = "secret";
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;
process.env.PLUGINS_WATCH = "0";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;

const setCookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "";
const cookieOf = (res: Response, name: string) => setCookieOf(res, name).split(";")[0] ?? "";

/** The callback's answer to a sign-in with this code. */
async function callback(code: string): Promise<Response> {
  const login = await app.fetch(new Request(`${RUNTIME}/api/auth/login?return=%2Fstudio%2F`));
  const authorize = new URL(login.headers.get("location") ?? "");
  return app.fetch(
    new Request(`${RUNTIME}/api/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`, {
      headers: { cookie: cookieOf(login, "wz_oauth") },
    }),
  );
}
const signIn = async (code: string) => cookieOf(await callback(code), "wz_session");

const get = (path: string, cookie: string) => app.fetch(new Request(`${RUNTIME}${path}`, { headers: { cookie } }));
const send = (method: string, path: string, cookie: string, body: unknown = {}) =>
  app.fetch(
    new Request(`${RUNTIME}${path}`, {
      method,
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

describe("an admin signed in as someone", () => {
  let imp = "";

  it("keeps the admin on the session, until the sign-in ends", async () => {
    const res = await callback("code-imp");
    imp = cookieOf(res, "wz_session");
    const maxAge = Number(setCookieOf(res, "wz_session").match(/Max-Age=(\d+)/i)?.[1]);
    expect(maxAge).toBeGreaterThan(3500);
    expect(maxAge).toBeLessThanOrEqual(3600);
    const me = (await (await get("/api/studio/me", imp)).json()) as any;
    expect(me.user.id).toBe("user-v");
    expect(me.impersonation).toEqual({ adminEmail: "admin@test.local", until: UNTIL * 1000 });

    const own = await signIn("code-v");
    expect(((await (await get("/api/studio/me", own)).json()) as any).impersonation).toBeNull();
  });

  it("tells the wizard page, and nobody else", async () => {
    expect(await (await get("/api/public/impersonation", imp)).json()).toEqual({ name: "Vera Team", until: UNTIL * 1000 });
    expect(await (await get("/api/public/impersonation", await signIn("code-v"))).json()).toBeNull();
    expect(await (await get("/api/public/impersonation", "")).json()).toBeNull();
  });

  it("changes nothing of the person's account or organization", async () => {
    changes.length = 0;
    for (const [method, path, body] of [
      ["POST", "/api/studio/organization/keys", { name: "Export" }],
      ["POST", "/api/studio/organization/invitations", { email: "x@test.local", role: "member" }],
      ["DELETE", "/api/studio/organization/members/user-x", {}],
      ["PUT", "/api/studio/organization/address", { slug: "other" }],
      ["PUT", "/api/studio/person/name", { name: "Changed" }],
      ["DELETE", "/api/studio/person/connections/consent-1", {}],
    ] as const) {
      const res = await send(method, path, imp, body);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { code: string }).code, path).toBe("impersonating");
    }
    expect((await get("/api/studio/organization/invoices/inv-1/pdf", imp)).status).toBe(403);
    expect(changes).toEqual([]);
    // Looking stays possible.
    expect((await get("/api/studio/organization/keys", imp)).status).toBe(200);
    // The person themselves still can.
    const own = await signIn("code-v");
    expect((await send("POST", "/api/studio/organization/keys", own, { name: "Export" })).status).toBe(200);
    expect(changes).toEqual([{ method: "POST", path: "/v1/tenants/tenant-v/keys" }]);
  });

  it("marks the runs it starts with the admin", async () => {
    const [space] = (await (await get("/api/studio/spaces", imp)).json()) as { id: string }[];
    const wizard = (await (await send("POST", "/api/studio/wizards", imp, { spaceId: space.id })).json()) as {
      id: string;
    };
    const started = await send("POST", `/api/studio/wizards/${wizard.id}/test-runs`, imp);
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };
    const { db, schema, withTenant } = await import("../src/db/client");
    const { eq } = await import("drizzle-orm");
    const row = await withTenant("tenant-v", () => db.query.run.findFirst({ where: eq(schema.run.id, runId) }));
    expect(row?.impersonatedBy).toBe("user-admin");
    expect(row?.userId).toBe("user-v");

    const own = await signIn("code-v");
    const mine = (await (await send("POST", `/api/studio/wizards/${wizard.id}/test-runs`, own)).json()) as {
      runId: string;
    };
    const ownRow = await withTenant("tenant-v", () => db.query.run.findFirst({ where: eq(schema.run.id, mine.runId) }));
    expect(ownRow?.impersonatedBy).toBeNull();
  });

  it("signs out to the admin's own account", async () => {
    const res = await send("POST", "/api/auth/sign-out", await signIn("code-imp"));
    expect(((await res.json()) as { account: string }).account).toBe(`${issuer}/api/impersonate/stop`);
    const own = await send("POST", "/api/auth/sign-out", await signIn("code-v"));
    expect(((await own.json()) as { account: string }).account).toBe(`${issuer}/api/sign-out`);
  });

  it("asks the Manage-App again within a minute, whatever the token's lifetime", async () => {
    const { controlDb, control } = await import("../src/db/client");
    const before = Date.now();
    await signIn("code-imp");
    await signIn("code-v");
    const rows = await controlDb.select().from(control.session);
    const newest = (userId: string, admin: boolean) =>
      rows
        .filter((r) => r.userId === userId && Boolean(r.impersonatedBy) === admin && r.createdAt.getTime() >= before - 1000)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    // The token is good for 10 minutes; the admin's sign-in as Vera renews after one.
    expect(newest("user-v", true)?.claimsExpireAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    // Vera's own session renews when her token runs out.
    expect(newest("user-v", false)?.claimsExpireAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
  });

  it("ends when the Manage-App refuses the renewal, or renews without the admin", async () => {
    const ended = await signIn("code-imp-short-ended");
    const plain = await signIn("code-imp-short-plain");
    await new Promise((r) => setTimeout(r, 2500));
    expect((await get("/api/studio/me", ended)).status).toBe(401);
    expect((await get("/api/studio/me", plain)).status).toBe(401);
  });
});

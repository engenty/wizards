import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Members in the Studio, one rule per space (docs/plans/capabilities.md, "Who sees the place"):
 * an owner and a member of one organization, two spaces, the rule on in one of them. Behind
 * `capabilities`; with it off, a member does what they did before.
 */

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

const RUNTIME = "http://localhost:5181";
const SERVICE_KEY = "wzr_test_service_key";
const TENANT = "tenant-s";
let issuer = "";

function token(claims: Record<string, unknown>, aud: string) {
  return new SignJWT({ scope: "openid wizards:read wizards:write wizards:publish runs:test", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setExpirationTime("10m")
    .sign(privateKey);
}

// A stand-in Manage-App: sign-in, and the organization with an owner (o) and a member (m).
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
    const who = new URLSearchParams(raw).get("code") === "code-m" ? "m" : "o";
    return json({
      access_token: await token(
        {
          sub: `user-${who}`,
          tenant: TENANT,
          role: who === "m" ? "member" : "owner",
          name: `User ${who.toUpperCase()}`,
          email: `${who}@test.local`,
          azp: "wizards-runtime-test",
        },
        new URLSearchParams(raw).get("resource") ?? RUNTIME,
      ),
      refresh_token: `refresh-${who}`,
      expires_in: 600,
    });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  if (url.pathname === `/v1/tenants/${TENANT}/members`) {
    return json({
      members: [
        { userId: "user-o", name: "User O", email: "o@test.local", image: null, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" },
        { userId: "user-m", name: "User M", email: "m@test.local", image: null, role: "member", joinedAt: "2026-10-02T00:00:00.000Z" },
      ],
      invitations: [],
      seats: { limit: 5, taken: 2 },
    });
  }
  if (url.pathname === `/v1/tenants/${TENANT}`) {
    return json({
      id: TENANT,
      name: TENANT,
      status: "active",
      balanceCredits: 500,
      plan: { id: "team", name: "Team" },
      limits: { concurrentRuns: 2, projects: null, members: 5 },
      features: {},
      db: null,
    });
  }
  if (/^\/v1\/users\/[^/]+$/.test(url.pathname)) {
    return json({ id: url.pathname.split("/").pop(), features: {}, admin: false, tenants: [] });
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-members-studio-"));
process.env.APP_URL = RUNTIME;
process.env.MANAGE_URL = issuer;
process.env.GATEWAY_URL = issuer;
process.env.MANAGE_CLIENT_ID = "wizards-runtime-test";
process.env.MANAGE_CLIENT_SECRET = "secret";
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;
process.env.PLUGINS_WATCH = "0";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

async function signIn(code: string): Promise<string> {
  const login = await app.fetch(new Request(`${RUNTIME}/api/auth/login?return=%2Fstudio`));
  const authorize = new URL(login.headers.get("location") ?? "");
  const callback = await app.fetch(
    new Request(`${RUNTIME}/api/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`, {
      headers: { cookie: cookieOf(login, "wz_oauth") },
    }),
  );
  return cookieOf(callback, "wz_session");
}

const send = (method: string, path: string, cookie: string, body?: unknown) =>
  app.fetch(
    new Request(`${RUNTIME}${path}`, {
      method,
      headers: { cookie, "content-type": "application/json", "accept-language": "en" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const get = (path: string, cookie: string) => send("GET", path, cookie);

/** Switches for the runtime: what `FEATURES` says counts unless the Manage-App says otherwise. */
const switches = (on: string[], off: string[] = []) => {
  process.env.FEATURES = [...on.map((name) => `${name}=on`), ...off.map((name) => `${name}=off`)].join(",");
};

let owner = "";
let member = "";
let open = "";
let closed = "";
let wizard = "";

type SpaceView = { id: string; membersStudio: boolean; studio: boolean };

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  app = (await import("../src/app")).default;
  owner = await signIn("code-o");
  member = await signIn("code-m");
  // The first space is made on the first look; the owner makes the second.
  [{ id: open }] = (await (await get("/api/studio/spaces", owner)).json()) as SpaceView[];
  ({ id: closed } = (await (await send("POST", "/api/studio/spaces", owner, { name: "Geschäftsführung" })).json()) as {
    id: string;
  });
  ({ id: wizard } = (await (await send("POST", "/api/studio/wizards", owner, { spaceId: open })).json()) as {
    id: string;
  });
}, 60_000);

afterAll(() => {
  manage.close();
  delete process.env.FEATURES;
});

describe("members in the Studio, switch off", () => {
  it("leaves a member where they were: every space's studio, no making", async () => {
    switches([], ["capabilities"]);
    expect((await get(`/api/studio/spaces/${closed}/knowledge`, member)).status).toBe(200);
    expect((await get(`/api/studio/wizards/${wizard}`, member)).status).toBe(200);
    const made = await send("POST", "/api/studio/wizards", member, { spaceId: open });
    expect(made.status).toBe(403);
    expect(((await made.json()) as { error: string }).error).toContain("Only organization admins");
    const spaces = (await (await get("/api/studio/spaces", member)).json()) as SpaceView[];
    expect(spaces.every((s) => s.studio && !s.membersStudio)).toBe(true);
  });
});

describe("members in the Studio, switch on", () => {
  it("closes every space's studio to a member until an admin opens it; Work still reads", async () => {
    switches(["capabilities"]);
    const spaces = (await (await get("/api/studio/spaces", member)).json()) as SpaceView[];
    expect(spaces.map((s) => s.studio)).toEqual([false, false]);
    for (const path of [`/api/studio/spaces/${open}/knowledge`, `/api/studio/spaces/${open}/data`, `/api/studio/wizards/${wizard}`]) {
      const refused = await get(path, member);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "forbidden", error: expect.stringContaining("open to its admins only") });
    }
    // What Work reads: the wizards to start, the files of the space.
    expect((await get(`/api/studio/spaces/${open}/wizards`, member)).status).toBe(200);
    expect((await get(`/api/studio/spaces/${open}/files`, member)).status).toBe(200);
    // The owner sees all of it, and every space open to them.
    expect((await get(`/api/studio/spaces/${closed}/knowledge`, owner)).status).toBe(200);
    const theirs = (await (await get("/api/studio/spaces", owner)).json()) as SpaceView[];
    expect(theirs.map((s) => s.studio)).toEqual([true, true]);
  });

  it("lets the admins alone set the rule", async () => {
    expect((await send("PATCH", `/api/studio/spaces/${open}`, member, { membersStudio: true })).status).toBe(403);
    expect((await send("PATCH", `/api/studio/spaces/${open}`, owner, { membersStudio: true })).status).toBe(200);
    const spaces = (await (await get("/api/studio/spaces", member)).json()) as SpaceView[];
    expect(spaces.find((s) => s.id === open)).toMatchObject({ membersStudio: true, studio: true });
    expect(spaces.find((s) => s.id === closed)).toMatchObject({ membersStudio: false, studio: false });
  });

  it("lets a member build in the open space, and only there", async () => {
    expect((await get(`/api/studio/spaces/${open}/knowledge`, member)).status).toBe(200);
    expect((await get(`/api/studio/wizards/${wizard}`, member)).status).toBe(200);
    const made = await send("POST", "/api/studio/wizards", member, { spaceId: open });
    expect(made.status).toBe(200);
    const table = await send("POST", `/api/studio/spaces/${open}/tables`, member, { title: "Leads" });
    expect(table.status).toBe(200);
    // The other space stays closed: its studio, its wizards, a wizard made there.
    expect((await get(`/api/studio/spaces/${closed}/knowledge`, member)).status).toBe(403);
    expect((await send("POST", "/api/studio/wizards", member, { spaceId: closed })).status).toBe(403);
    expect((await send("POST", `/api/studio/spaces/${closed}/tables`, member, { title: "Gehälter" })).status).toBe(403);
  });

  it("keeps publishing, sharing, connections and rules with the admins", async () => {
    switches(["capabilities", "broker"]);
    const published = await send("POST", `/api/studio/wizards/${wizard}/publish`, member, {});
    expect(published.status).toBe(403);
    expect(((await published.json()) as { error: string }).error).toContain("Only the space’s admins publish");
    expect((await send("PATCH", `/api/studio/wizards/${wizard}`, member, { shareEnabled: true })).status).toBe(403);
    expect((await send("POST", `/api/studio/wizards/${wizard}/rotate-link`, member, {})).status).toBe(403);
    const connection = await send("POST", `/api/studio/spaces/${open}/connections`, member, {
      connectorId: "hubspot",
      name: "HubSpot",
      signIn: "space",
    });
    expect(connection.status).toBe(403);
    expect((await get(`/api/studio/spaces/${open}/connections`, member)).status).toBe(200);
    expect((await send("PUT", `/api/studio/spaces/${open}/rules`, member, { rules: [] })).status).toBe(403);
    // The owner keeps everything.
    expect((await send("PATCH", `/api/studio/wizards/${wizard}`, owner, { shareEnabled: true })).status).toBe(200);
    expect((await get(`/api/studio/spaces/${open}/rules`, owner)).status).toBe(200);
  });
});

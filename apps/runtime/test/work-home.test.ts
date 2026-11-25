import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Work's chats are the chats of the team's Bot Server (wizards.bot). The runtime tells the studio
 * where that server is and fetches the pass that pairs the person's browser with it; the
 * studio's own chats are gone.
 */

const ORIGIN = "https://club.wizards.bot";
const MAKE = "https://account.test/home";
/** What the stand-in Manage-App answers for the team's Bot Server, and what it was asked. */
let home: Record<string, unknown> = { state: "none", mayMake: true, makeUrl: MAKE };
const asked: string[] = [];

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

const RUNTIME = "http://localhost:5181";
const SERVICE_KEY = "wzr_test_service_key";
const TENANT = "tenant-h";
let issuer = "";

function token(claims: Record<string, unknown>, aud: string) {
  return new SignJWT({ scope: "openid wizards:read wizards:write wizards:publish runs:test", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setExpirationTime("10m")
    .sign(privateKey);
}

// A stand-in Manage-App: sign-in, the organization with an owner (o) and a member (m), and the
// team's Bot Server as the studio asks for it.
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
  if (url.pathname === `/v1/tenants/${TENANT}/home`) {
    asked.push(`home ${url.searchParams.get("userId")}`);
    return json(home);
  }
  if (url.pathname === `/v1/tenants/${TENANT}/home/pass`) {
    const { userId } = JSON.parse(raw) as { userId: string };
    asked.push(`pass ${userId}`);
    return home.state === "running"
      ? json({ url: `${ORIGIN}/#admin=pass-of-${userId}` })
      : json({ error: "The Bot Server isn't running.", code: "not_running" }, 409);
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
  if (url.pathname === "/v1/grants/check") {
    return json({ active: true });
  }
  if (/^\/v1\/users\/[^/]+$/.test(url.pathname)) {
    return json({ id: url.pathname.split("/").pop(), features: {}, admin: false, tenants: [] });
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-work-home-"));
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

let owner = "";
let member = "";

beforeAll(async () => {
  process.env.FEATURES = "workMode=on";
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  app = (await import("../src/app")).default;
  owner = await signIn("code-o");
  member = await signIn("code-m");
}, 60_000);

afterAll(() => {
  manage.close();
  delete process.env.FEATURES;
});

describe("Work's chats on the team's Bot Server", () => {
  it("says that the team has none yet, and who runs one", async () => {
    const forOwner = await (await get("/api/studio/work/home", owner)).json();
    expect(forOwner).toEqual({ state: "none", mayMake: true, makeUrl: MAKE, may: true, runs: true });
    const forMember = await (await get("/api/studio/work/home", member)).json();
    expect(forMember).toMatchObject({ state: "none", may: true, runs: false });
    expect(asked).toEqual(["home user-o", "home user-m"]);
  });

  it("gives everyone of the team the address that pairs their browser, as themselves", async () => {
    home = { state: "running", address: "club", origin: ORIGIN, team: true, mayMake: false, makeUrl: MAKE };
    expect(await (await get("/api/studio/work/home", owner)).json()).toMatchObject({
      state: "running",
      origin: ORIGIN,
      team: true,
      may: true,
    });
    const pass = await send("POST", "/api/studio/work/home/pass", owner);
    expect(pass.status).toBe(200);
    expect(pass.headers.get("cache-control")).toBe("no-store");
    expect(await pass.json()).toEqual({ url: `${ORIGIN}/#admin=pass-of-user-o` });
    const forMember = await send("POST", "/api/studio/work/home/pass", member);
    expect(await forMember.json()).toEqual({ url: `${ORIGIN}/#admin=pass-of-user-m` });
    expect(await (await get("/api/studio/work/home", member)).json()).toMatchObject({
      may: true,
      runs: false,
    });
  });

  it("says so when the Bot Server does not run", async () => {
    home = { state: "stopped", address: "club", origin: ORIGIN, team: true, mayMake: false, makeUrl: MAKE };
    const pass = await send("POST", "/api/studio/work/home/pass", owner);
    expect(pass.status).toBe(409);
    expect((await pass.json()).code).toBe("not_running");
  });

  it("keeps the bell, without chats", async () => {
    const bell = await (await get("/api/studio/work/approvals", owner)).json();
    expect(bell).not.toHaveProperty("approvals");
    expect(bell).toHaveProperty("runs");
  });

  it("has no chats of its own any more", async () => {
    expect((await get("/api/studio/work/chats?space=x", owner)).status).toBe(404);
    expect((await send("POST", "/api/studio/work/chats", owner, { spaceId: "x" })).status).toBe(404);
  });
});

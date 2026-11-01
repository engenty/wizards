import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The portal server (docs/plans/client-portal.md): it signs the client in through the Manage-App
// and forwards two kinds of calls, the client contract with the session's token and a run's own
// routes with the run's ticket. It never sends the browser's cookies on, and keeps no token where
// the browser can read it.

process.env.PORTAL_URL = "https://portal.test";
process.env.MANAGE_URL = "https://manage.test";
process.env.RUNTIME_URL = "https://runtime.test";
process.env.RUNTIME_DOORS_URL = "https://doors.test";
process.env.PORTAL_CLIENT_SECRET = "client-secret-0123456789";
process.env.PORTAL_SECRET = "portal-secret-0123456789-0123456789";
// The built SPA, as far as the server looks at it.
process.env.PORTAL_WEB_DIR = mkdtempSync(join(tmpdir(), "portal-web-"));
writeFileSync(join(process.env.PORTAL_WEB_DIR, "index.html"), "<!doctype html><title>Portal</title>");

/** An access token as the Manage-App signs one; the portal only reads it. */
const token = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const ACCESS = token({ sub: "wagner", tenant: "t1", role: "client", name: "Wagner", exp: Date.now() / 1000 + 3600 });

const calls: { url: string; init: RequestInit }[] = [];

vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.endsWith("/.well-known/openid-configuration")) {
    return Response.json({
      authorization_endpoint: "https://manage.test/oauth/authorize",
      token_endpoint: "https://manage.test/oauth/token",
    });
  }
  if (url === "https://manage.test/oauth/token") {
    return Response.json({ access_token: ACCESS, refresh_token: "r1" });
  }
  if (url.startsWith("https://manage.test/v1/pages/host/")) {
    return Response.json({ team: { id: "t1", name: "Kanzlei Maier", slug: "maier", lang: "de" }, page: null, portal: true });
  }
  return Response.json({ url, auth: new Headers(init.headers).get("authorization") ?? null }, {
    headers: { "set-cookie": "runtime=1" },
  });
});

let app: typeof import("../server/app").app;
let seal: typeof import("../server/seal");

beforeAll(async () => {
  app = (await import("../server/app")).app;
  seal = await import("../server/seal");
});

const at = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  app.fetch(
    new Request(`https://maier.wizards.test${path}`, {
      ...init,
      headers: { host: "maier.wizards.test", "x-forwarded-proto": "https", ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as object) },
    }),
  );

/** Signs in as the Manage-App would let the client: start, callback, hand-over. */
async function signIn(): Promise<string> {
  const start = await at("/portal/auth/login?return=/portal/maier-gmbh");
  const authorize = new URL(start.headers.get("location") ?? "");
  expect(authorize.origin + authorize.pathname).toBe("https://manage.test/oauth/authorize");
  expect(authorize.searchParams.get("organization")).toBe("maier");
  expect(authorize.searchParams.get("redirect_uri")).toBe("https://portal.test/portal/auth/callback");
  expect(authorize.searchParams.get("resource")).toBe("https://runtime.test");
  const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
  const back = await app.fetch(
    new Request(`https://portal.test/portal/auth/callback?code=c1&state=${authorize.searchParams.get("state")}`, {
      headers: { host: "portal.test" },
    }),
  );
  const finish = new URL(back.headers.get("location") ?? "");
  expect(finish.origin).toBe("https://maier.wizards.test");
  const done = await at(`${finish.pathname}${finish.search}`, { cookie: stateCookie });
  expect(done.headers.get("location")).toBe("/portal/maier-gmbh");
  const cookies = done.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith("wz_portal="));
  expect(session).toMatch(/HttpOnly/i);
  return (session ?? "").split(";")[0];
}

describe("the portal server", () => {
  it("seals what it keeps: a changed or foreign value opens to nothing", () => {
    const sealed = seal.seal("a".repeat(32), { access: "secret" });
    expect(sealed).not.toContain("secret");
    expect(seal.unseal("a".repeat(32), sealed)).toEqual({ access: "secret" });
    expect(seal.unseal("b".repeat(32), sealed)).toBeNull();
    expect(seal.unseal("a".repeat(32), `${sealed.slice(0, -2)}xx`)).toBeNull();
  });

  it("says who is signed in for the host's team, and nobody before sign-in", async () => {
    const before = (await (await at("/portal/api/session")).json()) as any;
    expect(before).toMatchObject({ face: { portal: true }, person: null });
    const cookie = await signIn();
    const after = (await (await at("/portal/api/session", { cookie })).json()) as any;
    expect(after.person).toMatchObject({ name: "Wagner", role: "client", here: true });
    expect(JSON.stringify(after)).not.toContain(ACCESS);
  });

  it("hands the session over only to the browser that started the sign-in", async () => {
    const start = await at("/portal/auth/login");
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const back = await app.fetch(new Request(`https://portal.test/portal/auth/callback?code=c1&state=${state}`));
    const finish = new URL(back.headers.get("location") ?? "");
    const elsewhere = await at(`${finish.pathname}${finish.search}`);
    expect(elsewhere.headers.get("location")).toBe("/portal?signin=failed");
    expect(elsewhere.headers.getSetCookie().some((c) => c.startsWith("wz_portal=") && !c.includes("Max-Age=0"))).toBe(false);
  });

  it("calls the client contract with the session's token, never with the browser's cookies", async () => {
    expect((await at("/portal/api/client/spaces", { method: "POST", body: "{}" })).status).toBe(401);
    const cookie = await signIn();
    calls.length = 0;
    const res = await at("/portal/api/client/spaces/s1/for_you", { method: "POST", body: '{"input":{}}', cookie });
    expect(await res.json()).toEqual({ url: "https://runtime.test/api/v1/client/spaces/s1/for_you", auth: `Bearer ${ACCESS}` });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(new Headers(calls[0].init.headers).get("cookie")).toBeNull();
  });

  it("opens a run's routes with its ticket only, at the doors", async () => {
    const res = await at("/portal/api/run/r1/tick.et/pages/start", { method: "POST", body: '{"values":{}}' });
    expect(await res.json()).toEqual({ url: "https://doors.test/api/runs/r1/pages/start?rt=tick.et", auth: null });
  });

  it("sends every client address to the sign-in alike without a session, and asks nobody", async () => {
    calls.length = 0;
    const answers = await Promise.all(
      ["/portal/r/a1b2c3d4e5f6", "/portal/r/doesnotexist", "/portal/chat/x9", "/portal/f/y8", "/portal/results"].map((p) =>
        at(p),
      ),
    );
    for (const res of answers) {
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/^\/portal\/auth\/login\?return=%2Fportal%2F/);
    }
    expect(calls.filter((c) => !c.url.includes("/.well-known/"))).toEqual([]);
  });

  it("keeps the portal out of Referers and search engines", async () => {
    for (const path of ["/portal", "/portal/r/x", "/portal/api/session"]) {
      const res = await at(path);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
    }
  });

  it("limits the sign-in per address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push(
        (await at("/portal/auth/finish?h=x", { headers: { "x-forwarded-for": "203.0.113.9" } })).status,
      );
    }
    expect(statuses.slice(0, 30).every((s) => s === 302)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

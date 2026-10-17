import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A stand-in Manage-App with two tenants: one that builds nothing here (the free tier: its
// studio shows what a local install synced) and one that does.
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

const RUNTIME = "http://localhost:5181";
const SERVICE_KEY = "wzr_test_service_key";
const LIMITS: Record<string, { concurrentRuns: number; projects: number; build: boolean }> = {
  free: { concurrentRuns: 2, projects: 1, build: false },
  builder: { concurrentRuns: 2, projects: 2, build: true },
};
let issuer = "";

const ALL = "openid wizards:read wizards:write wizards:publish runs:test";

function token(tenant: string, scope = ALL, aud = RUNTIME) {
  return new SignJWT({
    scope,
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
      access_token: await token(form.get("code") ?? "free", ALL, form.get("resource") ?? RUNTIME),
      refresh_token: "refresh",
      expires_in: 600,
    });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  // Every grant behind a token here still stands.
  if (url.pathname === "/v1/grants/check") {
    return json({ active: true });
  }
  const tenant = url.pathname.match(/^\/v1\/tenants\/([^/]+)$/)?.[1];
  if (tenant) {
    return json({
      id: tenant,
      name: tenant,
      status: "active",
      balanceCredits: 500,
      limits: LIMITS[tenant],
      db: null,
    });
  }
  // The gateway's catalog: text is bound, video is not.
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

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-spaces-"));
process.env.APP_URL = RUNTIME;
process.env.MANAGE_URL = issuer;
process.env.GATEWAY_URL = issuer;
process.env.MANAGE_CLIENT_ID = "wizards-runtime-test";
process.env.MANAGE_CLIENT_SECRET = "secret";
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;
process.env.SANDBOX = "off";
process.env.LIMIT_SYNCED_WIZARDS = "2";
process.env.PLUGINS_WATCH = "0";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

/** Signs a tenant's person in at the studio; the stand-in takes the tenant as the code. */
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

async function studio(method: string, path: string, cookie: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`${RUNTIME}/api/studio${path}`, {
      method,
      headers: {
        cookie,
        origin: RUNTIME,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** A call of the API as a local install makes it: with the linked account's access token. */
async function api(method: string, path: string, tenant: string, body?: unknown, scope = ALL) {
  const res = await app.fetch(
    new Request(`${RUNTIME}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token(tenant, scope)}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const definition = (title: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  title,
  description: "",
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
  ...extra,
});

const SPACE = { name: "Mein Projekt", brand: { name: "Tischlerei Holz" }, facts: [] };
const SPACE_ID = "localspace001";
const WIZARD_ID = "localwizard01";
const text = (value: string) => Buffer.from(value).toString("base64");

const sync = (tenant: string, space: string, wizard: string, body: Record<string, unknown>) =>
  api("PUT", `/spaces/${space}/wizards/${wizard}`, tenant, { space: SPACE, ...body });

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await (await import("../src/plugins/loader")).loadPlugins();
  app = (await import("../src/app")).default;
}, 60_000);

afterAll(() => manage.close());

describe("a tenant that builds nothing here (the free tier)", () => {
  let free = "";
  let shareUrl = "";

  it("has an empty studio that makes nothing", async () => {
    free = await signIn("free");
    const me = await studio("GET", "/me", free);
    expect(me.body.limits).toEqual({ projects: 1, build: false, create: false, members: null });
    expect((await studio("GET", "/projects", free)).body).toEqual([]);
    const refused = await studio("POST", "/projects", free, { name: "Neu" });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("read_only");
    // Not through the API of a tenant that builds either.
    const imported = await api("POST", "/wizards/import", "free", { definition: definition("X") });
    expect(imported.status).toBe(403);
  });

  it("takes a wizard its local install published, under the ids it has there", async () => {
    const res = await sync("free", SPACE_ID, WIZARD_ID, {
      version: 3,
      definition: definition("Angebot"),
      files: [{ path: "prices.csv", data: text("a;1\n") }],
      dailyRunLimit: 20,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      wizardId: WIZARD_ID,
      shareEnabled: true,
      publishedVersion: 3,
      runnable: true,
      problems: [],
    });
    // The link is this runtime's own.
    shareUrl = res.body.shareUrl;
    expect(shareUrl).toMatch(new RegExp(`^${RUNTIME}/w/[A-Za-z0-9_-]{14}$`));

    const [project] = (await studio("GET", "/projects", free)).body;
    expect(project).toMatchObject({
      id: SPACE_ID,
      name: "Mein Projekt",
      brand: { name: "Tischlerei Holz" },
      origin: "local",
      readOnly: true,
      wizardCount: 1,
    });
    const wizard = await studio("GET", `/wizards/${WIZARD_ID}`, free);
    expect(wizard.body).toMatchObject({ id: WIZARD_ID, readOnly: true, publishedVersion: 3 });
    expect((await studio("GET", `/wizards/${WIZARD_ID}/files`, free)).body).toMatchObject([
      { path: "prices.csv" },
    ]);
  });

  it("runs the synced wizard for everyone behind its link", async () => {
    const shareToken = shareUrl.split("/w/")[1];
    const page = await app.fetch(new Request(`${RUNTIME}/api/public/wizards/${shareToken}`));
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ title: "Angebot" });
  });

  it("shows the synced project and changes nothing of it", async () => {
    const current = (await studio("GET", `/wizards/${WIZARD_ID}`, free)).body;
    const tries = [
      studio("PUT", `/wizards/${WIZARD_ID}/draft`, free, {
        definition: definition("Geändert"),
        baseRevision: current.revision,
      }),
      studio("PATCH", `/wizards/${WIZARD_ID}`, free, { shareEnabled: false }),
      studio("POST", `/wizards/${WIZARD_ID}/publish`, free),
      studio("POST", `/wizards/${WIZARD_ID}/duplicate`, free),
      studio("POST", `/wizards/${WIZARD_ID}/rotate-link`, free),
      studio("DELETE", `/wizards/${WIZARD_ID}`, free),
      studio("PATCH", `/projects/${SPACE_ID}`, free, { name: "Anders" }),
      studio("POST", "/wizards", free, { projectId: SPACE_ID }),
      studio("POST", `/wizards/${WIZARD_ID}/chat`, free, { message: "Mach es blau" }),
    ];
    for (const res of await Promise.all(tries)) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("read_only");
    }
    expect((await studio("GET", `/wizards/${WIZARD_ID}`, free)).body.title).toBe("Angebot");
  });

  it("updates the copy when the install publishes again, and keeps its link", async () => {
    const res = await sync("free", SPACE_ID, WIZARD_ID, {
      version: 4,
      definition: definition("Angebot 2"),
      files: [{ path: "terms.md", data: text("# AGB") }],
      shareEnabled: true,
    });
    expect(res.body).toMatchObject({ publishedVersion: 4, runnable: true, shareUrl });
    const wizard = (await studio("GET", `/wizards/${WIZARD_ID}`, free)).body;
    expect(wizard).toMatchObject({ title: "Angebot 2", publishedVersion: 4 });
    // The workspace is what was sent: the earlier file is gone.
    expect(
      (await studio("GET", `/wizards/${WIZARD_ID}/files`, free)).body.map((f: any) => f.path),
    ).toEqual(["terms.md"]);
  });

  it("leaves nothing behind when a sending breaks off, and takes the next one whole", async () => {
    const { objects } = await import("../src/files/objects");
    const logo = { name: "logo.svg", mime: "image/svg+xml", description: "", data: text("<svg/>") };
    const body = {
      space: { ...SPACE, name: "Mein Projekt, umbenannt", logo },
      version: 1,
      definition: definition("Rechner", {
        steps: [
          { id: "film", type: "widget", title: "Film", entry: "film/tour.html" },
          { id: "done", type: "result", title: "Fertig", deliverables: [] },
        ],
      }),
      files: [
        { path: "film/tour.html", data: text("<main>Rundgang</main>") },
        { path: "film/film.css", data: text("main{}") },
      ],
    };
    // The object store goes out of reach while the files are kept: nothing was written yet.
    const put = vi.spyOn(objects, "put").mockRejectedValueOnce(new TypeError("fetch failed"));
    const early = await sync("free", SPACE_ID, "localwizard02", body);
    expect(early.status).toBe(500);
    // It goes out of reach at the logo, after the project, the wizard and its files were written:
    // the transaction takes all of it back.
    put
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.resolve())
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const late = await sync("free", SPACE_ID, "localwizard02", body);
    expect(late.status).toBe(500);
    // Not a half-written wizard without its files: no wizard at all, and the project as before.
    expect((await studio("GET", "/wizards/localwizard02", free)).status).toBe(404);
    const spaces = (await api("GET", "/spaces", "free")).body.spaces;
    expect(spaces).toMatchObject([{ id: SPACE_ID, name: "Mein Projekt" }]);
    expect(spaces[0].wizards.map((w: any) => w.id)).toEqual([WIZARD_ID]);

    const whole = await sync("free", SPACE_ID, "localwizard02", body);
    expect(whole.status).toBe(200);
    expect(whole.body).toMatchObject({ publishedVersion: 1, runnable: true, problems: [] });
    expect(
      (await studio("GET", "/wizards/localwizard02/files", free)).body.map((f: any) => f.path),
    ).toEqual(["film/film.css", "film/tour.html"]);
    expect((await api("GET", "/spaces", "free")).body.spaces[0].name).toBe("Mein Projekt, umbenannt");
    put.mockRestore();
    // Back to how the other cases know the project.
    expect((await sync("free", SPACE_ID, "localwizard02", { ...body, space: SPACE })).status).toBe(200);
    expect((await api("DELETE", `/spaces/${SPACE_ID}/wizards/localwizard02`, "free")).status).toBe(
      200,
    );
  });

  it("keeps a version that cannot run here, without publishing it", async () => {
    const res = await sync("free", SPACE_ID, WIZARD_ID, {
      version: 5,
      definition: definition("Angebot 3", {
        connections: [{ id: "crm", connector: "hubspot_import", title: "CRM" }],
      }),
      files: [],
    });
    expect(res.status).toBe(200);
    // Runs still start on the version before; the studio shows the new one and why not.
    expect(res.body).toMatchObject({ publishedVersion: 4, runnable: false });
    expect(res.body.problems).toMatchObject([{ code: "connector", blocking: true }]);
    const wizard = (await studio("GET", `/wizards/${WIZARD_ID}`, free)).body;
    expect(wizard).toMatchObject({ title: "Angebot 3", publishedVersion: 4 });
  });

  it("says before a wizard is sent what it would lack here", async () => {
    const res = await api("POST", "/spaces/check", "free", {
      definition: definition("Film", {
        steps: [
          {
            id: "start",
            type: "page",
            title: "Start",
            fields: [{ id: "name", kind: "text", label: "Name" }],
          },
          {
            id: "work",
            type: "agent",
            title: "Rechnet",
            instructions: "Rechne mit {{name}}.",
            tools: ["sandbox"],
            output: { format: "text" },
          },
          { id: "clip", type: "generate", title: "Clip", asset: "video", prompt: "Ein Film." },
          { id: "done", type: "result", title: "Fertig", deliverables: [] },
        ],
      }),
      files: [],
    });
    expect(res.status).toBe(200);
    const codes = res.body.problems.map((p: any) => [p.code, p.blocking, p.steps[0]?.id]);
    expect(codes).toContainEqual(["model", true, "clip"]);
    expect(codes).toContainEqual(["sandbox", false, "work"]);
  });

  it("follows the install in how the wizard is shared", async () => {
    const off = await api("PATCH", `/spaces/${SPACE_ID}/wizards/${WIZARD_ID}`, "free", {
      shareEnabled: false,
      dailyRunLimit: 7,
    });
    expect(off.status).toBe(200);
    const wizard = (await studio("GET", `/wizards/${WIZARD_ID}`, free)).body;
    expect(wizard).toMatchObject({ shareEnabled: false, dailyRunLimit: 7 });
  });

  it("makes a new link when the install makes one: the old one stops", async () => {
    const before = shareUrl.split("/w/")[1];
    const res = await api("POST", `/spaces/${SPACE_ID}/wizards/${WIZARD_ID}/rotate-link`, "free");
    expect(res.status).toBe(200);
    expect(res.body.shareUrl).toMatch(new RegExp(`^${RUNTIME}/w/[A-Za-z0-9_-]{14}$`));
    expect(res.body.shareUrl).not.toBe(shareUrl);
    expect(res.body.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(
      (await app.fetch(new Request(`${RUNTIME}/api/public/wizards/${before}`))).status,
    ).toBe(404);
    shareUrl = res.body.shareUrl;
    const listed = await api("GET", "/spaces", "free");
    expect(listed.body.spaces[0].wizards[0].shareUrl).toBe(shareUrl);
    // Only the install's own wizards: an unknown one is not found.
    const other = await api("POST", `/spaces/${SPACE_ID}/wizards/unknownwiz1/rotate-link`, "free");
    expect(other.status).toBe(404);
  });

  it("has room for one project: another install's is refused until the first goes", async () => {
    const second = await sync("free", "otherspace002", "otherwizard2", {
      version: 1,
      definition: definition("Vom zweiten Rechner"),
    });
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({
      reason: "space_limit",
      spaces: [{ id: SPACE_ID, name: "Mein Projekt" }],
    });
    const listed = await api("GET", "/spaces", "free");
    expect(listed.body.spaces).toMatchObject([
      { id: SPACE_ID, wizards: [{ id: WIZARD_ID, publishedVersion: 4, shareUrl }] },
    ]);

    expect((await api("DELETE", `/spaces/${SPACE_ID}`, "free")).status).toBe(200);
    const shareToken = shareUrl.split("/w/")[1];
    expect(
      (await app.fetch(new Request(`${RUNTIME}/api/public/wizards/${shareToken}`))).status,
    ).toBe(404);
    const again = await sync("free", "otherspace002", "otherwizard2", {
      version: 1,
      definition: definition("Vom zweiten Rechner"),
    });
    expect(again.status).toBe(200);
    expect((await studio("GET", "/projects", free)).body).toMatchObject([{ id: "otherspace002" }]);
  });

  it("keeps only so many wizards of an install", async () => {
    const second = await sync("free", "otherspace002", "otherwizard3", {
      version: 1,
      definition: definition("Zweiter"),
    });
    expect(second.status).toBe(200);
    const third = await sync("free", "otherspace002", "otherwizard4", {
      version: 1,
      definition: definition("Dritter"),
    });
    expect(third.status).toBe(400);
    expect(third.body).toMatchObject({ reason: "wizard_limit", limit: 2 });
    // One that is there already is still updated.
    const again = await sync("free", "otherspace002", "otherwizard3", {
      version: 2,
      definition: definition("Zweiter, neu"),
    });
    expect(again.body).toMatchObject({ publishedVersion: 2 });
  });

  it("removes a wizard the install deleted", async () => {
    const gone = await api("DELETE", "/spaces/otherspace002/wizards/otherwizard2", "free");
    expect(gone.status).toBe(200);
    expect((await studio("GET", "/wizards/otherwizard2", free)).status).toBe(404);
    expect((await api("DELETE", "/spaces/otherspace002/wizards/otherwizard2", "free")).status).toBe(
      404,
    );
  });

  it("needs a token that may publish, and ids of the kind an install makes", async () => {
    const readOnly = await api(
      "PUT",
      `/spaces/${SPACE_ID}/wizards/${WIZARD_ID}`,
      "free",
      { space: SPACE, version: 1, definition: definition("X") },
      "openid wizards:read",
    );
    expect(readOnly.status).toBe(403);
    expect(readOnly.body.code).toBe("insufficient_scope");
    const badId = await sync("free", "not.an$id", WIZARD_ID, {
      version: 1,
      definition: definition("X"),
    });
    expect(badId.status).toBe(400);
    const none = await app.fetch(
      new Request(`${RUNTIME}/api/v1/spaces`, { headers: { authorization: "Bearer nope" } }),
    );
    expect(none.status).toBe(401);
  });
});

describe("a tenant that builds here", () => {
  let builder = "";

  it("keeps its own project writable beside a synced one, within its number", async () => {
    builder = await signIn("builder");
    expect((await studio("GET", "/me", builder)).body.limits).toEqual({
      projects: 2,
      build: true,
      create: true,
      members: null,
    });
    const [own] = (await studio("GET", "/projects", builder)).body;
    expect(own).toMatchObject({ origin: null, readOnly: false });

    // The same ids as the other tenant's install: each tenant has its own.
    const res = await sync("builder", SPACE_ID, WIZARD_ID, {
      version: 1,
      definition: definition("Vom Laptop"),
    });
    expect(res.status).toBe(200);
    const projects = (await studio("GET", "/projects", builder)).body;
    expect(projects.map((p: any) => [p.id === SPACE_ID, p.readOnly])).toEqual([
      [false, false],
      [true, true],
    ]);

    const made = await studio("POST", "/wizards", builder, { projectId: own.id });
    expect(made.status).toBe(200);
    const intoSynced = await studio("POST", "/wizards", builder, { projectId: SPACE_ID });
    expect(intoSynced.status).toBe(403);
    // A wizard made here does not move into the synced project.
    const moved = await studio("PATCH", `/wizards/${made.body.id}`, builder, {
      projectId: SPACE_ID,
    });
    expect(moved.status).toBe(403);

    // Two projects is this tenant's number: a third, synced or made here, is refused.
    const third = await sync("builder", "thirdspace003", "thirdwizard03", {
      version: 1,
      definition: definition("Zu viel"),
    });
    expect(third.body).toMatchObject({ reason: "space_limit" });
    expect((await studio("POST", "/projects", builder, { name: "Noch eins" })).status).toBe(400);
  });
});

describe("what visitors may send", () => {
  it("refuses a body far beyond a page's answers before reading it", async () => {
    const res = await app.fetch(
      new Request(`${RUNTIME}/api/public/wizards/whatever/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: RUNTIME },
        body: JSON.stringify({ filler: "x".repeat(5 * 1024 * 1024) }),
      }),
    );
    expect(res.status).toBe(413);
  });
});

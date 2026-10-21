import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A stand-in Manage-App for one team with its address, which keeps what the runtime sends for
// the team's public page (`PUT /v1/pages/:tenantId`, docs/manage-contract.md).
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

const RUNTIME = "http://localhost:5181";
const SERVICE_KEY = "wzr_test_service_key";
const TENANT = "tenant-berger";
let issuer = "";

/** Every `PUT /v1/pages/:id` the runtime made, in order; `DELETE` is noted as null. */
const pushes: { tenantId: string; body: any }[] = [];
// While set, the stand-in answers the push with an error.
let pagesDown = false;
/** The team's `pages` switch, as the fake Manage-App says it. */
let pagesOn = true;

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
  const pages = url.pathname.match(/^\/v1\/pages\/([^/]+)$/)?.[1];
  if (pages) {
    if (pagesDown) {
      return json({ error: "down", code: "unavailable" }, 503);
    }
    pushes.push({ tenantId: pages, body: req.method === "PUT" ? JSON.parse(raw) : null });
    return json({ ok: true, url: `http://berger-partner.wizards.localhost:18982/` });
  }
  const tenant = url.pathname.match(/^\/v1\/tenants\/([^/]+)$/)?.[1];
  if (tenant) {
    return json({
      id: tenant,
      name: "Berger & Partner",
      slug: "berger-partner",
      pagesHost: "berger-partner.wizards.localhost",
      features: { pages: pagesOn },
      status: "active",
      balanceCredits: 500,
      limits: { concurrentRuns: 2, projects: 3, build: true },
      db: null,
    });
  }
  if (url.pathname === "/v1/models") {
    const text = { model: "test/model", kind: "text", inputCreditsPerMTok: 1, outputCreditsPerMTok: 1 };
    return json({
      markup: 2,
      classes: { classifier: text, low: text, standard: text, high: text, video: null },
      webSearchCredits: 2,
    });
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-pages-"));
process.env.APP_URL = RUNTIME;
process.env.MANAGE_URL = issuer;
process.env.GATEWAY_URL = issuer;
process.env.MANAGE_CLIENT_ID = "wizards-runtime-test";
process.env.MANAGE_CLIENT_SECRET = "secret";
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;
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

/** A wizard that asks two things, checks a draft, and hands out a document and a table. */
const definition = (title: string) => ({
  version: 1,
  title,
  description: "Fotografiere die Belege, die KI sortiert sie.",
  avatar: "drop",
  lang: "de",
  steps: [
    {
      id: "upload",
      type: "page",
      title: "Belege hochladen",
      fields: [
        { id: "files", kind: "file", label: "Belege", required: true },
        { id: "quarter", kind: "text", label: "Quartal" },
      ],
    },
    {
      id: "read",
      type: "agent",
      title: "Belege lesen",
      instructions: "Lies die Belege.",
      tools: [],
      output: { format: "json" },
    },
    { id: "check", type: "review", title: "Liste prüfen", show: ["read"] },
    {
      id: "sum",
      type: "agent",
      title: "Summen bilden",
      instructions: "Bilde Summen.",
      tools: [],
      output: { format: "markdown" },
    },
    {
      id: "done",
      type: "result",
      title: "Dateien",
      deliverables: [
        { from: "read", label: "Belegliste", formats: ["xlsx"] },
        { from: "sum", label: "Übersicht", formats: ["pdf"] },
      ],
    },
  ],
});

const PAGE = {
  on: true,
  slug: "steuer",
  title: "Steuer",
  headline: "Bereiten Sie Ihre Steuer vor.",
  intro: "",
  lang: "de",
  form: "sie",
  wizards: [] as string[],
  examples: {} as Record<string, string>,
};

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await (await import("../src/plugins/loader")).loadPlugins();
  app = (await import("../src/app")).default;
}, 60_000);

afterAll(() => manage.close());

describe("the public page of a space", () => {
  let cookie = "";
  let space = "";
  let other = "";
  let wizard = "";

  it("shows the team's address and no page until one is set up", async () => {
    cookie = await signIn(TENANT);
    const me = await studio("GET", "/me", cookie);
    expect(me.body.tenant.pagesHost).toBe("berger-partner.wizards.localhost");
    const [project] = (await studio("GET", "/projects", cookie)).body;
    space = project.id;
    expect(project.page).toBeNull();
    other = (await studio("POST", "/projects", cookie, { name: "Zweiter" })).body.id;
  });

  it("keeps the page's settings, only this space's wizards on it and the form for German", async () => {
    wizard = (await studio("POST", "/wizards", cookie, { projectId: space })).body.id;
    const res = await studio("PATCH", `/projects/${space}`, cookie, {
      page: { ...PAGE, wizards: [wizard, "not-here", wizard], examples: { "not-here": "abc" } },
    });
    expect(res.status).toBe(200);
    const page = (await studio("GET", "/projects", cookie)).body.find((p: any) => p.id === space).page;
    expect(page).toEqual({
      on: true,
      slug: "steuer",
      title: "Steuer",
      headline: "Bereiten Sie Ihre Steuer vor.",
      lang: "de",
      form: "sie",
      wizards: [wizard],
      examples: {},
    });
    // An English page has no form.
    await studio("PATCH", `/projects/${space}`, cookie, { page: { ...PAGE, lang: "en" } });
    const english = (await studio("GET", "/projects", cookie)).body.find((p: any) => p.id === space).page;
    expect(english.form).toBeUndefined();
    await studio("PATCH", `/projects/${space}`, cookie, { page: PAGE });
  });

  it("refuses an address with other characters or one another space has", async () => {
    const bad = await studio("PATCH", `/projects/${space}`, cookie, { page: { ...PAGE, slug: "Steuer Büro" } });
    expect(bad.status).toBe(400);
    const taken = await studio("PATCH", `/projects/${other}`, cookie, { page: { ...PAGE, on: false } });
    expect(taken.status).toBe(400);
    expect(taken.body.error).toMatch(/address|Adresse/);
  });

  it("lets one space of the team have the page on, and names it to the second", async () => {
    const second = await studio("PATCH", `/projects/${other}`, cookie, {
      page: { ...PAGE, slug: "zweiter", title: "Zweiter" },
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: "page_taken", project: { id: space, name: "My wizards" } });
    // Off, it may keep its settings.
    const off = await studio("PATCH", `/projects/${other}`, cookie, {
      page: { ...PAGE, on: false, slug: "zweiter", title: "Zweiter" },
    });
    expect(off.status).toBe(200);
    // The first switches off: the second may switch on.
    await studio("PATCH", `/projects/${space}`, cookie, { page: { ...PAGE, on: false } });
    const on = await studio("PATCH", `/projects/${other}`, cookie, {
      page: { ...PAGE, slug: "zweiter", title: "Zweiter" },
    });
    expect(on.status).toBe(200);
    await studio("PATCH", `/projects/${other}`, cookie, {
      page: { ...PAGE, on: false, slug: "zweiter", title: "Zweiter" },
    });
    await studio("PATCH", `/projects/${space}`, cookie, { page: PAGE });
  });
});

describe("the page data sent to the Manage-App", () => {
  let cookie = "";
  let space = "";
  let wizard = "";
  const settled = async () => (await import("../src/services/pages")).pagesSettled();
  const lastPush = async () => {
    await settled();
    return pushes.at(-1)?.body;
  };

  it("sends no page while no listed wizard is published and shared", async () => {
    cookie = await signIn(TENANT);
    const projects = (await studio("GET", "/projects", cookie)).body;
    space = projects.find((p: any) => p.page?.on).id;
    wizard = (await studio("GET", `/projects/${space}/wizards`, cookie)).body[0].id;
    await studio("PATCH", `/projects/${space}`, cookie, { page: { ...PAGE, wizards: [wizard] } });
    const sent = await lastPush();
    expect(sent).toEqual({ slug: "berger-partner", name: "Berger & Partner", lang: "de", space: null });
  });

  it("sends the space with the published wizard as a teaser after a publish", async () => {
    const current = (await studio("GET", `/wizards/${wizard}`, cookie)).body;
    const draft = await studio("PUT", `/wizards/${wizard}/draft`, cookie, {
      definition: definition("Belege fürs Quartal sortieren"),
      baseRevision: current.revision,
    });
    expect(draft.status).toBe(200);
    await studio("PATCH", `/projects/${space}`, cookie, {
      brand: { name: "Berger & Partner", colors: [{ name: "Primär", value: "#0f4c5c" }] },
      facts: [
        { key: "firma", label: "Firma", value: "Berger & Partner Steuerberatung GmbH" },
        { key: "adresse", label: "Adresse", value: "Hauptplatz 4" },
        { key: "plz", label: "PLZ", value: "8010" },
        { key: "ort", label: "Ort", value: "Graz" },
        { key: "e_mail", label: "E-Mail", value: "kanzlei@berger-partner.at" },
        { key: "website", label: "Website", value: "berger-partner.at" },
      ],
    });
    const published = await studio("POST", `/wizards/${wizard}/publish`, cookie);
    expect(published.status).toBe(200);
    const sent = await lastPush();
    expect(sent.space).toMatchObject({
      slug: "steuer",
      title: "Steuer",
      headline: "Bereiten Sie Ihre Steuer vor.",
      lang: "de",
      form: "sie",
      brand: { name: "Berger & Partner", logoUrl: null, theme: { accent: "#0f4c5c", dark: false } },
      imprint: {
        name: "Berger & Partner Steuerberatung GmbH",
        lines: ["Hauptplatz 4", "8010 Graz", "kanzlei@berger-partner.at"],
        website: "https://berger-partner.at",
      },
    });
    expect(sent.space.intro).toBeUndefined();
    expect(sent.space.wizards).toEqual([
      {
        slug: "belege-fuers-quartal-sortieren",
        title: "Belege fürs Quartal sortieren",
        description: "Fotografiere die Belege, die KI sortiert sie.",
        avatar: "drop",
        lang: "de",
        results: [
          { title: "Belegliste", kind: "table", formats: ["xlsx"] },
          { title: "Übersicht", kind: "text", formats: ["pdf"] },
        ],
        effort: { fields: 2, reviews: 1, minutes: expect.any(Number), uploads: true },
        steps: [
          { title: "Belege hochladen", by: "you" },
          { title: "Belege lesen", by: "ai" },
          { title: "Liste prüfen", by: "you" },
          { title: "Summen bilden", by: "ai" },
          { title: "Dateien", by: "ai" },
        ],
        runUrl: `${RUNTIME}/w/${current.shareToken}`,
      },
    ]);
  });

  it("keeps the wizard's address on the page once made, whatever its title becomes", async () => {
    const current = (await studio("GET", `/wizards/${wizard}`, cookie)).body;
    await studio("PUT", `/wizards/${wizard}/draft`, cookie, {
      definition: { ...current.draft, title: "Belege sortieren" },
      baseRevision: current.revision,
    });
    await studio("POST", `/wizards/${wizard}/publish`, cookie);
    const sent = await lastPush();
    expect(sent.space.wizards[0]).toMatchObject({
      slug: "belege-fuers-quartal-sortieren",
      title: "Belege sortieren",
    });
    const page = (await studio("GET", "/projects", cookie)).body.find((p: any) => p.id === space).page;
    expect(page.slugs).toEqual({ [wizard]: "belege-fuers-quartal-sortieren" });
  });

  it("takes the wizard off the page when its sharing is switched off, and back on", async () => {
    await studio("PATCH", `/wizards/${wizard}`, cookie, { shareEnabled: false });
    expect((await lastPush()).space).toBeNull();
    await studio("PATCH", `/wizards/${wizard}`, cookie, { shareEnabled: true });
    expect((await lastPush()).space.wizards).toHaveLength(1);
  });

  it("logs a failed send and sends everything again on the next change", async () => {
    const before = pushes.length;
    pagesDown = true;
    const res = await studio("PATCH", `/projects/${space}`, cookie, {
      page: { ...PAGE, wizards: [wizard], headline: "Neu" },
    });
    expect(res.status).toBe(200);
    await settled();
    expect(pushes.length).toBe(before);
    pagesDown = false;
    await studio("PATCH", `/projects/${space}`, cookie, {
      page: { ...PAGE, wizards: [wizard], headline: "Neu", intro: "Ein paar Worte." },
    });
    const sent = await lastPush();
    expect(sent.space).toMatchObject({ headline: "Neu", intro: "Ein paar Worte." });
  });

  it("behind its switch: no address in the studio and no page sent", async () => {
    pagesOn = false;
    const { forgetTenant } = await import("../src/manage");
    forgetTenant(TENANT);
    try {
      const me = await studio("GET", "/me", cookie);
      expect(me.body.tenant.pagesHost).toBeNull();
      await studio("PATCH", `/projects/${space}`, cookie, {
        page: { ...PAGE, wizards: [wizard], headline: "Aus" },
      });
      expect((await lastPush()).space).toBeNull();
    } finally {
      pagesOn = true;
      forgetTenant(TENANT);
    }
  });

  it("sends no page once the listed wizard is deleted, and forgets it on the page", async () => {
    await studio("DELETE", `/wizards/${wizard}`, cookie);
    expect((await lastPush()).space).toBeNull();
    const page = (await studio("GET", "/projects", cookie)).body.find((p: any) => p.id === space).page;
    expect(page.wizards).toEqual([]);
  });
});

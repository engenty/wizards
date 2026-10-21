import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The cloud's sync calls (`/api/v1/sync`) on a runtime of a stand-in Manage-App: who may push
// what, the bytes of files, the schema both sides must share.

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

const RUNTIME = "http://localhost:5181";
const SERVICE_KEY = "wzr_test_service_key";
const LIMITS: Record<string, { concurrentRuns: number; projects: number; build: boolean }> = {
  org: { concurrentRuns: 2, projects: 3, build: true },
  viewer: { concurrentRuns: 2, projects: 1, build: false },
};
let issuer = "";

function token(tenant: string, role = "owner", scope = "openid wizards:read wizards:write wizards:publish") {
  return new SignJWT({
    scope,
    sub: `user-${tenant}-${role}`,
    tenant,
    role,
    name: `User ${tenant}`,
    email: `${tenant}@test.local`,
    azp: "wizards-desktop",
  })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(RUNTIME)
    .setExpirationTime("10m")
    .sign(privateKey);
}

const manage: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", issuer);
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  for await (const _ of req) {
    // The body is not read.
  }
  if (url.pathname === "/.well-known/openid-configuration") {
    return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
  }
  if (url.pathname === "/jwks") {
    return json({ keys: [jwk] });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  if (url.pathname === "/v1/grants/check") {
    return json({ active: true });
  }
  const tenant = url.pathname.match(/^\/v1\/tenants\/([^/]+)$/)?.[1];
  if (tenant) {
    return json({ id: tenant, name: tenant, status: "active", balanceCredits: 500, limits: LIMITS[tenant], db: null });
  }
  if (url.pathname === "/v1/models") {
    const text = { model: "test/model", kind: "text", inputCreditsPerMTok: 1, outputCreditsPerMTok: 1 };
    return json({ markup: 2, classes: { classifier: text, standard: text, high: text, highest: text }, webSearchCredits: 2 });
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-sync-api-"));
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
let schemaTag = "";

async function v1(method: string, path: string, auth: string, body?: unknown) {
  const raw = body instanceof Uint8Array;
  const res = await app.fetch(
    new Request(`${RUNTIME}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "content-type": raw ? "application/octet-stream" : "application/json" }),
      },
      body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.arrayBuffer() } as {
    status: number;
    body: any;
  };
}

const SPACE = "spaceFromInstall1";
const WIZARD = "wizardFromInstall1";
const definition = {
  version: 1,
  title: "From the install",
  description: "",
  avatar: "round",
  steps: [
    { id: "a", type: "page", title: "A", fields: [{ id: "f", label: "F", kind: "text" }] },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
};

let owner = "";
let member = "";

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  schemaTag = client.tenantSchemaVersion;
  app = (await import("../src/app")).default;
  owner = await token("org");
  member = await token("org", "member");
}, 60_000);

afterAll(() => {
  manage.close();
});

describe("the cloud's sync calls", () => {
  it("names the schema and the spaces", async () => {
    const res = await v1("GET", "/sync", owner);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tenantId: "org", schema: schemaTag, role: "owner", limits: { projects: 3 } });
  });

  it("takes a new space with a wizard from its owner, and hands it out from 0", async () => {
    const res = await v1("POST", `/sync/spaces/${SPACE}/changes`, owner, {
      schema: schemaTag,
      items: [
        { kind: "space", item: SPACE, base: 0, record: { name: "From the install", brand: {}, facts: [], themes: [], page: null, mcpServers: [] } },
        {
          kind: "wizard",
          item: WIZARD,
          base: 0,
          record: { projectId: SPACE, title: "From the install", draft: definition, shareEnabled: true, translate: true, files: [] },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r.status)).toEqual(["taken", "taken"]);
    const pulled = await v1("GET", `/sync/spaces/${SPACE}/changes?since=0`, owner);
    expect(pulled.body.changes.map((c: any) => c.kind).sort()).toEqual(["space", "wizard"]);
    expect(pulled.body.next).toBeGreaterThan(0);
  });

  it("answers a change made on an older version with the cloud's", async () => {
    const pulled = await v1("GET", `/sync/spaces/${SPACE}/changes?since=0`, owner);
    const seq = pulled.body.changes.find((c: any) => c.kind === "wizard").seq;
    const record = { projectId: SPACE, title: "Renamed", draft: { ...definition, title: "Renamed" }, shareEnabled: true, translate: true, files: [] };
    expect((await v1("POST", `/sync/spaces/${SPACE}/changes`, owner, { schema: schemaTag, items: [{ kind: "wizard", item: WIZARD, base: seq, record }] })).body.results[0].status).toBe("taken");
    const stale = await v1("POST", `/sync/spaces/${SPACE}/changes`, owner, {
      schema: schemaTag,
      items: [{ kind: "wizard", item: WIZARD, base: seq, record: { ...record, title: "Stale" } }],
    });
    expect(stale.body.results[0]).toMatchObject({ status: "conflict", record: { draft: { title: "Renamed" } } });
  });

  it("lets a member change a wizard but not make one or a space", async () => {
    const made = await v1("POST", `/sync/spaces/${SPACE}/changes`, member, {
      schema: schemaTag,
      items: [
        { kind: "wizard", item: "wizardOfAMember", base: 0, record: { projectId: SPACE, title: "Mine", draft: definition, files: [] } },
        { kind: "space", item: SPACE, base: 999_999, record: { name: "Renamed by a member" } },
      ],
    });
    expect(made.body.results.map((r: any) => [r.status, r.reason])).toEqual([
      ["refused", "forbidden"],
      ["refused", "forbidden"],
    ]);
  });

  it("keeps bytes only under their own hash, and hands them back", async () => {
    const bytes = new TextEncoder().encode("<div>widget</div>");
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect((await v1("POST", `/sync/spaces/${SPACE}/blobs/missing`, owner, { hashes: [hash] })).body).toEqual({ missing: [hash] });
    expect((await v1("PUT", `/sync/spaces/${SPACE}/blobs/${"0".repeat(64)}`, owner, bytes)).status).toBe(400);
    expect((await v1("PUT", `/sync/spaces/${SPACE}/blobs/${hash}`, owner, bytes)).status).toBe(200);
    expect((await v1("POST", `/sync/spaces/${SPACE}/blobs/missing`, owner, { hashes: [hash] })).body).toEqual({ missing: [] });
    const back = await v1("GET", `/sync/spaces/${SPACE}/blobs/${hash}`, owner);
    expect(new TextDecoder().decode(back.body)).toBe("<div>widget</div>");
  });

  it("refuses a schema other than its own", async () => {
    const res = await v1("POST", `/sync/spaces/${SPACE}/changes`, owner, { schema: "0000_old", items: [] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: "schema_mismatch", schema: schemaTag });
  });

  it("refuses an organization that builds nothing in the cloud", async () => {
    const res = await v1("POST", `/sync/spaces/${SPACE}/changes`, await token("viewer"), { schema: schemaTag, items: [] });
    expect(res.status).toBe(403);
  });

  it("needs the write scope to push", async () => {
    const res = await v1("POST", `/sync/spaces/${SPACE}/changes`, await token("org", "owner", "openid wizards:read"), { schema: schemaTag, items: [] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("insufficient_scope");
  });
});

import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// A stand-in for the account's Manage-App: discovery, its JWKS, the token endpoint, /v1/modules.
const signing = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const jwtKeys = await generateKeyPair("EdDSA", { crv: "Ed25519" });
const jwk = { ...(await exportJWK(jwtKeys.publicKey)), kid: "k1", alg: "EdDSA" };

const ACCOUNT_TOKEN = `e30.${Buffer.from(
  JSON.stringify({ sub: "user-1", tenant: "tenant-1", name: "P", email: "p@test.local" }),
).toString("base64url")}.sig`;
let origin = "";

/** What the Manage-App answers; the tests change it. */
const state = {
  modules: ["notes-pro"] as string[],
  tenant: "tenant-1",
  packages: new Map<string, { zip: Uint8Array; signature: string; sha256?: string }>(),
};

const manage: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", origin);
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/.well-known/openid-configuration") {
    return json({ issuer: origin, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks` });
  }
  if (url.pathname === "/jwks") {
    return json({ keys: [jwk] });
  }
  if (url.pathname === "/token") {
    return json({ access_token: ACCOUNT_TOKEN, refresh_token: "refresh-2", expires_in: 600 });
  }
  if (req.headers.authorization !== `Bearer ${ACCOUNT_TOKEN}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  const runtime = url.searchParams.get("runtime");
  if (url.pathname === "/v1/modules") {
    const token = await new SignJWT({ modules: state.modules, plan: "pro" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer(origin)
      .setAudience("urn:engenty:wizards:modules")
      .setSubject(state.tenant)
      .setExpirationTime("7d")
      .sign(jwtKeys.privateKey);
    return json({
      runtime,
      plan: { id: "pro", name: "Pro" },
      modules: [...state.packages].map(([id, p]) => ({
        id,
        name: "Notes Pro",
        version: "1.0.0",
        description: "Notes, the Pro way.",
        size: p.zip.length,
        sha256: p.sha256 ?? createHash("sha256").update(p.zip).digest("hex"),
        signature: p.signature,
        included: state.modules.includes(id),
      })),
      entitlement: { token, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
    });
  }
  const match = url.pathname.match(/^\/v1\/modules\/([a-z-]+)\/package$/);
  const pkg = match ? state.packages.get(match[1]) : undefined;
  if (pkg && state.modules.includes(match?.[1] ?? "")) {
    res.writeHead(200, { "content-type": "application/zip" });
    return res.end(pkg.zip);
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
origin = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

const der = (key: KeyObject) => key.export({ type: "spki", format: "der" }).toString("base64");
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-pro-"));
process.env.APP_URL = "http://localhost:5181";
process.env.ACCOUNT_URL = origin;
process.env.CLOUD_URL = origin;
process.env.PLUGINS_WATCH = "0";
process.env.PLUGINS_DIR = "";
process.env.PRO_MODULES_KEYS = der(signing.publicKey);
delete process.env.MANAGE_URL;

let pro: typeof import("../src/plugins/pro");
let state_: typeof import("../src/plugins/pro-state");
let registry: typeof import("../src/plugins/registry");
let loader: typeof import("../src/plugins/loader");

/** A module's package as the packer of the closed plugins makes it. */
function pack(files: Record<string, string>, key: KeyObject = signing.privateKey, id = "notes-pro") {
  const zip = zipSync(
    Object.fromEntries(Object.entries(files).map(([p, c]) => [p, new TextEncoder().encode(c)])),
  );
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const message = `engenty-module:v1\n${id}\n1.0.0\n${state_.runtimeTag()}\n${sha256}`;
  return { zip, signature: sign(null, Buffer.from(message), key).toString("base64") };
}

const GOOD = {
  "engenty.plugin.json": JSON.stringify({
    id: "notes-pro",
    name: "Notes Pro",
    version: "1.0.0",
    server: "dist/plugin.js",
  }),
  // Bundled as the packer does: an ES module that brings its own `require`.
  "dist/plugin.js": `import { createRequire as __wizardsRequire } from "node:module"; const require = __wizardsRequire(import.meta.url);
const { z } = require("zod");
export default function plugin(wizards) {
  wizards.server.registerMigrations("migrations");
  wizards.server.registerTool({
    name: "count",
    description: "Counts.",
    input: z.object({}),
    run: async () => ({ ok: true }),
  });
}
`,
  "migrations/0001_init.sql": "CREATE TABLE notes_pro_note (id INTEGER PRIMARY KEY);\n",
};

async function link() {
  const { vaultSet } = await import("../src/secrets/vault");
  const { writeSetting } = await import("../src/settings");
  await vaultSet("account.refresh", "refresh-1");
  await writeSetting("account", {
    userId: "user-1",
    tenantId: "tenant-1",
    name: "P",
    email: "p@test.local",
  });
}

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  state_ = await import("../src/plugins/pro-state");
  pro = await import("../src/plugins/pro");
  registry = await import("../src/plugins/registry");
  loader = await import("../src/plugins/loader");
  await loader.loadPlugins();
  await client.openTenantDb("local");
}, 60_000);

afterAll(() => manage.close());

beforeEach(() => {
  state.modules = ["notes-pro"];
  state.tenant = "tenant-1";
  state.packages = new Map([["notes-pro", pack(GOOD)]]);
});

const moduleDir = () => join(state_.proModulesDir(), "notes-pro");

describe("Pro modules on a local install", () => {
  it("has none while no account is linked", async () => {
    await pro.refreshPro();
    const view = await pro.proState();
    expect(view.linked).toBe(false);
    expect(view.modules).toEqual([]);
    await expect(pro.installPro("notes-pro")).rejects.toThrow(/account/);
  });

  it("installs a module of the plan, checked against the signature, and loads it", async () => {
    await link();
    await pro.refreshPro();
    const before = await pro.proState();
    expect(before).toMatchObject({ linked: true, plan: { id: "pro" }, error: null });
    expect(before.modules).toEqual([
      expect.objectContaining({ id: "notes-pro", included: true, installed: null, loaded: false }),
    ]);
    await pro.installPro("notes-pro");
    const plugin = registry.loadedPlugin("notes-pro");
    expect(plugin?.error).toBeNull();
    expect(plugin?.source.pro).toBe(true);
    expect([...(plugin?.tools.keys() ?? [])]).toEqual(["count"]);
    const installed = JSON.parse(readFileSync(join(moduleDir(), ".engenty-module.json"), "utf8"));
    expect(installed).toMatchObject({ id: "notes-pro", runtime: state_.runtimeTag() });
    expect((await pro.proState()).modules[0]).toMatchObject({ loaded: true, update: false });
  });

  it("refuses a package signed with another key, or that is not what was signed", async () => {
    await pro.removePro("notes-pro");
    state.packages.set("notes-pro", pack(GOOD, stranger.privateKey));
    await pro.refreshPro();
    await expect(pro.installPro("notes-pro")).rejects.toThrow(/not signed by engenty/);
    const good = pack(GOOD);
    state.packages.set("notes-pro", { ...good, zip: pack({ ...GOOD, "dist/x.js": "1" }).zip, sha256: createHash("sha256").update(good.zip).digest("hex") });
    await pro.refreshPro();
    await expect(pro.installPro("notes-pro")).rejects.toThrow(/not signed by engenty/);
    expect(existsSync(moduleDir())).toBe(false);
    expect(registry.loadedPlugin("notes-pro")).toBeUndefined();
  });

  it("refuses a signed package with files outside its parts", async () => {
    state.packages.set("notes-pro", pack({ ...GOOD, "../escape.js": "x" }));
    await pro.refreshPro();
    await expect(pro.installPro("notes-pro")).rejects.toThrow(/a file it may not/);
    expect(existsSync(join(state_.proModulesDir(), "..", "escape.js"))).toBe(false);
  });

  it("refuses a module the plan does not include", async () => {
    state.modules = [];
    await pro.refreshPro();
    await expect(pro.installPro("notes-pro")).rejects.toThrow(/not part of your plan/);
  });

  it("unloads a module the plan no longer includes and keeps its files", async () => {
    await pro.refreshPro();
    await pro.installPro("notes-pro");
    expect(registry.loadedPlugin("notes-pro")).toBeDefined();
    state.modules = [];
    await pro.refreshPro();
    expect(registry.loadedPlugin("notes-pro")).toBeUndefined();
    expect(existsSync(moduleDir())).toBe(true);
    expect((await pro.proState()).modules[0]).toMatchObject({
      included: false,
      loaded: false,
      heldBack: "plan",
    });
    state.modules = ["notes-pro"];
    await pro.refreshPro();
    expect(registry.loadedPlugin("notes-pro")?.source.pro).toBe(true);
  });

  it("keeps a module on offline until the confirmation ends, then holds it back", async () => {
    const { readSetting, writeSetting } = await import("../src/settings");
    const kept = await readSetting<import("../src/plugins/pro-state").Entitlement>(
      state_.ENTITLEMENT_SETTING,
    );
    expect(kept?.modules).toEqual(["notes-pro"]);
    // A restart reads what was kept, without the network.
    state_.setEntitlement(null);
    await pro.loadEntitlement();
    await loader.rescanPlugins();
    expect(registry.loadedPlugin("notes-pro")).toBeDefined();
    await writeSetting(state_.ENTITLEMENT_SETTING, { ...kept, expiresAt: Date.now() - 1000 });
    await pro.loadEntitlement();
    await loader.rescanPlugins();
    expect(registry.loadedPlugin("notes-pro")).toBeUndefined();
    expect(state_.heldBackModules().get("notes-pro")).toBe("unconfirmed");
    await writeSetting(state_.ENTITLEMENT_SETTING, kept);
  });

  it("counts no confirmation of another account, and refuses one signed for another team", async () => {
    const { readSetting, writeSetting } = await import("../src/settings");
    const kept = await readSetting<import("../src/plugins/pro-state").Entitlement>(
      state_.ENTITLEMENT_SETTING,
    );
    await writeSetting(state_.ENTITLEMENT_SETTING, { ...kept, tenantId: "tenant-2" });
    await pro.loadEntitlement();
    expect(state_.currentEntitlement()).toBeNull();
    state.tenant = "tenant-2";
    await pro.refreshPro();
    expect((await pro.proState()).error).toMatch(/could not be checked/);
    expect(state_.currentEntitlement()).toBeNull();
  });

  it("holds back a module built for another release and fetches it anew", async () => {
    await pro.refreshPro();
    const file = join(moduleDir(), ".engenty-module.json");
    const installed = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...installed, runtime: "v0.0.1", sha256: "old" }));
    await loader.rescanPlugins();
    expect(registry.loadedPlugin("notes-pro")).toBeUndefined();
    expect(state_.heldBackModules().get("notes-pro")).toBe("release");
    await pro.refreshPro();
    expect(registry.loadedPlugin("notes-pro")?.source.pro).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).runtime).toBe(state_.runtimeTag());
  });

  it("drops every Pro module when the account is unlinked", async () => {
    const { unlink } = await import("../src/auth/account");
    await unlink();
    await pro.refreshPro();
    expect(registry.loadedPlugin("notes-pro")).toBeUndefined();
    expect(state_.currentEntitlement()).toBeNull();
  });
});

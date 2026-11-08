import { mkdtempSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A stand-in Manage-App and gateway. Tenant G has `ownKeysGateway` on, tenant O has it off.
// The Manage-App keeps tenant G's accounts as the contract's upstream routes do.
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

const RUNTIME = "http://localhost:5181";
const SERVICE_KEY = "wzr_test_service_key";
let issuer = "";

interface Account {
  id: string;
  source: string;
  label: string;
  place: string;
  keyHint: string;
  status: "ready" | "refused" | "resting";
  error: string | null;
  checkedAt: string;
  models: number;
  passing: number;
  uses: { class: string; model: string }[];
  month: { calls: number; usd: number };
}

const accounts: Record<string, Account[]> = {};
let fallback = true;
/** What the runtime asked of the upstream routes, in order. */
const upstreamCalls: { method: string; path: string; body: any }[] = [];
/** The gateway's model calls: the headers say what was asked for. */
const modelCalls: { path: string; headers: IncomingHttpHeaders }[] = [];

function token(claims: Record<string, unknown>, aud: string) {
  return new SignJWT({ scope: "openid wizards:read wizards:write", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setExpirationTime("10m")
    .sign(privateKey);
}

const server: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", issuer);
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
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
    // code-g: the owner of tenant G; code-m: a member of tenant G.
    const member = form.get("code") === "code-m";
    return json({
      access_token: await token(
        {
          sub: member ? "user-m" : "user-g",
          tenant: "tenant-g",
          role: member ? "member" : "owner",
          name: member ? "Member" : "Owner",
          email: member ? "m@test.local" : "g@test.local",
          azp: "wizards-runtime-test",
        },
        form.get("resource") ?? RUNTIME,
      ),
      refresh_token: "refresh",
      expires_in: 600,
    });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  const ups = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/upstreams(?:\/([^/]+))?(\/check)?$/);
  if (ups) {
    const [, tenant, id, check] = ups;
    const body = raw ? JSON.parse(raw) : null;
    upstreamCalls.push({ method: req.method ?? "", path: url.pathname, body });
    const list = (accounts[tenant] ??= []);
    if (req.method === "GET") {
      return json({ fallback, accounts: list });
    }
    if (req.method === "PATCH" && !id) {
      fallback = body.fallback;
      return json({ fallback });
    }
    if (req.method === "POST" && !id) {
      if (body.key.includes("down")) {
        return json({ error: { type: "unavailable", message: "Down for a moment." } }, 503);
      }
      if (body.key.includes("bad")) {
        return json({ error: { type: "key_refused", message: "Incorrect API key provided." } }, 422);
      }
      const account: Account = {
        id: `up-${list.length + 1}`,
        source: body.source,
        label: body.label,
        place: "USA",
        keyHint: body.key.slice(-4),
        status: "ready",
        error: null,
        checkedAt: "2026-11-08T10:00:00.000Z",
        models: 3,
        passing: 3,
        uses: [{ class: "standard", model: "Claude Sonnet 5.5" }],
        month: { calls: 0, usd: 0 },
      };
      list.push(account);
      return json(account, 201);
    }
    const account = list.find((a) => a.id === id);
    if (!account) {
      return json({ error: { type: "not_found", message: "No such account." } }, 404);
    }
    if (req.method === "DELETE") {
      accounts[tenant] = list.filter((a) => a !== account);
      res.writeHead(204);
      return res.end();
    }
    if (check) {
      return json({ ...account, checkedAt: "2026-11-08T11:00:00.000Z" });
    }
    Object.assign(account, body.label ? { label: body.label } : {});
    return json(account);
  }
  const tenant = url.pathname.match(/^\/v1\/tenants\/([^/]+)$/)?.[1];
  if (tenant) {
    return json({
      id: tenant,
      name: tenant,
      status: "active",
      // Tenants Z and Y have the switch on and no credits; Z has an account ready, Y none.
      balanceCredits: tenant === "tenant-z" || tenant === "tenant-y" ? 0 : 100,
      plan: tenant === "tenant-free" ? { id: "free", name: "Free" } : { id: "pro", name: "Pro" },
      limits: { concurrentRuns: 2 },
      db: null,
      features: { ownKeys: true, ownKeysGateway: tenant !== "tenant-o" },
    });
  }
  if (url.pathname === "/v1/models") {
    return json({
      markup: 2,
      classes: { low: { model: "deepseek/deepseek-v4.1-flash", kind: "text" } },
      webSearchCredits: 2,
      models: [
        { id: "fal:fal-ai/flux/schnell", name: "FLUX", source: "fal", provider: "fal", kind: "image" },
      ],
    });
  }
  if (url.pathname.startsWith("/v4/ai/")) {
    modelCalls.push({ path: url.pathname, headers: req.headers });
    return json({ error: { message: "refused", type: "forbidden" } }, 403);
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-own-keys-"));
process.env.APP_URL = RUNTIME;
process.env.MANAGE_URL = issuer;
process.env.GATEWAY_URL = issuer;
process.env.MANAGE_CLIENT_ID = "wizards-runtime-test";
process.env.MANAGE_CLIENT_SECRET = "secret";
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;
process.env.SECRETS = "file";
process.env.PLUGINS_WATCH = "0";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let withTenant: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
let models: typeof import("../src/models");
let upstreams: typeof import("../src/upstreams");
let settings: typeof import("../src/settings");

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  withTenant = client.withTenant;
  models = await import("../src/models");
  upstreams = await import("../src/upstreams");
  settings = await import("../src/settings");
  app = (await import("../src/app")).default;
}, 60_000);

afterAll(() => server.close());

/** The model id the gateway was asked for by one text call of tenant G. */
async function askedFor(cls: "low" | "standard" | "high") {
  modelCalls.length = 0;
  const resolved = await withTenant("tenant-g", () => models.textModel(cls));
  expect(resolved.metered).toBe(true);
  await generateText({ model: resolved.model as never, prompt: "x", maxRetries: 0 }).catch(
    () => null,
  );
  return modelCalls.find((c) => c.path.endsWith("/language-model"))?.headers[
    "ai-language-model-id"
  ];
}

const stored = (tenant: string) =>
  settings.readTenantSetting<{ bindings: Record<string, string>; keys: string | null }>(
    tenant,
    "models",
  );

describe("a provider's binding through the gateway", () => {
  const known = new Set(["openai/gpt-5.5", "anthropic/claude-sonnet-5.5", "fal:fal-ai/flux/schnell"]);
  it("becomes the catalog id of the same model, or nothing", () => {
    expect(models.gatewayRef("openai:gpt-5.5", known)).toBe("credits:openai/gpt-5.5");
    expect(models.gatewayRef("anthropic:claude-sonnet-5-5", known)).toBe(
      "credits:anthropic/claude-sonnet-5.5",
    );
    expect(models.gatewayRef("google:gemini-pro-latest", known)).toBeNull();
    expect(models.gatewayRef("fal:fal-ai/flux/schnell", known)).toBe(
      "credits:fal:fal-ai/flux/schnell",
    );
    expect(models.gatewayRef("replicate:black-forest-labs/flux-schnell", known)).toBeNull();
    expect(models.gatewayRef("codex/default", known)).toBeNull();
    expect(models.gatewayRef("ollama:qwen3", known)).toBeNull();
    // An AI Gateway id is the catalog's already; the credits stay as they are.
    expect(models.gatewayRef("moonshotai/kimi-k3", known)).toBe("credits:moonshotai/kimi-k3");
    expect(models.gatewayRef("credits", known)).toBe("credits");
  });
});

describe("an organization with ownKeysGateway on", () => {
  it("calls the gateway for every class and moves its saved keys to the Manage-App once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withTenant("tenant-g", () =>
      models.saveModels({
        keys: {
          openai: "sk-test-openai-1111",
          anthropic: "sk-ant-test-2222",
          replicate: "r8_test-3333",
        },
        bindings: {
          high: "openai:gpt-5.5",
          standard: "anthropic:claude-sonnet-5-5",
          low: "google:gemini-pro-latest",
        },
      }),
    );
    expect(await askedFor("high")).toBe("openai/gpt-5.5");
    expect(await askedFor("standard")).toBe("anthropic/claude-sonnet-5.5");
    // The catalog has no model for this one: the gateway's class decides.
    expect(await askedFor("low")).toBe("wizards/low");

    const posted = upstreamCalls.filter((c) => c.method === "POST");
    expect(posted.map((c) => c.body)).toEqual([
      { source: "openai", label: "OpenAI", key: "sk-test-openai-1111" },
      { source: "anthropic", label: "Anthropic", key: "sk-ant-test-2222" },
    ]);
    // No key is kept here any more, and the bindings name what the gateway serves.
    expect(await stored("tenant-g")).toEqual({
      keys: null,
      bindings: { high: "credits:openai/gpt-5.5", standard: "credits:anthropic/claude-sonnet-5.5" },
    });
    // Further calls move nothing again.
    await askedFor("high");
    expect(upstreamCalls.filter((c) => c.method === "POST")).toHaveLength(2);
    const view = await withTenant("tenant-g", () => models.modelSettings());
    expect(view.ownKeysGateway).toBe(true);
    expect(view.ownKeysUnused).toBe(false);
    expect(view.keys.openai).toBe(false);
    // A class bound to a language model the gateway serves can start a run.
    expect(await withTenant("tenant-g", () => models.classProblem("high"))).toBeNull();
    // The binding the gateway has nothing for is told once, not at every look.
    const told = warn.mock.calls.filter((args) => String(args[0]).includes("google:gemini-pro-latest"));
    warn.mockRestore();
    expect(told).toHaveLength(1);
  });

  it("doesn't add an account twice when a move was cut short", async () => {
    upstreams.forgetMove("tenant-g");
    upstreamCalls.length = 0;
    // The OpenAI key is there already (same last four); the move left before it cleared the setting.
    await withTenant("tenant-g", () =>
      models.saveModels({ keys: { openai: "sk-test-openai-1111" } }),
    );
    await askedFor("high");
    expect(upstreamCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect((await stored("tenant-g"))?.keys).toBeNull();
  });

  it("keeps a key for the next try while the Manage-App is down, and drops one it refuses", async () => {
    upstreams.forgetMove("tenant-g");
    upstreamCalls.length = 0;
    await withTenant("tenant-g", () =>
      models.saveModels({
        keys: { google: "AIza-test-down-4444", elevenlabs: "sk_test-bad-5555" },
      }),
    );
    await askedFor("high");
    expect(upstreamCalls.filter((c) => c.method === "POST").map((c) => c.body.source)).toEqual([
      "google",
      "elevenlabs",
    ]);
    // Google waits; ElevenLabs is gone. Calls go through the gateway all the same.
    expect((await stored("tenant-g"))?.keys).not.toBeNull();
    expect(await askedFor("high")).toBe("openai/gpt-5.5");
    // Within five minutes the move doesn't try again.
    expect(upstreamCalls.filter((c) => c.method === "POST")).toHaveLength(2);
  });
});

describe("an organization whose plan doesn't let it choose models", () => {
  it("leaves its text classes to the gateway instead of naming models, and keeps media models", async () => {
    await withTenant("tenant-free", () =>
      models.saveModels({
        bindings: {
          high: "openai:gpt-5.5",
          standard: "credits:anthropic/claude-sonnet-5.5",
          low: "credits",
          image: "fal:fal-ai/flux/schnell",
        },
      }),
    );
    const resolved = await withTenant("tenant-free", () => models.textModel("high"));
    expect(resolved.metered).toBe(true);
    expect((await stored("tenant-free"))?.bindings).toEqual({
      low: "credits",
      image: "credits:fal:fal-ai/flux/schnell",
    });
    // A binding saved later is taken out the same way.
    const saved = await withTenant("tenant-free", () =>
      models.asGatewayBindings({ high: "anthropic:claude-sonnet-5-5", image: "fal:fal-ai/flux/schnell" }),
    );
    expect(saved).toEqual({ high: "", image: "credits:fal:fal-ai/flux/schnell" });
  });
});

describe("an organization with ownKeysGateway off", () => {
  it("keeps today's way: its own keys, straight to the provider", async () => {
    await withTenant("tenant-o", () =>
      models.saveModels({
        keys: { openai: "sk-test-own-key-1234" },
        bindings: { high: "openai:gpt-own" },
      }),
    );
    const resolved = await withTenant("tenant-o", () => models.textModel("high"));
    expect(resolved.ref).toBe("openai:gpt-own");
    expect(resolved.metered).toBe(false);
    expect((await stored("tenant-o"))?.keys).not.toBeNull();
  });
});

describe("a failure on the organization's own account", () => {
  it("is for its admins to top up, where the platform's would be final", async () => {
    const { classifyFailure } = await import("../src/engine/failures");
    const err = Object.assign(new Error("You exceeded your current quota"), { statusCode: 429 });
    expect(classifyFailure(err, { managed: true }).class).toBe("final");
    expect(classifyFailure(err, { managed: true, ownAccount: true })).toMatchObject({
      class: "credits",
      why: "provider_credits",
    });
  });
});

// --- the studio's API keys page, passed on to the Manage-App ----------------------------------

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

async function signIn(code: string): Promise<string> {
  const login = await app.fetch(
    new Request(`${RUNTIME}/api/auth/login?return=${encodeURIComponent("/studio/settings")}`),
  );
  const authorize = new URL(login.headers.get("location") ?? "");
  const callback = await app.fetch(
    new Request(
      `${RUNTIME}/api/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`,
      { headers: { cookie: cookieOf(login, "wz_oauth") } },
    ),
  );
  return cookieOf(callback, "wz_session");
}

const call = (method: string, path: string, cookie: string, body?: unknown) =>
  app.fetch(
    new Request(`${RUNTIME}/api/studio${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

describe("the studio's API keys in the cloud", () => {
  let owner = "";
  let member = "";

  beforeAll(async () => {
    owner = await signIn("code-g");
    member = await signIn("code-m");
  });

  it("lists the accounts for everyone, and the keys that didn't move once for the admins", async () => {
    const seen = (await (await call("GET", "/models/keys", member)).json()) as any;
    expect(seen.accounts.map((a: Account) => a.label)).toEqual(["OpenAI", "Anthropic"]);
    expect(seen.kept).toEqual([]);
    const first = (await (await call("GET", "/models/keys", owner)).json()) as any;
    expect(first.fallback).toBe(true);
    expect(first.kept).toEqual([
      expect.objectContaining({ provider: "replicate", reason: "unsupported" }),
      expect.objectContaining({
        provider: "elevenlabs",
        reason: "refused",
        message: "Incorrect API key provided.",
      }),
    ]);
    const again = (await (await call("GET", "/models/keys", owner)).json()) as any;
    expect(again.kept).toEqual([]);
    // The key itself never comes back.
    expect(JSON.stringify(again)).not.toContain("sk-test-openai");
  });

  it("lets owners and admins change them, members not", async () => {
    upstreamCalls.length = 0;
    const add = {
      source: "azure",
      label: "Microsoft Azure",
      key: "azure-test-key-7777",
      settings: {
        baseUrl: "https://acme.openai.azure.com",
        deployments: [{ deployment: "gpt-5.5" }],
        noAbuseLog: true,
      },
    };
    const refused = await call("POST", "/models/keys", member, add);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "forbidden" });
    expect(upstreamCalls).toHaveLength(0);

    const added = await call("POST", "/models/keys", owner, add);
    expect(added.status).toBe(201);
    const account = (await added.json()) as Account;
    expect(account).toMatchObject({ source: "azure", keyHint: "7777" });
    const sent = upstreamCalls[0].body;
    expect(sent.settings.noAbuseLog).toEqual({ by: "user-g", at: expect.any(String) });
    expect(sent.settings.deployments).toEqual([{ deployment: "gpt-5.5" }]);

    const other = await call("POST", "/models/keys", owner, {
      source: "compat",
      label: "Anderer Anbieter",
      key: "compat-key-8888",
      settings: { baseUrl: "https://openai.inference.de-txl.ionos.com/v1", euServers: true, noRetention: true },
    });
    expect(other.status).toBe(201);
    expect(upstreamCalls.at(-1)?.body.settings).toMatchObject({
      company: "ionos",
      euServers: true,
      noRetention: { by: "user-g" },
    });

    // Another provider names its company whether or not the request says where its servers are.
    const plain = await call("POST", "/models/keys", owner, {
      source: "compat",
      label: "Anderer Anbieter",
      key: "compat-key-6666",
      settings: { baseUrl: "https://api.example-llm.de/v1" },
    });
    expect(plain.status).toBe(201);
    expect(upstreamCalls.at(-1)?.body.settings).toEqual({
      baseUrl: "https://api.example-llm.de/v1",
      company: "example-llm",
    });
    const moved = (await plain.json()) as Account;
    await call("PATCH", `/models/keys/${moved.id}`, owner, {
      settings: { baseUrl: "https://eu.other-llm.com/v1" },
    });
    expect(upstreamCalls.at(-1)?.body.settings).toEqual({
      baseUrl: "https://eu.other-llm.com/v1",
      company: "other-llm",
    });

    const bad = await call("POST", "/models/keys", owner, {
      source: "openai",
      label: "OpenAI",
      key: "sk-bad-9999",
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "Incorrect API key provided.", code: "key_refused" });

    expect((await call("POST", `/models/keys/${account.id}/check`, owner, {})).status).toBe(200);
    expect((await call("POST", `/models/keys/${account.id}/check`, member, {})).status).toBe(403);
    const renamed = await call("PATCH", `/models/keys/${account.id}`, owner, { key: "azure-new-0000" });
    expect(renamed.status).toBe(200);
    expect(upstreamCalls.at(-1)).toMatchObject({ method: "PATCH", body: { key: "azure-new-0000" } });

    expect((await call("PATCH", "/models/keys", member, { fallback: false })).status).toBe(403);
    expect(await (await call("PATCH", "/models/keys", owner, { fallback: false })).json()).toEqual({
      fallback: false,
    });

    expect((await call("DELETE", `/models/keys/${account.id}`, member)).status).toBe(403);
    expect((await call("DELETE", `/models/keys/${account.id}`, owner)).status).toBe(204);
    expect(accounts["tenant-g"].some((a) => a.id === account.id)).toBe(false);
  });

  it("takes no keys into the model settings any more, and saves bindings the gateway serves", async () => {
    const withKey = await call("PUT", "/models", owner, { keys: { openai: "sk-test" } });
    expect(withKey.status).toBe(400);
    expect(await withKey.json()).toMatchObject({ code: "own_keys_gateway" });
    const saved = await call("PUT", "/models", owner, { bindings: { high: "openai:gpt-5.5" } });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as any).bindings.high).toBe("credits:openai/gpt-5.5");
  });
});

describe("an organization with ownKeysGateway on and no credits", () => {
  it("may start what runs on its own account ready, and nothing without one", async () => {
    const { canSpend } = await import("../src/credits/credits");
    accounts["tenant-z"] = [
      {
        id: "up-z",
        source: "compat",
        label: "Ours",
        place: "EU",
        keyHint: "1234",
        status: "ready",
        error: null,
        checkedAt: "2026-11-08T10:00:00.000Z",
        models: 1,
        passing: 1,
        uses: [{ class: "standard", model: "GPT 5.4 Nano" }],
        month: { calls: 0, usd: 0 },
      },
    ];
    expect(await withTenant("tenant-z", () => canSpend())).toBe(true);
    expect(await withTenant("tenant-y", () => canSpend())).toBe(false);
  });
});

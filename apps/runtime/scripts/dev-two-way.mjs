#!/usr/bin/env node
// Two-way sync on one machine: a stand-in account service, a cloud runtime with its own studio,
// and the studio of a computer with the twoWaySync switch on. Data lives in data/two-way/ (gone
// with --fresh). Not for production: the stand-in signs anyone in as the owner of "Dev org".
//
//   node apps/runtime/scripts/dev-two-way.mjs [--fresh]
//
// Ports: account 8790, cloud API 8891 + studio 5182, computer API 24368 + studio 5181.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DATA = join(ROOT, "data/two-way");
const ACCOUNT = "http://127.0.0.1:8790";
const CLOUD = "http://localhost:5182";
const COMPUTER = "http://localhost:5181";
const SERVICE_KEY = `wzr_dev_${randomBytes(12).toString("hex")}`;
const ACCESS_KEY = randomBytes(18).toString("hex");

if (process.argv.includes("--fresh")) {
  rmSync(DATA, { recursive: true, force: true });
}
mkdirSync(join(DATA, "cloud"), { recursive: true });
mkdirSync(join(DATA, "computer"), { recursive: true });

// ---- the stand-in account service (Manage-App): sign-in, tokens, one organization ----

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "dev", alg: "ES256", use: "sig" };
const person = { id: "dev-person", name: "Dev", email: "dev@localhost" };
const org = {
  id: "dev-org",
  name: "Dev org",
  slug: "dev-org",
  status: "active",
  balanceCredits: 1000,
  limits: { concurrentRuns: 2, projects: 10, build: true, members: null },
  features: { twoWaySync: true },
  db: null,
};

const token = (audience, clientId) =>
  new SignJWT({
    scope: "openid profile email offline_access wizards:read wizards:write wizards:publish",
    sub: person.id,
    tenant: org.id,
    role: "owner",
    name: person.name,
    email: person.email,
    azp: clientId,
  })
    .setProtectedHeader({ alg: "ES256", kid: "dev" })
    .setIssuer(ACCOUNT)
    .setAudience(audience)
    .setExpirationTime("8h")
    .sign(privateKey);

const account = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ACCOUNT);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const json = (body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const path = url.pathname;
  if (path === "/.well-known/openid-configuration" || path === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: ACCOUNT,
      authorization_endpoint: `${ACCOUNT}/authorize`,
      token_endpoint: `${ACCOUNT}/token`,
      jwks_uri: `${ACCOUNT}/jwks`,
      revocation_endpoint: `${ACCOUNT}/revoke`,
    });
  }
  if (path === "/jwks") return json({ keys: [jwk] });
  if (path === "/authorize") {
    // Signs in without asking: straight back with a code.
    const back = new URL(url.searchParams.get("redirect_uri") ?? COMPUTER);
    back.searchParams.set("code", "dev");
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (path === "/token") {
    const form = new URLSearchParams(raw);
    const audience = form.get("resource") ?? CLOUD;
    return json({
      access_token: await token(audience, form.get("client_id") ?? "wizards-desktop"),
      refresh_token: "dev-refresh",
      expires_in: 8 * 3600,
      token_type: "Bearer",
    });
  }
  if (path === "/revoke") return json({});
  if (path === "/v1/me") {
    return json({
      user: person,
      tenant: { id: org.id, name: org.name, role: "owner", balanceCredits: org.balanceCredits, features: org.features },
    });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }
  if (path === "/v1/grants/check") return json({ active: true });
  if (/^\/v1\/tenants\/[^/]+$/.test(path)) return json(org);
  if (path === "/v1/models") {
    // The cloud's AI goes through the gateway, which the stand-in does not have: runs in the
    // cloud fail, editing and syncing work.
    const text = { model: "dev/none", kind: "text", inputCreditsPerMTok: 1, outputCreditsPerMTok: 1 };
    return json({ markup: 2, classes: { classifier: text, standard: text, high: text, highest: text }, webSearchCredits: 2 });
  }
  return json({ error: "not found", code: "not_found" }, 404);
});
await new Promise((done) => account.listen(8790, "127.0.0.1", done));

// ---- the runtimes and their studios ----

const children = [];
const quiet = { SANDBOX_ENABLED: "0", PLUGINS_WATCH: "0", MARKETPLACE_URL: "off" };

function run(name, color, command, args, env, cwd = ROOT) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `\x1b[${color}m${name.padEnd(8)}\x1b[0m│ `;
  const print = (chunk) => {
    for (const line of String(chunk).split("\n")) if (line.trim()) process.stdout.write(tag + line + "\n");
  };
  child.stdout.on("data", print);
  child.stderr.on("data", print);
  child.on("exit", (code) => {
    if (!stopping) {
      console.log(`${tag}stopped (${code}); stopping the rest`);
      stop(1);
    }
  });
  children.push(child);
}

const tsx = ["exec", "tsx", "--conditions=wizards-source", "apps/runtime/src/index.ts"];

run("cloud", 34, "pnpm", tsx, {
  ...quiet,
  DATA_DIR: join(DATA, "cloud"),
  API_PORT: "8891",
  APP_URL: CLOUD,
  MANAGE_URL: ACCOUNT,
  GATEWAY_URL: ACCOUNT,
  MANAGE_CLIENT_ID: "wizards-runtime",
  MANAGE_CLIENT_SECRET: "dev",
  MANAGE_SERVICE_KEY: SERVICE_KEY,
});
run("cloud-ui", 36, "pnpm", ["exec", "vite", "--port", "5182", "--strictPort"], { API_PORT: "8891" }, join(ROOT, "apps/web"));
run("computer", 32, "pnpm", tsx, {
  ...quiet,
  DATA_DIR: join(DATA, "computer"),
  API_PORT: "24368",
  APP_URL: COMPUTER,
  ACCOUNT_URL: ACCOUNT,
  ACCOUNT_GATEWAY_URL: ACCOUNT,
  CLOUD_URL: CLOUD,
  FEATURES: "twoWaySync=on",
  LOCAL_ACCESS_KEY: ACCESS_KEY,
  DEV_LOGIN: "1",
});
run("ui", 35, "pnpm", ["exec", "vite", "--port", "5181", "--strictPort"], { API_PORT: "24368" }, join(ROOT, "apps/web"));

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  account.close();
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

setTimeout(() => {
  console.log(`
  Two-way sync, on this machine
  ─────────────────────────────
  Your computer   ${COMPUTER}/studio/   (Dev-Login, or ${COMPUTER}/api/local/enter?k=${ACCESS_KEY})
  The cloud       ${CLOUD}/studio/      (sign in: the stand-in lets you straight in)

  On the computer: Settings › Account › Sign in links it to "Dev org";
  Settings › Spaces in the cloud shows what syncs. Data: data/two-way/ (--fresh starts over).
`);
}, 6000);

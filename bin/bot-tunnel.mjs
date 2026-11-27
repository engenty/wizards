// The tunnel of a home at <name>.wizards.host: frpc to our relay, and its certificate.
//
// `wizards bot tunnel` (bin/bot.mjs) uses what this file exports, and copies the file into the
// home as `tunnel/run.mjs`; run there by the home's tunnel service, it keeps frpc running and
// renews the certificate before it ends. Like bot.mjs it needs nothing but Node.
//
//   tunnel/claim.pem     the tunnel's own Ed25519 key (0600): its name is made from it, and it
//                        claims the name again after --off; losing it loses the name
//   tunnel/tunnel.json   the API, the name, the key for it, frpc and the home's port (0600)
//   tunnel/frpc.toml     frpc's settings (0600: it holds the key)
//   tunnel/key.pem       this computer's private key for the name (0600); it never leaves it
//   tunnel/cert.pem      the certificate for the name, from Let's Encrypt through wizards.host
//
// The relay ends no TLS: frpc's https2http plugin ends it here, with key.pem and cert.pem, and
// hands plain HTTP to the home on 127.0.0.1.
import { spawn, spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  X509Certificate,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Where tunnels get their names and certificates: WIZARDS_TUNNEL_URL changes it. */
export const TUNNEL_URL = "https://wizards.host";
/** Renew this long before a certificate ends. */
export const RENEW_BEFORE = 30 * 24 * 3600_000;
/** How often the running tunnel looks at its certificate. */
const CHECK_EVERY = 12 * 3600_000;

// --- the tunnel's own key, and the name it gets ---------------------------------------------

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lower case, without padding. */
function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

/** The name a key claims: the first 10 characters of base32(sha256(raw public key)). */
export function claimName(publicKeyRaw) {
  return base32(createHash("sha256").update(publicKeyRaw).digest()).slice(0, 10);
}

/** The tunnel's Ed25519 key in `claim.pem`, made the first time; it stays for you alone. */
export function claimKey(file) {
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileAtomic(file, privateKey.export({ type: "pkcs8", format: "pem" }), true);
  }
  return createPrivateKey(readFileSync(file, "utf8"));
}

/** A key's raw 32-byte public half, base64url. */
export function publicKeyOf(privateKey) {
  return createPublicKey(privateKey).export({ format: "jwk" }).x;
}

/** What a claim signs. */
export const claimText = (publicKey, timestamp) => `wizards.host claim ${publicKey} ${timestamp}`;

/** The body of `POST /v1/tunnels/claim`: the public key, now, and the signature over both. */
export function claimBody(privateKey, now = Date.now()) {
  const publicKey = publicKeyOf(privateKey);
  const signature = sign(null, Buffer.from(claimText(publicKey, now)), privateKey).toString(
    "base64url",
  );
  return { publicKey, timestamp: now, signature };
}

/**
 * Claims the name of the key in `file`: no account, no browser. Every claim gives a fresh key
 * for the relay; the name stays the key's.
 */
export async function claim(api, file, computer) {
  const { data } = await call(api, "/v1/tunnels/claim", {
    method: "POST",
    body: { ...claimBody(claimKey(file)), ...(computer ? { computer } : {}) },
  });
  return data;
}

// --- a key and a certificate request ---------------------------------------------------------

/** A new EC P-256 private key, as PEM. */
export function makeKey() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

function length(n) {
  if (n < 0x80) {
    return Buffer.from([n]);
  }
  const bytes = [];
  for (let rest = n; rest > 0; rest >>= 8) {
    bytes.unshift(rest & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};

function oid(text) {
  const [a, b, ...rest] = text.split(".").map(Number);
  const bytes = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) {
      chunk.unshift((v & 0x7f) | 0x80);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const sequence = (...parts) => tlv(0x30, ...parts);

/**
 * A PKCS#10 certificate request for one name, signed with the key: the name as the subject's
 * common name and as the only DNS name. Built by hand, since Node has no API for it.
 */
export function csrFor(name, keyPem) {
  const key = createPrivateKey(keyPem);
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const subject = sequence(tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(name)))));
  const san = sequence(tlv(0x82, Buffer.from(name, "ascii")));
  const extensions = sequence(sequence(oid("2.5.29.17"), tlv(0x04, san)));
  const attributes = tlv(0xa0, sequence(oid("1.2.840.113549.1.9.14"), tlv(0x31, extensions)));
  const info = sequence(tlv(0x02, Buffer.from([0])), subject, spki, attributes);
  const signature = sign("sha256", info, { key, dsaEncoding: "der" });
  const der = sequence(
    info,
    sequence(oid("1.2.840.10045.4.3.2")),
    tlv(0x03, Buffer.from([0]), signature),
  );
  const lines = der
    .toString("base64")
    .match(/.{1,64}/g)
    .join("\n");
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines}\n-----END CERTIFICATE REQUEST-----\n`;
}

// --- the certificate -------------------------------------------------------------------------

/** When a certificate ends, or null when the text isn't one. */
export function notAfter(certPem) {
  try {
    return new Date(new X509Certificate(certPem).validTo);
  } catch {
    return null;
  }
}

/** Whether a certificate is missing, unreadable, or ends within RENEW_BEFORE. */
export function needsRenewal(certPem, now = Date.now()) {
  const end = certPem ? notAfter(certPem) : null;
  return !end || end.getTime() - now < RENEW_BEFORE;
}

/** Something the tunnel API said no to, with its sentence for people and its code. */
export class AccountError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** A call to the tunnel API at `api` (wizards.host): its JSON, or an AccountError. */
export async function call(api, path, { method = "GET", key, body } = {}) {
  let res;
  try {
    res = await fetch(`${api}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        "user-agent": "wizards-bot-tunnel",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new AccountError(`${api} didn’t answer: ${error.message}`, "unreachable", 0);
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AccountError(
      data.error || `${api} answered ${res.status}.`,
      data.code || "error",
      res.status,
    );
  }
  return { status: res.status, data };
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * A certificate for the key's name: posts the request, then asks every `every` ms until the
 * API has it (Let's Encrypt checks the name's DNS meanwhile). Returns the PEM chain.
 */
export async function orderCertificate(api, key, csr, { every = 3000, within = 300_000 } = {}) {
  const { data: order } = await call(api, "/v1/tunnels/cert", {
    method: "POST",
    key,
    body: { csr },
  });
  const until = Date.now() + within;
  while (Date.now() < until) {
    const { data } = await call(api, `/v1/tunnels/cert/${encodeURIComponent(order.id)}`, {
      key,
    });
    if (data.state === "ready" && data.cert) {
      return data.cert;
    }
    if (data.state === "failed") {
      throw new AccountError(data.error || "The certificate couldn’t be made.", "failed", 200);
    }
    await pause(every);
  }
  throw new AccountError("The certificate took too long. Try again in a few minutes.", "slow", 0);
}

/** Writes a file in one move, readable only by you where `secret`. */
export function writeFileAtomic(file, text, secret = false) {
  const next = `${file}.next`;
  writeFileSync(next, text, { mode: secret ? 0o600 : 0o644 });
  if (secret) {
    chmodSync(next, 0o600);
  }
  renameSync(next, file);
}

// --- frpc's settings -------------------------------------------------------------------------

const toml = (text) => JSON.stringify(String(text));

/**
 * frpc.toml for a home: one https proxy for the name, TLS ended here by the https2http plugin,
 * the control connection over wss to the relay, the key as metadata, and frpc's admin API on
 * 127.0.0.1 so `frpc reload` can read a renewed certificate.
 */
export function frpcConfig(tunnel) {
  return [
    "# Written by `wizards bot tunnel`; `wizards bot update` writes it again.",
    `serverAddr = ${toml(tunnel.server)}`,
    `serverPort = ${Number(tunnel.serverPort)}`,
    "loginFailExit = false",
    'transport.protocol = "wss"',
    "transport.tls.useSystemCa = true",
    "transport.heartbeatInterval = 30",
    "transport.heartbeatTimeout = 90",
    `metadatas.token = ${toml(tunnel.key)}`,
    'webServer.addr = "127.0.0.1"',
    `webServer.port = ${Number(tunnel.adminPort)}`,
    'webServer.user = "wizards"',
    `webServer.password = ${toml(tunnel.adminPassword)}`,
    "",
    "[[proxies]]",
    `name = ${toml(tunnel.name)}`,
    'type = "https"',
    `customDomains = [${toml(tunnel.name)}]`,
    "",
    "[proxies.plugin]",
    'type = "https2http"',
    `localAddr = ${toml(`127.0.0.1:${Number(tunnel.port)}`)}`,
    `crtPath = ${toml(join(tunnel.dir, "cert.pem"))}`,
    `keyPath = ${toml(join(tunnel.dir, "key.pem"))}`,
    "",
  ].join("\n");
}

// --- running -------------------------------------------------------------------------------

const stamp = () => new Date().toISOString();
const say = (text) => console.log(`${stamp()}  ${text}`);

/** Renews the certificate when it's due; true when there's a new one. */
export async function renewIfDue(tunnel, now = Date.now()) {
  const certFile = join(tunnel.dir, "cert.pem");
  const current = existsSync(certFile) ? readFileSync(certFile, "utf8") : null;
  if (!needsRenewal(current, now)) {
    return false;
  }
  const keyPem = readFileSync(join(tunnel.dir, "key.pem"), "utf8");
  const cert = await orderCertificate(tunnel.api, tunnel.key, csrFor(tunnel.name, keyPem));
  writeFileAtomic(certFile, cert);
  return true;
}

/**
 * The tunnel's service: frpc, started again when it ends (after 1 s, then longer, up to a
 * minute), and the certificate looked at every 12 hours.
 */
export async function run(dir) {
  const tunnel = { ...JSON.parse(readFileSync(join(dir, "tunnel.json"), "utf8")), dir };
  const config = join(dir, "frpc.toml");
  let child = null;
  let wait = 1000;
  let stopping = false;
  const startFrpc = () => {
    const started = Date.now();
    say(`frpc for https://${tunnel.name}`);
    child = spawn(tunnel.frpc, ["-c", config], { stdio: "inherit" });
    child.on("exit", (code, signal) => {
      child = null;
      if (stopping) {
        return;
      }
      wait = Date.now() - started > 300_000 ? 1000 : Math.min(wait * 2, 60_000);
      say(`frpc ended (${signal || code}); again in ${Math.round(wait / 1000)} s`);
      setTimeout(startFrpc, wait);
    });
    child.on("error", (error) => say(`frpc didn’t start: ${error.message}`));
  };
  const check = async () => {
    try {
      if (await renewIfDue(tunnel)) {
        say(
          `New certificate for ${tunnel.name}, until ${notAfter(readFileSync(join(dir, "cert.pem"), "utf8"))?.toISOString()}`,
        );
        const reload = spawnSync(tunnel.frpc, ["reload", "-c", config], { encoding: "utf8" });
        if (reload.status !== 0) {
          say(`frpc reload failed (${(reload.stderr || reload.stdout).trim()}); restarting frpc`);
          child?.kill("SIGTERM");
        }
      }
    } catch (error) {
      say(`The certificate wasn’t renewed: ${error.message}`);
    }
  };
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      stopping = true;
      child?.kill("SIGTERM");
      process.exit(0);
    });
  }
  await check();
  startFrpc();
  setInterval(check, CHECK_EVERY);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node run.mjs <the home's tunnel folder>");
    process.exit(2);
  }
  await run(dir);
}

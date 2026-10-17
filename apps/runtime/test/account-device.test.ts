import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A stand-in for the account's Manage-App: the discovery, the device code endpoint and the
// token endpoint, which lets the device wait, slows it down once, then hands out tokens.
interface Seen {
  path: string;
  body: URLSearchParams;
}
const seen: Seen[] = [];
let polls = 0;
let verdict: "approved" | "denied" = "approved";
let origin = "";
const ACCOUNT_TOKEN = `e30.${Buffer.from(
  JSON.stringify({ sub: "user-7", tenant: "tenant-7", name: "Mia", email: "mia@test.local" }),
).toString("base64url")}.sig`;

const manage: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", origin);
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  seen.push({ path: url.pathname, body: new URLSearchParams(raw) });
  if (url.pathname === "/.well-known/openid-configuration") {
    // No device_authorization_endpoint: the runtime falls back to the documented path.
    return json({
      issuer: origin,
      token_endpoint: `${origin}/api/auth/oauth2/token`,
      jwks_uri: `${origin}/jwks`,
    });
  }
  if (url.pathname === "/api/auth/device/code") {
    return json({
      device_code: "device-1",
      user_code: "ABCD-EFGH",
      verification_uri: `${origin}/device`,
      verification_uri_complete: `${origin}/device?user_code=ABCD-EFGH`,
      expires_in: 1800,
      interval: 5,
    });
  }
  if (url.pathname === "/api/auth/oauth2/token") {
    polls++;
    if (verdict === "denied") {
      return json({ error: "access_denied" }, 400);
    }
    if (polls === 1) {
      return json({ error: "authorization_pending" }, 400);
    }
    if (polls === 2) {
      return json({ error: "slow_down" }, 400);
    }
    return json({ access_token: ACCOUNT_TOKEN, refresh_token: "refresh-1", expires_in: 600 });
  }
  return json({ error: "not found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
origin = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

const dir = mkdtempSync(join(tmpdir(), "wizards-device-code-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.ACCOUNT_URL = origin;
process.env.CLOUD_URL = "https://cloud.test";
process.env.MARKETPLACE_URL = "off";
process.env.PLUGINS_WATCH = "0";
delete process.env.MANAGE_URL;
delete process.env.SECRETS;

let device: typeof import("../src/auth/device");
let account: typeof import("../src/auth/account");
let vault: typeof import("../src/secrets/vault");

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  device = await import("../src/auth/device");
  account = await import("../src/auth/account");
  vault = await import("../src/secrets/vault");
});
afterAll(() => {
  manage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("signing in with a device code", () => {
  it("asks for a code as the wizards-desktop client, for the cloud", async () => {
    const code = await device.requestDeviceCode();
    expect(code).toMatchObject({
      deviceCode: "device-1",
      userCode: "ABCD-EFGH",
      verificationUri: `${origin}/device`,
      verificationUriComplete: `${origin}/device?user_code=ABCD-EFGH`,
      interval: 5,
    });
    expect(code.expiresAt).toBeGreaterThan(Date.now() + 1700_000);
    const request = seen.find((s) => s.path === "/api/auth/device/code");
    expect(request?.body.get("client_id")).toBe("wizards-desktop");
    expect(request?.body.get("scope")).toBe(account.SCOPE);
    expect(request?.body.get("resource")).toBe("https://cloud.test");
  });

  it("waits, slows down when told, and keeps the tokens as the browser flow does", async () => {
    const code = await device.requestDeviceCode();
    const waited: number[] = [];
    const linked = await device.waitForDeviceSignIn(code, {
      wait: async (ms) => {
        waited.push(ms);
      },
    });
    expect(linked).toEqual({
      userId: "user-7",
      tenantId: "tenant-7",
      name: "Mia",
      email: "mia@test.local",
    });
    // Five seconds as the Manage-App said, then five more after slow_down.
    expect(waited).toEqual([5000, 5000, 10_000]);
    const tokenRequests = seen.filter((s) => s.path === "/api/auth/oauth2/token");
    expect(tokenRequests).toHaveLength(3);
    expect(Object.fromEntries(tokenRequests[0].body)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device-1",
      resource: "https://cloud.test",
      client_id: "wizards-desktop",
    });
    // The refresh token in the vault, the account in the settings: what the runtime reads.
    expect(await vault.vaultGet("account.refresh")).toBe("refresh-1");
    expect(await account.linkedAccount()).toEqual(linked);
  });

  it("ends without an account when the person chose to sign in later", async () => {
    const code = await device.requestDeviceCode();
    const later = new AbortController();
    const asked = polls;
    const waiting = device.waitForDeviceSignIn(code, { signal: later.signal });
    later.abort();
    await expect(waiting).rejects.toMatchObject({ reason: "skipped" });
    // The pause ended at once, and the token endpoint was not asked again.
    expect(polls).toBe(asked);
  });

  it("ends when the code expired or the person refused", async () => {
    const code = await device.requestDeviceCode();
    await expect(
      device.waitForDeviceSignIn(
        { ...code, expiresAt: Date.now() - 1 },
        { wait: async () => undefined },
      ),
    ).rejects.toMatchObject({ reason: "expired" });
    verdict = "denied";
    await expect(
      device.waitForDeviceSignIn(code, { wait: async () => undefined }),
    ).rejects.toMatchObject({ reason: "denied" });
  });
});

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A stand-in for the account's Manage-App: its sign-in token endpoint and /v1/connect.
interface Seen {
  path: string;
  authorization: string | undefined;
  body: any;
}
const seen: Seen[] = [];
const ACCOUNT_TOKEN = `e30.${Buffer.from(
  JSON.stringify({ sub: "user-1", tenant: "tenant-1", name: "C", email: "c@test.local" }),
).toString("base64url")}.sig`;
const offersGoogle = true;
let origin = "";

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
  if (url.pathname === "/.well-known/openid-configuration") {
    return json({ issuer: origin, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks` });
  }
  if (url.pathname === "/token") {
    return json({ access_token: ACCOUNT_TOKEN, refresh_token: "refresh-2", expires_in: 600 });
  }
  seen.push({ path: url.pathname, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
  if (url.pathname === "/v1/connect") {
    return json({ google: offersGoogle });
  }
  if (url.pathname === "/v1/connect/google/start") {
    return json({ url: "https://accounts.google.test/consent" });
  }
  if (url.pathname === "/v1/connect/google/redeem") {
    return json({
      access_token: "ya29.first",
      refresh_token: "1//refresh",
      expires_in: 3600,
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
    });
  }
  if (url.pathname === "/v1/connect/google/refresh") {
    return JSON.parse(raw).refreshToken === "1//refresh"
      ? json({ access_token: "ya29.second", expires_in: 3600, scope: "openid email" })
      : json({ error: "Google no longer accepts this connection.", code: "invalid_grant" }, 400);
  }
  return json({ error: "not found" }, 404);
});
await new Promise<void>((r) => manage.listen(0, "127.0.0.1", r));
origin = `http://127.0.0.1:${(manage.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-connect-"));
process.env.APP_URL = "http://localhost:5181";
process.env.ACCOUNT_URL = origin;
process.env.CLOUD_URL = origin;
process.env.PLUGINS_WATCH = "0";
for (const key of [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MANAGE_URL",
]) {
  delete process.env[key];
}

let connectors: typeof import("../src/connectors/index");
let client: typeof import("../src/db/client");
let wizardId = "";

const connection = { id: "mail", kind: "mail" as const };
const local = <T>(fn: () => Promise<T>) => client.withTenant("local", fn);

async function link() {
  const { vaultSet } = await import("../src/secrets/vault");
  const { writeSetting } = await import("../src/settings");
  await vaultSet("account.refresh", "refresh-1");
  await writeSetting("account", { userId: "user-1", tenantId: "tenant-1", name: "C", email: "c@test.local" });
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  connectors = await import("../src/connectors/index");
  const wizards = await import("../src/services/wizards");
  wizardId = (
    await local(() =>
      wizards.createWizard("local", {
        definition: {
          version: 1,
          title: "Mail",
          description: "",
          avatar: "round",
          steps: [{ id: "done", type: "result", title: "Fertig", deliverables: [] }],
        },
      }),
    )
  ).id;
}, 60_000);

afterAll(() => manage.close());

describe("Google on a local install without its own Google client", () => {
  it("is offered when the account's Manage-App connects Google, linked or not", async () => {
    const options = await connectors.connectorOptions(connection, "p");
    expect(options.map((o) => o.id)).toContain("mail-gmail");
    expect(seen.at(-1)?.authorization).toBeUndefined();
  });

  it("asks to link the account first", async () => {
    await expect(
      local(() =>
        connectors.startOAuth({ wizardId, holder: "local" }, "p", "run-1", connection, "mail-gmail"),
      ),
    ).rejects.toThrow(/engenty account first/);
  });

  it("starts at the Manage-App with the account's token, the scopes and its own callback", async () => {
    await link();
    const url = await local(() =>
      connectors.startOAuth({ wizardId, holder: "local" }, "p", "run-1", connection, "mail-gmail"),
    );
    expect(url).toBe("https://accounts.google.test/consent");
    const start = seen.findLast((s) => s.path === "/v1/connect/google/start");
    expect(start?.authorization).toBe(`Bearer ${ACCOUNT_TOKEN}`);
    expect(start?.body.returnUrl).toBe("http://localhost:5181/api/connect/callback");
    expect(start?.body.scopes).toEqual(
      expect.arrayContaining(["https://www.googleapis.com/auth/gmail.readonly"]),
    );
    expect(connectors.oauthStateRun(start?.body.state)).toBe("run-1");
  });

  it("redeems a ticket and refreshes through the Manage-App", async () => {
    const { redeemTicket, refreshThroughAccount } = await import("../src/connectors/via-account");
    const tokens = await redeemTicket("ticket-0123456789abcdefghij");
    expect(tokens).toMatchObject({ accessToken: "ya29.first", refreshToken: "1//refresh" });
    expect(tokens.grantedScopes).toContain("https://www.googleapis.com/auth/gmail.readonly");

    const scope = { wizardId, holder: "local" };
    const { putSecret } = await import("../src/store/index");
    await local(() =>
      putSecret(scope, "connection:mail", "mail-gmail", "c@gmail.com", {
        accessToken: "ya29.old",
        refreshToken: "1//refresh",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        scopes: [],
        via: "account",
      }),
    );
    const ctx = await local(() => connectors.connectionContext(scope, connection, "p"));
    expect(ctx?.ctx.accessToken).toBe("ya29.second");
    expect(seen.at(-1)?.path).toBe("/v1/connect/google/refresh");

    await expect(refreshThroughAccount("1//gone")).rejects.toThrow(/Connect the account again/);
  });

});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STAND_IN_KEY, startComposioStandIn } from "./composio-stand-in.shared";

/**
 * The Composio client (docs/plans/composio.md, step 3): a key of one's own straight to Composio,
 * or through the Manage-App, which says `composio: true` at `GET /v1/connect`. Both against a
 * stand-in; no real key, no real account.
 */
const composio = await startComposioStandIn();

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-composio-"));
process.env.APP_URL = "http://localhost:5181";
process.env.ACCOUNT_URL = composio.origin;
process.env.COMPOSIO_URL = composio.origin;
delete process.env.COMPOSIO_API_KEY;
delete process.env.MANAGE_URL;

// The linked account's token, as auth/account.ts would hand it out.
vi.mock("../src/auth/account.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/account.js")>()),
  accountToken: async () => "linked-account-token",
}));

let client: typeof import("../src/connectors/composio");
let failures: typeof import("../src/engine/failures");

beforeAll(async () => {
  client = await import("../src/connectors/composio");
  failures = await import("../src/engine/failures");
});
afterAll(() => composio.close());
beforeEach(async () => {
  composio.seen.length = 0;
  composio.answer.execute = undefined;
  composio.offers.composio = true;
  await client.setComposioKey("");
  client.forgetComposioWay();
  client.forgetComposioCatalog();
});

describe("which way", () => {
  it("takes the Manage-App where it offers Composio and no key of one's own is there", async () => {
    expect(await client.composioWay()).toBe("account");
  });

  it("takes nothing where the Manage-App doesn't offer it", async () => {
    composio.offers.composio = false;
    expect(await client.composioWay()).toBeNull();
  });

  it("takes the own key where both are there, and shows it masked", async () => {
    await client.setComposioKey(`  ${STAND_IN_KEY}  `);
    expect(await client.composioWay()).toBe("own");
    expect(await client.composioKeyHint()).toEqual({ set: true, masked: "…-key" });
    await client.setComposioKey("");
    expect(await client.composioKeyHint()).toEqual({ set: false, masked: null });
  });
});

describe("with a key of one's own", () => {
  beforeEach(() => client.setComposioKey(STAND_IN_KEY));

  it("searches the catalog and reads a toolkit's tools, and never sends the key to the Manage-App", async () => {
    const hits = await client.searchToolkits("gm", "own");
    expect(hits.map((t) => t.slug)).toEqual(["gmail"]);
    expect(hits[0]).toMatchObject({ name: "Gmail", managed: true, categories: ["mail"] });
    const found = await client.toolkitTools("gmail", "own");
    expect(found?.tools.map((t) => t.slug)).toContain("GMAIL_SEND_EMAIL");
    expect(await client.toolkitTools("nothing-here", "own")).toBeNull();
    expect(await client.toolkitTools("../etc", "own")).toBeNull();
    expect(composio.seen.every((s) => !s.path.startsWith("/v1/"))).toBe(true);
    expect(composio.seen.every((s) => s.headers["x-api-key"] === STAND_IN_KEY)).toBe(true);
  });

  it("signs in with Composio's own app, made once, and checks whose account comes back", async () => {
    const url = await client.startComposioSignIn("own", {
      toolkit: "gmail",
      holder: "s:space-1",
      returnUrl: "http://localhost:5181/api/connect/callback",
      state: "sealed-state",
    });
    const made = composio.seen.filter((s) => s.path === "/api/v3/auth_configs" && s.method === "POST");
    expect(made).toHaveLength(1);
    expect(made[0]?.body.auth_config).toEqual({ type: "use_composio_managed_auth" });
    const back = new URL(decodeURIComponent(new URL(url).searchParams.get("next") ?? ""));
    expect(back.searchParams.get("state")).toBe("sealed-state");
    const id = back.searchParams.get("connected_account_id") ?? "";

    // A second sign-in takes the same auth config.
    await client.startComposioSignIn("own", {
      toolkit: "gmail",
      holder: "u:user-1",
      returnUrl: "http://localhost:5181/api/connect/callback",
      state: "s2",
    });
    expect(composio.seen.filter((s) => s.path === "/api/v3/auth_configs" && s.method === "POST")).toHaveLength(1);

    expect(
      await client.finishComposioSignIn("own", { connectedAccountId: id, holder: "s:space-1", toolkit: "gmail" }),
    ).toBe(id);
    // Someone else's account in the address: refused.
    await expect(
      client.finishComposioSignIn("own", { connectedAccountId: id, holder: "s:space-2", toolkit: "gmail" }),
    ).rejects.toThrow(/didn’t finish/);
    await expect(
      client.finishComposioSignIn("own", { connectedAccountId: id, holder: "s:space-1", toolkit: "notion" }),
    ).rejects.toThrow(/didn’t finish/);
  });

  it("runs a tool for the connected account and signs it out", async () => {
    const url = await client.startComposioSignIn("own", {
      toolkit: "gmail",
      holder: "s:space-1",
      returnUrl: "http://localhost:5181/api/connect/callback",
      state: "x",
    });
    const id = new URL(decodeURIComponent(new URL(url).searchParams.get("next") ?? "")).searchParams.get(
      "connected_account_id",
    ) as string;
    const data = await client.executeComposioTool("own", {
      connectedAccountId: id,
      holder: "s:space-1",
      tool: "GMAIL_FETCH_EMAILS",
      arguments: { query: "is:unread" },
    });
    expect(data).toEqual({ ran: "GMAIL_FETCH_EMAILS", input: { query: "is:unread" } });
    await client.composioSignOut("own", id);
    expect(composio.accounts.has(id)).toBe(false);
    // Gone already: no failure.
    await client.composioSignOut("own", id);
  });

  it("says what Composio refused, and a 429 is tried again after its Retry-After", async () => {
    composio.answer.execute = () => ({ status: 200, body: { successful: false, error: "Quota of Gmail" } });
    await expect(
      client.executeComposioTool("own", { connectedAccountId: "ca", holder: "s:a", tool: "GMAIL_SEND_EMAIL", arguments: {} }),
    ).rejects.toThrow(/Quota of Gmail/);

    composio.answer.execute = () => ({ status: 429, body: { error: "slow down" }, headers: { "retry-after": "7" } });
    const err = await client
      .executeComposioTool("own", { connectedAccountId: "ca", holder: "s:a", tool: "GMAIL_SEND_EMAIL", arguments: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(client.ComposioError);
    expect((err as InstanceType<typeof client.ComposioError>).retryAfter).toBe(7);
    expect(failures.classifyFailure(err, { managed: false })).toEqual({
      class: "retry",
      retryAfterMs: 7000,
      why: "rate_limit",
    });
  });

  it("tells a key Composio turns down", async () => {
    await client.setComposioKey("wrong");
    await expect(client.searchToolkits("", "own")).rejects.toThrow(/didn’t accept the key/);
  });
});

describe("through the Manage-App", () => {
  it("reads the catalog, signs in with a ticket and runs a tool, with the linked account's token", async () => {
    const hits = await client.searchToolkits("", "account");
    expect(hits.map((t) => t.slug)).toEqual(["gmail", "notion", "custom-crm"]);
    expect((await client.toolkitTools("gmail", "account"))?.tools).toHaveLength(4);

    const url = await client.startComposioSignIn("account", {
      toolkit: "gmail",
      holder: "u:user-1",
      returnUrl: "http://localhost:5181/api/connect/callback",
      state: "sealed",
    });
    const back = new URL(decodeURIComponent(new URL(url).searchParams.get("next") ?? ""));
    const ticket = back.searchParams.get("ticket") as string;
    const id = await client.finishComposioSignIn("account", { state: "sealed", ticket });
    expect(id).toMatch(/^ca_manage_/);

    expect(
      await client.executeComposioTool("account", {
        connectedAccountId: id,
        holder: "u:user-1",
        tool: "GMAIL_SEND_EMAIL",
        arguments: { recipient_email: "a@example.com" },
      }),
    ).toEqual({ ran: "GMAIL_SEND_EMAIL", input: { recipient_email: "a@example.com" } });
    await client.composioSignOut("account", id);
    expect(composio.accounts.has(id)).toBe(false);

    const passed = composio.seen.filter((s) => s.path.startsWith("/v1/connect/composio/"));
    expect(passed.map((s) => s.path)).toEqual([
      "/v1/connect/composio/toolkits",
      "/v1/connect/composio/toolkits",
      "/v1/connect/composio/start",
      "/v1/connect/composio/complete",
      "/v1/connect/composio/execute",
      `/v1/connect/composio/accounts/${id}`,
    ]);
    expect(passed.every((s) => s.headers.authorization === "Bearer linked-account-token")).toBe(true);
    // Composio's own API is never reached without a key of one's own.
    expect(composio.seen.some((s) => s.path.startsWith("/api/v3/"))).toBe(false);
  });

  it("a ticket never finishes a sign-in made with the own key", async () => {
    await expect(client.finishComposioSignIn("own", { state: "s", ticket: "t" })).rejects.toThrow();
  });
});

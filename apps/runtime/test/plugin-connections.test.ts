import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Accounts a plugin connects for a space (`server.connections`): the sign-in page, the shared
 * OAuth callback finishing it in the right tenant, the kept connection, and what calling it
 * refuses. The provider is played by a stubbed `fetch`.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-plugin-connections-"));
process.env.APP_URL = "http://localhost:5181";
process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";

// A connector that takes keys, played: the guarded fetch of the connectors never sees a stub.
vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const real = mod.hubspotConnector;
  if (real.auth.kind !== "api_key") {
    throw new Error("hubspot takes keys");
  }
  return {
    ...mod,
    hubspotConnector: {
      ...real,
      auth: {
        kind: "api_key",
        apiKey: {
          fields: real.auth.apiKey.fields,
          verify: async (credentials: Record<string, string>) => {
            if (credentials.access_token !== "pat-good") {
              throw new Error("hubspot_verify_failed (401): no");
            }
            return { label: "HubSpot" };
          },
        },
      },
      actions: real.actions.map((a) =>
        a.id === "list_contacts"
          ? {
              ...a,
              handler: async (_input: unknown, ctx: { accessToken: string }) => ({
                contacts: JSON.parse(ctx.accessToken).access_token === "pat-good" ? [{ id: "7" }] : [],
              }),
            }
          : a,
      ),
    },
  };
});

let client: typeof import("../src/db/client");
let connections: typeof import("../src/connectors/plugin-connections");
let app: typeof import("../src/app").default;
let space: string;

const TENANT = "tenant-c";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const real = globalThis.fetch;

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  connections = await import("../src/connectors/plugin-connections");
  app = (await import("../src/app")).default;
  const projects = await import("../src/services/projects");
  space = (await inTenant(() => projects.createProject("user-c", "Kalender"))).id;
}, 60_000);

afterEach(() => {
  globalThis.fetch = real;
});

describe("plugin connections", () => {
  const cal = () => connections.pluginConnections("appointments");

  it("offers the connectors that can be signed in to here, and those that take keys", async () => {
    const offered = await inTenant(() => cal().available(["google-calendar", "nope", "hubspot"]));
    expect(offered).toEqual([
      { id: "google-calendar", name: "Google Calendar", auth: "oauth2" },
      {
        id: "hubspot",
        name: "HubSpot",
        auth: "api_key",
        fields: [{ key: "access_token", label: "Private app access token", placeholder: "pat-…", secret: true }],
      },
    ]);
  });

  it("connects with keys the connector accepts, and refuses the ones it does not", async () => {
    const shop = () => connections.pluginConnections("shop");
    await expect(
      inTenant(() =>
        shop().connect({ space, connector: "hubspot", actions: ["list_contacts"], credentials: {} }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "credentials" });
    await expect(
      inTenant(() =>
        shop().connect({
          space,
          connector: "hubspot",
          actions: ["list_contacts"],
          credentials: { access_token: "pat-bad" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "credentials" });
    const made = await inTenant(() =>
      shop().connect({
        space,
        connector: "hubspot",
        actions: ["list_contacts"],
        credentials: { access_token: "pat-good" },
      }),
    );
    expect(made).toMatchObject({ connector: "hubspot", label: "HubSpot", actions: ["list_contacts"] });
    // The keys are handed to the action as the connector expects them.
    const listed = await inTenant(() => shop().call<{ contacts: unknown[] }>(made.id, "list_contacts", {}));
    expect(listed.contacts).toHaveLength(1);
    // Connected again: still one connection for the account.
    await inTenant(() =>
      shop().connect({ space, connector: "hubspot", actions: ["list_contacts"], credentials: { access_token: "pat-good" } }),
    );
    expect(await inTenant(() => shop().list(space))).toHaveLength(1);
    await expect(
      inTenant(() =>
        shop().connect({ space, connector: "google-calendar", actions: [], credentials: {} }),
      ),
    ).rejects.toThrow(/signing in/);
  });

  it("asks only for the rights the named actions need", async () => {
    const { url } = await inTenant(() =>
      cal().start({ space, connector: "google-calendar", actions: ["list_events", "create_event"] }),
    );
    const scope = new URL(url).searchParams.get("scope") ?? "";
    expect(scope).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(scope).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(scope).not.toContain("gmail");
    await expect(
      inTenant(() => cal().start({ space: "nope", connector: "google-calendar", actions: [] })),
    ).rejects.toThrow(/no space/);
    await expect(
      inTenant(() => cal().start({ space, connector: "google-calendar", actions: ["send_mail"] })),
    ).rejects.toThrow(/no action "send_mail"/);
  });

  it("keeps the account when the provider comes back, once per account", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.includes("oauth2.googleapis.com/token")) {
        return Response.json({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.readonly",
        });
      }
      if (target.includes("/userinfo")) {
        return Response.json({ email: "matthias@example.at" });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    for (let i = 0; i < 2; i += 1) {
      const { url } = await inTenant(() =>
        cal().start({ space, connector: "google-calendar", actions: ["list_events"] }),
      );
      const state = new URL(url).searchParams.get("state") ?? "";
      expect(connections.pluginStateTenant(state)).toBe(TENANT);
      const res = await app.fetch(
        new Request(`http://localhost:5181/api/connect/callback?code=c${i}&state=${encodeURIComponent(state)}`),
      );
      expect(await res.text()).toContain("Connected");
    }
    const list = await inTenant(() => cal().list(space));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ connector: "google-calendar", label: "matthias@example.at", actions: ["list_events"] });
    // Another plugin sees none of it.
    expect(await inTenant(() => connections.pluginConnections("other").list(space))).toEqual([]);
  });

  it("refuses an action the connection was not made for, and forgets it", async () => {
    const [found] = await inTenant(() => cal().list(space));
    await expect(inTenant(() => cal().call(found.id, "delete_event", { event_id: "x" }))).rejects.toThrow(
      /not made for "delete_event"/,
    );
    await inTenant(() => cal().remove(found.id));
    expect(await inTenant(() => cal().list(space))).toEqual([]);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Transport } from "../src/sync/client";

// A computer whose account switches from one organization to another (`wizards account switch`,
// Settings › Account): the tenant `local` is the install, `org-a` and `org-b` stand in for the
// two organizations in the cloud. The install's calls go to the one its account names now.

const dir = mkdtempSync(join(tmpdir(), "wizards-sync-switch-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.ACCOUNT_URL = "http://127.0.0.1:9";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "twoWaySync=on";
process.env.LIMIT_SPACES = "5";
process.env.MARKETPLACE_URL = "off";
delete process.env.MANAGE_URL;
delete process.env.SECRETS;

let client: typeof import("../src/db/client");
let sync: typeof import("../src/sync/client");
let hub: typeof import("../src/sync/hub");
let account: typeof import("../src/auth/account");
let spaces: typeof import("../src/services/spaces");
let data: typeof import("../src/services/space-data");
let settings: typeof import("../src/settings");

const USER = "local";
const local = <T>(fn: () => Promise<T>) => client.withTenant("local", fn);
/** The organization the account is signed in to now. */
const now = async () => (await account.linkedAccount())?.tenantId ?? "org-a";
const there = async <T>(fn: () => Promise<T>) => client.withTenant(await now(), fn);
const inOrg = <T>(org: string, fn: () => Promise<T>) => client.withTenant(org, fn);

const inCloud: Transport = {
  overview: () => there(() => hub.syncOverview()),
  pull: (id, since, cursor) => there(() => hub.pullChanges(id, since, cursor)),
  push: (id, input) => there(() => hub.pushChanges(id, input)),
  missing: (_id, hashes) => there(() => hub.missingBlobs(hashes)),
  putBlob: (_id, hash, bytes) => there(() => hub.takeBlob(hash, bytes)),
  getBlob: async (_id, hash) => new Uint8Array(await there(() => hub.blobBytes(hash))),
  publish: (id, wizardId) => there(() => hub.publishSynced(USER, id, wizardId)),
  rotate: (id, wizardId) => there(() => hub.rotateSynced(USER, id, wizardId)),
  adopt: async (id) => {
    await there(() => hub.adoptSpace(id));
  },
};

/** An access token as the Manage-App hands one out, for `keep()`: only its claims are read. */
const token = (tenant: string) =>
  `x.${Buffer.from(
    JSON.stringify({ sub: "user-1", tenant, name: "Clara", email: "clara@test.local" }),
  ).toString("base64url")}.x`;

const spacesIn = (org: string) =>
  inOrg(org, async () => (await hub.syncOverview()).spaces.map((s) => s.id));

let first = "";
let onlyHere = "";
let pageId = "";

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  for (const id of ["local", "org-a", "org-b"]) {
    await client.openTenantDb(id);
  }
  sync = await import("../src/sync/client");
  hub = await import("../src/sync/hub");
  account = await import("../src/auth/account");
  spaces = await import("../src/services/spaces");
  data = await import("../src/services/space-data");
  settings = await import("../src/settings");
  sync.useTransport(inCloud);
  await account.keep({ access_token: token("org-a"), refresh_token: "refresh-a" } as never);
  await local(async () => {
    first = (await spaces.defaultSpace(USER)).id;
    pageId = (await data.createPage(USER, first, { title: "Notes", markdown: "From A." })).id;
    await sync.syncAll();
    // A space the person keeps on this computer only.
    onlyHere = (await spaces.createSpace(USER, "Private")).id;
    await sync.stopSpace(onlyHere);
  });
}, 60_000);

describe("switching the organization", () => {
  it("sends what changed here to the organization it belongs to first", async () => {
    expect(await spacesIn("org-a")).toEqual([first]);
    await local(() => data.updatePage(USER, pageId, { markdown: "Changed before the switch." }));
    expect(await local(() => sync.sendBeforeSwitch())).toEqual([]);
    const page = await inOrg("org-a", () => data.getPage(USER, pageId));
    expect(page.markdown).toBe("Changed before the switch.");
  });

  it("keeps the spaces here and sends none of them to the new organization", async () => {
    await account.keep({ access_token: token("org-b"), refresh_token: "refresh-b" } as never);
    expect((await account.linkedAccount())?.tenantId).toBe("org-b");
    await local(() => sync.syncAll());
    expect(await spacesIn("org-b")).toEqual([]);
    // Both spaces are still on this computer, with what they hold.
    const here = await local(() => spaces.listSpaces(USER));
    expect(here.map((p) => p.id).sort()).toEqual([first, onlyHere].sort());
    expect((await local(() => data.getPage(USER, pageId))).markdown).toBe("Changed before the switch.");
    const view = await local(() => sync.syncView());
    expect(view.spaces.find((s) => s.spaceId === first)).toMatchObject({ on: false, organization: "org-a" });
    expect(view.spaces.find((s) => s.spaceId === onlyHere)).toMatchObject({ on: false, organization: null });
  });

  it("refuses to turn a space of the other organization on", async () => {
    await expect(local(() => sync.startSpace(first))).rejects.toMatchObject({
      data: { reason: "other_organization" },
    });
    expect(await spacesIn("org-b")).toEqual([]);
  });

  it("lets a space that was only here join the new organization when the person turns it on", async () => {
    await local(() => sync.startSpace(onlyHere));
    expect(await spacesIn("org-b")).toEqual([onlyHere]);
  });

  it("syncs the spaces again after a switch back, and the other's stay out", async () => {
    await account.keep({ access_token: token("org-a"), refresh_token: "refresh-a2" } as never);
    await local(() => sync.syncAll());
    expect(await spacesIn("org-a")).toEqual([first]);
    const view = await local(() => sync.syncView());
    expect(view.spaces.find((s) => s.spaceId === first)).toMatchObject({ on: true, organization: null });
    expect(view.spaces.find((s) => s.spaceId === onlyHere)).toMatchObject({ on: false, organization: "org-b" });
    expect(await settings.readSetting("space-organizations")).toMatchObject({
      [first]: { id: "org-a" },
      [onlyHere]: { id: "org-b" },
    });
  });
});

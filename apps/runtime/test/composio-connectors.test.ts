import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STAND_IN_KEY, startComposioStandIn } from "./composio-stand-in.shared";

/**
 * Composio as a source of connectors (docs/plans/composio.md, step 3): one per toolkit, its actions
 * from the toolkit's tools, each with its kind so a space's rules apply; nothing behind the switch
 * when it is off.
 */
const composio = await startComposioStandIn();

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-composio-connectors-"));
process.env.APP_URL = "http://localhost:5181";
process.env.ACCOUNT_URL = composio.origin;
process.env.COMPOSIO_URL = composio.origin;
process.env.COMPOSIO_API_KEY = STAND_IN_KEY;
delete process.env.MANAGE_URL;
const outside = (process.env.FEATURES ?? "").split(",").filter((f) => f && !f.startsWith("composio"));

let source: typeof import("../src/connectors/composio-connectors");
let client: typeof import("../src/connectors/composio");
let external: typeof import("../src/connectors/external");
let db: typeof import("../src/db/client");
const TENANT = "tenant-composio-source";
const inTenant = <T>(fn: () => Promise<T>) => db.withTenant(TENANT, fn);

const turn = (on: boolean) => {
  process.env.FEATURES = [...outside, `composio=${on ? "on" : "off"}`].join(",");
};

beforeAll(async () => {
  turn(true);
  source = await import("../src/connectors/composio-connectors");
  client = await import("../src/connectors/composio");
  external = await import("../src/connectors/external");
  db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb(TENANT);
});
afterAll(() => composio.close());
beforeEach(() => {
  turn(true);
  client.forgetComposioCatalog();
});

describe("a toolkit as a connector", () => {
  it("names its actions without the toolkit in front, and reads what each does", async () => {
    const found = await source.composioConnector("composio-gmail");
    expect(found?.connector).toMatchObject({
      id: "composio-gmail",
      name: "Gmail",
      toolPrefix: "composio_gmail",
      auth: { kind: "oauth2" },
    });
    const kinds = Object.fromEntries(found?.connector.actions.map((a) => [a.id, a.group]) ?? []);
    expect(kinds).toEqual({
      // Composio's readOnlyHint.
      fetch_emails: "read",
      send_email: "send",
      // A draft is kept, not sent: a change.
      create_email_draft: "write",
      delete_message: "destructive",
    });
    expect(found?.inputs.get("send_email")).toMatchObject({ required: ["recipient_email"] });
    expect(source.isComposioConnector(found?.connector as never)).toBe(true);
  });

  it("is never a read without Composio's hint", () => {
    expect(
      source.kindOfTool("crm", { slug: "CRM_LIST_DEALS", name: "List deals", description: "", input: {}, tags: [] }),
    ).toBe("write");
  });

  it("resolves through resolveConnector, and is nothing with the switch off or a slug that isn't one", async () => {
    const resolve = (id: string) => inTenant(() => external.resolveConnector("space-x", id));
    const found = await resolve("composio-gmail");
    expect(found?.imported).toBe(false);
    expect(found?.inputSchema("fetch_emails")).toMatchObject({ properties: { query: { type: "string" } } });
    expect(await resolve("composio-no-such")).toBeNull();
    expect(await resolve("composio-../x")).toBeNull();
    turn(false);
    expect(await resolve("composio-gmail")).toBeNull();
  });
});

describe("the catalog", () => {
  it("lists what Composio signs in to with its own app, the whole catalog searched", async () => {
    const all = await source.composioCatalog("");
    expect(all.available).toBe(true);
    expect(all.toolkits.map((t) => t.connectorId)).toEqual(["composio-gmail", "composio-notion"]);
    expect((await source.composioCatalog("not")).toolkits.map((t) => t.slug)).toEqual(["notion"]);
    turn(false);
    expect(await source.composioCatalog("")).toEqual({ available: false, toolkits: [] });
  });

});

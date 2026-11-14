import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { noteText, saidText } from "@engenty/wizards-shared/run";
import { nanoid } from "nanoid";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The check before a run reads connections (docs/plans/run-connections.md, steps 4 and 6): a
// connection whose connectors can't connect on this install says so, with what the server's
// owner sets, and one none of whose connectors connects keeps the run from starting.
const dir = mkdtempSync(join(tmpdir(), "wizards-connection-needs-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "web";
delete process.env.FEATURES;

/** The connectors that connect on this install, by id; the rest lack their OAuth client. */
const connectable = new Set<string>();
vi.mock("../src/connectors/builtin.js", async (original) => ({
  ...(await original<typeof import("../src/connectors/builtin.js")>()),
  usable: async (c: { id: string }) => connectable.has(c.id),
}));
vi.mock("../src/manage.js", async (original) => ({
  ...(await original<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async (id: string) => ({ id, status: "active", limits: {} }),
}));
// Only the forms of these wizards run: no model is under test.
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
  canSpend: async () => true,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let requirements: typeof import("../src/engine/requirements");

const T = "tenant-connection-needs";
const SPACE = "space-1";

/** The wish "Connect my Gmail and show me the most important mails": a page that connects, a step that reads. */
const mailWizard = (connection: object): WizardDefinition =>
  ({
    version: 1,
    title: "Wichtige Mails",
    description: "",
    connections: [{ id: "inbox", title: "Gmail", ...connection }],
    steps: [
      {
        id: "connect",
        type: "form",
        title: "Gmail verbinden",
        fields: [{ id: "account", kind: "connection", label: "Postfach", connection: "inbox" }],
      },
      { id: "done", type: "result", title: "Fertig", deliverables: [] },
    ],
  }) as unknown as WizardDefinition;

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);

async function start(def: WizardDefinition) {
  return inTenant(async () => {
    const wizardId = nanoid(12);
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: SPACE,
      tenantId: T,
      title: def.title,
      draft: def as never,
    });
    return runner.createRun({
      wizardId,
      definition: def,
      files: [],
      version: null,
      mode: "test",
      userId: "u-admin",
    });
  });
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(T);
  await client.controlDb
    .insert(client.control.tenant)
    .values({ id: T, status: "active" } as never)
    .onConflictDoNothing()
    .catch(() => undefined);
  runner = await import("../src/engine/runner");
  requirements = await import("../src/engine/requirements");
  await inTenant(() =>
    client.db.insert(client.schema.space).values({ id: SPACE, tenantId: T, name: "Space" } as never),
  );
}, 120_000);

beforeEach(() => {
  connectable.clear();
});

describe("connections before a run", () => {
  it("names a mail connection's connectors that can't connect, and lets it start with IMAP", async () => {
    connectable.add("imap");
    const def = mailWizard({ kind: "mail" });
    const said = await inTenant(() => requirements.missingConnectionsSaid(def, SPACE));
    expect(said.map(({ problem: _, ...m }) => m)).toEqual([
      {
        id: "inbox",
        name: "Gmail",
        kind: "mail",
        connectors: ["mail-gmail", "mail-outlook"],
        steps: [{ id: "connect", title: "Gmail verbinden" }],
        blocking: false,
      },
    ]);
    expect(saidText(said[0].problem, "en")).toBe(
      "Gmail, Outlook can’t connect here yet. IMAP connects instead.",
    );
    expect(saidText(said[0].problem, "de")).toBe(
      "Gmail, Outlook lassen sich hier noch nicht verbinden. Stattdessen lässt sich IMAP verbinden.",
    );
    expect(requirements.blockingMessage(said)).toBeNull();
    await expect(start(def)).resolves.toEqual(expect.any(String));
  });

  it("tells an admin what the server's owner sets", async () => {
    connectable.add("imap");
    const [need] = await inTenant(() =>
      requirements.missingConnections(mailWizard({ kind: "mail" }), SPACE, "de", true),
    );
    expect(need.problem).toBe(
      "Gmail, Outlook lassen sich hier noch nicht verbinden. " +
        "Um Gmail zu verbinden, braucht engenty wizards hier GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET. " +
        "Um Outlook zu verbinden, braucht engenty wizards hier MICROSOFT_OAUTH_CLIENT_ID, MICROSOFT_OAUTH_CLIENT_SECRET. " +
        "Stattdessen lässt sich IMAP verbinden.",
    );
  });

  it("says nothing where every connector connects, nor of a connection of the space", async () => {
    connectable.add("imap").add("mail-gmail").add("mail-outlook");
    const def = mailWizard({ kind: "mail" });
    expect(await inTenant(() => requirements.missingConnectionsSaid(def, SPACE))).toEqual([]);
    connectable.clear();
    const space = mailWizard({ spaceConnection: "conn-1" });
    expect(await inTenant(() => requirements.missingConnectionsSaid(space, SPACE))).toEqual([]);
  });

  it("refuses the start when the connector a step on every path needs can't connect", async () => {
    const def = mailWizard({ connector: "google-gmail" });
    const said = await inTenant(() => requirements.missingConnectionsSaid(def, SPACE, true));
    expect(said.map((m) => [m.connectors, m.blocking])).toEqual([[["google-gmail"], true]]);
    const blocked = requirements.blockingMessage(said);
    expect(blocked && noteText(blocked, "en")).toBe(
      "“Gmail verbinden”: Gmail can’t connect here yet. " +
        "To connect Gmail, engenty wizards needs GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET here.",
    );
    const { ModelUnavailableError } = await import("../src/model-errors");
    await expect(start(def)).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(start(def)).rejects.toThrow("“Gmail verbinden”: Gmail can’t connect here yet.");
  });

  it("says when the space doesn't have the connector a connection names", async () => {
    const def = mailWizard({ connector: "acme-crm", title: undefined });
    const [need] = await inTenant(() => requirements.missingConnections(def, SPACE, "en"));
    expect(need).toMatchObject({
      name: "acme-crm",
      connectors: ["acme-crm"],
      problem: "This space has no connector “acme-crm”.",
      blocking: true,
    });
  });
});

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

// The live feed (docs/plans/live-changes.md, 1): triggers number every write to an item the
// studio shows, in `live_change`, pulled writes and wizard-owned lists too.

const dir = mkdtempSync(join(tmpdir(), "wizards-live-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.MARKETPLACE_URL = "off";
process.env.LIMIT_PROJECTS = "5";

const USER = "local";
let client: typeof import("../src/db/client");
let feed: typeof import("../src/live/feed");
let wizards: typeof import("../src/services/wizards");
let data: typeof import("../src/services/space-data");
let projects: typeof import("../src/services/projects");
let categories: typeof import("../src/services/space-categories");
let log: typeof import("../src/sync/log");
const local = <T>(fn: () => Promise<T>) => client.withTenant("local", fn);
let spaceId = "";

/** What the feed got from `fn`, without numbers and times. */
async function logged(fn: () => Promise<unknown>) {
  return local(async () => {
    const since = await feed.newestSeq();
    await fn();
    return (await feed.changesAfter(since, 1000)).map(({ seq: _, ...rest }) => rest);
  });
}

const definition = {
  version: 1,
  title: "Report",
  description: "",
  avatar: "round",
  steps: [
    { id: "a", type: "page", title: "A", fields: [{ id: "aF", label: "F", kind: "text" }] },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
};

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  feed = await import("../src/live/feed");
  wizards = await import("../src/services/wizards");
  data = await import("../src/services/space-data");
  projects = await import("../src/services/projects");
  categories = await import("../src/services/space-categories");
  log = await import("../src/sync/log");
  spaceId = await local(async () => (await projects.defaultProject(USER)).id);
}, 60_000);

describe("live_change", () => {
  it("logs a page as put and its delete as del", async () => {
    let pageId = "";
    const made = await logged(async () => {
      pageId = (await data.createPage(USER, spaceId, { title: "About", markdown: "One." })).id;
    });
    expect(made).toContainEqual({ projectId: spaceId, kind: "page", op: "put", item: pageId, parent: null });
    const gone = await logged(() => data.deletePage(USER, pageId));
    expect(gone.at(-1)).toMatchObject({ kind: "page", op: "del", item: pageId });
  });

  it("names a row's table as its parent, also on delete", async () => {
    const tableId = await local(async () => (await data.createTable(USER, spaceId, { title: "Clients" })).id);
    let rowId = "";
    const added = await logged(async () => {
      rowId = (await data.addTableRow(USER, tableId, { name: "Acme" })).id;
    });
    expect(added).toContainEqual({ projectId: spaceId, kind: "row", op: "put", item: rowId, parent: tableId });
    const edited = await logged(() => data.updateTableRow(USER, tableId, rowId, { name: "Acme AG" }));
    expect(edited).toContainEqual({ projectId: spaceId, kind: "row", op: "put", item: rowId, parent: tableId });
    const gone = await logged(() => data.deleteTableRows(USER, tableId, [rowId]));
    expect(gone).toContainEqual({ projectId: spaceId, kind: "row", op: "del", item: rowId, parent: tableId });
  });

  it("logs a wizard, and a change of its files as a put of the wizard", async () => {
    let wizardId = "";
    const made = await logged(async () => {
      wizardId = (await wizards.createWizard(USER, { projectId: spaceId, definition })).id;
    });
    expect(made).toContainEqual({ projectId: spaceId, kind: "wizard", op: "put", item: wizardId, parent: null });
    const files = await logged(() =>
      client.db.run(
        sql`INSERT INTO wizard_file (wizard_id, path, hash, mime, size) VALUES (${wizardId}, 'notes.md', 'h', 'text/markdown', 2)`,
      ),
    );
    expect(files).toEqual([{ projectId: spaceId, kind: "wizard", op: "put", item: wizardId, parent: null }]);
    const removed = await logged(() =>
      client.db.run(sql`DELETE FROM wizard_file WHERE wizard_id = ${wizardId}`),
    );
    expect(removed).toEqual([{ projectId: spaceId, kind: "wizard", op: "put", item: wizardId, parent: null }]);
  });

  it("logs a category's values as the category, and an assignment as its item", async () => {
    const pageId = await local(async () => (await data.createPage(USER, spaceId, { title: "Region page" })).id);
    let categoryId = "";
    const made = await logged(async () => {
      categoryId = (
        await categories.putCategory(spaceId, { name: "Region", type: "choice", values: ["North"] } as never)
      ).id;
    });
    expect(made.every((c) => c.kind === "category" && c.item === categoryId && c.op === "put")).toBe(true);
    const set = await logged(() => categories.setItemCategory(spaceId, { pageId }, categoryId, ["North"]));
    expect(set).toContainEqual({ projectId: spaceId, kind: "page", op: "put", item: pageId, parent: null });
  });

  it("logs writes made quietly, which the two-way sync does not note", async () => {
    const quiet = await logged(() =>
      log.quietly(() => data.createPage(USER, spaceId, { title: "Pulled" })),
    );
    expect(quiet.map((c) => c.kind)).toContain("page");
  });

  it("logs pages and tables a wizard owns, with the wizard as parent", async () => {
    const wizardId = await local(async () => (await wizards.createWizard(USER, { projectId: spaceId, definition })).id);
    let ownId = "";
    const own = await logged(async () => {
      ownId = (await data.createPage(USER, spaceId, { title: "List", wizardId })).id;
    });
    expect(own).toContainEqual({ projectId: spaceId, kind: "page", op: "put", item: ownId, parent: wizardId });
  });

  it("keeps 15 minutes", async () => {
    await local(async () => {
      await data.createPage(USER, spaceId, { title: "Recent" });
      const newest = await feed.newestSeq();
      await client.db.run(sql`UPDATE live_change SET at = at - ${16 * 60_000} WHERE seq < ${newest}`);
      await feed.pruneLive();
      expect(await feed.oldestSeq()).toBe(newest);
      // The numbers keep rising after a prune: a cursor stays valid.
      await data.createPage(USER, spaceId, { title: "Later" });
      expect((await feed.changesAfter(newest, 10))[0]?.seq).toBeGreaterThan(newest);
    });
  });
});

describe("the triggers", () => {
  const migrations = join(import.meta.dirname, "../src/db/migrations/tenant");
  const tablesOf = (file: string, prefix: string) =>
    new Set(
      [...readFileSync(join(migrations, file), "utf8").matchAll(new RegExp(`CREATE TRIGGER \`${prefix}_\\w+?_a[iud]\` AFTER \\w+ ON \`(\\w+)\``, "g"))].map(
        (m) => m[1],
      ),
    );

  it("cover the same tables as the two-way sync's", () => {
    const synced = tablesOf("0022_sync.sql", "sync");
    expect(synced.size).toBe(13);
    expect(tablesOf("0023_live_change.sql", "live")).toEqual(synced);
  });

  it("are the ones the generator writes", async () => {
    const { CHAT_TABLES, LIVE_TABLES, liveTriggerSql, PRESENCE_TABLE } = await import(
      "../src/db/live-triggers"
    );
    expect(readFileSync(join(migrations, "0029_work_chats_live.sql"), "utf8")).toContain(
      liveTriggerSql(CHAT_TABLES),
    );
    // Tables that came later carry their triggers in their own migration.
    const later: Record<string, string> = { space_skill: "0030_space_skill.sql" };
    expect(readFileSync(join(migrations, "0023_live_change.sql"), "utf8")).toContain(
      liveTriggerSql(LIVE_TABLES.filter((t) => !later[t.table])),
    );
    expect(readFileSync(join(migrations, "0024_live_presence.sql"), "utf8")).toContain(
      liveTriggerSql([PRESENCE_TABLE]),
    );
    for (const [table, file] of Object.entries(later)) {
      expect(readFileSync(join(migrations, file), "utf8")).toContain(
        liveTriggerSql(LIVE_TABLES.filter((t) => t.table === table)),
      );
    }
  });
});

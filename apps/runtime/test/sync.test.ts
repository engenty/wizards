import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Transport } from "../src/sync/client";

// The two-way sync end to end, in one process: the tenant `local` is the install, the tenant
// `org` stands in for the organization in the cloud. The install's calls go straight to the
// cloud's half (sync/hub.ts), inside `org`, as its owner.

const dir = mkdtempSync(join(tmpdir(), "wizards-sync-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "twoWaySync=on";
process.env.LIMIT_PROJECTS = "5";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

// The model "Solve with AI" asks: it answers what a test queued, one answer per call.
const llm = { answers: [] as string[], prompts: [] as string[] };
vi.mock("../src/models.js", async (original) => {
  const models = await original<typeof import("../src/models.js")>();
  return {
    ...models,
    textModel: async () => ({
      model: new MockLanguageModelV3({
        doGenerate: async (options) => {
          llm.prompts.push(JSON.stringify(options.prompt));
          return {
            content: [{ type: "text", text: llm.answers.shift() ?? "" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          };
        },
      }),
      ref: "test/scripted",
      vendor: "test",
      gateway: false,
      metered: true,
    }),
  };
});

let client: typeof import("../src/db/client");
let sync: typeof import("../src/sync/client");
let hub: typeof import("../src/sync/hub");
let records: typeof import("../src/sync/records");
let wizards: typeof import("../src/services/wizards");
let data: typeof import("../src/services/space-data");
let projects: typeof import("../src/services/projects");
let categories: typeof import("../src/services/space-categories");

const USER = "local";
const local = <T>(fn: () => Promise<T>) => client.withTenant("local", fn);
const cloud = <T>(fn: () => Promise<T>) => client.withTenant("org", fn);
let schemaTag = "";

/** Counts what crosses: a test can say the cloud was asked. */
const calls: string[] = [];

const inCloud: Transport = {
  overview: () => cloud(() => hub.syncOverview()),
  pull: (id, since, cursor) => (calls.push("pull"), cloud(() => hub.pullChanges(id, since, cursor))),
  push: (id, input) => (calls.push("push"), cloud(() => hub.pushChanges(id, input))),
  missing: (_id, hashes) => cloud(() => hub.missingBlobs(hashes)),
  putBlob: (_id, hash, bytes) => cloud(() => hub.takeBlob(hash, bytes)),
  getBlob: async (_id, hash) => new Uint8Array(await cloud(() => hub.blobBytes(hash))),
  publish: (id, wizardId) => cloud(() => hub.publishSynced(USER, id, wizardId)),
  rotate: (id, wizardId) => cloud(() => hub.rotateSynced(USER, id, wizardId)),
  adopt: async (id) => {
    await cloud(() => hub.adoptSpace(id));
  },
};

const definition = (title: string, steps: { id: string; title: string }[]) => ({
  version: 1,
  title,
  description: "",
  avatar: "round",
  steps: [
    ...steps.map((s) => ({
      id: s.id,
      type: "page",
      title: s.title,
      fields: [{ id: `${s.id}F`, label: "F", kind: "text" }],
    })),
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
});

let spaceId = "";
let wizardId = "";
let pageId = "";
let tableId = "";
let rowId = "";

const readIn = (side: typeof local, kind: Parameters<typeof records.KINDS.space.read>[0] extends string ? any : any, item: string) =>
  side(async () => {
    const r = await records.KINDS[kind as keyof typeof records.KINDS].read(item);
    return r && r !== "skip" ? records.canonical(r.record) : null;
  });

async function draftOf(side: typeof local, id: string) {
  return side(async () => (await wizards.ownedWizard(USER, id)).draft);
}

async function edit(side: typeof local, id: string, change: (d: any) => void) {
  return side(async () => {
    const w = await wizards.ownedWizard(USER, id);
    const d = structuredClone(w.draft) as any;
    change(d);
    await wizards.writeDraft(USER, id, { definition: d, baseRevision: w.revision });
  });
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  await client.openTenantDb("org");
  schemaTag = client.tenantSchemaVersion;
  sync = await import("../src/sync/client");
  hub = await import("../src/sync/hub");
  records = await import("../src/sync/records");
  wizards = await import("../src/services/wizards");
  data = await import("../src/services/space-data");
  projects = await import("../src/services/projects");
  categories = await import("../src/services/space-categories");
  const settings = await import("../src/settings");
  // An account is linked: the sync can run.
  await settings.writeSetting("account", {
    userId: "user-1",
    tenantId: "org",
    name: "Clara",
    email: "clara@test.local",
  });
  sync.useTransport(inCloud);
  // What the space holds before the sync starts.
  await local(async () => {
    spaceId = (await projects.defaultProject(USER)).id;
    wizardId = (
      await wizards.createWizard(USER, {
        projectId: spaceId,
        definition: definition("Report", [
          { id: "a", title: "A" },
          { id: "b", title: "B" },
        ]),
      })
    ).id;
    pageId = (await data.createPage(USER, spaceId, { title: "About", markdown: "One.\n\nTwo.\n\nThree." })).id;
    tableId = (await data.createTable(USER, spaceId, { title: "Clients" })).id;
    rowId = (await data.addTableRow(USER, tableId, { name: "Acme" })).id;
    const region = await categories.putCategory(spaceId, {
      name: "Region",
      type: "choice",
      values: ["North", "South"],
    } as never);
    await categories.setItemCategory(spaceId, { pageId }, region.id, ["North"]);
  });
}, 60_000);

describe("the first sync", () => {
  it("sends every item of the space up, and the cloud holds the same", async () => {
    await local(() => sync.syncAll());
    for (const [kind, item] of [
      ["space", spaceId],
      ["wizard", wizardId],
      ["page", pageId],
      ["table", tableId],
      ["row", rowId],
    ] as const) {
      const here = await readIn(local, kind, item);
      expect(here, `${kind} here`).not.toBeNull();
      expect(await readIn(cloud, kind, item), `${kind} in the cloud`).toBe(here);
    }
    const view = await local(() => sync.syncView());
    expect(view.available).toBe(true);
    expect(view.spaces.find((s) => s.spaceId === spaceId)).toMatchObject({
      on: true,
      error: null,
      waiting: 0,
      conflicts: 0,
    });
  });

  it("writes in the cloud's change log, and nothing more here", async () => {
    const top = await cloud(async () => (await import("../src/sync/log")).spaceSeq(spaceId));
    expect(top).toBeGreaterThan(0);
    const mine = await local(async () =>
      (await import("../src/sync/log")).changedSince(spaceId, 0, 100),
    );
    expect(mine).toEqual([]);
  });
});

describe("a change on one side", () => {
  it("goes up after a save here", async () => {
    await edit(local, wizardId, (d) => {
      d.steps[0].title = "A, renamed here";
    });
    await local(() => sync.syncSpace(spaceId, "push"));
    expect((await draftOf(cloud, wizardId)).steps[0].title).toBe("A, renamed here");
  });

  it("comes down before the studio shows it", async () => {
    await cloud(() => data.updatePage(USER, pageId, { markdown: "One.\n\nTwo, changed in the cloud.\n\nThree." }));
    calls.length = 0;
    await local(() => sync.syncSpace(spaceId, "pull"));
    expect(calls).toContain("pull");
    const page = await local(() => data.getPage(USER, pageId));
    expect(page.markdown).toContain("Two, changed in the cloud.");
    // What came down is not sent back up.
    calls.length = 0;
    await local(() => sync.syncSpace(spaceId, "push"));
    expect(calls).not.toContain("push");
  });

  it("deletes in the cloud what was deleted here", async () => {
    const extra = await local(() => data.createPage(USER, spaceId, { title: "Scratch" }));
    await local(() => sync.syncSpace(spaceId, "push"));
    expect(await readIn(cloud, "page", extra.id)).not.toBeNull();
    await local(() => data.deletePage(USER, extra.id));
    await local(() => sync.syncSpace(spaceId, "push"));
    expect(await readIn(cloud, "page", extra.id)).toBeNull();
  });
});

describe("both sides changed the same item", () => {
  it("merges different steps by itself and says so", async () => {
    await local(() => sync.syncSpace(spaceId));
    await edit(cloud, wizardId, (d) => {
      d.steps[1].title = "B, renamed in the cloud";
    });
    await edit(local, wizardId, (d) => {
      d.steps[0].title = "A, renamed again here";
    });
    await local(() => sync.syncSpace(spaceId, "push"));
    const both = (d: any) => [d.steps[0].title, d.steps[1].title];
    expect(both(await draftOf(local, wizardId))).toEqual(["A, renamed again here", "B, renamed in the cloud"]);
    expect(both(await draftOf(cloud, wizardId))).toEqual(["A, renamed again here", "B, renamed in the cloud"]);
    const view = await local(() => sync.syncView());
    expect(view.conflicts).toEqual([]);
    const merge = view.merges.find((m) => m.item === wizardId);
    expect(merge).toBeTruthy();
    expect(merge?.remote.join(" ")).toContain("B, renamed in the cloud");
  });

  it("merges a page's text changed in two places", async () => {
    await cloud(() => data.updatePage(USER, pageId, { markdown: "One.\n\nTwo, changed in the cloud.\n\nThree, the cloud again." }));
    await local(() => data.updatePage(USER, pageId, { markdown: "One, changed here.\n\nTwo, changed in the cloud.\n\nThree." }));
    await local(() => sync.syncSpace(spaceId, "push"));
    const md = (await cloud(() => data.getPage(USER, pageId))).markdown;
    expect(md).toContain("One, changed here.");
    expect(md).toContain("Three, the cloud again.");
  });

  it("asks when both changed the same step, and takes the person's choice", async () => {
    await edit(cloud, wizardId, (d) => {
      d.steps[0].title = "Cloud's title";
    });
    await edit(local, wizardId, (d) => {
      d.steps[0].title = "My title";
    });
    await local(() => sync.syncSpace(spaceId, "push"));
    const view = await local(() => sync.syncView());
    const conflict = view.conflicts.find((c) => c.item === wizardId);
    expect(conflict?.conflicts.map((c) => c.label)).toEqual(["steps › “My title” › title"]);
    expect(view.spaces.find((s) => s.spaceId === spaceId)?.conflicts).toBe(1);
    // The cloud keeps its own until the person chose.
    expect((await draftOf(cloud, wizardId)).steps[0].title).toBe("Cloud's title");
    await local(() => sync.resolveConflict(conflict!.id, { choices: [{ take: "local" }] }));
    await local(() => sync.syncSpace(spaceId, "push"));
    expect((await draftOf(cloud, wizardId)).steps[0].title).toBe("My title");
    expect((await local(() => sync.syncView())).conflicts).toEqual([]);
  });

  it("takes the cloud's version for a conflict when asked", async () => {
    await edit(cloud, wizardId, (d) => {
      d.steps[1].title = "Cloud B";
    });
    await edit(local, wizardId, (d) => {
      d.steps[1].title = "My B";
    });
    await local(() => sync.syncSpace(spaceId, "push"));
    const conflict = (await local(() => sync.syncView())).conflicts.find((c) => c.item === wizardId);
    await local(() => sync.resolveConflict(conflict!.id, { take: "remote" }));
    expect((await draftOf(local, wizardId)).steps[1].title).toBe("Cloud B");
    await local(() => sync.syncSpace(spaceId));
    expect((await draftOf(cloud, wizardId)).steps[1].title).toBe("Cloud B");
  });

  it("undoes a merge on request", async () => {
    await edit(cloud, wizardId, (d) => {
      d.description = "From the cloud";
    });
    await edit(local, wizardId, (d) => {
      d.steps[0].title = "Mine only";
    });
    await local(() => sync.syncSpace(spaceId, "push"));
    const merge = (await local(() => sync.syncView())).merges.find(
      (m) => m.item === wizardId && m.remote.some((p) => p.includes("description")),
    );
    expect(merge).toBeTruthy();
    await local(() => sync.undoMerge(merge!.id, "remote"));
    await local(() => sync.syncSpace(spaceId));
    const d = await draftOf(cloud, wizardId);
    expect(d.description).toBe("From the cloud");
    expect(d.steps[0].title).not.toBe("Mine only");
  });
});

describe("more of the space", () => {
  it("sends a file with its bytes", async () => {
    const files = await import("../src/services/project-files");
    const added = await local(() =>
      files.addProjectFile(spaceId, {
        kind: "asset",
        name: "data.json",
        mime: "application/json",
        data: Buffer.from('{"a":1}'),
      }),
    );
    await local(() => sync.syncSpace(spaceId, "push"));
    const there = await cloud(() => files.projectFileContent(spaceId, added.id));
    expect(Buffer.from(there.data).toString("utf8")).toBe('{"a":1}');
  });

  it("makes one category of two that were made on both sides under the same name", async () => {
    const theirs = await cloud(() =>
      categories.putCategory(spaceId, { name: "Topic", type: "text" } as never),
    );
    const mine = await local(() =>
      categories.putCategory(spaceId, { name: "Topic", type: "text" } as never),
    );
    expect(theirs.id).not.toBe(mine.id);
    await local(() => sync.syncSpace(spaceId));
    const named = (side: typeof local) =>
      side(async () => (await categories.categoryRows(spaceId)).filter((c) => c.name === "Topic").map((c) => c.id));
    // One of the two ids wins on both sides; what was set with the other one moves to it.
    const there = await named(cloud);
    expect(there).toHaveLength(1);
    expect([mine.id, theirs.id]).toContain(there[0]);
    expect(await named(local)).toEqual(there);
  });

  it("brings a space made in the cloud to this install, and lists it beside the others", async () => {
    const state = await import("../src/sync/state");
    const made = await cloud(async () => {
      const { id } = await projects.createProject(USER, "Made in the cloud");
      await data.createPage(USER, id, { title: "Hello from the cloud" });
      return id;
    });
    await local(() => sync.syncAll());
    const page = await local(async () => {
      const db = client.db;
      return db.query.spacePage.findFirst({
        where: (p, { eq }) => eq(p.projectId, made),
      });
    });
    expect(page?.title).toBe("Hello from the cloud");
    // This install lists as many spaces as the organization allows.
    state.setCloudSpaceLimit(3);
    expect(await local(() => projects.projectLimit())).toBe(3);
  });

  it("asks when one side deleted what the other changed, and keeps it when told", async () => {
    const extra = await local(() => data.createPage(USER, spaceId, { title: "Keep me" }));
    await local(() => sync.syncSpace(spaceId));
    await cloud(() => data.deletePage(USER, extra.id));
    await local(() => data.updatePage(USER, extra.id, { markdown: "Changed here." }));
    await local(() => sync.syncSpace(spaceId, "push"));
    const conflict = (await local(() => sync.syncView())).conflicts.find((c) => c.item === extra.id);
    expect(conflict?.deleted).toBe("remote");
    await local(() => sync.resolveConflict(conflict!.id, { take: "local" }));
    await local(() => sync.syncSpace(spaceId, "push"));
    expect((await cloud(() => data.getPage(USER, extra.id))).markdown).toBe("Changed here.");
  });
});

describe("help from a model", () => {
  it("proposes a merge that passes the checks, and the person takes it", async () => {
    await local(() => sync.syncSpace(spaceId));
    await edit(cloud, wizardId, (d) => {
      d.steps[0].title = "Cloud's A";
    });
    await edit(local, wizardId, (d) => {
      d.steps[0].title = "My A";
    });
    await local(() => sync.syncSpace(spaceId, "push"));
    const conflict = (await local(() => sync.syncView())).conflicts.find((c) => c.item === wizardId);
    expect(conflict).toBeTruthy();
    const merged = await local(async () => {
      const base = (await import("../src/sync/records")).KINDS.wizard;
      const read = await base.read(wizardId);
      return read && read !== "skip" ? structuredClone(read.record) : null;
    });
    (merged as any).draft.steps[0].title = "Both A";
    // The first answer is no JSON: it is asked again, with why.
    llm.answers = ["I would merge them like this.", JSON.stringify(merged)];
    const proposal = await local(() => sync.proposeMerge(conflict!.id));
    expect((proposal.record as any).draft.steps[0].title).toBe("Both A");
    expect(llm.prompts.at(-1)).toContain("did not pass the checks");
    // Nothing is written until the person takes it.
    expect((await draftOf(local, wizardId)).steps[0].title).toBe("My A");
    await local(() => sync.resolveConflict(conflict!.id, { record: proposal.record }));
    expect((await draftOf(cloud, wizardId)).steps[0].title).toBe("Both A");
  });
});

describe("what does not sync", () => {
  it("leaves runs, the index and the chats where they are", async () => {
    const kinds = Object.keys((await import("../src/sync/records")).KINDS);
    expect(kinds).not.toContain("run");
    expect(kinds).not.toContain("assistant");
  });

  it("pauses when the two sides have different schemas", async () => {
    const answer = cloud(() => hub.pushChanges(spaceId, { schema: "0000_old", items: [] }));
    await expect(answer).rejects.toMatchObject({ data: { reason: "schema_mismatch", schema: schemaTag } });
  });
});

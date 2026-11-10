import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWizard, type WizardDefinition } from "@engenty/wizards-shared/definition";
import {
  isReadSql,
  splitSql,
  sqlParams,
  sqlRefusal,
  wizardDataIssues,
} from "@engenty/wizards-shared/wizard-data";
import { requiresOf } from "@engenty/wizards-shared/requires";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { beforeAll, describe, expect, it } from "vitest";

// A wizard's own database (docs/plans/wizard-data.md): libSQL the runtime keeps per person and
// shared, made on the first write, reached only through the broker. Guests stay apart: an AI
// step in a guest's run reaches the guest's own database alone.

const dir = mkdtempSync(join(tmpdir(), "wizards-data-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.WIZARD_DATA_MAX_ROWS = "50";
process.env.WIZARD_DATA_MAX_CHANGES = "100";
process.env.WIZARD_DATA_TIMEOUT_MS = "1500";
process.env.WIZARD_DATA_MAX_MB = "1";
delete process.env.FEATURES;

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let wizardId = "";
let client: typeof import("../src/db/client");
let access: typeof import("../src/store/data-access");
let files: WorkspaceFile[] = [];

const url = (path: string) => `http://localhost:5181${path}`;
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(path), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>;
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);

const SCHEMA = `
-- what every run collects, and what each person saw
CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);
CREATE TABLE signups (email TEXT PRIMARY KEY, name TEXT);
CREATE TRIGGER notes_trim AFTER INSERT ON notes BEGIN
  UPDATE notes SET text = trim(text) WHERE id = new.id;
END;
`;

const def = {
  version: 1,
  title: "Data",
  description: "",
  avatar: "round",
  data: { scope: "shared", schema: "data/schema.sql" },
  steps: [{ id: "end", type: "result", title: "Done", deliverables: [] }],
} as unknown as WizardDefinition;

async function file(path: string, text: string): Promise<WorkspaceFile> {
  const { putBlob } = await import("../src/files/blobs");
  const bytes = Buffer.from(text, "utf8");
  return { path, hash: await putBlob(bytes), mime: "application/sql", size: bytes.length };
}

/** A step's caller for a holder: a guest by visitor id, or the studio's own person. */
async function callerFor(holder: string) {
  const { subjectsOfGuest, subjectsOfPerson } = await import("../src/broker/rwx");
  const guest = !holder.startsWith("u:");
  return {
    space: { id: spaceId, name: "Space" },
    who: guest ? { kind: "guest" as const, id: holder.slice(2) } : { kind: "admin" as const, id: "local" },
    subjects: [
      ...(guest ? subjectsOfGuest() : subjectsOfPerson("local", "owner")),
      { kind: "wizard" as const, id: wizardId },
    ],
    where: { runId: `run-${holder}`, wizardId, spaceId },
    signal: new AbortController().signal,
  };
}

function call(
  holder: string,
  scope: "person" | "shared",
  sql: string,
  opts: { by?: "model" | "wizard"; params?: Record<string, unknown>; ws?: WorkspaceFile[] } = {},
) {
  return local(async () =>
    access.runData(
      await callerFor(holder),
      { def, files: opts.ws ?? files, store: { wizardId, holder } },
      {
        action: isReadSql(sql) ? "data_query" : "data_exec",
        by: opts.by ?? "model",
        scope,
        sql,
        params: opts.params,
        mode: isReadSql(sql) ? "read" : "write",
      },
    ),
  );
}

const databases = () =>
  local(() => client.db.query.storeDatabase.findMany({ where: (t, { eq }) => eq(t.wizardId, wizardId) }));
const dataFolder = () => join(dir, "data", "tenants", "local", "data");

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
  wizardId = (await json(send("POST", "/api/studio/wizards", { spaceId }))).id;
  access = await import("../src/store/data-access");
  files = [await local(() => file("data/schema.sql", SCHEMA))];
}, 300_000);

describe("the SQL a wizard brings", () => {
  it("splits into statements, a trigger's body and strings whole", () => {
    expect(splitSql(SCHEMA)).toHaveLength(3);
    expect(splitSql("INSERT INTO t VALUES ('a;b'); -- x;\nSELECT 1")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      "-- x;\nSELECT 1",
    ]);
    expect(() => splitSql("SELECT 'open")).toThrow(/inside a string/);
    expect(sqlParams("SELECT * FROM t WHERE a = :email AND b = @name AND c = ':no'")).toEqual([
      "email",
      "name",
    ]);
  });

  it("refuses what reaches past the database", () => {
    for (const sql of [
      "ATTACH DATABASE '/etc/x.db' AS x",
      "PRAGMA journal_mode = DELETE",
      "PRAGMA writable_schema = 1",
      "SELECT load_extension('x')",
      "VACUUM INTO '/tmp/copy.db'",
      "BEGIN",
      "SELECT 1; SELECT 2",
      "DELETE FROM sqlite_master",
    ]) {
      expect(sqlRefusal(sql), sql).not.toBeNull();
    }
    for (const sql of ["SELECT * FROM notes", "PRAGMA table_info(notes)", "INSERT INTO notes (text) VALUES (:t)"]) {
      expect(sqlRefusal(sql), sql).toBeNull();
    }
  });

  it("is checked by the validator: the schema file, the scopes, a fixed step's parameters", () => {
    const raw = {
      ...def,
      data: { scope: "person", schema: "data/schema.sql" },
      steps: [
        {
          id: "save",
          type: "tool",
          title: "Save",
          data: { scope: "shared", sql: "INSERT INTO signups (email) VALUES (:email)", params: {} },
        },
        { id: "both", type: "tool", title: "Both", call: { tool: "a.b", input: {} }, data: { sql: "SELECT 1" } },
        { id: "end", type: "result", title: "Done", deliverables: [] },
      ],
    };
    const parsed = parseWizard(raw, []);
    expect(parsed.ok, JSON.stringify(parsed.issues)).toBe(true);
    const messages = parsed.issues.map((i) => i.message).join("\n");
    expect(messages).toContain('data.schema "data/schema.sql" is not in the wizard\'s files.');
    expect(messages).toContain("data.scope is \"shared\", but the wizard's data is per person.");
    expect(messages).toContain('data.sql names :email, which "params" doesn\'t give.');
    expect(messages).toContain('A tool step has "call" or "data", one of them.');
    // `requires` names the database, filled in from `data`.
    expect(parsed.ok && requiresOf(parsed.wizard).data).toBe("person");
    const texts: Record<string, string> = {
      "data/schema.sql": SCHEMA,
      "data/migrations/001_bad.sql": "ALTER TABLE notes ADD COLUMN at TEXT; PRAGMA journal_mode = OFF;",
      "data/migrations/002_open.sql": "SELECT 'x",
    };
    const issues = wizardDataIssues(def, Object.keys(texts), (p) => texts[p] ?? null);
    expect(issues.map((i) => i.message)).toEqual([
      "data/migrations/001_bad.sql, statement 2: A PRAGMA may only read: table_info, index_list and the like.",
      "data/migrations/002_open.sql: The SQL ends inside a string.",
    ]);
  });

  it("is checked by wizards validate", async () => {
    const { validatePath } = await import("../src/cli/validate");
    const folder = join(dir, "pkg");
    mkdirSync(join(folder, "files", "data"), { recursive: true });
    writeFileSync(join(folder, "wizard.json"), JSON.stringify(def));
    writeFileSync(join(folder, "files", "data", "schema.sql"), "CREATE TABLE a (x); ATTACH 'b' AS b;");
    const checked = await validatePath(folder);
    expect(checked.ok).toBe(false);
    expect(checked.issues.map((i) => i.message), JSON.stringify(checked.issues)).toContain(
      "data/schema.sql, statement 2: ATTACH reaches another database.",
    );
  });
});

describe("a database per person, and one shared", () => {
  it("makes none for a read: it reads the empty schema in memory", async () => {
    const read = await call("v:reader", "person", "SELECT count(*) AS n FROM notes");
    expect(read.rows).toEqual([{ n: 0 }]);
    expect(await databases()).toEqual([]);
  });

  it("keeps each person's rows apart, and shares the shared one", async () => {
    await call("v:ann", "person", "INSERT INTO notes (text) VALUES (:t)", { params: { t: "  ann's  " } });
    await call("v:bob", "person", "INSERT INTO notes (text) VALUES (:t)", { params: { t: "bob's" } });
    expect((await call("v:ann", "person", "SELECT text FROM notes")).rows).toEqual([{ text: "ann's" }]);
    expect((await call("v:bob", "person", "SELECT text FROM notes")).rows).toEqual([{ text: "bob's" }]);
    // A guest's sign-up is saved by a fixed step, SQL the wizard wrote.
    await call("v:ann", "shared", "INSERT INTO signups (email, name) VALUES (:email, :name)", {
      by: "wizard",
      params: { email: "ann@example.com", name: "Ann" },
    });
    const all = await call("u:local", "shared", "SELECT email FROM signups");
    expect(all.rows).toEqual([{ email: "ann@example.com" }]);
    const rows = await databases();
    expect(rows.map((r) => r.holder).sort()).toEqual(["shared:" + spaceId, "v:ann", "v:bob"].sort());
    expect(readdirSync(dataFolder()).filter((f) => f.endsWith(".db"))).toHaveLength(3);
  });

  it("lets a fixed step in a guest's run save into the shared database", async () => {
    const { runStepData } = await import("@engenty/wizards-engine/data-step");
    const state = { values: { email: "cy@example.com", first: "Cy" }, outputs: {}, history: [], notes: {} };
    const ctx = {
      def,
      files,
      state,
      scope: { def, state, brand: {}, lists: {} },
      store: { wizardId, holder: "v:cy" },
      holder: { kind: "guest", id: "cy" },
      dataSpace: { id: spaceId, name: "Space" },
      space: { id: spaceId },
      runId: "run-cy",
      stepId: "signup",
      test: false,
      signal: new AbortController().signal,
      emit: async () => {},
      resources: { acted: false },
    } as never;
    const { dataService } = await import("../src/run-services/data");
    (ctx as { services: unknown }).services = {
      data: dataService({ definition: def } as never, () => ctx, () => ctx),
    };
    const out = await local(() =>
      runStepData(
        {
          scope: "shared",
          sql: "INSERT INTO signups (email, name) VALUES (:email, :name)",
          params: { email: "email", name: "{{first}} at the door" },
        },
        ctx,
      ),
    );
    expect(out).toMatchObject({ changes: 1, count: 0 });
    expect((ctx as { resources: { acted: boolean } }).resources.acted).toBe(true);
    const read = await call("u:local", "shared", "SELECT name FROM signups WHERE email = :e", {
      params: { e: "cy@example.com" },
    });
    expect(read.rows).toEqual([{ name: "Cy at the door" }]);
    await call("u:local", "shared", "DELETE FROM signups WHERE email = 'cy@example.com'");
  });

  it("binds parameters, never splices them", async () => {
    const evil = "x'); DROP TABLE notes; --";
    await call("v:ann", "person", "INSERT INTO notes (text) VALUES (:t)", { params: { t: evil } });
    const read = await call("v:ann", "person", "SELECT text FROM notes WHERE text = :t", {
      params: { t: evil },
    });
    expect(read.rows).toEqual([{ text: evil }]);
  });
});

describe("the guest rule", () => {
  it("keeps a guest's AI step out of the shared database, and logs the refusal", async () => {
    await expect(call("v:eve", "shared", "SELECT * FROM signups")).rejects.toThrow();
    await expect(
      call("v:eve", "shared", "INSERT INTO signups (email) VALUES (:e)", { params: { e: "x" } }),
    ).rejects.toThrow();
    const log = await local(() =>
      client.db.query.brokerLog.findMany({
        where: (t, { and, eq }) => and(eq(t.connectionId, `data:${wizardId}`), eq(t.whoId, "eve")),
      }),
    );
    expect(log.map((l) => [l.actionId, l.kind, l.outcome])).toEqual([
      ["data_query", "read", "deny"],
      ["data_exec", "write", "deny"],
    ]);
    expect(log[0].reason).toContain("guest");
  });

  it("lets a person's AI step read and write the shared database", async () => {
    const read = await call("u:local", "shared", "SELECT count(*) AS n FROM signups");
    expect(read.rows).toEqual([{ n: 1 }]);
  });

  it("follows a rule of the space with the broker on", async () => {
    process.env.FEATURES = "broker=on";
    try {
      const rwx = await import("../src/broker/rwx");
      await local(() =>
        rwx.addRule("local", spaceId, {
          subjectKind: "guest",
          subjectId: null,
          resourceKind: "data",
          resourceId: wizardId,
          r: null,
          w: "deny",
          x: null,
        }),
      );
      await expect(
        call("v:ann", "person", "INSERT INTO notes (text) VALUES ('no')"),
            ).rejects.toThrow(/permission/);
      expect((await call("v:ann", "person", "SELECT count(*) AS n FROM notes")).rows).toEqual([
        { n: 2 },
      ]);
    } finally {
      process.env.FEATURES = "broker=off";
    }
  });

  it("writes one line per call, with the statement's start and no parameter's value", async () => {
    const log = await local(() =>
      client.db.query.brokerLog.findMany({
        where: (t, { and, eq }) => and(eq(t.connectionId, `data:${wizardId}`), eq(t.whoId, "bob")),
      }),
    );
    expect(log.map((l) => [l.actionId, l.outcome, l.result])).toEqual([
      ["data_exec", "allow", "ok"],
      ["data_query", "allow", "ok"],
    ]);
    expect(log[0].inputSummary).toContain("INSERT INTO notes");
    expect(log[0].inputSummary).not.toContain("bob's");
  });
});

describe("limits", () => {
  it("refuses a statement that reaches past the database", async () => {
    await expect(call("v:ann", "person", "ATTACH DATABASE 'x.db' AS x")).rejects.toThrow(/ATTACH/);
    await expect(call("v:ann", "person", "PRAGMA journal_mode = DELETE")).rejects.toThrow(/PRAGMA/);
  });

  it("refuses a write in data_query", async () => {
    await expect(
      local(async () =>
        access.runData(
          await callerFor("v:ann"),
          { def, files, store: { wizardId, holder: "v:ann" } },
          { action: "data_query", by: "model", scope: "person", sql: "DELETE FROM notes", mode: "read" },
        ),
      ),
    ).rejects.toThrow(/readonly|read-only|query_only/i);
  });

  it("hands back at most the rows allowed, and says so", async () => {
    await call("v:many", "person", "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 80) INSERT INTO notes (text) SELECT 'row ' || i FROM n");
    const read = await call("v:many", "person", "SELECT text FROM notes");
    expect(read.rows).toHaveLength(50);
    expect(read.truncated).toBe(true);
  });

  it("writes nothing where one statement changes too many rows", async () => {
    await call("v:many", "person", "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 80) INSERT INTO notes (text) SELECT 'more ' || i FROM n");
    await expect(call("v:many", "person", "UPDATE notes SET text = 'x'")).rejects.toThrow(/at most 100/);
    const left = await call("v:many", "person", "SELECT count(*) AS n FROM notes WHERE text = 'x'");
    expect(left.rows).toEqual([{ n: 0 }]);
  });

  it("stops a statement that takes too long, and goes on after", async () => {
    await expect(
      call("v:many", "person", "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n"),
    ).rejects.toThrow(/longer than 1.5 s/);
    expect((await call("v:many", "person", "SELECT count(*) AS n FROM notes")).rows).toEqual([{ n: 160 }]);
  });

  it("refuses a write when the database is full, and keeps what it holds", async () => {
    await call("v:big", "person", "INSERT INTO notes (text) VALUES ('first')");
    await expect(
      call("v:big", "person", "INSERT INTO notes (text) SELECT hex(randomblob(900000))"),
    ).rejects.toThrow(/full \(1 MB\)/);
    expect((await call("v:big", "person", "SELECT text FROM notes")).rows).toEqual([{ text: "first" }]);
  });
});

describe("migrations", () => {
  it("runs a migration added later once, before the next statement", async () => {
    const ws = [...files, await local(() => file("data/migrations/001_at.sql", "ALTER TABLE notes ADD COLUMN at TEXT;"))];
    await call("v:ann", "person", "UPDATE notes SET at = 'today' WHERE id = 1", { ws });
    const read = await call("v:ann", "person", "SELECT at FROM notes WHERE id = 1", { ws });
    expect(read.rows).toEqual([{ at: "today" }]);
    // A new database runs the schema, then every migration.
    await call("v:new", "person", "INSERT INTO notes (text, at) VALUES ('n', 'now')", { ws });
    const rows = await databases();
    expect(rows.find((r) => r.holder === "v:ann")?.migrations).toEqual(["data/migrations/001_at.sql"]);
    expect(rows.find((r) => r.holder === "v:new")?.migrations).toEqual(["data/migrations/001_at.sql"]);
  });
});

describe("many guests", () => {
  it("make a database each that writes, none that only reads", async () => {
    const before = (await databases()).length;
    const guests = Array.from({ length: 40 }, (_, i) => `v:guest${i}`);
    await Promise.all(
      guests.map((g, i) =>
        i % 2
          ? call(g, "person", "SELECT count(*) FROM notes")
          : call(g, "person", "INSERT INTO notes (text) VALUES ('hi')"),
      ),
    );
    // Half of them only read, and the shared database is one for all.
    expect((await databases()).length - before).toBe(20);
  }, 60_000);
});

describe("Space → Data", () => {
  it("lists the shared database with how many people keep their own, and none of theirs", async () => {
    const listed = await json(send("GET", `/api/studio/spaces/${spaceId}/data`));
    const shared = (await databases()).find((r) => r.holder === `shared:${spaceId}`);
    const people = (await databases()).filter((r) => !r.holder.startsWith("shared:")).length;
    expect(listed.databases).toEqual([
      { id: shared?.id, wizardId, people, updatedAt: expect.any(String) },
    ]);
    const person = (await databases()).find((r) => r.holder === "v:bob");
    expect((await send("GET", `/api/studio/databases/${person?.id}`)).status).toBe(404);
  });

  it("shows its tables read-only, a page of rows at a time, and each as CSV", async () => {
    const shared = (await databases()).find((r) => r.holder === `shared:${spaceId}`);
    const db = await json(send("GET", `/api/studio/databases/${shared?.id}`));
    expect(db.tables).toEqual([
      { name: "notes", rows: 0 },
      { name: "signups", rows: 1 },
    ]);
    const rows = await json(send("GET", `/api/studio/databases/${shared?.id}/tables/signups`));
    expect(rows).toMatchObject({ columns: ["email", "name"], rows: [{ email: "ann@example.com", name: "Ann" }], total: 1 });
    expect((await send("GET", `/api/studio/databases/${shared?.id}/tables/nope`)).status).toBe(404);
    const csv = await send("GET", `/api/studio/databases/${shared?.id}/tables/signups/csv`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toBe("email,name\r\nann@example.com,Ann\r\n");
  });
});

describe("deleting", () => {
  it("deletes a person's database with the rest of their store", async () => {
    const store = await import("../src/store/index");
    const ann = (await databases()).find((r) => r.holder === "v:ann");
    await local(() => store.clearStore({ wizardId, holder: "v:ann" }));
    expect((await databases()).some((r) => r.holder === "v:ann")).toBe(false);
    expect(existsSync(join(dataFolder(), `${ann?.id}.db`))).toBe(false);
  });

  it("deletes a store nobody came back to, the shared database stays", async () => {
    const store = await import("../src/store/index");
    const { schema } = client;
    await local(() =>
      client.db
        .update(schema.storeHolder)
        .set({ usedAt: new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000) }),
    );
    await local(() => store.purgeUnusedStores());
    const left = (await databases()).map((r) => r.holder);
    expect(left).toEqual([`shared:${spaceId}`]);
  });

  it("deletes every database with the wizard", async () => {
    expect((await send("DELETE", `/api/studio/wizards/${wizardId}`)).status).toBe(200);
    expect(await databases()).toEqual([]);
    expect(readdirSync(dataFolder()).filter((f) => f.endsWith(".db"))).toEqual([]);
  });
});


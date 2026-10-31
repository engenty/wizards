import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The tool catalogue (docs/plans/modular.md, phase 1): one list of element tools for every caller,
// the caller fixed before a model sees a tool (I1), every call a line of the broker's log with the
// client that made it (I6), and wizards, skills and a space's setup decided by the space's rules.

const dir = mkdtempSync(join(tmpdir(), "wizards-elements-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
delete process.env.FEATURES;

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let skillId = "";
let client: typeof import("../src/db/client");

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

/** The owner of the local install, as a caller of the catalogue. */
async function owner(client?: string) {
  const { personCaller } = await import("../src/elements/caller");
  return personCaller({
    space: { id: spaceId, name: "Test" },
    userId: "local",
    role: "owner",
    signal: new AbortController().signal,
    client,
  });
}

/** A rule an admin wrote, beside the seed. */
async function deny(subjectKind: string, subjectId: string | null, resourceKind: string, perm: "r" | "w" | "x") {
  const rwx = await import("../src/broker/rwx");
  await local(async () => {
    await rwx.decide(spaceId, [{ kind: "role", id: "owner" }], { kind: "page", id: "x" }, "r");
    await client.db.insert(client.schema.rwxRule).values({
      id: `t${Math.random().toString(36).slice(2, 12)}`,
      tenantId: "local",
      spaceId,
      subjectKind: subjectKind as never,
      subjectId,
      resourceKind: resourceKind as never,
      resourceId: "*",
      r: perm === "r" ? "deny" : null,
      w: perm === "w" ? "deny" : null,
      x: perm === "x" ? "deny" : null,
      createdBy: "test",
    });
  });
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
  const data = await import("../src/services/space-data");
  await local(() =>
    data.createPage("local", spaceId, { title: "Akten", markdown: "Maier hat zwei Akten." }),
  );
  const made = await json(
    send("POST", `/api/studio/spaces/${spaceId}/skills`, {
      name: "tonalitaet",
      description: "So schreiben wir.",
      body: "# Tonalität\n\nPer du.",
    }),
  );
  skillId = made.id;
  await send("PATCH", `/api/studio/skills/${skillId}`, { mode: "demand" });
}, 60_000);

/** The runtime's source files, relative to src/. */
function sources(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("one catalogue", () => {
  it("makes every element tool, and no caller keeps its own", async () => {
    const { ELEMENT_TOOL_NAMES } = await import("../src/elements/catalogue");
    const src = join(__dirname, "../src");
    const makers = new Map<string, string[]>();
    for (const file of sources(src)) {
      const text = readFileSync(file, "utf8");
      for (const name of ELEMENT_TOOL_NAMES) {
        if (text.includes(`id: "${name}"`)) {
          makers.set(name, [...(makers.get(name) ?? []), relative(src, file)]);
        }
      }
    }
    for (const [name, files] of makers) {
      for (const file of files) {
        // The catalogue's modules; tools/pages.ts gives a step that writes pages its own
        // page_read, which reads a wizard's pages too and asks the broker as Knowledge's does.
        expect(
          file.startsWith("elements/") || file === "tools/skills.ts" || file === "tools/pages.ts",
          `${name} is made in ${file}`,
        ).toBe(true);
      }
    }
    for (const caller of ["services/work-ai.ts", "tools/index.ts", "agents/studio-assistant.ts"]) {
      expect(readFileSync(join(src, caller), "utf8"), caller).toContain("elementTools(");
    }
  });

  it("fixes the caller before the model: no element tool takes who, where or for whom (I1)", async () => {
    const { elementTools } = await import("../src/elements/catalogue");
    const { activeSkills } = await import("../src/services/skills");
    await local(async () => {
      const tools = await elementTools(await owner(), {
        knowledge: true,
        skills: await activeSkills(spaceId),
        wizards: true,
      });
      expect(Object.keys(tools)).toEqual(
        expect.arrayContaining(["space_search", "skill_load", "wizard_list", "wizard_run"]),
      );
      for (const [name, tool] of Object.entries(tools)) {
        const keys = Object.keys((tool as any).inputSchema?.shape ?? {});
        for (const key of keys) {
          expect(key, `${name}.${key}`).not.toMatch(
            /^(user|userId|tenant|tenantId|space|spaceId|who|holder|role|subject)$/,
          );
        }
      }
    });
  });

  it("writes one line of the broker's log per call, with the client that made it (I6)", async () => {
    const { elementTools } = await import("../src/elements/catalogue");
    const { activeSkills } = await import("../src/services/skills");
    await local(async () => {
      const tools = await elementTools(await owner("claude-code"), {
        knowledge: true,
        skills: await activeSkills(spaceId),
      });
      const found = await tools.space_search.execute({ query: "Maier" });
      // The page is indexed later; the call is what this checks.
      expect(Array.isArray(found.hits)).toBe(true);
      const loaded = await tools.skill_load.execute({ name: "tonalitaet" });
      expect(loaded.instructions).toContain("Per du.");
      const { eq } = await import("drizzle-orm");
      const rows = await client.db.query.brokerLog.findMany({
        where: eq(client.schema.brokerLog.client, "claude-code"),
      });
      expect(rows.map((r) => [r.connectionId, r.actionId, r.kind, r.outcome])).toEqual(
        expect.arrayContaining([
          ["knowledge", "space_search", "read", "allow"],
          [`skill:${skillId}`, "skill_load", "read", "allow"],
        ]),
      );
      expect(rows.every((r) => r.whoKind === "admin" && r.whoId === "local")).toBe(true);
    });
  });
});

describe("the space's rules decide", () => {
  it("a skill is read only with r", async () => {
    await deny("person", "local", "skill", "r");
    const { elementTools } = await import("../src/elements/catalogue");
    const { activeSkills } = await import("../src/services/skills");
    await local(async () => {
      const tools = await elementTools(await owner(), { skills: await activeSkills(spaceId) });
      const loaded = await tools.skill_load.execute({ name: "tonalitaet" });
      expect(loaded).toMatchObject({ error: expect.stringContaining("permission"), resource: "skill" });
      expect(JSON.stringify(loaded)).not.toContain("Per du.");
    });
  });

  it("a wizard runs only with x, and the refusal is logged", async () => {
    await deny("person", "local", "wizard", "x");
    const { elementTools } = await import("../src/elements/catalogue");
    await local(async () => {
      const tools = await elementTools(await owner("codex"), { wizards: true });
      const run = await tools.wizard_run.execute({ wizardId: "w1", answers: {}, waitSeconds: 0 });
      expect(run).toMatchObject({ error: expect.stringContaining("permission"), resource: "wizard" });
      const { and, eq } = await import("drizzle-orm");
      const row = await client.db.query.brokerLog.findFirst({
        where: and(
          eq(client.schema.brokerLog.client, "codex"),
          eq(client.schema.brokerLog.actionId, "wizard_run"),
        ),
      });
      expect(row).toMatchObject({ outcome: "deny", kind: "run", connectionId: "wizard:w1" });
    });
  });

  it("Goose writes the space's setup only with w (B4)", async () => {
    await deny("goose", "local", "setup", "w");
    const { gooseSpaceTools } = await import("../src/agents/studio-assistant");
    await local(async () => {
      const space = await client.db.query.space.findFirst({
        where: (await import("drizzle-orm")).eq(client.schema.space.id, spaceId),
      });
      let wrote = 0;
      const tools = gooseSpaceTools(
        {
          user: { id: "local", role: "owner" },
          chat: { id: "c1" },
          lang: "en",
          signal: new AbortController().signal,
        } as never,
        space as never,
        () => {
          wrote++;
        },
        { brandSections: true, brandRules: true, typography: true },
      );
      const out = await tools.set_profile.execute({ name: "Neu" });
      expect(out).toMatchObject({ error: expect.stringContaining("permission"), resource: "setup" });
      expect(wrote).toBe(0);
    });
  });
});

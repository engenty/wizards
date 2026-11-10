import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { beforeAll, describe, expect, it } from "vitest";

// Skills a wizard brings in its workspace (docs/plans/wizard-code.md): skills/<name>/SKILL.md,
// in its own steps only, before a space skill of the same name; their scripts in the sandbox of
// a step that has one; validate's checks.

const dir = mkdtempSync(join(tmpdir(), "wizards-wizard-skills-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "skills=on";

let client: typeof import("../src/db/client");
let spaceId = "";
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);

const FORMS = [
  "---",
  "name: supplier-forms",
  "description: Fills a supplier's order form.",
  "---",
  "",
  "Read [the fields](reference/fields.md), then run [fill.py](scripts/fill.py).",
].join("\n");
const VOICE = [
  "---",
  "name: voice",
  "description: How this wizard writes.",
  "mode: always",
  "---",
  "",
  "Short sentences, no jargon.",
].join("\n");

/** A workspace of these files, their bytes in the blob store. */
async function workspace(files: Record<string, string | Uint8Array>): Promise<WorkspaceFile[]> {
  const { putBlob } = await import("../src/files/blobs");
  const { mimeForPath } = await import("@engenty/wizards-shared/workspace");
  const out: WorkspaceFile[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    out.push({ path, hash: await putBlob(data), mime: mimeForPath(path), size: data.length });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const WIZARD_FILES = {
  "skills/supplier-forms/SKILL.md": FORMS,
  "skills/supplier-forms/reference/fields.md": "# Fields\n\nItem, amount.",
  "skills/supplier-forms/scripts/fill.py": "print('fill')",
  "skills/supplier-forms/assets/form.pdf": new Uint8Array([37, 80, 68, 70]),
  "skills/voice/SKILL.md": VOICE,
  "prices.csv": "item,price\n",
};

/** A step's context with the wizard's files, as tools/skills.ts reads it. */
function stepContext(files: WorkspaceFile[]) {
  return {
    tenantId: "local",
    space: { id: spaceId },
    dataSpace: { id: spaceId, name: "" },
    files,
    signal: new AbortController().signal,
    holder: { kind: "person", id: "local", role: "owner" },
    store: { holder: "u:local", wizardId: "w1" },
    emit: async () => undefined,
  } as never;
}

/** A sandbox that keeps what is written to it. */
function fakeSandbox() {
  const written = new Map<string, string | Uint8Array>();
  const sandbox = {
    capabilities: { commands: [], network: "none", uses: "", workdir: "/sandbox" },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    writeFile: async (path: string, data: string | Uint8Array) => {
      written.set(path, data);
    },
    readFile: async () => new Uint8Array(),
    destroy: async () => undefined,
  };
  return { sandbox, written };
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
}, 60_000);

describe("in a step", () => {
  it("stands whole when always on, by name on demand, and loads with skill_load", async () => {
    const { skillsBlock, skillsOf, skillTools } = await import("../src/tools/skills");
    await local(async () => {
      const ctx = stepContext(await workspace(WIZARD_FILES));
      const skills = await skillsOf(ctx);
      const block = skillsBlock(skills, { tools: true });
      expect(block).toContain('<skill name="voice">\nShort sentences, no jargon.');
      expect(block).toContain("- supplier-forms: Fills a supplier's order form.");

      const tools = await skillTools(ctx);
      const loaded = await tools.skill_load.execute({ name: "supplier-forms" });
      expect(loaded).toMatchObject({
        name: "supplier-forms",
        files: ["reference/fields.md", "scripts/fill.py"],
      });
      expect(loaded.instructions).toContain("run [fill.py](scripts/fill.py)");
      const file = await tools.skill_read.execute({
        name: "supplier-forms",
        path: "reference/fields.md",
      });
      expect(file.text).toBe("# Fields\n\nItem, amount.");

      // The broker's log names it as the wizard's skill.
      const lines = await client.db.query.brokerLog.findMany();
      expect(
        lines
          .filter((l) => l.actionId === "skill_load")
          .map((l) => [l.connectionId, l.wizardId, l.outcome]),
      ).toContainEqual(["skill:wizard.supplier-forms", "w1", "allow"]);
    });
  });

  it("hides a space skill of the same name", async () => {
    const { skillsOf } = await import("../src/tools/skills");
    const { insertSkill } = await import("../src/services/skills");
    await local(async () => {
      await insertSkill(
        spaceId,
        {
          name: "voice",
          description: "How the space writes.",
          body: "Long and formal.",
          meta: {},
          files: [],
          blobFiles: [],
        },
        { source: "own", mode: "always" },
      );
      await insertSkill(
        spaceId,
        {
          name: "glossary",
          description: "The space's words.",
          body: "Say wizard.",
          meta: {},
          files: [],
          blobFiles: [],
        },
        { source: "own", mode: "demand" },
      );
      const skills = await skillsOf(stepContext(await workspace(WIZARD_FILES)));
      expect(skills.always.map((k) => [k.id, k.body])).toEqual([
        ["wizard.voice", "Short sentences, no jargon."],
      ]);
      expect(skills.demand.map((k) => k.name)).toEqual(["supplier-forms", "glossary"]);

      // Another wizard, without skills of its own, sees the space's.
      const other = await skillsOf(stepContext(await workspace({ "prices.csv": "item\n" })));
      expect(other.always.map((k) => k.body)).toEqual(["Long and formal."]);
    });
  });
});

describe("scripts", () => {
  it("land in the sandbox of a step that has one, when it loads the skill", async () => {
    const { skillsBlock, skillsOf, skillTools } = await import("../src/tools/skills");
    const { sandbox, written } = fakeSandbox();
    await local(async () => {
      const ctx = stepContext(await workspace(WIZARD_FILES));
      expect(skillsBlock(await skillsOf(ctx), { tools: true, sandbox: true })).toContain(
        "These skills bring scripts that run in the sandbox: supplier-forms.",
      );
      const tools = await skillTools(ctx, { handle: () => sandbox as never, workdir: "/sandbox" });
      const loaded = await tools.skill_load.execute({ name: "supplier-forms" });
      expect(loaded).toMatchObject({
        folder: "/sandbox/skills/supplier-forms",
        files: ["assets/form.pdf", "reference/fields.md", "scripts/fill.py"],
      });
      expect([...written.keys()].sort()).toEqual([
        "skills/supplier-forms/SKILL.md",
        "skills/supplier-forms/assets/form.pdf",
        "skills/supplier-forms/reference/fields.md",
        "skills/supplier-forms/scripts/fill.py",
      ]);
      expect(written.get("skills/supplier-forms/scripts/fill.py")).toBe("print('fill')");
      expect(String(written.get("skills/supplier-forms/SKILL.md"))).toMatch(
        /^---\nname: supplier-forms\n/,
      );
      expect([...(written.get("skills/supplier-forms/assets/form.pdf") as Uint8Array)]).toEqual([
        37, 80, 68, 70,
      ]);
    });
  });

  it("stay text without a sandbox", async () => {
    const { skillsBlock, skillsOf, skillTools } = await import("../src/tools/skills");
    await local(async () => {
      const ctx = stepContext(await workspace(WIZARD_FILES));
      expect(skillsBlock(await skillsOf(ctx), { tools: true })).not.toContain("scripts that run");
      const tools = await skillTools(ctx);
      expect(tools.skill_read.description).toContain("nothing runs them");
      const loaded = await tools.skill_load.execute({ name: "supplier-forms" });
      expect(loaded.folder).toBeUndefined();
      expect(loaded.files).toEqual(["reference/fields.md", "scripts/fill.py"]);
    });
  });
});

describe("validate", () => {
  it("finds no issue in skills that are well made", async () => {
    const { workspaceSkillIssues } = await import("../src/services/wizard-skills");
    await local(async () => {
      expect(await workspaceSkillIssues(await workspace(WIZARD_FILES))).toEqual([]);
    });
  });

  it("says what is wrong with a skill", async () => {
    const { wizardSkillIssues } = await import("@engenty/wizards-shared/wizard-skills");
    const md = (front: string, body = "Body.") => `---\n${front}\n---\n\n${body}`;
    const issues = wizardSkillIssues(
      [
        "skills/loose/notes.md",
        "skills/plain/SKILL.md",
        "skills/nameless/SKILL.md",
        "skills/other/SKILL.md",
        "skills/moody/SKILL.md",
        "skills/linked/SKILL.md",
        "skills/linked/there.md",
        "skills/Big/SKILL.md",
      ],
      {
        "skills/plain/SKILL.md": "# No front matter",
        "skills/nameless/SKILL.md": md("description: No name."),
        "skills/other/SKILL.md": md("name: elsewhere\ndescription: Named otherwise."),
        "skills/moody/SKILL.md": md("name: moody\ndescription: A mode.\nmode: sometimes"),
        "skills/linked/SKILL.md": md(
          "name: linked\ndescription: Links.",
          "See [there](there.md), [gone](scripts/gone.py), [web](https://example.com) and [top](#top).",
        ),
        "skills/Big/SKILL.md": md("name: Big\ndescription: Upper case."),
      },
    );
    expect(issues.map((i) => i.message)).toEqual([
      'Skill folder "skills/loose" has no SKILL.md.',
      'Skill "skills/plain/SKILL.md" has no front matter between --- lines.',
      'Skill "skills/nameless/SKILL.md" has no "name" in its front matter.',
      'Skill "skills/other" is named "elsewhere" in its SKILL.md: name it "other".',
      'Skill "skills/moody" has mode "always" or "demand", not "sometimes".',
      'Skill "skills/linked" links to "scripts/gone.py", which is not in its folder.',
      'Skill folder "skills/Big" is named in lower-case letters, digits and hyphens, at most 64 characters.',
    ]);
  });

  it("counts the skills always on", async () => {
    const { wizardSkillIssues } = await import("@engenty/wizards-shared/wizard-skills");
    const names = ["a", "b", "c", "d", "e", "f"];
    const issues = wizardSkillIssues(
      names.map((n) => `skills/${n}/SKILL.md`),
      Object.fromEntries(
        names.map((n) => [
          `skills/${n}/SKILL.md`,
          `---\nname: ${n}\ndescription: ${n}.\nmode: always\n---\n\nBody.`,
        ]),
      ),
    );
    expect(issues.map((i) => i.message)).toEqual([
      'A wizard has at most 5 skills with mode "always", not 6.',
    ]);
  });
});

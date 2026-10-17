import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-package-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LIMIT_PROJECTS = "5";

let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");
let files: typeof import("../src/services/files");
let projects: typeof import("../src/services/projects");
let pkg: typeof import("../src/services/package");

const TENANT = "tenant-p";
const USER = "user-p";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);

const definition = {
  version: 1,
  title: "Wetter für Köche",
  description: "Mit Karte",
  avatar: "round",
  steps: [
    { id: "start", type: "page", title: "See", fields: [{ id: "lake", label: "See", kind: "text" }] },
    {
      id: "map",
      type: "widget",
      title: "Karte",
      entry: "map/index.html",
      data: { lake: "lake" },
      sample: "map/sample.json",
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

const manifest = (def: unknown, extra: Record<string, unknown> = {}) =>
  strToU8(JSON.stringify({ format: "engenty-wizard", version: 1, definition: def, ...extra }));

let sourceId: string;
let otherProject: string;

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  wizards = await import("../src/services/wizards");
  files = await import("../src/services/files");
  projects = await import("../src/services/projects");
  pkg = await import("../src/services/package");
  await inTenant(async () => {
    sourceId = (await wizards.createWizard(USER, { definition })).id;
    await files.writeFile(USER, sourceId, "map/index.html", "<h1>Karte</h1>");
    await files.writeFile(USER, sourceId, "map/sample.json", '{"lake":"Attersee"}');
    await files.writeFile(USER, sourceId, "img/pin.png", PNG);
    otherProject = (await projects.createProject(USER, "Zweites Projekt")).id;
  });
}, 60_000);

describe("wizard packages", () => {
  it("exports the definition and the workspace as one zip", async () => {
    const { name, zip } = await inTenant(() => pkg.exportWizard(USER, sourceId));
    expect(name).toBe("wetter-fur-koche.wizard");
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      "files/img/pin.png",
      "files/map/index.html",
      "files/map/sample.json",
      "wizard.json",
    ]);
    expect(entries["files/img/pin.png"]).toEqual(PNG);
    const told = JSON.parse(strFromU8(entries["wizard.json"]));
    expect(told).toMatchObject({ format: "engenty-wizard", version: 1, connectors: [], mcpServers: [] });
    expect(told.definition.title).toBe("Wetter für Köche");
  });

  it("takes the project's pages along as Markdown files when asked, within the cap", async () => {
    await inTenant(async () => {
      const projectId = (await wizards.ownedWizard(USER, sourceId)).projectId;
      const page = (id: string, title: string, markdown: string, parentId: string | null = null) => ({
        id,
        tenantId: TENANT,
        projectId,
        parentId,
        title,
        markdown,
      });
      await client.db
        .insert(client.schema.spacePage)
        .values([
          page("pg-1", "Öffnungszeiten: Sommer", "Mo–Fr 9–18 Uhr."),
          page("pg-2", "Preise", "x".repeat(pkg.KNOWLEDGE_PAGE_CHARS + 5)),
          page("pg-3", "Leer", "   "),
          page("pg-4", "Kinder", "Ab 6 Jahren.", "pg-2"),
        ]);
      const plain = unzipSync((await pkg.exportWizard(USER, sourceId)).zip);
      expect(Object.keys(plain).some((k) => k.startsWith("files/knowledge/"))).toBe(false);
      const { zip } = await pkg.exportWizard(USER, sourceId, { knowledge: true });
      const entries = unzipSync(zip);
      const told = JSON.parse(strFromU8(entries["wizard.json"]));
      // The empty page stays out; the long one is cut at its limit, and the manifest says so.
      expect(told.knowledge).toEqual({ pages: 3, truncated: true });
      const paths = Object.keys(entries).filter((k) => k.startsWith("files/knowledge/")).sort();
      expect(paths).toEqual([
        "files/knowledge/oeffnungszeiten-sommer.md",
        "files/knowledge/preise.md",
        "files/knowledge/preise/kinder.md",
      ]);
      const hours = strFromU8(entries["files/knowledge/oeffnungszeiten-sommer.md"]);
      expect(hours).toContain('title: "Öffnungszeiten: Sommer"');
      expect(hours).toContain("path: pages/oeffnungszeiten-sommer");
      expect(hours).toContain("Mo–Fr 9–18 Uhr.");
      expect(strFromU8(entries["files/knowledge/preise.md"]).length).toBeLessThan(pkg.KNOWLEDGE_PAGE_CHARS + 200);
    });
  });

  it("imports a package as a new, unpublished wizard of another project", async () => {
    await inTenant(async () => {
      const { zip } = await pkg.exportWizard(USER, sourceId);
      const { id, issues } = await pkg.importWizard(USER, otherProject, zip, "wetter.wizard");
      expect(issues).toEqual([]);
      expect(id).not.toBe(sourceId);
      const [source, copy] = [await wizards.ownedWizard(USER, sourceId), await wizards.ownedWizard(USER, id)];
      expect(copy.projectId).toBe(otherProject);
      expect(copy.draft).toEqual(source.draft);
      expect(copy.publishedVersion).toBeNull();
      expect(copy.shareToken).not.toBe(source.shareToken);
      expect(await files.draftFiles(id)).toEqual(await files.draftFiles(sourceId));
      const [note] = await wizards.wizardMessages(id);
      expect(note.content).toContain("“wetter.wizard”");
      expect(note.content).toContain("3 files");
    });
  });

  it("takes a package that was unpacked and zipped again in a folder", async () => {
    await inTenant(async () => {
      const zip = zipSync({
        "wetter/wizard.json": manifest(definition),
        "wetter/files/map/index.html": strToU8("<h1>neu</h1>"),
        "wetter/files/map/sample.json": strToU8("{}"),
        "wetter/.DS_Store": strToU8("x"),
        "__MACOSX/wetter/._wizard.json": strToU8("x"),
      });
      const { id, issues } = await pkg.importWizard(USER, otherProject, zip);
      expect(issues).toEqual([]);
      expect((await files.draftFiles(id)).map((f) => f.path)).toEqual(["map/index.html", "map/sample.json"]);
    });
  });

  it("takes a bare definition as JSON", async () => {
    await inTenant(async () => {
      const bare = { ...definition, steps: [definition.steps[0], definition.steps[2]] };
      const { id, issues } = await pkg.importWizard(USER, otherProject, strToU8(JSON.stringify(bare)));
      expect(issues).toEqual([]);
      expect((await wizards.ownedWizard(USER, id)).title).toBe("Wetter für Köche");
    });
  });

  it("says what the project lacks", async () => {
    await inTenant(async () => {
      const def = {
        ...definition,
        connections: [{ id: "notes", connector: "notion", title: "Notion" }],
        steps: [
          definition.steps[0],
          {
            id: "write",
            type: "agent",
            title: "Schreiben",
            instructions: "Schreibe {{lake}} auf.",
            tools: [],
            mcp: ["crm"],
            connections: ["notes"],
            output: { format: "markdown" },
          },
          definition.steps[2],
        ],
      };
      const zip = zipSync({
        "wizard.json": manifest(def, {
          connectors: [{ id: "notion", name: "Notion", domain: "notion.com", sourceKind: "mcp" }],
          mcpServers: [{ id: "crm", name: "Unser CRM" }],
        }),
      });
      const { id, issues } = await pkg.importWizard(USER, otherProject, zip);
      expect(issues.map((i) => i.message).join()).toContain('connector "notion"');
      const [note] = await wizards.wizardMessages(id);
      expect(note.content).toContain("Connector „Notion“ (notion.com)");
      expect(note.content).toContain("MCP-Server „Unser CRM“");
    });
  });

  it("refuses what is not a package and leaves no wizard behind", async () => {
    await inTenant(async () => {
      const before = (await wizards.listWizards(USER, otherProject)).length;
      const refused = async (data: Uint8Array, message: RegExp) =>
        expect(pkg.importWizard(USER, otherProject, data)).rejects.toThrow(message);
      await refused(zipSync({ "readme.txt": strToU8("hi") }), /wizard\.json is missing/);
      await refused(strToU8("PK not a zip"), /can’t be opened/);
      await refused(strToU8("hello"), /wizard\.json can’t be read/);
      await refused(zipSync({ "wizard.json": manifest({ title: "Ohne Schritte" }) }), /schema/);
      await refused(
        zipSync({ "wizard.json": strToU8(JSON.stringify({ format: "engenty-wizard", version: 2 })) }),
        /newer version/,
      );
      await refused(
        zipSync({ "wizard.json": manifest(definition), "files/.env": strToU8("x") }),
        /isn’t a valid file path/,
      );
      await refused(
        zipSync({ "wizard.json": manifest(definition), "files/big.bin": new Uint8Array(5_000_001) }),
        /larger than 5 MB/,
      );
      expect((await wizards.listWizards(USER, otherProject)).length).toBe(before);
    });
  });
});

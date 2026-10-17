import type { Lang, WizardDefinition } from "@engenty-wizards/shared/definition";
import {
  type Manifest,
  PACKAGE_EXTENSION,
  PACKAGE_FILES,
  PACKAGE_FORMAT,
  PACKAGE_MANIFEST,
  PACKAGE_SCHEMA_URL,
} from "@engenty-wizards/shared/wizard-package";
import { and, eq, isNull } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { listConnectors } from "../connectors/external.js";
import { db, schema } from "../db/client.js";
import { getBlob } from "../files/blobs.js";
import { serverText } from "../texts.js";
import { requireAdmin } from "./access.js";
import { draftFiles, writeFile } from "./files.js";
import { pageTree } from "./knowledge.js";
import { readPackage } from "./package-file.js";
import { ownedProject } from "./projects.js";
import { createWizard, deleteWizard, draftIssues, ownedWizard, parseDraft } from "./wizards.js";

/** A wizard as a file — the format is `@engenty-wizards/shared/wizard-package`'s. */

/** Where the project's pages go in a package, as Markdown the standalone runner reads inline. */
export const KNOWLEDGE_DIR = "knowledge/";
/** How much of the project's knowledge a package takes along: enough pages, never the whole space. */
export const KNOWLEDGE_MAX_CHARS = 2_000_000;
/** What one page may hold in the package (the plugin hands a file to the model up to there). */
export const KNOWLEDGE_PAGE_CHARS = 60_000;

function fileName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "wizard"}${PACKAGE_EXTENSION}`;
}

/**
 * The wizard as a file: its draft, or with `published` the version that is live (what a website
 * runs on its own). Null with `published` while the wizard is a draft only.
 */
export async function exportWizard(
  userId: string,
  wizardId: string,
  options: { published?: boolean; knowledge?: boolean } = {},
) {
  const w = await ownedWizard(userId, wizardId);
  const live =
    options.published && w.publishedVersion !== null
      ? await db.query.wizardVersion.findFirst({
          where: and(
            eq(schema.wizardVersion.wizardId, w.id),
            eq(schema.wizardVersion.version, w.publishedVersion),
          ),
        })
      : null;
  if (options.published && !live) {
    return null;
  }
  const definition = live ? live.definition : w.draft;
  const project = await ownedProject(userId, w.projectId);
  const named = new Set((definition.connections ?? []).map((c) => c.connector));
  const servers = new Set(
    definition.steps.flatMap((s) => (s.type === "agent" ? (s.mcp ?? []) : [])),
  );
  const manifest: Manifest = {
    $schema: PACKAGE_SCHEMA_URL,
    format: PACKAGE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    definition,
    connectors: (await listConnectors(project.id))
      .filter((c) => c.sourceKind !== "builtin" && named.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        domain: c.domain,
        sourceKind: c.sourceKind as "openapi" | "mcp",
      })),
    mcpServers: project.mcpServers
      .filter((s) => servers.has(s.id))
      .map((s) => ({ id: s.id, name: s.name })),
  };
  const entries: Record<string, Uint8Array> = {};
  for (const f of live ? live.files : await draftFiles(w.id)) {
    entries[PACKAGE_FILES + f.path] = new Uint8Array(await getBlob(f.hash));
  }
  if (options.knowledge) {
    const snapshot = await knowledgeSnapshot(project.id);
    manifest.knowledge = { pages: snapshot.pages.length, truncated: snapshot.truncated };
    for (const page of snapshot.pages) {
      entries[PACKAGE_FILES + KNOWLEDGE_DIR + page.path] = strToU8(page.text);
    }
  }
  entries[PACKAGE_MANIFEST] = strToU8(JSON.stringify(manifest, null, 2));
  return { name: fileName(definition.title), zip: zipSync(entries, { level: 6 }) };
}

/**
 * The project's pages as Markdown files, one per page at its path (`pages/<a>/<b>` becomes
 * `a/b.md`), each with its title in front: what a wizard that ran with `pages` reads inline on
 * a site without the space. Opt-in, and capped: a page is cut at its own limit, and the pages
 * stop where the whole would pass the snapshot's; `truncated` says so.
 */
export async function knowledgeSnapshot(
  projectId: string,
): Promise<{ pages: { path: string; text: string }[]; truncated: boolean }> {
  const tree = await pageTree(projectId);
  const rows = await db.query.spacePage.findMany({
    where: and(eq(schema.spacePage.projectId, projectId), isNull(schema.spacePage.wizardId)),
    columns: { id: true, markdown: true },
  });
  const markdown = new Map(rows.map((r) => [r.id, r.markdown]));
  const nodes = [...tree.values()].sort((a, b) => a.path.localeCompare(b.path));
  const pages: { path: string; text: string }[] = [];
  let left = KNOWLEDGE_MAX_CHARS;
  let truncated = false;
  for (const node of nodes) {
    const body = (markdown.get(node.id) ?? "").trim();
    if (!body) {
      continue;
    }
    const cut = body.length > KNOWLEDGE_PAGE_CHARS;
    const text = `---\ntitle: ${yamlValue(node.title)}\npath: ${node.path}\n---\n\n${cut ? body.slice(0, KNOWLEDGE_PAGE_CHARS) : body}\n`;
    if (text.length > left) {
      truncated = true;
      break;
    }
    truncated ||= cut;
    left -= text.length;
    pages.push({ path: `${node.path.replace(/^pages\//, "")}.md`, text });
  }
  return { pages, truncated };
}

/** A string as a YAML value: quoted, so a colon or a quote in a title does no harm. */
function yamlValue(s: string): string {
  return JSON.stringify(s);
}

/** What the wizard names that the project does not have, in words for the chat. */
async function missing(
  userId: string,
  projectId: string,
  draft: WizardDefinition,
  manifest: Manifest,
) {
  const project = await ownedProject(userId, projectId);
  const connectors = await listConnectors(project.id);
  const wanted = [...new Set((draft.connections ?? []).flatMap((c) => c.connector ?? []))];
  const servers = [
    ...new Set(draft.steps.flatMap((s) => (s.type === "agent" ? (s.mcp ?? []) : []))),
  ];
  return [
    ...wanted
      .filter((id) => !connectors.some((c) => c.id === id))
      .map((id) => {
        const told = manifest.connectors.find((c) => c.id === id);
        return `Connector „${told?.name ?? id}“${told?.domain ? ` (${told.domain})` : ""}`;
      }),
    ...servers
      .filter((id) => !project.mcpServers.some((s) => s.id === id))
      .map((id) => `MCP-Server „${manifest.mcpServers.find((s) => s.id === id)?.name ?? id}“`),
  ];
}

/** Makes a new wizard of a package in the project: the draft and its workspace, not published. */
export async function importWizard(
  userId: string,
  projectId: string,
  data: Uint8Array,
  name?: string,
  /** The language the admin reads the import's note in. */
  lang: Lang = "en",
) {
  await requireAdmin();
  const { manifest, files } = readPackage(data);
  // The shape is checked before anything is written; a wrong one leaves no wizard behind.
  const { draft } = parseDraft(
    manifest.definition,
    files.map((f) => f.path),
  );
  const lacks = await missing(userId, projectId, draft, manifest);
  const counts = {
    name,
    steps: serverText(lang, "stepCount", { count: draft.steps.length }),
    files: serverText(lang, "fileCount", { count: files.length }),
  };
  const note = [
    serverText(lang, name ? "importedFrom" : "imported", counts),
    lacks.length ? serverText(lang, "spaceStillNeeds", { needs: lacks }) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const { id } = await createWizard(userId, { projectId, definition: draft, note });
  try {
    for (const file of files) {
      await writeFile(userId, id, file.path, file.data);
    }
  } catch (err) {
    await deleteWizard(userId, id);
    throw err;
  }
  return { id, issues: await draftIssues(await ownedWizard(userId, id)) };
}

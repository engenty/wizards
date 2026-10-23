import { createHash } from "node:crypto";
import { featureOn } from "@engenty/wizards-shared/features";
import {
  byteLength,
  officialSkill,
  parseSkillMd,
  SKILL_LIMITS,
  SKILL_NAME,
  type SkillDetail,
  type SkillFile,
  SkillMdError,
  type SkillMode,
  type SkillSource,
  type SkillSummary,
  type SkillsList,
  skillMd,
  skillPathOk,
  skillTextPath,
} from "@engenty/wizards-shared/skills";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { unzipSync, zipSync } from "fflate";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";
import { currentTenant } from "../tenants/tenant.js";
import type { ServerKey } from "../texts.js";
import { projectWritable, requireWritableProject } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { ownedProject } from "./projects.js";

/**
 * The skills of a space (docs/plans/skills.md): instructions in the Agent Skills format, written
 * in the studio, uploaded as a `SKILL.md` or a folder in a zip, or added from skills.sh. A skill
 * is always on (in every AI step), on demand (a step sees its name and description and reads it
 * when it fits) or off. Only text is kept: scripts stay as text and never run. Everything here
 * answers "not found" while the `skills` switch is off.
 */

type SkillRow = typeof schema.spaceSkill.$inferSelect;

/** What a skill is made of: its `SKILL.md` read, and the other files of its folder. */
export interface SkillContent {
  name: string;
  description: string;
  body: string;
  meta: Record<string, unknown>;
  files: SkillFile[];
}

/** A file left out of an upload or an import, and why. */
export interface SkippedFile {
  path: string;
  reason: "binary" | "size" | "path" | "count";
}

const refuse = (server: ServerKey, params?: Record<string, string | number>) =>
  new ServiceError("invalid", { server, params });

export async function skillsOn(): Promise<boolean> {
  return featureOn(await currentFeatures(), "skills");
}

/** Skills are behind their switch: while it is off, they are not there. */
export async function requireSkills(): Promise<void> {
  if (!(await skillsOn())) {
    throw notFound();
  }
}

// --- checks ---------------------------------------------------------------------------------

const MD_ERRORS: Record<SkillMdError["problem"], ServerKey> = {
  frontmatter: "skillMdFrontmatter",
  name: "skillMdName",
  description: "skillMdDescription",
};

/** A `SKILL.md` read, its failure said in the person's words. */
export function readSkillMd(text: string) {
  try {
    return parseSkillMd(text);
  } catch (err) {
    if (err instanceof SkillMdError) {
      throw refuse(MD_ERRORS[err.problem]);
    }
    throw err;
  }
}

/** The bytes of a skill: its `SKILL.md` and its files. */
export function skillBytes(c: Omit<SkillContent, "files"> & { files: SkillFile[] }): number {
  return byteLength(skillMd(c)) + c.files.reduce((n, f) => n + byteLength(f.text), 0);
}

/** What a skill may be: a name of the format, a description, text within the limits. */
export function checkContent(c: SkillContent): SkillContent {
  const name = c.name.trim();
  const description = c.description.replace(/\s+/g, " ").trim();
  if (name.length > SKILL_LIMITS.name || !SKILL_NAME.test(name)) {
    throw refuse("skillName");
  }
  if (!description || description.length > SKILL_LIMITS.description) {
    throw refuse("skillDescription");
  }
  const seen = new Set<string>();
  for (const f of c.files) {
    if (!skillPathOk(f.path) || f.path === "SKILL.md" || seen.has(f.path)) {
      throw refuse("skillFilePath", { path: f.path.slice(0, 120) });
    }
    if (!skillTextPath(f.path)) {
      throw refuse("skillFileText", { path: f.path });
    }
    seen.add(f.path);
  }
  const out = { ...c, name, description };
  if (
    byteLength(skillMd(out)) > SKILL_LIMITS.skillMd ||
    c.files.length > SKILL_LIMITS.files ||
    c.files.some((f) => byteLength(f.text) > SKILL_LIMITS.file) ||
    skillBytes(out) > SKILL_LIMITS.total
  ) {
    throw refuse("skillTooLarge");
  }
  return out;
}

async function nameTaken(projectId: string, name: string, except?: string): Promise<boolean> {
  const row = await db.query.spaceSkill.findFirst({
    where: and(
      eq(schema.spaceSkill.projectId, projectId),
      eq(schema.spaceSkill.name, name),
      ...(except ? [ne(schema.spaceSkill.id, except)] : []),
    ),
    columns: { id: true },
  });
  return Boolean(row);
}

/** A name not yet taken in the space: the name itself, else with `-2`, `-3` … */
async function freeName(projectId: string, name: string): Promise<string> {
  if (!(await nameTaken(projectId, name))) {
    return name;
  }
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const next = `${name.slice(0, SKILL_LIMITS.name - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!(await nameTaken(projectId, next))) {
      return next;
    }
  }
  return `${name.slice(0, SKILL_LIMITS.name - 9)}-${nanoid(8)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "x")}`;
}

/**
 * At most five skills always on, their instructions 20,000 characters together: each of them
 * is in every AI step of the space.
 */
export async function checkAlways(
  projectId: string,
  id: string | null,
  mode: SkillMode,
  body: string,
) {
  if (mode !== "always") {
    return;
  }
  const others = await db
    .select({ id: schema.spaceSkill.id, body: schema.spaceSkill.body })
    .from(schema.spaceSkill)
    .where(and(eq(schema.spaceSkill.projectId, projectId), eq(schema.spaceSkill.mode, "always")));
  const rest = others.filter((o) => o.id !== id);
  if (rest.length + 1 > SKILL_LIMITS.always) {
    throw refuse("skillsAlwaysCount");
  }
  const chars = rest.reduce((n, o) => n + o.body.length, 0) + body.length;
  if (chars > SKILL_LIMITS.alwaysChars) {
    throw refuse("skillsAlwaysChars", { n: chars.toLocaleString("en") });
  }
}

// --- views ----------------------------------------------------------------------------------

function summaryOf(row: SkillRow): SkillSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mode: row.mode,
    source: row.source,
    origin: row.origin,
    official: row.source === "skills.sh" && officialSkill(row.origin),
    files: row.files.length,
    chars: row.body.length,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function skillRow(id: string): Promise<SkillRow> {
  const row = await db.query.spaceSkill.findFirst({
    where: and(eq(schema.spaceSkill.id, id), eq(schema.spaceSkill.tenantId, currentTenant())),
  });
  if (!row) {
    throw notFound();
  }
  return row;
}

export async function listSkills(userId: string, projectId: string): Promise<SkillsList> {
  await requireSkills();
  const project = await ownedProject(userId, projectId);
  const rows = await db.query.spaceSkill.findMany({
    where: eq(schema.spaceSkill.projectId, project.id),
    orderBy: [asc(schema.spaceSkill.name)],
  });
  return { skills: rows.map(summaryOf), readOnly: !(await projectWritable(project)) };
}

export async function getSkill(userId: string, id: string): Promise<SkillDetail> {
  await requireSkills();
  const row = await skillRow(id);
  const project = await ownedProject(userId, row.projectId);
  return {
    ...summaryOf(row),
    projectId: row.projectId,
    body: row.body,
    meta: row.meta,
    fileList: row.files,
    originHash: row.originHash,
    readOnly: !(await projectWritable(project)),
  };
}

// --- writes ---------------------------------------------------------------------------------

/** The hash of a skill's content, as skills.sh had it: an update is offered when it differs. */
export function contentHash(c: SkillContent): string {
  const files = [...c.files].sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256")
    .update(JSON.stringify([skillMd(c), files.map((f) => [f.path, f.text])]))
    .digest("hex");
}

/** Puts a new skill into the space; its name is the one given, or the next free one. */
export async function insertSkill(
  projectId: string,
  content: SkillContent,
  options: {
    source: SkillSource;
    mode?: SkillMode;
    origin?: string | null;
    originHash?: string | null;
    rename?: boolean;
  },
): Promise<{ id: string; name: string }> {
  const checked = checkContent(content);
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.spaceSkill)
    .where(eq(schema.spaceSkill.projectId, projectId));
  if (n >= SKILL_LIMITS.perSpace) {
    throw refuse("skillsTooMany");
  }
  const name = options.rename ? await freeName(projectId, checked.name) : checked.name;
  if (!options.rename && (await nameTaken(projectId, name))) {
    throw refuse("skillNameTaken", { name });
  }
  const mode = options.mode ?? "demand";
  await checkAlways(projectId, null, mode, checked.body);
  const id = nanoid(12);
  await db.insert(schema.spaceSkill).values({
    id,
    tenantId: currentTenant(),
    projectId,
    name,
    description: checked.description,
    body: checked.body,
    meta: checked.meta,
    files: checked.files,
    mode,
    source: options.source,
    origin: options.origin ?? null,
    originHash: options.originHash ?? null,
  });
  return { id, name };
}

/** A skill written in the studio: a name, a description and a first heading. */
export async function createSkill(
  userId: string,
  projectId: string,
  input: { name: string; description: string; body?: string; mode?: SkillMode },
) {
  await requireSkills();
  const project = await ownedProject(userId, projectId);
  await requireWritableProject(project.id);
  return insertSkill(
    project.id,
    {
      name: input.name,
      description: input.description,
      body: input.body ?? "",
      meta: {},
      files: [],
    },
    { source: "own", mode: input.mode, rename: true },
  );
}

export interface SkillPatch {
  name?: string;
  description?: string;
  body?: string;
  meta?: Record<string, unknown>;
  files?: SkillFile[];
  /** The whole `SKILL.md`, as the code view edits it: name, description, front matter and body. */
  skillMd?: string;
  mode?: SkillMode;
}

/**
 * Changes a skill: when it counts, always; its content only when it is the space's own, since
 * one from skills.sh stays as it came (an update replaces it whole).
 */
export async function updateSkill(userId: string, id: string, patch: SkillPatch) {
  await requireSkills();
  const row = await skillRow(id);
  await ownedProject(userId, row.projectId);
  await requireWritableProject(row.projectId);
  const content = { ...patch };
  if (patch.skillMd !== undefined) {
    Object.assign(content, readSkillMd(patch.skillMd));
  }
  const touches = ["name", "description", "body", "meta", "files"].some(
    (k) => content[k as keyof SkillPatch] !== undefined,
  );
  if (touches && row.source === "skills.sh") {
    throw refuse("skillReadOnly");
  }
  const next = checkContent({
    name: content.name ?? row.name,
    description: content.description ?? row.description,
    body: content.body ?? row.body,
    meta: content.meta ?? row.meta,
    files: content.files ?? row.files,
  });
  if (next.name !== row.name && (await nameTaken(row.projectId, next.name, row.id))) {
    throw refuse("skillNameTaken", { name: next.name });
  }
  const mode = patch.mode ?? row.mode;
  await checkAlways(row.projectId, row.id, mode, next.body);
  await db
    .update(schema.spaceSkill)
    .set({ ...next, mode, updatedAt: new Date() })
    .where(eq(schema.spaceSkill.id, row.id));
  return { updatedAt: new Date().toISOString() };
}

export async function deleteSkill(userId: string, id: string) {
  await requireSkills();
  const row = await skillRow(id);
  await ownedProject(userId, row.projectId);
  await requireWritableProject(row.projectId);
  await db.delete(schema.spaceSkill).where(eq(schema.spaceSkill.id, row.id));
}

/** A skill as the space's own: a copy to change, on demand until someone switches it on. */
export async function copySkill(userId: string, id: string) {
  await requireSkills();
  const row = await skillRow(id);
  await ownedProject(userId, row.projectId);
  await requireWritableProject(row.projectId);
  return insertSkill(
    row.projectId,
    {
      name: row.name,
      description: row.description,
      body: row.body,
      meta: row.meta,
      files: row.files,
    },
    { source: "own", mode: row.mode === "always" ? "demand" : row.mode, rename: true },
  );
}

// --- files: a SKILL.md, a zip ---------------------------------------------------------------

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Bytes as text, or null when they are not text: not UTF-8, or a NUL among them. */
export function asText(data: Uint8Array): string | null {
  try {
    const text = utf8.decode(data);
    return text.includes("\u0000") ? null : text.replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/**
 * The files of a skill's folder as the format keeps them: its `SKILL.md` read, the others that
 * are text and fit kept, the rest named as left out.
 */
export function contentOf(entries: { path: string; text: string | null; bytes: number }[]): {
  content: SkillContent;
  skipped: SkippedFile[];
} {
  const md = entries.find((e) => e.path === "SKILL.md");
  if (!md || md.text === null) {
    throw refuse("skillNoSkillMd");
  }
  const parsed = readSkillMd(md.text);
  const files: SkillFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const e of entries) {
    if (e.path === "SKILL.md") {
      continue;
    }
    if (!skillPathOk(e.path)) {
      skipped.push({ path: e.path, reason: "path" });
    } else if (e.text === null || !skillTextPath(e.path)) {
      skipped.push({ path: e.path, reason: "binary" });
    } else if (e.bytes > SKILL_LIMITS.file) {
      skipped.push({ path: e.path, reason: "size" });
    } else if (files.length >= SKILL_LIMITS.files) {
      skipped.push({ path: e.path, reason: "count" });
    } else {
      files.push({ path: e.path, text: e.text });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { content: { ...parsed, files }, skipped };
}

/** Never unpacked: more than this many entries, or an entry larger than this. */
const ZIP_ENTRIES = 500;
const ZIP_ENTRY_BYTES = 2_000_000;

/**
 * A skill from an uploaded zip (a `.skill` is one too): the folder of its shallowest `SKILL.md`,
 * paths taken relative to it. Hidden files and the Mac's resource forks stay out.
 */
export function unpackSkill(data: Uint8Array) {
  let seen = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (f) => {
        seen++;
        return seen <= ZIP_ENTRIES && f.originalSize <= ZIP_ENTRY_BYTES && !f.name.endsWith("/");
      },
    });
  } catch {
    throw refuse("skillUploadKind");
  }
  const paths = Object.keys(entries).filter(
    (p) => !p.split("/").some((part) => part.startsWith(".") || part === "__MACOSX"),
  );
  const md = paths
    .filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
    .sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (!md) {
    throw refuse("skillNoSkillMd");
  }
  const root = md.slice(0, -"SKILL.md".length);
  return contentOf(
    paths
      .filter((p) => p.startsWith(root))
      .map((p) => ({
        path: p.slice(root.length),
        text: asText(entries[p]),
        bytes: entries[p].length,
      })),
  );
}

/** An uploaded `SKILL.md`, `.zip` or `.skill`, as a skill of the space. */
export async function uploadSkill(
  userId: string,
  projectId: string,
  file: { name: string; data: Uint8Array },
) {
  await requireSkills();
  const project = await ownedProject(userId, projectId);
  await requireWritableProject(project.id);
  const lower = file.name.toLowerCase();
  let read: { content: SkillContent; skipped: SkippedFile[] };
  if (lower.endsWith(".zip") || lower.endsWith(".skill")) {
    read = unpackSkill(file.data);
  } else if (lower.endsWith(".md")) {
    const text = asText(file.data);
    if (text === null) {
      throw refuse("skillUploadKind");
    }
    read = { content: { ...readSkillMd(text), files: [] }, skipped: [] };
  } else {
    throw refuse("skillUploadKind");
  }
  const made = await insertSkill(project.id, read.content, { source: "upload", rename: true });
  return { ...made, skipped: read.skipped };
}

/** A skill as a zip: its folder, named by the skill, as other tools take it. */
export async function skillZip(userId: string, id: string) {
  await requireSkills();
  const row = await skillRow(id);
  await ownedProject(userId, row.projectId);
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    [`${row.name}/SKILL.md`]: enc.encode(skillMd(row)),
  };
  for (const f of row.files) {
    files[`${row.name}/${f.path}`] = enc.encode(f.text);
  }
  return { name: `${row.name}.zip`, data: zipSync(files, { level: 6 }) };
}

// --- for steps and Goose ----------------------------------------------------------------------

/** Every skill of the space, off ones too, by name: what Goose is told the space has. */
export async function skillList(projectId: string) {
  return db
    .select({
      name: schema.spaceSkill.name,
      description: schema.spaceSkill.description,
      mode: schema.spaceSkill.mode,
    })
    .from(schema.spaceSkill)
    .where(eq(schema.spaceSkill.projectId, projectId))
    .orderBy(asc(schema.spaceSkill.name));
}

/** The space's skills that count, by mode: none while the switch is off. */
export async function activeSkills(projectId: string): Promise<{
  always: SkillRow[];
  demand: SkillRow[];
}> {
  if (!(await skillsOn())) {
    return { always: [], demand: [] };
  }
  const rows = await db.query.spaceSkill.findMany({
    where: and(eq(schema.spaceSkill.projectId, projectId), ne(schema.spaceSkill.mode, "off")),
    orderBy: [asc(schema.spaceSkill.name)],
  });
  return {
    always: rows.filter((r) => r.mode === "always"),
    demand: rows.filter((r) => r.mode === "demand").slice(0, SKILL_LIMITS.listed),
  };
}

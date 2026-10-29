import {
  byteLength,
  officialSkill,
  SKILL_REF,
  type SkillHit,
  type SkillMode,
  type SkillPreview,
} from "@engenty/wizards-shared/skills";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { requireWritableProject } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { ownedProject } from "./projects.js";
import {
  asText,
  blobBytes,
  checkAlways,
  checkContent,
  contentHash,
  contentOf,
  insertSkill,
  keepBlobs,
  requireSkills,
  type SkillIntake,
  skillBytes,
  skillRow,
} from "./skills.js";

/**
 * skills.sh, the open directory of skills (docs/plans/skills.md): its search, and a skill read
 * whole from its registry address `/r/<owner>/<repo>/<skill>`, which hands out the `SKILL.md`
 * and the text files of the skill's folder (not fonts or images). A skill added is a copy: it
 * changes only when someone takes an update, and its scripts stay off until someone switches
 * them on.
 */

const BASE = (process.env.SKILLS_REGISTRY_URL ?? "https://skills.sh").replace(/\/+$/, "");
/** What a registry answer may weigh: a skill of 1 MB with its JSON around it. */
const MAX_ANSWER = 5_000_000;

const down = () => new ServiceError("refused", { server: "skillsRegistryDown" });

async function getJson(path: string, signal?: AbortSignal): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      redirect: "follow",
      headers: { accept: "application/json", "user-agent": "engenty-wizards" },
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    });
  } catch {
    throw down();
  }
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw down();
  }
  const text = await res.text();
  if (text.length > MAX_ANSWER) {
    throw down();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw down();
  }
}

const searchAnswer = z.object({
  skills: z
    .array(
      z.object({
        id: z.string(),
        source: z.string(),
        skillId: z.string().optional(),
        name: z.string(),
        installs: z.number().optional(),
      }),
    )
    .default([]),
});

/** Skills on skills.sh for a few words, the space's own marked as added. */
export async function searchSkills(userId: string, projectId: string, query: string) {
  await requireSkills();
  const project = await ownedProject(userId, projectId);
  const q = query.trim();
  if (q.length < 2) {
    return { hits: [] as SkillHit[] };
  }
  const answer = searchAnswer.safeParse(
    await getJson(`/api/search?q=${encodeURIComponent(q.slice(0, 100))}&limit=40`),
  );
  if (!answer.success) {
    throw down();
  }
  const added = new Set(
    (
      await db
        .select({ origin: schema.spaceSkill.origin })
        .from(schema.spaceSkill)
        .where(
          and(eq(schema.spaceSkill.projectId, project.id), isNotNull(schema.spaceSkill.origin)),
        )
    ).map((r) => r.origin),
  );
  const hits: SkillHit[] = answer.data.skills
    .filter((s) => SKILL_REF.test(s.id))
    .map((s) => ({
      ref: s.id,
      name: s.name,
      source: s.source,
      installs: s.installs ?? 0,
      official: officialSkill(s.id),
      added: added.has(s.id),
    }));
  return { hits };
}

const registryItem = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  files: z
    .array(z.object({ path: z.string(), content: z.string().nullish() }))
    .max(2000)
    .default([]),
});

/** A skill of skills.sh read whole: its content as the space would keep it, and what was left out. */
export async function readRegistrySkill(ref: string): Promise<SkillIntake & { hash: string }> {
  if (!SKILL_REF.test(ref)) {
    throw notFound();
  }
  const item = registryItem.safeParse(
    await getJson(`/r/${ref.split("/").map(encodeURIComponent).join("/")}`),
  );
  if (!item.success) {
    throw new ServiceError("not_found", { server: "skillsRegistryMissing", params: { ref } });
  }
  const enc = new TextEncoder();
  const read = contentOf(
    item.data.files.map((f) => {
      // The registry hands out text; a file that is not came as something else (null, empty).
      const data = typeof f.content === "string" ? enc.encode(f.content) : null;
      return {
        path: f.path.replace(/^\.?\//, ""),
        text: data === null ? null : asText(data),
        data,
      };
    }),
  );
  return { ...read, hash: contentHash(read.content) };
}

/** A skill of skills.sh to look at before it is added: everything it would bring. */
export async function previewSkill(userId: string, projectId: string, ref: string) {
  await requireSkills();
  await ownedProject(userId, projectId);
  const read = await readRegistrySkill(ref);
  const preview: SkillPreview = {
    ref,
    name: read.content.name,
    description: read.content.description,
    body: read.content.body,
    meta: read.content.meta,
    fileList: read.content.files,
    blobList: read.content.blobFiles.map((f) => ({ path: f.path, bytes: f.bytes })),
    skipped: read.skipped,
    official: officialSkill(ref),
    bytes: skillBytes(read.content) + blobBytes(read.content.blobFiles),
    hash: read.hash,
  };
  // What the space would refuse is said now, before anyone presses Add.
  checkContent(read.content);
  return preview;
}

/** Adds a skill of skills.sh to the space, as it is there now. */
export async function addRegistrySkill(
  userId: string,
  projectId: string,
  input: { ref: string; mode?: SkillMode },
) {
  await requireSkills();
  const project = await ownedProject(userId, projectId);
  await requireWritableProject(project.id);
  const read = await readRegistrySkill(input.ref);
  await keepBlobs(read.blobs);
  return insertSkill(project.id, read.content, {
    source: "skills.sh",
    mode: input.mode,
    origin: input.ref,
    originHash: read.hash,
    rename: true,
  });
}

/** What skills.sh has now for a skill added from it: null when nothing changed. */
export async function skillUpdate(userId: string, id: string) {
  await requireSkills();
  const row = await skillRow(id);
  if (!row.origin || row.source !== "skills.sh") {
    throw notFound();
  }
  await ownedProject(userId, row.projectId);
  const read = await readRegistrySkill(row.origin);
  if (read.hash === row.originHash) {
    return { update: null };
  }
  return {
    update: {
      description: read.content.description,
      body: read.content.body,
      fileList: [
        ...read.content.files.map((f) => ({ path: f.path, bytes: byteLength(f.text) })),
        ...read.content.blobFiles.map((f) => ({ path: f.path, bytes: f.bytes })),
      ].sort((a, b) => a.path.localeCompare(b.path)),
      skipped: read.skipped,
      hash: read.hash,
    },
  };
}

/** Takes what skills.sh has now; the skill keeps its name and when it counts. */
export async function applySkillUpdate(userId: string, id: string, hash: string) {
  await requireSkills();
  const row = await skillRow(id);
  if (!row.origin || row.source !== "skills.sh") {
    throw notFound();
  }
  await ownedProject(userId, row.projectId);
  await requireWritableProject(row.projectId);
  const read = await readRegistrySkill(row.origin);
  // Taken only as it was shown: a change since the person looked is shown first.
  if (read.hash !== hash) {
    throw new ServiceError("revision_conflict", { server: "skillUpdateChanged" });
  }
  const next = checkContent({ ...read.content, name: row.name });
  await checkAlways(row.projectId, row.id, row.mode, next.body);
  await keepBlobs(read.blobs);
  await db
    .update(schema.spaceSkill)
    .set({
      description: next.description,
      body: next.body,
      meta: next.meta,
      files: next.files,
      blobFiles: next.blobFiles,
      originHash: read.hash,
      updatedAt: new Date(),
    })
    .where(eq(schema.spaceSkill.id, row.id));
  return { ok: true };
}

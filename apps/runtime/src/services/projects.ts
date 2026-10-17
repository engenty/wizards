import type { Lang } from "@engenty-wizards/shared/definition";
import {
  type AssetSection,
  type BrandFont,
  type BrandGradient,
  type BrandPattern,
  type BrandRule,
  COLOR_SECTION_KINDS,
  type ColorSection,
  cleanAssetSections,
  cleanLogoSections,
  FACT_TYPES,
  FONT_USES,
  FONT_WEIGHTS,
  GRADIENT_TYPES,
  type LogoSection,
  orderColors,
  PROJECT_LIMITS,
  type ProjectFact,
  RULE_MARKS,
  type TextStyle,
} from "@engenty-wizards/shared/projects";
import { note } from "@engenty-wizards/shared/run";
import { and, count, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { managed, tenantInfo } from "../manage.js";
import { spaceChanged } from "../plugins/events.js";
import { currentTenant } from "../tenants/tenant.js";
import { serverText } from "../texts.js";
import { mayBuild, requireAdmin, requireBuild, requireWritable } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { forgetWizardLinks } from "./links.js";
import { removeProjectFiles } from "./project-files.js";

export type ProjectRow = typeof schema.project.$inferSelect;

const MASK = "••••";

export const mcpServerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
  name: z.string().min(1).max(60),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const sectionId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const brandColorSchema = z.object({
  name: z.string().max(120),
  value: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  section: sectionId.optional(),
});

export const colorSectionSchema = z.object({
  id: sectionId,
  title: z.string().max(80),
  kind: z.enum(COLOR_SECTION_KINDS).optional(),
});

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const gradientSchema = z.object({
  id: sectionId,
  name: z.string().max(80),
  description: z.string().max(400).optional(),
  section: sectionId,
  type: z.enum(GRADIENT_TYPES),
  angle: z.number().min(-360).max(720),
  stops: z
    .array(z.object({ color: hexColor, at: z.number().min(0).max(100) }))
    .min(2)
    .max(12),
});

export const patternSchema = z.object({
  id: sectionId,
  name: z.string().max(80),
  description: z.string().max(400).optional(),
  section: sectionId,
  file: z.string().max(40),
  tile: z.boolean().optional(),
});

const rulesSchema = z
  .array(z.object({ text: z.string().max(200), mark: z.enum(RULE_MARKS).optional() }))
  .max(PROJECT_LIMITS.logoRules);

export const brandFontSchema = z.object({
  id: sectionId,
  family: z.string().max(80),
  role: z.string().max(200),
  weights: z.array(z.number().int().min(100).max(900)).max(FONT_WEIGHTS.length + 3),
  license: z.string().max(200).optional(),
  uses: z.array(z.enum(FONT_USES)).max(FONT_USES.length).optional(),
});

export const textStyleSchema = z.object({
  id: sectionId,
  name: z.string().max(60),
  font: sectionId.optional(),
  size: z.number().min(6).max(400),
  weight: z.number().int().min(100).max(900),
  lineHeight: z.number().min(50).max(300),
  tracking: z.number().min(-20).max(50),
  uppercase: z.boolean().optional(),
});

export const assetSectionSchema = z.object({
  id: sectionId,
  title: z.string().max(80),
  assets: z.array(z.string().max(40)).max(PROJECT_LIMITS.files.asset),
});

export const logoSectionSchema = z.object({
  id: sectionId,
  title: z.string().max(80),
  description: z.string().max(400),
  logos: z.array(z.string().max(40)).max(PROJECT_LIMITS.files.logo),
});

export const projectFactSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().min(1).max(80),
  value: z.string().max(4000),
  type: z.enum(FACT_TYPES).optional(),
});

export const projectPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  brand: z
    .object({
      name: z.string().max(120).optional(),
      about: z.string().max(8000).optional(),
      colors: z.array(brandColorSchema).max(PROJECT_LIMITS.colors).optional(),
      colorSections: z.array(colorSectionSchema).max(PROJECT_LIMITS.logoSections).optional(),
      gradients: z.array(gradientSchema).max(PROJECT_LIMITS.gradients).optional(),
      patterns: z.array(patternSchema).max(PROJECT_LIMITS.files.pattern).optional(),
      colorRules: rulesSchema.optional(),
      assetSections: z.array(assetSectionSchema).max(PROJECT_LIMITS.logoSections).optional(),
      fonts: z.array(brandFontSchema).max(PROJECT_LIMITS.fonts).optional(),
      textStyles: z.array(textStyleSchema).max(PROJECT_LIMITS.textStyles).optional(),
      typeRules: rulesSchema.optional(),
      logoSections: z.array(logoSectionSchema).max(PROJECT_LIMITS.logoSections).optional(),
      logoRules: rulesSchema.optional(),
    })
    .optional(),
  facts: z.array(projectFactSchema).max(PROJECT_LIMITS.facts).optional(),
  mcpServers: z.array(mcpServerSchema).max(10).optional(),
});

/**
 * How many projects the tenant works with: the number the Manage-App gives for it, else this
 * runtime's (`LIMIT_PROJECTS`, one unless set). The studio shows a project switcher only above
 * one. Projects beyond the number stay in the database and are not listed.
 */
export async function projectLimit(): Promise<number> {
  if (managed) {
    const info = await tenantInfo(currentTenant()).catch(() => null);
    // Null: the plan sets no limit.
    if (info && info.limits.projects === null) {
      return Number.POSITIVE_INFINITY;
    }
    if (info?.limits.projects) {
      return info.limits.projects;
    }
  }
  return Math.max(1, env.limits.projects);
}

/** The number for the studio: null where there is no limit (JSON has no infinity). */
export async function projectLimitOrNull(): Promise<number | null> {
  const limit = await projectLimit();
  return Number.isFinite(limit) ? limit : null;
}

export async function ownedProject(_userId: string, projectId: string): Promise<ProjectRow> {
  const p = await db.query.project.findFirst({
    where: and(eq(schema.project.id, projectId), eq(schema.project.tenantId, currentTenant())),
  });
  if (!p) {
    throw notFound();
  }
  return p;
}

/** The tenant's projects that were made here, not synced from a local install. */
const madeHere = () =>
  and(eq(schema.project.tenantId, currentTenant()), isNull(schema.project.origin));

/** The tenant's projects a local install synced. */
const synced = () =>
  and(eq(schema.project.tenantId, currentTenant()), eq(schema.project.origin, "local"));

/** What the first space is called, in the language of whoever first opens the studio. */
const FIRST_SPACE = { cloud: "firstSpaceCloud", local: "firstSpaceLocal" } as const;

/**
 * A tenant that builds here always has a project of its own: the first one is made when its
 * studio is first opened, named in that request's language.
 */
async function ensureProject(lang: Lang = "en"): Promise<void> {
  const any = await db.query.project.findFirst({ where: madeHere() });
  if (!any) {
    const id = nanoid(12);
    await db.insert(schema.project).values({
      id,
      tenantId: currentTenant(),
      name: serverText(lang, FIRST_SPACE[env.manage.url ? "cloud" : "local"]),
    });
    spaceChanged("space.created", id);
  }
}

/**
 * The project a caller means when it names none: the oldest one made here, where a wizard
 * lands; for a tenant that builds nothing here, the one its local install synced.
 */
export async function defaultProject(_userId: string): Promise<ProjectRow> {
  const build = await mayBuild();
  if (build) {
    await ensureProject();
  }
  const p = await db.query.project.findFirst({
    where: build ? madeHere() : synced(),
    orderBy: [schema.project.createdAt],
  });
  if (!p) {
    throw notFound();
  }
  return p;
}

/**
 * The projects the studio shows. A tenant that builds here: its own and the synced ones, up to
 * its number. One that does not: only what its local install synced — possibly nothing yet.
 */
export async function listProjects(_userId: string, lang?: Lang) {
  const build = await mayBuild();
  if (build) {
    await ensureProject(lang);
  }
  // The oldest come first: with a limit of one, that is the project everything lands in.
  const limit = await projectLimit();
  const projects = await db.query.project.findMany({
    where: build ? eq(schema.project.tenantId, currentTenant()) : synced(),
    orderBy: [schema.project.createdAt],
    ...(Number.isFinite(limit) ? { limit } : {}),
  });
  const counts = await db
    .select({ projectId: schema.wizard.projectId, n: count() })
    .from(schema.wizard)
    .where(eq(schema.wizard.tenantId, currentTenant()))
    .groupBy(schema.wizard.projectId);
  return projects.map((p) => ({
    ...p,
    wizardCount: counts.find((x) => x.projectId === p.id)?.n ?? 0,
  }));
}

/** MCP server headers carry the admin's credentials: shown masked, kept when sent back masked. */
export function maskedServers(p: ProjectRow) {
  return p.mcpServers.map((s) => ({
    ...s,
    headers: s.headers
      ? Object.fromEntries(Object.keys(s.headers).map((k) => [k, MASK]))
      : undefined,
  }));
}

export async function createProject(_userId: string, name: string): Promise<{ id: string }> {
  await requireBuild();
  await requireAdmin();
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.project)
    .where(eq(schema.project.tenantId, currentTenant()));
  const limit = await projectLimit();
  if (n >= limit) {
    throw new ServiceError(
      "refused",
      limit === 1 ? note("onlyOneSpaceAllowed") : note("mostSpaces", { count: limit }),
    );
  }
  const id = nanoid(12);
  await db
    .insert(schema.project)
    .values({ id, tenantId: currentTenant(), name, brand: {}, mcpServers: [] });
  spaceChanged("space.created", id);
  return { id };
}

export async function updateProject(
  userId: string,
  projectId: string,
  patch: z.infer<typeof projectPatchSchema>,
) {
  const p = await ownedProject(userId, projectId);
  await requireWritable(p);
  await requireAdmin();
  const mcpServers = patch.mcpServers?.map((s) => {
    const before = p.mcpServers.find((x) => x.id === s.id);
    const headers = s.headers
      ? Object.fromEntries(
          Object.entries(s.headers).map(([k, v]) => [
            k,
            v === MASK ? (before?.headers?.[k] ?? "") : v,
          ]),
        )
      : undefined;
    return { ...s, headers };
  });
  if (patch.facts && new Set(patch.facts.map((f) => f.key)).size !== patch.facts.length) {
    throw new ServiceError("invalid", note("twoEntriesSameKey"));
  }
  await db
    .update(schema.project)
    .set({
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.brand ? { brand: brandAfter(p.brand, patch.brand) } : {}),
      ...(patch.facts ? { facts: patch.facts } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.project.id, p.id));
  spaceChanged("space.updated", p.id);
}

/**
 * The brand with the patch on it. Sections and rules are optional: a section without title and
 * logos and rules without words are not kept.
 */
function brandAfter(
  brand: ProjectRow["brand"],
  patch: NonNullable<z.infer<typeof projectPatchSchema>["brand"]>,
): ProjectRow["brand"] {
  const {
    logoSections,
    logoRules,
    colors,
    colorSections,
    colorRules,
    gradients,
    patterns,
    assetSections,
    fonts,
    textStyles,
    typeRules,
    ...rest
  } = {
    ...brand,
    ...patch,
  };
  // A rule is its words and its sign; a bullet is the sign of none.
  const rows = (list: BrandRule[] | undefined) =>
    (list ?? [])
      .map(({ text, mark }) => ({
        text: text.trim(),
        ...(mark && mark !== "bullet" ? { mark } : {}),
      }))
      .filter((r) => r.text);
  const used = new Set(
    [...(colors ?? []), ...(gradients ?? []), ...(patterns ?? [])].map((c) => c.section),
  );
  const colorGroups = (colorSections ?? [])
    .map((s) => ({
      ...s,
      title: s.title.trim(),
      ...(s.kind && s.kind !== "colors" ? { kind: s.kind } : { kind: undefined }),
    }))
    .filter((s) => s.title || used.has(s.id));
  // A gradient or a pattern lives in a section of its kind; colours only in colour sections.
  const kindOf = (id: string | undefined) => colorGroups.find((s) => s.id === id)?.kind ?? "colors";
  const inKind = (id: string, kind: "gradients" | "patterns") =>
    colorGroups.some((s) => s.id === id && s.kind === kind);
  const told = <T extends { name: string; description?: string }>({ description, ...x }: T) => ({
    ...x,
    name: x.name.trim(),
    ...(description?.trim() ? { description: description.trim() } : {}),
  });
  const fills = (gradients ?? []).filter((g) => inKind(g.section, "gradients")).map(told);
  const tiles = (patterns ?? []).filter((p) => inKind(p.section, "patterns")).map(told);
  const swatches = colors?.map((c) =>
    c.section && kindOf(c.section) !== "colors" ? { name: c.name, value: c.value } : c,
  );
  const sections = cleanLogoSections(
    (logoSections ?? []).map((s) => ({
      ...s,
      title: s.title.trim(),
      description: s.description.trim(),
    })),
  ).filter((s) => s.title || s.logos.length);
  const assetGroups = cleanAssetSections(
    (assetSections ?? []).map((s) => ({ ...s, title: s.title.trim() })),
  ).filter((s) => s.title || s.assets.length);
  const typefaces = (fonts ?? [])
    .map(({ license, uses, ...f }) => ({
      ...f,
      family: f.family.trim(),
      role: f.role.trim(),
      ...(license?.trim() ? { license: license.trim() } : {}),
      ...(uses?.length ? { uses: FONT_USES.filter((u) => uses.includes(u)) } : {}),
    }))
    .filter((f) => f.family);
  const styles = (textStyles ?? [])
    .map((s) => ({
      ...s,
      name: s.name.trim(),
      font: typefaces.some((f) => f.id === s.font) ? s.font : undefined,
    }))
    .filter((s) => s.name);
  const typeRows = rows(typeRules);
  const rules = rows(logoRules);
  const colourRules = rows(colorRules);
  return {
    ...rest,
    ...(swatches ? { colors: orderColors(swatches, colorGroups) } : {}),
    ...(colorGroups.length
      ? { colorSections: colorGroups.map(({ kind, ...s }) => (kind ? { ...s, kind } : s)) }
      : {}),
    ...(fills.length ? { gradients: fills } : {}),
    ...(tiles.length ? { patterns: tiles } : {}),
    ...(colourRules.length ? { colorRules: colourRules } : {}),
    ...(assetGroups.length ? { assetSections: assetGroups } : {}),
    ...(typefaces.length ? { fonts: typefaces } : {}),
    ...(styles.length ? { textStyles: styles } : {}),
    ...(typeRows.length ? { typeRules: typeRows } : {}),
    ...(sections.length ? { logoSections: sections } : {}),
    ...(rules.length ? { logoRules: rules } : {}),
  };
}

/** What a step knows of the project it runs in: who it is, its colours, logo use and facts. */
export interface ProjectProfile {
  name: string;
  about: string;
  colors: { name: string; value: string; section?: string }[];
  /** Empty where the colours are not grouped. */
  colorSections: ColorSection[];
  gradients: BrandGradient[];
  patterns: BrandPattern[];
  /** One rule per row; empty where the brand states none. */
  colorRules: BrandRule[];
  /** Empty where the logos are not grouped. */
  logoSections: LogoSection[];
  /** Empty where the assets are not grouped. */
  assetSections: AssetSection[];
  fonts: BrandFont[];
  textStyles: TextStyle[];
  typeRules: BrandRule[];
  /** One rule per row; empty where the brand states none. */
  logoRules: BrandRule[];
  facts: ProjectFact[];
}

export function projectProfile(p: ProjectRow): ProjectProfile {
  return {
    name: p.brand.name ?? "",
    about: p.brand.about ?? "",
    colors: p.brand.colors ?? [],
    colorSections: p.brand.colorSections ?? [],
    gradients: p.brand.gradients ?? [],
    patterns: p.brand.patterns ?? [],
    colorRules: p.brand.colorRules ?? [],
    logoSections: p.brand.logoSections ?? [],
    assetSections: p.brand.assetSections ?? [],
    fonts: p.brand.fonts ?? [],
    textStyles: p.brand.textStyles ?? [],
    typeRules: p.brand.typeRules ?? [],
    logoRules: p.brand.logoRules ?? [],
    facts: p.facts.filter((f) => f.value.trim()),
  };
}

export async function deleteProject(userId: string, projectId: string) {
  await requireWritable(await ownedProject(userId, projectId));
  await requireAdmin();
  const all = await db.query.project.findMany({ where: madeHere() });
  if (all.length <= 1) {
    throw new ServiceError("refused", note("notDeleteLastSpace"));
  }
  await removeProject(projectId);
}

/** Takes a project away with its wizards' links and its files. */
export async function removeProject(projectId: string) {
  const wizards = await db
    .select({ id: schema.wizard.id })
    .from(schema.wizard)
    .where(eq(schema.wizard.projectId, projectId));
  for (const w of wizards) {
    await forgetWizardLinks(w.id);
  }
  await removeProjectFiles(projectId);
  await db
    .delete(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.tenantId, currentTenant())));
  spaceChanged("space.deleted", projectId);
}

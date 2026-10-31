import type { Lang } from "@engenty/wizards-shared/definition";
import { note } from "@engenty/wizards-shared/run";
import {
  type AssetSection,
  type BrandFont,
  type BrandGradient,
  type BrandLink,
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
  NOTIFY_MAIL,
  orderColors,
  PAGE_LANGS,
  PAGE_LIMITS,
  PAGE_SLUG,
  RULE_MARKS,
  SPACE_LIMITS,
  type SpaceFact,
  type SpacePage,
  type TextStyle,
  type VoiceBlock,
} from "@engenty/wizards-shared/spaces";
import { and, count, eq, isNull, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { managed, tenantInfo } from "../manage.js";
import { spaceChanged } from "../plugins/events.js";
import { cloudSpaceLimit, twoWayActive } from "../sync/state.js";
import { putLink } from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";
import { serverText } from "../texts.js";
import { currentRole, mayBuild, requireAdmin, requireBuild, requireWritable } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { forgetWizardLinks } from "./links.js";
import { pushPages } from "./pages.js";
import { removeSpaceFiles } from "./space-files.js";

export type SpaceRow = typeof schema.space.$inferSelect;

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
  .max(SPACE_LIMITS.logoRules);

export const brandFontSchema = z.object({
  id: sectionId,
  family: z.string().max(80),
  role: z.string().max(200),
  weights: z.array(z.number().int().min(100).max(900)).max(FONT_WEIGHTS.length + 3),
  license: z.string().max(200).optional(),
  uses: z.array(z.enum(FONT_USES)).max(FONT_USES.length).optional(),
  source: z
    .union([
      z.object({ file: z.string().max(40) }),
      z.object({
        url: z
          .string()
          .max(600)
          .url()
          .refine((u) => u.startsWith("https://"), "an https:// address"),
      }),
    ])
    .optional(),
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
  assets: z.array(z.string().max(40)).max(SPACE_LIMITS.files.asset),
});

export const logoSectionSchema = z.object({
  id: sectionId,
  title: z.string().max(80),
  description: z.string().max(400),
  logos: z.array(z.string().max(40)).max(SPACE_LIMITS.files.logo),
});

export const voiceBlockSchema = z.object({
  id: sectionId,
  title: z.string().max(80),
  text: z.string().max(SPACE_LIMITS.voiceText),
});

export const brandLinkSchema = z.object({
  id: sectionId,
  label: z.string().max(80),
  url: z.string().max(600),
});

export const spaceFactSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().min(1).max(80),
  value: z.string().max(4000),
  type: z.enum(FACT_TYPES).optional(),
});

const trimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || undefined)
    .optional();

/** The space's public page as the studio sends it, whole. */
export const spacePageSchema = z.object({
  on: z.boolean(),
  slug: z.string().trim().toLowerCase().max(PAGE_LIMITS.slug),
  title: z.string().trim().min(1).max(PAGE_LIMITS.title),
  headline: trimmed(PAGE_LIMITS.headline),
  intro: trimmed(PAGE_LIMITS.intro),
  lang: z.enum(PAGE_LANGS),
  form: z.enum(["du", "sie"]).optional(),
  wizards: z.array(z.string().max(40)).max(60),
  examples: z.record(z.string().max(40), z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)),
  slugs: z.record(z.string().max(40), z.string().regex(PAGE_SLUG)).optional(),
});

export const spacePatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  page: spacePageSchema.optional(),
  brand: z
    .object({
      name: z.string().max(120).optional(),
      about: z.string().max(8000).optional(),
      brandName: z.string().max(120).optional(),
      tagline: z.string().max(200).optional(),
      voice: z.array(voiceBlockSchema).max(SPACE_LIMITS.voiceBlocks).optional(),
      voiceRules: rulesSchema.optional(),
      links: z.array(brandLinkSchema).max(SPACE_LIMITS.links).optional(),
      colors: z.array(brandColorSchema).max(SPACE_LIMITS.colors).optional(),
      colorSections: z.array(colorSectionSchema).max(SPACE_LIMITS.logoSections).optional(),
      gradients: z.array(gradientSchema).max(SPACE_LIMITS.gradients).optional(),
      patterns: z.array(patternSchema).max(SPACE_LIMITS.files.pattern).optional(),
      colorRules: rulesSchema.optional(),
      assetSections: z.array(assetSectionSchema).max(SPACE_LIMITS.logoSections).optional(),
      fonts: z.array(brandFontSchema).max(SPACE_LIMITS.fonts).optional(),
      textStyles: z.array(textStyleSchema).max(SPACE_LIMITS.textStyles).optional(),
      typeRules: rulesSchema.optional(),
      logoSections: z.array(logoSectionSchema).max(SPACE_LIMITS.logoSections).optional(),
      logoRules: rulesSchema.optional(),
    })
    .optional(),
  facts: z.array(spaceFactSchema).max(SPACE_LIMITS.facts).optional(),
  /** The space's own mail domains, where a guest's run may send to (broker/send.ts). Admins only. */
  mailDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/),
    )
    .max(20)
    .optional(),
  /** How the admins hear of the broker's critical lines (docs/plans/broker.md, "Notifications"). */
  notify: z.object({ bell: z.boolean(), mail: z.enum(NOTIFY_MAIL) }).optional(),
  /** „Mitglieder dürfen ins Studio“ (services/members-studio.ts). Admins only, as every change here. */
  membersStudio: z.boolean().optional(),
});

/**
 * How many spaces the tenant works with: the number the Manage-App gives for it, else this
 * runtime's (`LIMIT_SPACES`, one unless set). The studio shows a space switcher only above
 * one. Spaces beyond the number stay in the database and are not listed.
 */
export async function spaceLimit(): Promise<number> {
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
  // A local install that syncs both ways has the organization's spaces: its number counts.
  if (twoWayActive()) {
    const limit = cloudSpaceLimit();
    if (limit === null) {
      return Number.POSITIVE_INFINITY;
    }
    if (limit !== undefined) {
      return Math.max(1, limit);
    }
  }
  return Math.max(1, env.limits.spaces);
}

/** The number for the studio: null where there is no limit (JSON has no infinity). */
export async function spaceLimitOrNull(): Promise<number | null> {
  const limit = await spaceLimit();
  return Number.isFinite(limit) ? limit : null;
}

export async function ownedSpace(userId: string, spaceId: string): Promise<SpaceRow> {
  const p = await db.query.space.findFirst({
    where: and(eq(schema.space.id, spaceId), eq(schema.space.tenantId, currentTenant())),
  });
  if (!p) {
    throw notFound();
  }
  // A client of the organization reaches only the client spaces they are in
  // (docs/plans/client-spaces.md); every other space is not there for them.
  if (currentRole() === "client" && !(p.kind === "client" && (await inSpace(userId, p.id)))) {
    throw notFound();
  }
  return p;
}

/** Whether the person is a member of the space, as a client or as the firm's (`space_member`). */
async function inSpace(userId: string, spaceId: string): Promise<boolean> {
  const row = await db.query.spaceMember.findFirst({
    columns: { id: true },
    where: and(eq(schema.spaceMember.spaceId, spaceId), eq(schema.spaceMember.userId, userId)),
  });
  return Boolean(row);
}

/** The tenant's spaces that were made here, not synced from a local install. */
const madeHere = () => and(eq(schema.space.tenantId, currentTenant()), isNull(schema.space.origin));

/** The tenant's spaces a local install synced. */
const synced = () =>
  and(eq(schema.space.tenantId, currentTenant()), eq(schema.space.origin, "local"));

/** What the first space is called, in the language of whoever first opens the studio. */
const FIRST_SPACE = { cloud: "firstSpaceCloud", local: "firstSpaceLocal" } as const;

/**
 * A tenant that builds here always has a space of its own: the first one is made when its
 * studio is first opened, named in that request's language.
 */
async function ensureSpace(lang: Lang = "en"): Promise<void> {
  const any = await db.query.space.findFirst({ where: madeHere() });
  if (!any) {
    const id = nanoid(12);
    await db.insert(schema.space).values({
      id,
      tenantId: currentTenant(),
      name: serverText(lang, FIRST_SPACE[env.manage.url ? "cloud" : "local"]),
    });
    spaceChanged("space.created", id);
  }
}

/**
 * The space a caller means when it names none: the oldest one made here, where a wizard
 * lands; for a tenant that builds nothing here, the one its local install synced.
 */
export async function defaultSpace(userId: string): Promise<SpaceRow> {
  if (currentRole() === "client") {
    const [first] = await clientSpacesOf(userId);
    if (!first) {
      throw notFound();
    }
    return first;
  }
  const build = await mayBuild();
  if (build) {
    await ensureSpace();
  }
  const p = await db.query.space.findFirst({
    where: and(build ? madeHere() : synced(), eq(schema.space.kind, "space")),
    orderBy: [schema.space.createdAt],
  });
  if (!p) {
    throw notFound();
  }
  return p;
}

/**
 * The spaces the studio shows. A tenant that builds here: its own and the synced ones, up to
 * its number. One that does not: only what its local install synced — possibly nothing yet.
 */
export async function listSpaces(userId: string, lang?: Lang) {
  // A client sees the client spaces they are in, nothing else (docs/plans/client-spaces.md).
  if (currentRole() === "client") {
    return clientSpacesOf(userId);
  }
  const build = await mayBuild();
  if (build) {
    await ensureSpace(lang);
  }
  // The oldest come first: with a limit of one, that is the space everything lands in. Client
  // spaces stay out: they are a part of their space, never a space of the menu.
  const limit = await spaceLimit();
  const spaces = await db.query.space.findMany({
    where: and(
      build ? eq(schema.space.tenantId, currentTenant()) : synced(),
      eq(schema.space.kind, "space"),
    ),
    orderBy: [schema.space.createdAt],
    ...(Number.isFinite(limit) ? { limit } : {}),
  });
  const counts = await db
    .select({ spaceId: schema.wizard.spaceId, n: count() })
    .from(schema.wizard)
    .where(eq(schema.wizard.tenantId, currentTenant()))
    .groupBy(schema.wizard.spaceId);
  return spaces.map((p) => ({
    ...p,
    wizardCount: counts.find((x) => x.spaceId === p.id)?.n ?? 0,
  }));
}

/** The client spaces a client is in, as the space list shows them. */
async function clientSpacesOf(userId: string) {
  const rows = await db
    .select({ space: schema.space })
    .from(schema.spaceMember)
    .innerJoin(schema.space, eq(schema.space.id, schema.spaceMember.spaceId))
    .where(
      and(
        eq(schema.spaceMember.userId, userId),
        eq(schema.space.tenantId, currentTenant()),
        eq(schema.space.kind, "client"),
      ),
    );
  return rows.map((r) => ({ ...r.space, wizardCount: 0 }));
}

export async function createSpace(_userId: string, name: string): Promise<{ id: string }> {
  await requireBuild();
  await requireAdmin();
  // Client spaces do not count as spaces of the plan.
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.space)
    .where(and(eq(schema.space.tenantId, currentTenant()), eq(schema.space.kind, "space")));
  const limit = await spaceLimit();
  if (n >= limit) {
    throw new ServiceError(
      "refused",
      limit === 1 ? note("onlyOneSpaceAllowed") : note("mostSpaces", { count: limit }),
    );
  }
  const id = nanoid(12);
  await db.insert(schema.space).values({ id, tenantId: currentTenant(), name, brand: {} });
  spaceChanged("space.created", id);
  return { id };
}

export async function updateSpace(
  userId: string,
  spaceId: string,
  patch: z.infer<typeof spacePatchSchema>,
) {
  const p = await ownedSpace(userId, spaceId);
  await requireWritable(p);
  await requireAdmin();
  if (patch.facts && new Set(patch.facts.map((f) => f.key)).size !== patch.facts.length) {
    throw new ServiceError("invalid", note("twoEntriesSameKey"));
  }
  if (patch.brand?.fonts) {
    await linkFontFiles(p.id, patch.brand.fonts);
  }
  const page = patch.page ? await checkedPage(p, patch.page) : undefined;
  await db
    .update(schema.space)
    .set({
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.brand ? { brand: brandAfter(p.brand, patch.brand) } : {}),
      ...(patch.facts ? { facts: patch.facts } : {}),
      ...(patch.mailDomains ? { mailDomains: [...new Set(patch.mailDomains)] } : {}),
      ...(patch.notify ? { notify: patch.notify } : {}),
      ...(page ? { page } : {}),
      ...(patch.membersStudio !== undefined ? { membersStudio: patch.membersStudio } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.space.id, p.id));
  spaceChanged("space.updated", p.id);
  // The page itself, and what it is drawn from: the brand, the facts as the imprint.
  if (page || patch.brand || patch.facts) {
    pushPages();
  }
}

/**
 * The page as it is kept: its address made of the allowed characters and taken by no other space
 * of the tenant, only this tenant's wizards of this space on it, and the page on in one space at
 * most (`409 page_taken`, naming that space). The form is German's alone.
 */
async function checkedPage(p: SpaceRow, page: SpacePage): Promise<SpacePage> {
  if (!PAGE_SLUG.test(page.slug)) {
    throw new ServiceError("invalid", note("pageSlugInvalid"));
  }
  const others = await db.query.space.findMany({
    where: and(eq(schema.space.tenantId, currentTenant()), ne(schema.space.id, p.id)),
    columns: { id: true, name: true, page: true },
  });
  if (others.some((o) => o.page?.slug === page.slug)) {
    throw new ServiceError("invalid", note("pageSlugTaken"));
  }
  const holder = page.on ? others.find((o) => o.page?.on) : undefined;
  if (holder) {
    throw new ServiceError("page_taken", note("pageTaken", { space: holder.name }), {
      space: { id: holder.id, name: holder.name },
    });
  }
  const own = new Set(
    (
      await db.query.wizard.findMany({
        where: eq(schema.wizard.spaceId, p.id),
        columns: { id: true },
      })
    ).map((w) => w.id),
  );
  const wizards = [...new Set(page.wizards)].filter((id) => own.has(id));
  const examples = Object.fromEntries(Object.entries(page.examples).filter(([id]) => own.has(id)));
  // The wizards' addresses are kept as made (pages.ts); a wizard that is gone frees its address.
  const slugs = Object.fromEntries(
    Object.entries({ ...p.page?.slugs, ...page.slugs }).filter(([id]) => own.has(id)),
  );
  return {
    on: page.on,
    slug: page.slug,
    title: page.title,
    ...(page.headline ? { headline: page.headline } : {}),
    ...(page.intro ? { intro: page.intro } : {}),
    lang: page.lang,
    ...(page.lang === "de" && page.form ? { form: page.form } : {}),
    wizards,
    examples,
    ...(Object.keys(slugs).length ? { slugs } : {}),
  };
}

/**
 * A brand font's own file is a font of the space; run pages ask for it by its id, before the
 * tenant is known, so the control database learns it.
 */
async function linkFontFiles(spaceId: string, fonts: BrandFont[]) {
  for (const f of fonts) {
    if (!(f.source && "file" in f.source)) {
      continue;
    }
    const file = await db.query.spaceFile.findFirst({
      where: and(eq(schema.spaceFile.id, f.source.file), eq(schema.spaceFile.spaceId, spaceId)),
    });
    if (!file?.mime.startsWith("font/")) {
      throw new ServiceError("invalid", note("fontSourceNoFont", { family: f.family }));
    }
    await putLink(file.id, "font", file.id);
  }
}

/** An address as typed, with https:// where it has no scheme; empty where it is not one. */
function webAddress(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const url = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? url : "";
  } catch {
    return "";
  }
}

/**
 * The brand with the patch on it. Sections and rules are optional: a section without title and
 * logos and rules without words are not kept.
 */
function brandAfter(
  brand: SpaceRow["brand"],
  patch: NonNullable<z.infer<typeof spacePatchSchema>["brand"]>,
): SpaceRow["brand"] {
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
    voice,
    voiceRules,
    links,
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
  // A block without words and a link without an address are not kept.
  const blocks = (voice ?? [])
    .map((b) => ({ ...b, title: b.title.trim(), text: b.text.trim() }))
    .filter((b) => b.text);
  const voiceRows = rows(voiceRules);
  const places = (links ?? [])
    .map((l) => ({ ...l, label: l.label.trim(), url: webAddress(l.url) }))
    .filter((l) => l.url);
  return {
    ...rest,
    ...(blocks.length ? { voice: blocks } : {}),
    ...(voiceRows.length ? { voiceRules: voiceRows } : {}),
    ...(places.length ? { links: places } : {}),
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

/** What a step knows of the space it runs in: who it is, its colours, logo use and facts. */
export interface SpaceProfile {
  name: string;
  about: string;
  /** Empty where the brand is written as the title. */
  brandName: string;
  tagline: string;
  /** Empty where the brand states none. */
  voice: VoiceBlock[];
  voiceRules: BrandRule[];
  links: BrandLink[];
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
  facts: SpaceFact[];
}

export function spaceProfile(p: SpaceRow): SpaceProfile {
  return {
    name: p.brand.name ?? "",
    about: p.brand.about ?? "",
    brandName: p.brand.brandName ?? "",
    tagline: p.brand.tagline ?? "",
    voice: p.brand.voice ?? [],
    voiceRules: p.brand.voiceRules ?? [],
    links: p.brand.links ?? [],
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

export async function deleteSpace(userId: string, spaceId: string) {
  await requireWritable(await ownedSpace(userId, spaceId));
  await requireAdmin();
  const all = await db.query.space.findMany({
    where: and(madeHere(), eq(schema.space.kind, "space")),
  });
  if (all.length <= 1) {
    throw new ServiceError("refused", note("notDeleteLastSpace"));
  }
  await removeSpace(spaceId);
}

/** Takes a space away with its wizards' links and its files, and its client spaces first. */
export async function removeSpace(spaceId: string) {
  const clients = await db
    .select({ id: schema.space.id })
    .from(schema.space)
    .where(and(eq(schema.space.parentId, spaceId), eq(schema.space.tenantId, currentTenant())));
  for (const c of clients) {
    await removeSpace(c.id);
  }
  const wizards = await db
    .select({ id: schema.wizard.id })
    .from(schema.wizard)
    .where(eq(schema.wizard.spaceId, spaceId));
  for (const w of wizards) {
    await forgetWizardLinks(w.id);
  }
  await removeSpaceFiles(spaceId);
  await db
    .delete(schema.space)
    .where(and(eq(schema.space.id, spaceId), eq(schema.space.tenantId, currentTenant())));
  spaceChanged("space.deleted", spaceId);
  pushPages();
}

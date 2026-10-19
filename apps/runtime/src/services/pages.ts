import {
  langOf,
  type Step,
  type WizardDefinition,
  wizardLang,
} from "@engenty/wizards-shared/definition";
import { effortOf } from "@engenty/wizards-shared/marketplace";
import { type EntryResult, resultsOf } from "@engenty/wizards-shared/marketplace-entry";
import {
  factType,
  type PageForm,
  type PageLang,
  type ProjectFact,
  pageSlugOf,
  runTheme,
} from "@engenty/wizards-shared/projects";
import type { RunTheme } from "@engenty/wizards-shared/run";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { managed, putPages, tenantInfo } from "../manage.js";
import { currentTenant } from "../tenants/tenant.js";
import { mainLogoId } from "./brand.js";

/**
 * The team's public page at `<team>.wizards.page` (docs/plans/wizards-page-launch.md in the
 * Manage repository): what Manage draws it from, made here from the space that has its page on
 * and the published definitions of the wizards it lists, and sent whole with the service key
 * (`PUT /v1/pages/:tenantId`, docs/manage-contract.md) after a publish and after every change
 * of the page. Manage keeps it; it never reads a tenant's database. Nothing of the page sits on
 * a wizard: the teaser is the published definition read as a visitor would.
 */

export interface PageWizard {
  slug: string;
  title: string;
  description: string;
  avatar: string;
  lang: PageLang;
  results: EntryResult[];
  effort: { fields: number; reviews: number; minutes: number; uploads: boolean };
  /** The way through, as a short list: who does what, about five rows. */
  steps: { title: string; by: "you" | "ai" }[];
  /** The run page, `/w/<token>`. */
  runUrl: string;
  /** A run the owner shared as the example, `/s/<token>`. */
  exampleUrl?: string;
}

export interface PageSpace {
  slug: string;
  title: string;
  headline?: string;
  intro?: string;
  lang: PageLang;
  form?: PageForm;
  brand: { name: string; logoUrl: string | null; theme: RunTheme };
  imprint: { name: string; lines: string[]; website?: string } | null;
  wizards: PageWizard[];
}

export interface PageTeam {
  slug: string;
  name: string;
  lang: PageLang;
  /** Null: the team has no page; its address shows Manage's "nothing here" page. */
  space: PageSpace | null;
}

/** About how many rows the teaser's step list has. */
const STEP_ROWS = 5;
/** Fields whose answer is a file the person brings. */
const UPLOAD_KINDS = new Set(["file", "image", "audio"]);
/** Facts that name who stands behind the page, by key. */
const NAME_KEYS = ["name", "firma", "unternehmen", "company", "firmenname", "kanzlei"];

/** A wizard's language where the page knows it, else the page's. */
function pageLangOf(def: WizardDefinition, fallback: PageLang): PageLang {
  const lang = langOf(wizardLang(def));
  return lang === "de" || lang === "en" ? lang : fallback;
}

/** Who acts in a step: the person on a page, in a review or a surface; the AI everywhere else. */
const by = (step: Step): "you" | "ai" =>
  step.type === "page" || step.type === "review" || step.type === "surface" ? "you" : "ai";

/** "A und B", "A, B und C". */
function joinTitles(titles: string[], lang: PageLang): string {
  if (titles.length <= 1) {
    return titles[0] ?? "";
  }
  const and = lang === "de" ? " und " : " and ";
  return `${titles.slice(0, -1).join(", ")}${and}${titles.at(-1)}`;
}

/**
 * The way through as the teaser shows it: the steps along the path a run takes when no
 * condition applies (a branch's "otherwise", else the next step), each page, review and result
 * step as written, the AI steps between them merged into one row, and about five rows in all.
 * An `each` step is one step and so one row.
 */
export function pageSteps(def: WizardDefinition, lang: PageLang): PageWizard["steps"] {
  const path: Step[] = [];
  const seen = new Set<string>();
  let at = 0;
  while (at >= 0 && at < def.steps.length && !seen.has(def.steps[at].id)) {
    const step = def.steps[at];
    seen.add(step.id);
    path.push(step);
    const otherwise = step.next?.find((r) => r.when === undefined && r.ask === undefined);
    if (!otherwise) {
      at += 1;
    } else if (otherwise.goto === "end") {
      break;
    } else {
      at = def.steps.findIndex((s) => s.id === otherwise.goto);
    }
  }
  const rows: { titles: string[]; by: "you" | "ai"; merge: boolean }[] = [];
  for (const step of path) {
    const who = by(step);
    const merge = who === "ai" && step.type !== "result";
    const last = rows.at(-1);
    if (merge && last?.merge) {
      last.titles.push(step.title);
    } else {
      rows.push({ titles: [step.title], by: who, merge });
    }
  }
  const kept = rows.length > STEP_ROWS ? [...rows.slice(0, STEP_ROWS - 1), rows.at(-1)!] : rows;
  return kept.map((r) => ({ title: joinTitles(r.titles, lang).slice(0, 80), by: r.by }));
}

/**
 * The space's facts as the imprint: who stands behind the page, one line per fact, the postcode
 * and the town as one line after the address, the website apart; null without filled facts.
 */
export function imprintOf(facts: ProjectFact[], fallbackName: string): PageSpace["imprint"] {
  const filled = facts.filter((f) => f.value.trim());
  if (!filled.length) {
    return null;
  }
  const named = filled.find((f) => NAME_KEYS.includes(f.key));
  const website = filled.find((f) => f.key === "website" || factType(f) === "url");
  const town = ["plz", "ort"]
    .map((key) => filled.find((f) => f.key === key)?.value.trim())
    .filter(Boolean)
    .join(" ");
  const apart = new Set(["plz", "ort", named?.key, website?.key]);
  const lines: string[] = [];
  for (const f of filled) {
    const type = factType(f);
    if (apart.has(f.key) || type === "longtext" || type === "boolean") {
      continue;
    }
    lines.push(f.value.trim());
    if (f.key === "adresse" && town) {
      lines.push(town);
    }
  }
  if (town && !lines.includes(town)) {
    lines.push(town);
  }
  const site = website?.value.trim();
  return {
    name: (named?.value.trim() || fallbackName).slice(0, 200),
    lines: lines.map((l) => l.slice(0, 200)).slice(0, 8),
    ...(site ? { website: /^https?:\/\//i.test(site) ? site : `https://${site}` } : {}),
  };
}

/** A wizard's address on the page, from its title, unique among the page's wizards. */
function wizardSlug(title: string, taken: Set<string>): string {
  const base = pageSlugOf(title) || "wizard";
  let slug = base;
  for (let n = 2; taken.has(slug); n++) {
    slug = `${base.slice(0, 44)}-${n}`;
  }
  taken.add(slug);
  return slug;
}

/** The team's page data as Manage expects it; null where this runtime is not a team's. */
export async function pageTeam(): Promise<PageTeam | null> {
  if (!managed) {
    return null;
  }
  const tenantId = currentTenant();
  const team = await tenantInfo(tenantId);
  // Only one space of a team has its page on (services/projects.ts).
  const spaces = await db.query.project.findMany({
    where: eq(schema.project.tenantId, tenantId),
  });
  const space = spaces.find((p) => p.page?.on) ?? null;
  const page = space?.page;
  const lang: PageLang = page?.lang ?? "de";
  const base = { slug: team.slug ?? tenantId, name: team.name, lang };
  if (!(space && page)) {
    return { ...base, space: null };
  }
  const listed = page.wizards.length
    ? await db.query.wizard.findMany({
        where: and(
          eq(schema.wizard.projectId, space.id),
          inArray(schema.wizard.id, page.wizards),
          eq(schema.wizard.shareEnabled, true),
        ),
      })
    : [];
  const taken = new Set<string>();
  const wizards: PageWizard[] = [];
  for (const id of page.wizards) {
    const w = listed.find((x) => x.id === id);
    if (!w || w.publishedVersion === null) {
      continue;
    }
    const version = await db.query.wizardVersion.findFirst({
      where: and(
        eq(schema.wizardVersion.wizardId, w.id),
        eq(schema.wizardVersion.version, w.publishedVersion),
      ),
      columns: { definition: true },
    });
    if (!version) {
      continue;
    }
    const def = version.definition;
    const wizardLanguage = pageLangOf(def, lang);
    const effort = effortOf(def);
    const uploads = def.steps.some(
      (s) => s.type === "page" && s.fields.some((f) => UPLOAD_KINDS.has(f.kind)),
    );
    const exampleToken = page.examples[w.id];
    const example = exampleToken
      ? await db.query.run.findFirst({
          where: and(eq(schema.run.wizardId, w.id), eq(schema.run.shareToken, exampleToken)),
          columns: { status: true, expiresAt: true },
        })
      : null;
    const shown =
      example?.status === "done" && !(example.expiresAt && example.expiresAt < new Date());
    wizards.push({
      slug: wizardSlug(def.title, taken),
      title: def.title.slice(0, 120),
      description: def.description.slice(0, 600),
      avatar: def.avatar,
      lang: wizardLanguage,
      results: resultsOf(def).slice(0, 12),
      effort: { fields: effort.fields, reviews: effort.reviews, minutes: effort.minutes, uploads },
      steps: pageSteps(def, wizardLanguage),
      runUrl: `${env.publicUrl}/w/${w.shareToken}`,
      ...(shown ? { exampleUrl: `${env.publicUrl}/s/${exampleToken}` } : {}),
    });
  }
  if (!wizards.length) {
    return { ...base, space: null };
  }
  const logo = await mainLogoId(space.id);
  return {
    ...base,
    space: {
      slug: page.slug,
      title: page.title,
      ...(page.headline ? { headline: page.headline } : {}),
      ...(page.intro ? { intro: page.intro } : {}),
      lang,
      ...(lang === "de" && page.form ? { form: page.form } : {}),
      brand: {
        name: (space.brand.name ?? "").slice(0, 120),
        logoUrl: logo ? `${env.publicUrl}/api/public/logos/${logo}` : null,
        theme: runTheme(space.brand),
      },
      imprint: imprintOf(space.facts, space.brand.name || space.name),
      wizards,
    },
  };
}

/**
 * Where the team's page is opened: `https://<host>`; on a `.localhost` domain in development
 * `http://<host>:<Manage's port>`, as Manage serves it there.
 */
export function pageOrigin(host: string): string {
  if (host.endsWith(".localhost")) {
    const port = URL.canParse(env.manage.url) ? new URL(env.manage.url).port : "";
    return `http://${host}${port ? `:${port}` : ""}`;
  }
  return `https://${host}`;
}

/** What the studio's "Public page" part shows beside its fields: the team's address and page data. */
export async function pagePreview(): Promise<{
  host: string | null;
  origin: string | null;
  team: PageTeam | null;
}> {
  if (!managed) {
    return { host: null, origin: null, team: null };
  }
  const host = (await tenantInfo(currentTenant())).pagesHost ?? null;
  return { host, origin: host ? pageOrigin(host) : null, team: await pageTeam() };
}

let last: Promise<void> = Promise.resolve();

/**
 * Sends the team's page data to Manage, whole; a space switched off or with no listed wizard
 * published and shared is sent as none. Not waited for by the change that caused it: a failure
 * is logged, and the next change sends everything again. `pagesSettled` waits for the last send.
 */
export function pushPages(): void {
  if (!managed) {
    return;
  }
  const send = async () => {
    const data = await pageTeam();
    if (data) {
      await putPages(currentTenant(), data);
    }
  };
  last = last.then(send, send).catch((err) => {
    console.error("[pages] the page was not sent:", (err as Error).message);
  });
}

/** Resolves once every push so far has been answered or has failed. */
export function pagesSettled(): Promise<void> {
  return last;
}

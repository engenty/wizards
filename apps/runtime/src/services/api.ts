import {
  type Field,
  type Lang,
  textLang,
  type WizardDefinition,
  wizardLang,
} from "@engenty-wizards/shared/definition";
import { standaloneEntry } from "@engenty-wizards/shared/fit";
import { pluginsOf } from "@engenty-wizards/shared/marketplace";
import { noteText } from "@engenty-wizards/shared/run";
import { and, count, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { MICROS_PER_CREDIT } from "../credits/credits.js";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { wizardUnavailable } from "../limits.js";
import { codeOf } from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";
import { serverText } from "../texts.js";
import { mayBuild, projectWritable, READ_ONLY_TENANT } from "./access.js";
import { mainLogoId } from "./brand.js";
import { notFound, ServiceError } from "./errors.js";
import { knowledgeCounts } from "./knowledge.js";
import { listProjects, ownedProject } from "./projects.js";
import { runReport } from "./runs.js";
import { shareUrlFor } from "./shares.js";
import { shareUrl, studioUrl } from "./wizards.js";

/*
 * What `/api/v1` shows a client that is no studio: the WordPress plugin lists the wizards it
 * embeds, the results its visitors left and the space's own details.
 */

type RunRow = typeof schema.run.$inferSelect;

/** The spaces the caller works with, as the studio lists them, and whether each may change here. */
export async function apiSpaces(userId: string) {
  const projects = await listProjects(userId);
  return Promise.all(
    projects.map(async (p) => ({
      id: p.id,
      name: p.name,
      title: p.brand.name ?? "",
      wizards: p.wizardCount,
      writable: await projectWritable(p),
    })),
  );
}

/** The space a call names, or the one a caller means when it names none: the first one listed. */
export async function apiSpace(userId: string, spaceId?: string | null) {
  if (spaceId) {
    return ownedProject(userId, spaceId);
  }
  const [first] = await listProjects(userId);
  if (!first) {
    // A plan that builds nothing here has a space only once its local install synced one.
    if (!(await mayBuild())) {
      throw new ServiceError("read_only", READ_ONLY_TENANT);
    }
    throw notFound();
  }
  return first;
}

/** The space's own details: what it says about itself, and what its wizards look things up in. */
export async function apiSpaceDetails(userId: string, spaceId?: string | null) {
  const p = await apiSpace(userId, spaceId);
  const logo = await mainLogoId(p.id);
  return {
    id: p.id,
    name: p.name,
    title: p.brand.name ?? "",
    about: p.brand.about ?? "",
    colors: p.brand.colors ?? [],
    facts: p.facts.map(({ label, value }) => ({ label, value })),
    logoUrl: logo ? `${env.publicUrl}/api/public/logos/${logo}` : null,
    knowledge: await knowledgeCounts(p.id),
    writable: await projectWritable(p),
    studioUrl: `${env.appUrl}/studio/space`,
  };
}

/**
 * The wizards of the caller's spaces, newest change first. A published one carries what a website
 * embeds it with: its link's token and the ID the mobile app takes.
 */
export async function apiWizards(userId: string, spaceId?: string | null) {
  const spaces = (await listProjects(userId)).filter((p) => !spaceId || p.id === spaceId);
  if (!spaces.length) {
    return [];
  }
  const rows = await db.query.wizard.findMany({
    where: and(
      eq(schema.wizard.tenantId, currentTenant()),
      inArray(
        schema.wizard.projectId,
        spaces.map((p) => p.id),
      ),
    ),
    orderBy: [desc(schema.wizard.updatedAt)],
  });
  const published = rows.filter((w) => w.publishedVersion !== null);
  const versions = published.length
    ? await db.query.wizardVersion.findMany({
        where: or(
          ...published.map((w) =>
            and(
              eq(schema.wizardVersion.wizardId, w.id),
              eq(schema.wizardVersion.version, w.publishedVersion as number),
            ),
          ),
        ),
        columns: { wizardId: true, definition: true },
      })
    : [];
  return Promise.all(
    rows.map(async (w) => {
      const live = versions.find((v) => v.wizardId === w.id)?.definition;
      const def: WizardDefinition = live ?? w.draft;
      const reason = live ? await wizardUnavailable(w) : null;
      return {
        id: w.id,
        spaceId: w.projectId,
        title: def.title,
        description: def.description ?? "",
        avatar: def.avatar ?? null,
        published: Boolean(live),
        publishedVersion: w.publishedVersion,
        token: live ? w.shareToken : null,
        code: live ? await codeOf(w.shareToken) : null,
        shareUrl: live ? shareUrl(w.shareToken) : null,
        shareEnabled: w.shareEnabled,
        iconUrl: live
          ? `${env.publicUrl}/api/public/wizards/${w.shareToken}/icons/icon-192.png`
          : null,
        available: Boolean(live) && !reason,
        unavailableReason: reason && noteText(reason, wizardLang(def)),
        dailyRunLimit: w.dailyRunLimit,
        /** The plugins its steps call: a wizard that books needs `appointments`. */
        plugins: pluginsOf(def),
        /** Whether it runs on a website by itself, in the gallery's words (packages/shared/src/fit.ts). */
        standalone: standaloneEntry(def),
        studioUrl: studioUrl(w.id),
        updatedAt: w.updatedAt.toISOString(),
      };
    }),
  );
}

/** A value as one line of text, in the wizard's language: what the person typed or picked. */
function answerText(field: Field, value: unknown, lang: Lang): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value === "boolean") {
    return serverText(lang, value ? "yes" : "no");
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (["file", "image", "audio", "signature"].includes(field.kind)) {
      return serverText(lang, "fileCount", { count: value.length });
    }
    return value
      .map((v) => (typeof v === "object" && v ? Object.values(v).join(" ") : String(v)))
      .join(", ");
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    const said = v.label ?? v.address ?? v.text ?? v.name ?? v.start;
    return typeof said === "string" ? said : JSON.stringify(value).slice(0, 200);
  }
  return "";
}

/** What the person answered on the run's pages, by the fields' labels, in the order asked. */
function answersOf(run: Pick<RunRow, "definition" | "state">) {
  const answers: { field: string; label: string; kind: string; value: string }[] = [];
  const lang = textLang(wizardLang(run.definition));
  for (const step of run.definition.steps) {
    if (step.type !== "page") {
      continue;
    }
    for (const field of step.fields) {
      const value = answerText(field, run.state.values[field.id], lang);
      if (value) {
        answers.push({ field: field.id, label: field.label, kind: field.kind, value });
      }
    }
  }
  return answers;
}

/** The person's address where a page asked for one: the first e-mail field answered. */
function emailOf(answers: ReturnType<typeof answersOf>): string | null {
  return (
    answers.find((a) => a.kind === "email")?.value ??
    answers.find((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.value))?.value ??
    null
  );
}

export interface ApiRunsFilter {
  spaceId?: string | null;
  wizardId?: string | null;
  /** `done` (the default): the results; `open`: started and not finished; `all`. */
  status?: "done" | "open" | "all";
  q?: string | null;
  days?: number | null;
  page?: number;
}

const PAGE = 50;

/** The live runs of the caller's wizards, newest first, by pages of 50: what visitors left. */
export async function apiRuns(userId: string, filter: ApiRunsFilter = {}) {
  const wizards = await apiWizards(userId, filter.spaceId);
  const ids = wizards.map((w) => w.id).filter((id) => !filter.wizardId || id === filter.wizardId);
  const page = Math.max(1, filter.page ?? 1);
  if (!ids.length) {
    return { runs: [], page, pages: 0, total: 0 };
  }
  const q = filter.q?.trim().toLowerCase();
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const status = filter.status ?? "done";
  const where = and(
    inArray(schema.run.wizardId, ids),
    eq(schema.run.mode, "live"),
    status === "done"
      ? eq(schema.run.status, "done")
      : status === "open"
        ? inArray(schema.run.status, ["waiting_input", "running"])
        : undefined,
    filter.days
      ? gte(schema.run.createdAt, new Date(Date.now() - filter.days * 86_400_000))
      : undefined,
    like
      ? or(
          sql`lower(${schema.run.state}) like ${like} escape '\\'`,
          sql`lower(coalesce(${schema.run.origin}, '')) like ${like} escape '\\'`,
        )
      : undefined,
  );
  const [{ total }] = await db.select({ total: count() }).from(schema.run).where(where);
  const rows = await db.query.run.findMany({
    where,
    orderBy: [desc(schema.run.createdAt)],
    limit: PAGE,
    offset: (page - 1) * PAGE,
  });
  const assets = rows.length
    ? await db
        .select({ runId: schema.asset.runId, n: count() })
        .from(schema.asset)
        .where(
          and(
            isNotNull(schema.asset.runId),
            inArray(
              schema.asset.runId,
              rows.map((r) => r.id),
            ),
          ),
        )
        .groupBy(schema.asset.runId)
    : [];
  return {
    runs: rows.map((r) => {
      const answers = answersOf(r);
      return {
        id: r.id,
        wizardId: r.wizardId,
        wizard: wizards.find((w) => w.id === r.wizardId)?.title ?? r.definition.title,
        status: r.status,
        step: r.definition.steps.find((s) => s.id === r.cursor)?.title ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        origin: r.origin,
        email: emailOf(answers),
        /** The first answers, for a line in a list. */
        summary: answers
          .slice(0, 3)
          .map((a) => a.value)
          .join(" · ")
          .slice(0, 200),
        credits: Math.ceil(r.costMicros / MICROS_PER_CREDIT),
        files: assets.find((a) => a.runId === r.id)?.n ?? 0,
      };
    }),
    page,
    pages: Math.ceil(total / PAGE),
    total,
  };
}

/** One run with everything a reader of the result needs: the answers, the outputs, the downloads. */
export async function apiRun(userId: string, runId: string) {
  // Refuses what is no live run of the tenant.
  const report = await runReport(userId, runId, 0, "live");
  const run = await db.query.run.findFirst({
    where: and(eq(schema.run.id, runId), eq(schema.run.tenantId, currentTenant())),
  });
  if (!run) {
    throw notFound();
  }
  const answers = answersOf(run);
  return {
    ...report,
    wizard: run.definition.title,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    origin: run.origin,
    email: emailOf(answers),
    answers: answers.map(({ label, kind, value }) => ({ label, kind, value })),
    shareUrl: run.shareToken ? shareUrlFor(run.shareToken) : null,
  };
}

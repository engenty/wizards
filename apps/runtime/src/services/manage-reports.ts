import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { capabilitiesOf, effortOf } from "@engenty/wizards-shared/marketplace";
import { resultsOf } from "@engenty/wizards-shared/marketplace-entry";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema, withTenant } from "../db/client.js";
import { env } from "../env.js";
import { managed, postRunReport, putWizards } from "../manage.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * What the Manage-App's admin app learns of a team (docs/plans/wizards-admin.md in the Manage
 * repository): its wizards, whole, after every change that shows there, and each run's turns.
 * Manage never reads a tenant's database. Only a managed runtime reports.
 */

let last: Promise<void> = Promise.resolve();

/** The team's wizards as the admin app lists them: the published version where there is one. */
export async function wizardsReport() {
  const tenantId = currentTenant();
  const [wizards, projects] = await Promise.all([
    db.select().from(schema.wizard).where(eq(schema.wizard.tenantId, tenantId)),
    db
      .select({ id: schema.project.id, name: schema.project.name })
      .from(schema.project)
      .where(eq(schema.project.tenantId, tenantId)),
  ]);
  const published = wizards.filter((w) => w.publishedVersion !== null);
  const versions = published.length
    ? await db
        .select({
          wizardId: schema.wizardVersion.wizardId,
          version: schema.wizardVersion.version,
          definition: schema.wizardVersion.definition,
          createdAt: schema.wizardVersion.createdAt,
        })
        .from(schema.wizardVersion)
        .where(
          inArray(
            schema.wizardVersion.wizardId,
            published.map((w) => w.id),
          ),
        )
    : [];
  const spaces = new Map(projects.map((p) => [p.id, p.name]));
  return {
    wizards: wizards.map((w) => {
      const live = versions.find((v) => v.wizardId === w.id && v.version === w.publishedVersion);
      const def: WizardDefinition = live?.definition ?? w.draft;
      return {
        id: w.id,
        title: (def.title || w.title).slice(0, 160),
        description: (def.description ?? "").slice(0, 1000),
        avatar: def.avatar ?? "round",
        lang: (def.lang ?? "de").slice(0, 5),
        space: spaces.has(w.projectId) ? { id: w.projectId, name: spaces.get(w.projectId)! } : null,
        published: Boolean(live),
        publishedAt: live?.createdAt.toISOString() ?? null,
        template: w.starter ? { id: w.starter, revision: w.starterRevision ?? null } : null,
        runUrl: live && w.shareEnabled ? `${env.publicUrl}/w/${w.shareToken}` : null,
        effort: effortOf(def),
        results: [...new Set(resultsOf(def).map((r) => r.kind))],
        capabilities: capabilitiesOf(def),
        steps: def.steps.length,
        changedAt: w.updatedAt.toISOString(),
      };
    }),
  };
}

/** Sends the team's wizards; one send after the other, a failure is only written down. */
export function pushWizards(): void {
  if (!managed) {
    return;
  }
  const tenantId = currentTenant();
  const send = async () => {
    await putWizards(tenantId, await withTenant(tenantId, () => wizardsReport()));
  };
  last = last.then(send, send).catch((err) => {
    console.error("[reports] the wizards were not sent:", (err as Error).message);
  });
}

export function wizardsSettled(): Promise<void> {
  return last;
}

// --- runs ----------------------------------------------------------------------------------

type RunStatus = "waiting_input" | "running" | "done" | "failed" | "cancelled";

const STATE: Record<RunStatus, string> = {
  waiting_input: "waiting",
  running: "running",
  done: "finished",
  failed: "failed",
  cancelled: "cancelled",
};

/** A run at work says so again after this long, so the admin app can tell it from a stuck one. */
const AGAIN_MS = 2 * 60_000;
const said = new Map<string, { state: string; at: number }>();

/** Where the run came from, as the admin app sorts it. */
function viaOf(run: {
  mode: string;
  client: string | null;
  origin: string | null;
  userId: string | null;
}): string {
  if (run.mode === "test") {
    return "test";
  }
  if (run.client) {
    return "api";
  }
  if (run.origin) {
    return "page";
  }
  return run.userId ? "studio" : "link";
}

/**
 * Tells the admin app of a run's turn: a new state at once, the same state again only after a
 * while (a long step at work is not stuck). Runs in the current tenant's context.
 */
export function reportRun(runId: string, status: RunStatus): void {
  if (!managed) {
    return;
  }
  const state = STATE[status];
  const before = said.get(runId);
  if (before && before.state === state && Date.now() - before.at < AGAIN_MS) {
    return;
  }
  said.set(runId, { state, at: Date.now() });
  if (state === "finished" || state === "failed" || state === "cancelled") {
    // A run that ended says nothing more; the map forgets it.
    setTimeout(() => said.delete(runId), AGAIN_MS).unref?.();
  }
  const tenantId = currentTenant();
  void (async () => {
    const run = await db.query.run.findFirst({
      where: and(eq(schema.run.id, runId), eq(schema.run.tenantId, tenantId)),
      columns: {
        wizardId: true,
        mode: true,
        client: true,
        origin: true,
        userId: true,
        cursor: true,
        error: true,
        definition: true,
        createdAt: true,
      },
    });
    if (!run) {
      return;
    }
    const step =
      state === "failed" && run.cursor
        ? run.definition.steps.find((s) => s.id === run.cursor)
        : undefined;
    await postRunReport(tenantId, {
      runId,
      wizardId: run.wizardId,
      via: viaOf(run),
      state,
      startedAt: run.createdAt.toISOString(),
      at: new Date().toISOString(),
      ...(step
        ? { step: { id: step.id, title: (step.title ?? step.id).slice(0, 160), kind: step.type } }
        : {}),
      ...(state === "failed" && run.error ? { error: run.error.slice(0, 2000) } : {}),
    });
  })().catch((err) => {
    console.warn(`[reports] run ${runId}:`, (err as Error).message);
  });
}

import { arch, hostname, platform } from "node:os";
import { desc, eq } from "drizzle-orm";
import { accountToken, linkedAccount } from "./auth/account.js";
import { packageVersion } from "./cli/home.js";
import { db, knownTenants, schema, withTenant } from "./db/client.js";
import { env } from "./env.js";
import { type LogLine, logState, startedAt, type TailQuery, tail } from "./log.js";
import { managed } from "./manage.js";
import { modelSettings } from "./models.js";
import { loadedPlugins } from "./plugins/registry.js";
import { sandboxEngine } from "./sandbox/index.js";
import { runIndexOf, tenantOfRun } from "./tenants/control.js";
import { LOCAL_TENANT } from "./tenants/tenant.js";

/**
 * What an installation tells about itself when someone looks at it from afar
 * (docs/plans/remote-debug.md): its status, the lines it printed, one run, a tenant's models.
 * Nothing here holds a key or a person's answers; the log ring took the secrets out already.
 * The Manage-App asks a runtime of its own over `/api/internal/debug/*`; a runtime that runs
 * alone answers the command line over `/api/local/debug/*` and sends a report to its account.
 */

/** This process, as every installation names itself. */
export function processStatus() {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    node: process.version,
    platform: `${platform()} ${arch()}`,
    hostname: hostname(),
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    memoryMb: Math.round(memory.rss / 1_048_576),
    log: logState(),
  };
}

export async function status() {
  const tenants = await knownTenants().catch(() => []);
  return {
    app: "engenty-wizards-runtime",
    version: packageVersion(),
    process: processStatus(),
    managed,
    appUrl: env.appUrl,
    manageUrl: env.manage.url || null,
    gatewayUrl: (managed ? env.manage.gatewayUrl : env.local.gatewayUrl) || null,
    sandbox: sandboxEngine()?.name ?? "off",
    browser: env.browserCdpUrl ? "cdp" : "local",
    files: env.s3.bucket ? "s3" : "data folder",
    database: env.databaseUrl ? "libsql" : "file",
    tenantDatabases: env.tenantDbUrlTemplate ? "libsql" : "files",
    tenants: tenants.length,
    plugins: loadedPlugins().map((p) => ({
      id: p.source.id,
      version: p.source.manifest.version ?? null,
    })),
  };
}

export interface LogsAnswer {
  /** Where lines came from: this process, named by its host. */
  sources: { from: string; ok: boolean; error?: string }[];
  lines: (LogLine & { from: string })[];
}

const from = () => hostname();

/** The lines this process printed. */
export function logs(query: TailQuery): LogsAnswer {
  const own = from();
  return {
    sources: [{ from: own, ok: true }],
    lines: tail(query).map((line) => ({ ...line, from: own })),
  };
}

/** One run, whichever tenant it belongs to: its state, its error, what the line knows, its last events. */
export async function runDetail(runId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) {
    return null;
  }
  const tenantId = await tenantOfRun(runId);
  if (!tenantId) {
    return null;
  }
  return withTenant(tenantId, async () => {
    const run = await db.query.run.findFirst({
      where: eq(schema.run.id, runId),
      columns: {
        id: true,
        wizardId: true,
        version: true,
        mode: true,
        status: true,
        cursor: true,
        error: true,
        ask: true,
        unattended: true,
        costMicros: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
      },
    });
    if (!run) {
      return null;
    }
    const [wizard, events, line] = await Promise.all([
      db.query.wizard.findFirst({
        where: eq(schema.wizard.id, run.wizardId),
        columns: { title: true, publishedVersion: true },
      }),
      db
        .select({
          id: schema.runEvent.id,
          stepId: schema.runEvent.stepId,
          type: schema.runEvent.type,
          message: schema.runEvent.message,
          createdAt: schema.runEvent.createdAt,
        })
        .from(schema.runEvent)
        .where(eq(schema.runEvent.runId, runId))
        .orderBy(desc(schema.runEvent.id))
        .limit(60),
      runIndexOf(runId),
    ]);
    return {
      tenantId,
      run: {
        ...run,
        ask: run.ask ? { id: run.ask.id, kind: run.ask.kind } : null,
        costCredits: Math.round(run.costMicros / 10_000) / 100,
      },
      wizard: wizard ? { id: run.wizardId, ...wizard } : null,
      line,
      events: events.reverse(),
    };
  });
}

/** Where each class of a tenant runs, as its settings page shows it; never a key. */
export async function tenantModels(tenantId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) {
    return null;
  }
  const known = await knownTenants();
  if (!known.includes(tenantId)) {
    return null;
  }
  return withTenant(tenantId, async () => {
    const settings = await modelSettings();
    return {
      tenantId,
      source: settings.source,
      bindings: settings.bindings,
      creditFallback: settings.creditFallback,
      keys: settings.keys,
      ways: settings.ways,
    };
  });
}

export class ReportError extends Error {
  constructor(
    readonly code: "no_account" | "not_sent",
    message: string,
  ) {
    super(message);
  }
}

/**
 * A runtime that runs alone sends its account what a look from afar needs: its status, its
 * model settings (never a key) and the last lines it printed. The person asks for it
 * (`wizards report`); nothing goes by itself.
 */
export async function sendReport(): Promise<{ id: string; to: string }> {
  const account = await linkedAccount();
  const token = account ? await accountToken() : null;
  if (!account || !token) {
    throw new ReportError("no_account", "This install is linked to no account.");
  }
  const [state, models] = await Promise.all([status(), withTenant(LOCAL_TENANT, modelSettings)]);
  const body = {
    kind: "install",
    version: state.version,
    status: state,
    models: {
      source: models.source,
      bindings: models.bindings,
      creditFallback: models.creditFallback,
      keys: models.keys,
      ways: models.ways,
    },
    logs: tail({ limit: 500 }),
  };
  const res = await fetch(`${env.local.accountUrl}/v1/diagnostics`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch((err: Error) => {
    throw new ReportError("not_sent", `The account did not answer: ${err.message}`);
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ReportError("not_sent", `The account answered ${res.status}: ${text.slice(0, 200)}`);
  }
  const { id } = (await res.json()) as { id: string };
  return { id, to: env.local.accountUrl };
}

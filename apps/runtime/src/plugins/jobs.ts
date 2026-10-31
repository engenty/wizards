import { and, eq } from "drizzle-orm";
import { readingAs, SYSTEM } from "../broker/rwx.js";
import { control, controlDb, withTenant } from "../db/client.js";
import { env } from "../env.js";
import { twoWayActive } from "../sync/state.js";
import { LOCAL_TENANT } from "../tenants/tenant.js";
import { loadedPlugins, pluginIdsOf } from "./registry.js";

/**
 * Plugins' jobs (`server.every`). A tick looks once a minute which job is due for which tenant
 * and runs it inside that tenant. When a job ran is kept in the control database, so a restart
 * does not start the count again; a runtime that was off runs a due job once when it starts,
 * not once per turn it missed.
 */

/** Jobs that run right now, by tenant, plugin and name: one turn at a time each. */
const running = new Set<string>();

/** Starts every job that is due, and is done when they are. */
export async function runDueJobs(now = new Date()): Promise<void> {
  const jobs = loadedPlugins().flatMap((plugin) =>
    [...plugin.jobs].map(([name, job]) => ({ plugin, name, job })),
  );
  if (!jobs.length) {
    return;
  }
  const tenants = await controlDb.query.tenant.findMany({
    where: eq(control.tenant.status, "active"),
  });
  const started: Promise<void>[] = [];
  for (const tenant of tenants) {
    // An install whose spaces sync both ways leaves the jobs to the cloud: both would write the
    // same items of the same spaces (docs/plans/tenant-sync.md).
    if (twoWayActive() && tenant.id === LOCAL_TENANT) {
      continue;
    }
    const has = await pluginIdsOf(tenant.id);
    for (const { plugin, name, job } of jobs) {
      const id = plugin.source.id;
      const key = `${tenant.id}/${id}/${name}`;
      if (!has.has(id) || running.has(key)) {
        continue;
      }
      const where = and(
        eq(control.pluginJob.tenantId, tenant.id),
        eq(control.pluginJob.plugin, id),
        eq(control.pluginJob.name, name),
      );
      const last = (await controlDb.query.pluginJob.findFirst({ where }))?.lastRunAt ?? null;
      if (last && now.getTime() - last.getTime() < job.everyMs) {
        continue;
      }
      running.add(key);
      // The start counts as the run: a turn that throws or hangs is not repeated every minute.
      await controlDb
        .insert(control.pluginJob)
        .values({ tenantId: tenant.id, plugin: id, name, lastRunAt: now })
        .onConflictDoUpdate({
          target: [control.pluginJob.tenantId, control.pluginJob.plugin, control.pluginJob.name],
          set: { lastRunAt: now },
        });
      started.push(
        withTenant(tenant.id, () =>
          // A job runs on the clock, for no person, guest or run: the runtime itself reads.
          readingAs([SYSTEM], async () =>
            job.handler({ tenantId: tenant.id, lastRun: last, signal: plugin.stopped.signal }),
          ),
        )
          .catch((err) => console.error(`[plugin ${id}] job ${name}:`, err))
          .finally(() => running.delete(key)),
      );
    }
  }
  await Promise.all(started);
}

const TICK_MS = 60_000;
let timer: NodeJS.Timeout | null = null;

/** Looks for due jobs now and then once a minute, while the runtime runs. */
export function startJobs() {
  if (timer || !env.plugins.jobs) {
    return;
  }
  const tick = () => void runDueJobs().catch((err) => console.error("[plugins] jobs:", err));
  // Soon after the start, not during it: tenant databases open first.
  setTimeout(tick, 5_000).unref();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

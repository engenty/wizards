// First: drops Node's `localStorage` before a dependency reads it (no-webstorage.ts).
import "./no-webstorage.js";
import { serve } from "@hono/node-server";
import { localEntryUrl, purgeSessions } from "./auth/index.js";
import { startClientChecks } from "./clients.js";
import { adoptLegacyData } from "./db/adopt.js";
import {
  knownTenants,
  migrateAllTenants,
  migrateControlDb,
  openTenantDb,
  withTenant,
} from "./db/client.js";
import { startRunner, stopRunner } from "./engine/runner.js";
import { basePath, env } from "./env.js";
import { pruneLive } from "./live/feed.js";
import { hookConsole } from "./log.js";
import { managed } from "./manage.js";
import { checkModelsAtStart, loadCatalog, loadLocalModels } from "./models.js";
import { startJobs } from "./plugins/jobs.js";
import { loadPlugins } from "./plugins/loader.js";
import { loadEntitlement, startProChecks } from "./plugins/pro.js";
import { closeBrowser } from "./render/chromium.js";
import { clearRunning, writeRunning } from "./running.js";
import { reportAllWizards } from "./services/manage-reports.js";
import { syncMarketplace } from "./services/marketplace.js";
import { purgeExpiredRuns } from "./services/shares.js";
import { dropChatSandboxes } from "./services/work-sandbox.js";
import { purgeUnusedStores } from "./store/index.js";
import { compactLog } from "./sync/log.js";
import { forgetRunner, registerRunner } from "./tenants/control.js";
import { LOCAL_TENANT } from "./tenants/tenant.js";
import { onRestart, RESTART_EXIT, startUpdateChecks } from "./update.js";

// Before anything prints: the last lines stay in memory for a look from afar (debug.ts).
hookConsole();
// A background job that failed (a dropped connection to a remote database) is logged; the
// server keeps running for every other request instead of ending with it.
process.on("unhandledRejection", (err) => console.error("[unhandled]", err));
await migrateControlDb();
// What the linked account's plan confirmed last: the Pro modules it includes load with the rest.
await loadEntitlement();
// Before any tenant database opens: each gets the plugins' own tables as it does.
await loadPlugins();
startJobs();
if (managed) {
  // Every tenant database is brought to this release's schema; a new one migrates when first opened.
  void migrateAllTenants()
    .then(({ migrated, failed }) => {
      console.log(
        `tenant databases: ${migrated} current${failed.length ? `, failed: ${failed}` : ""}`,
      );
      // The admin app's list of every team's wizards starts from what is here now.
      return reportAllWizards();
    })
    .catch((err) => console.error("[migrate]", err));
  // Which clients may start runs over the public API, and how often: the Manage-App's list.
  startClientChecks();
} else {
  await adoptLegacyData();
  await openTenantDb(LOCAL_TENANT);
  await loadLocalModels();
  void loadCatalog();
  void checkModelsAtStart().catch(() => undefined);
  startProChecks();
  // A newer release is downloaded beside this one and used from the next start.
  startUpdateChecks();
}

// The marketplace's starters and the starred entries, kept for offline use; checked hourly.
const marketplace = () =>
  void syncMarketplace().catch((err) => console.error("[marketplace]", (err as Error).message));
marketplace();
setInterval(marketplace, 3600_000).unref();

const { default: app } = await import("./app.js");

/** Behind a path (APP_URL ends in /w) the proxy may leave the prefix on; the routes know none. */
function withoutBasePath(request: Request) {
  const url = new URL(request.url);
  if (basePath && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) {
    url.pathname = url.pathname.slice(basePath.length) || "/";
    return app.fetch(new Request(url, request));
  }
  return app.fetch(request);
}

const server = serve({ fetch: withoutBasePath, port: env.port, hostname: env.host }, (info) => {
  console.log(`engenty wizards on :${info.port} — ${env.appUrl}`);
  const entry = localEntryUrl();
  if (entry && !env.local.accessKey && env.serves.studio) {
    console.log(`Open the studio: ${entry}`);
  }
  if (!managed) {
    writeRunning(env.dataDir, {
      pid: process.pid,
      port: info.port,
      url: env.appUrl,
      startedAt: new Date().toISOString(),
      restarts: process.env.ENGENTY_WIZARDS_RESTARTS === "1",
    });
  }
});

// A runner takes the runs in line, those a stopped process left behind first (RUNTIME_ROLE).
if (env.serves.runner) {
  await registerRunner();
  setInterval(() => void registerRunner().catch(() => undefined), 10_000).unref();
  startRunner();
}

// End-user results are kept RESULT_TTL_DAYS; expired runs and their files go once an hour.
// What a wizard keeps for a person goes once nobody used it for STORE_TTL_DAYS.
async function purge() {
  await purgeSessions();
  for (const id of await knownTenants()) {
    await withTenant(id, () =>
      Promise.all([purgeExpiredRuns(), purgeUnusedStores(), compactLog(), pruneLive()]),
    ).catch((err) => console.error(`[retention ${id}]`, err));
  }
}
void purge().catch((err) => console.error("[retention]", err));

// Assets came into the index later than documents: what is not there yet goes in once.
if (env.serves.studio) {
  const { indexMissingAssets } = await import("./services/space-index.js");
  for (const id of await knownTenants()) {
    void withTenant(id, () => indexMissingAssets()).catch((err) =>
      console.error(`[space-index ${id}]`, err),
    );
  }
}
// The broker is heard (docs/plans/broker.md, "Notifications"): a guest's critical lines go to
// the Manage-App at once, the rest daily; the admins of each space get a mail once an hour where
// none of them was in the app. The studio alone, so several runners don't send the same mail.
if (env.serves.studio) {
  const { startCriticalReports } = await import("./services/manage-reports.js");
  startCriticalReports();
  const { sendCriticalMails } = await import("./services/broker-notify.js");
  const criticalMails = async () => {
    for (const id of await knownTenants()) {
      await withTenant(id, () => sendCriticalMails()).catch((err) =>
        console.error(`[broker] the hourly mail for ${id}:`, (err as Error).message),
      );
    }
  };
  setInterval(() => void criticalMails(), 3600_000).unref();
}
setInterval(() => void purge().catch((err) => console.error("[retention]", err)), 3600_000).unref();

// A runtime that runs alone sends again what did not arrive in its account's cloud.
if (!managed) {
  const { retryFailedSends } = await import("./services/cloud.js");
  const retry = () =>
    withTenant(LOCAL_TENANT, () => retryFailedSends("local")).catch((err) =>
      console.error("[cloud] retry failed:", err),
    );
  setInterval(() => void retry(), 60_000).unref();
  // The two-way sync of the spaces with the account's organization (sync/client.ts).
  const { syncAll } = await import("./sync/client.js");
  const twoWay = () =>
    withTenant(LOCAL_TENANT, () => syncAll()).catch((err) => console.error("[sync]", err));
  setTimeout(() => void twoWay(), 5_000).unref();
  setInterval(() => void twoWay(), 60_000).unref();
  // And between the rounds: what changes in the cloud, as it happens.
  const { followCloud } = await import("./sync/client.js");
  void withTenant(LOCAL_TENANT, () => followCloud(new AbortController().signal)).catch((err) =>
    console.error("[sync] following the cloud:", err),
  );
}

async function shutdown(code = 0) {
  clearRunning(env.dataDir);
  server.close();
  if (env.serves.runner) {
    // The runs go back in line for another runner; their steps start afresh there.
    await stopRunner();
    await forgetRunner().catch(() => undefined);
  }
  await closeBrowser();
  await dropChatSandboxes();
  process.exit(code);
}
// A process that hangs (docs/plans/health-and-status.md) ends, after saying what hangs; the
// container's restart policy starts it again. A dependency that is down never ends it.
if (env.healthWatchdog) {
  const { health } = await import("./health.js");
  let downs = 0;
  setInterval(async () => {
    const h = await health();
    const own = h.checks.process;
    downs = own.status === "down" ? downs + 1 : 0;
    if (downs < 3) {
      return;
    }
    console.error(`[watchdog] this process hangs, ending it: ${own.error}`);
    console.error(`[watchdog] ${JSON.stringify(own.detail)}`);
    // The shutdown waits on the control database, which may be what hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
    await shutdown(1);
  }, 30_000).unref();
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
onRestart((code) => void shutdown(code));
// `wizards restart`: the command that started it starts it again, where it ran.
if (process.env.ENGENTY_WIZARDS_RESTARTS === "1" && process.platform !== "win32") {
  process.on("SIGUSR2", () => shutdown(RESTART_EXIT));
}

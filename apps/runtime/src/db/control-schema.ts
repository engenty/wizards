import type { Lang } from "@engenty-wizards/shared/definition";
import type { MarketplaceExport } from "@engenty-wizards/shared/marketplace";
import type { UiTexts } from "@engenty-wizards/shared/run";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;
const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull().default(now);

// The control database: what the runtime must know before it can open a tenant's database,
// and what it counts across tenants. No wizard, run content or file lives here.

/** Every tenant this runtime has opened. `dbUrl` null = a libSQL file in the data folder. */
export const tenant = sqliteTable("tenant", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["active", "suspended"] })
    .notNull()
    .default("active"),
  dbUrl: text("db_url"),
  createdAt: createdAt(),
});

/** Public tokens that arrive without a session: which tenant, and which row there. */
export const link = sqliteTable(
  "link",
  {
    token: text("token").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /**
     * `wizard` = a share link `/w/<token>`, `result` = a shared result `/s/<token>`, `logo` = a
     * brand logo, `code` = a wizard's ID to type in (its `ref` is the wizard's share token).
     */
    kind: text("kind", { enum: ["wizard", "result", "logo", "code"] }).notNull(),
    ref: text("ref").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("link_tenant").on(t.tenantId), index("link_ref").on(t.kind, t.ref)],
);

/**
 * One row per run: finds the run's tenant, counts a visitor's runs across all wizards, and
 * marks the runs that are working (resumed after a restart, counted against the tenant's limit).
 */
export const runIndex = sqliteTable(
  "run_index",
  {
    runId: text("run_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    visitorId: text("visitor_id"),
    ipHash: text("ip_hash"),
    active: integer("active", { mode: "boolean" }).notNull().default(false),
    /** The runner working on the run; null while it waits for one. */
    owner: text("owner"),
    /** The owner's last heartbeat; one silent for RUNNER_STALE_MS has lost the run. */
    seen: integer("seen", { mode: "timestamp_ms" }),
    /**
     * The mobile app's device for push, set by the app for this run (`POST /api/runs/:id/notify`):
     * `{ token, platform: "ios" | "android", lang }`. Told through the Manage-App when the run is
     * done, failed or waits for the person.
     */
    push: text("push", { mode: "json" }).$type<{
      token: string;
      platform: "ios" | "android";
      lang: Lang;
    }>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("run_index_visitor").on(t.visitorId, t.createdAt),
    index("run_index_ip").on(t.ipHash, t.createdAt),
    index("run_index_active").on(t.active, t.tenantId),
  ],
);

/**
 * The runners that execute runs (RUNTIME_ROLE=runner or all): where the web reaches one for what
 * only the process holding a run can answer (its browser's screen), and when it last reported.
 */
export const runner = sqliteTable("runner", {
  id: text("id").primaryKey(),
  url: text("url"),
  seen: integer("seen", { mode: "timestamp_ms" }).notNull(),
});

/** A studio session of someone signed in at the Manage-App. The refresh token is encrypted. */
export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    role: text("role").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    image: text("image"),
    refreshToken: text("refresh_token"),
    /** When the access token's claims (tenant, role) must be renewed. */
    claimsExpireAt: integer("claims_expire_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("session_expires").on(t.expiresAt)],
);

/** Settings of a runtime that runs alone: model bindings, the linked account. Never secrets. */
export const setting = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});

/**
 * The runner's own words in a language outside `LANGS`, translated once for the runtime:
 * `source` is the hash of the English tables they were made from.
 */
export const uiTranslation = sqliteTable("ui_translation", {
  lang: text("lang").primaryKey(),
  source: text("source").notNull(),
  texts: text("texts", { mode: "json" }).$type<Omit<UiTexts, "lang">>().notNull(),
  createdAt: createdAt(),
});

// --- marketplace -----------------------------------------------------------------
// The marketplace is an app of its own (docs/marketplace-contract.md). What this runtime keeps
// of it for offline use: its starters and what people starred, as the marketplace exports them.

export const marketplaceCache = sqliteTable("marketplace_cache", {
  id: text("id").primaryKey(),
  /** The marketplace's hash of the entry: a different one in its list means it changed. */
  hash: text("hash").notNull(),
  entry: text("entry", { mode: "json" }).$type<MarketplaceExport>().notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull().default(now),
});

/** When a plugin's job (`server.every`) last ran for a tenant: the next turn counts from it. */
export const pluginJob = sqliteTable(
  "plugin_job",
  {
    tenantId: text("tenant_id").notNull(),
    plugin: text("plugin").notNull(),
    name: text("name").notNull(),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.plugin, t.name] })],
);

/**
 * The part of a plugin's public address (`server.publicUrl`) that names the tenant, without
 * giving its id away: `/api/public/plugins/<plugin>/<ref>/…`.
 */
export const pluginAddress = sqliteTable(
  "plugin_address",
  {
    ref: text("ref").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    plugin: text("plugin").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("plugin_address_tenant").on(t.tenantId, t.plugin)],
);

/**
 * Keys a plugin holds across tenants (`server.claims`), each for one tenant at a time: a keyword
 * on a number every tenant shares, who writes to it, a number a tenant connected. What a shared
 * route asks to find the tenant of a call.
 */
export const pluginClaim = sqliteTable(
  "plugin_claim",
  {
    plugin: text("plugin").notNull(),
    key: text("key").notNull(),
    tenantId: text("tenant_id").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.plugin, t.key] }),
    index("plugin_claim_tenant").on(t.tenantId, t.plugin),
  ],
);

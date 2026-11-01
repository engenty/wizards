import {
  CONNECTION_AUDIENCES,
  CONNECTION_SIGN_INS,
  type ConnectionRules,
} from "@engenty/wizards-shared/connectors";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import type { TableColumn } from "@engenty/wizards-shared/engenty/data-tables";
import type { AskAnswer, RunAsk, RunNote, RunState } from "@engenty/wizards-shared/run";
import type { RunnerSettings } from "@engenty/wizards-shared/runners";
import { RWX_FLAGS, RWX_RESOURCE_KINDS, RWX_SUBJECT_KINDS } from "@engenty/wizards-shared/rwx";
import type { ShareIcon, ShareJobView, ShareRequest } from "@engenty/wizards-shared/sharing";
import {
  SKILL_MODES,
  SKILL_SOURCES,
  type SkillBlobFile,
  type SkillFile,
} from "@engenty/wizards-shared/skills";
import type {
  AssetSection,
  BrandColor,
  BrandFont,
  BrandGradient,
  BrandLink,
  BrandPattern,
  BrandRule,
  ColorSection,
  LogoSection,
  SpaceFact,
  SpaceNotify,
  SpacePage,
  TextStyle,
  VoiceBlock,
} from "@engenty/wizards-shared/spaces";
import type { Theme } from "@engenty/wizards-shared/theme";
import type { TranslationMemory } from "@engenty/wizards-shared/translation";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { Grant } from "../broker/grant.js";
import type { ImportedConnectorRecord } from "../engenty/connections-external/types.js";
import type { DeviceAnswer, DeviceOffer, DeviceRequest } from "../engine/device.js";

const now = sql`(unixepoch() * 1000)`;
const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull().default(now);
const updatedAt = () => integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now);

// One database per tenant holds these tables; `tenant_id` stays in every row so a tenant's
// rows can be moved or merged. Users and tenants themselves live outside (Manage-App).

export interface BrandConfig {
  /** The title end users see: a company, a brand, an undertaking. */
  name?: string;
  /** Free text about it: what it does, for whom, in which tone it speaks. */
  about?: string;
  /** The brand's name as it is written ("engrd."), where it differs from the title. */
  brandName?: string;
  /** The line that stands with the name: a claim, a promise. */
  tagline?: string;
  /** Optional: how the brand speaks, in blocks (tone, audience, positioning, values, …). */
  voice?: VoiceBlock[];
  /** Optional: what to say and not to say, one rule per row with its sign. */
  voiceRules?: BrandRule[];
  /** Optional: where the brand is found on the web. */
  links?: BrandLink[];
  /** The first colour is the accent of documents, dashboards and public pages. */
  colors?: BrandColor[];
  /** Optional: further colours, gradients or patterns grouped by use, each saying when to use it. */
  colorSections?: ColorSection[];
  /** In gradients sections. */
  gradients?: BrandGradient[];
  /** In patterns sections. */
  patterns?: BrandPattern[];
  /** Optional: how the colours may be used, one rule per row with its sign. */
  colorRules?: BrandRule[];
  /** The brand's typefaces, each with what it is for. */
  fonts?: BrandFont[];
  /** Optional: the type scale. */
  textStyles?: TextStyle[];
  /** Optional: how type may be used, one rule per row. */
  typeRules?: BrandRule[];
  /** Optional: assets of one kind each, shown as tabs. */
  assetSections?: AssetSection[];
  /** Optional: the logos grouped by use, each group saying when to use it. */
  logoSections?: LogoSection[];
  /** Optional: how the logos may be used, one rule per row with its sign. */
  logoRules?: BrandRule[];
}

export const space = sqliteTable(
  "space",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    brand: text("brand", { mode: "json" }).$type<BrandConfig>().notNull().default({}),
    facts: text("facts", { mode: "json" }).$type<SpaceFact[]>().notNull().default([]),
    /** The space's themes: values only (docs/plans/themes.md). Wizards name them in `themes`. */
    themes: text("themes", { mode: "json" }).$type<Theme[]>().notNull().default([]),
    /** The space's public page at `<organization>.wizards.page/<slug>`; null until it is set up. */
    page: text("page", { mode: "json" }).$type<SpacePage>(),
    /**
     * The space's own mail domains (`firma.at`): a guest's run may send to an address in one of
     * them, besides the address the run itself collected (broker/send.ts). Admins set them.
     */
    mailDomains: text("mail_domains", { mode: "json" }).$type<string[]>().notNull().default([]),
    /**
     * How the space's admins hear of the broker's critical lines (docs/plans/broker.md,
     * "Notifications"): under Work's bell, and by mail once an hour where nobody of them was in
     * the app. Set through `PATCH /api/studio/spaces/:id`, on Fähigkeiten › Protokoll.
     */
    notify: text("notify", { mode: "json" })
      .$type<SpaceNotify>()
      .notNull()
      .default({ bell: true, mail: "hourly" }),
    /** When the hourly mail last went out, or was skipped because an admin had seen the bell. */
    criticalMailedAt: integer("critical_mailed_at", { mode: "timestamp_ms" }),
    /**
     * „Mitglieder dürfen ins Studio“: the organization's members build here too, with less than
     * its admins (services/members-studio.ts). One rule for all members; admins set it.
     */
    membersStudio: integer("members_studio", { mode: "boolean" }).notNull().default(false),
    /**
     * `local`: the space of a local install, synced here when that install publishes. It keeps
     * the ids it has there and is changed only by the next sync. Null: made on this runtime.
     */
    origin: text("origin", { enum: ["local"] }),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }),
    /**
     * `client`: a client space under `parentId` (docs/plans/client-spaces.md): one client's data,
     * results and chats, reading the parent's setup. `space`: a space of the organization.
     */
    kind: text("kind", { enum: ["space", "client"] })
      .notNull()
      .default("space"),
    /** The space a client space belongs to; null for a space. Two levels, never more. */
    parentId: text("parent_id").references((): AnySQLiteColumn => space.id, {
      onDelete: "cascade",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("space_tenant").on(t.tenantId), index("space_parent").on(t.parentId)],
);

/**
 * Who of the organization is in a client space (docs/plans/client-spaces.md): `client`, the
 * client's own people, who see only the client spaces they are in; `member`, the firm's people
 * assigned to it. The firm's members see every client space of their space all the same until a
 * space turns "assigned only" on.
 */
export const spaceMember = sqliteTable(
  "space_member",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    /** Null while the person is invited and has not signed in yet. */
    userId: text("user_id"),
    /** The address an invitation went to: the person is found by it on their first sign-in. */
    email: text("email"),
    role: text("role", { enum: ["member", "client"] }).notNull(),
    addedBy: text("added_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("space_member_key").on(t.spaceId, t.userId),
    index("space_member_user").on(t.userId),
  ],
);

export const wizard = sqliteTable(
  "wizard",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    title: text("title").notNull(),
    draft: text("draft", { mode: "json" }).$type<WizardDefinition>().notNull(),
    publishedVersion: integer("published_version"),
    shareToken: text("share_token").notNull(),
    shareEnabled: integer("share_enabled", { mode: "boolean" }).notNull().default(true),
    dailyRunLimit: integer("daily_run_limit").notNull().default(50),
    /** How many emails guests' runs of this wizard send per day, from any address (broker/send.ts). */
    dailyMailLimit: integer("daily_mail_limit").notNull().default(50),
    starter: text("starter"),
    /** The revision of the marketplace entry the wizard was made from. */
    starterRevision: integer("starter_revision"),
    /** Bumped on every draft write; a write carrying an older one is refused. */
    revision: integer("revision").notNull().default(0),
    /** How the wizard is offered: the runner its link opens, the ones switched on. Null: steps and chat. */
    runners: text("runners", { mode: "json" }).$type<RunnerSettings>(),
    /** The wizard's page offers it in the viewer's language, translated on request. */
    translate: integer("translate", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("wizard_share_token").on(t.shareToken), index("wizard_space").on(t.spaceId)],
);

export const wizardVersion = sqliteTable(
  "wizard_version",
  {
    id: text("id").primaryKey(),
    wizardId: text("wizard_id")
      .notNull()
      .references(() => wizard.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: text("definition", { mode: "json" }).$type<WizardDefinition>().notNull(),
    /** The workspace as it was at publish time. */
    files: text("files", { mode: "json" }).$type<WorkspaceFile[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("wizard_version_n").on(t.wizardId, t.version)],
);

/**
 * A wizard in one viewer's language: each original text the person reads with its translation,
 * written by a model or by the author. Shared by every version; a new version's changed texts
 * are added when the next viewer asks for the language.
 */
export const wizardTranslation = sqliteTable(
  "wizard_translation",
  {
    wizardId: text("wizard_id")
      .notNull()
      .references(() => wizard.id, { onDelete: "cascade" }),
    /** Any language, by its code ("fr"). */
    lang: text("lang").notNull(),
    texts: text("texts", { mode: "json" }).$type<TranslationMemory>().notNull(),
    /** The published version whose texts it last completed. */
    version: integer("version"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.wizardId, t.lang] })],
);

/** The draft's workspace: widget code, libraries, reference data. Content lives in the blob store. */
export const wizardFile = sqliteTable(
  "wizard_file",
  {
    wizardId: text("wizard_id")
      .notNull()
      .references(() => wizard.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    hash: text("hash").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.wizardId, t.path] })],
);

export const wizardMessage = sqliteTable(
  "wizard_message",
  {
    id: text("id").primaryKey(),
    wizardId: text("wizard_id")
      .notNull()
      .references(() => wizard.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    /** Set on assistant turns that changed the wizard. */
    changed: integer("changed", { mode: "boolean" }).notNull().default(false),
    /** "mcp": written by an admin's own client (Claude Code, Cursor …) named in `client`. */
    source: text("source", { enum: ["studio", "mcp"] })
      .notNull()
      .default("studio"),
    client: text("client"),
    createdAt: createdAt(),
  },
  (t) => [index("wizard_message_wizard").on(t.wizardId, t.createdAt)],
);

export const run = sqliteTable(
  "run",
  {
    id: text("id").primaryKey(),
    wizardId: text("wizard_id")
      .notNull()
      .references(() => wizard.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    /** The definition the run started on — edits never reach a running wizard. */
    definition: text("definition", { mode: "json" }).$type<WizardDefinition>().notNull(),
    /** The workspace the run started with. */
    files: text("files", { mode: "json" }).$type<WorkspaceFile[]>().notNull().default([]),
    /**
     * What the run may reach outside, from the definition it started on (broker/grant.ts); null
     * on a run from before grants were kept, filled from its definition on first use.
     */
    grant: text("grant", { mode: "json" }).$type<Grant | null>(),
    version: integer("version"),
    mode: text("mode", { enum: ["test", "live"] }).notNull(),
    /** The door the run came through: steps, chat, or a plugin's runner. Null: the page. */
    runner: text("runner"),
    /** The language the viewer reads the wizard in, translated on request; null: its own. */
    lang: text("lang"),
    visitorId: text("visitor_id"),
    userId: text("user_id"),
    /** The platform admin who started it while signed in as someone; null otherwise. */
    impersonatedBy: text("impersonated_by"),
    ipHash: text("ip_hash"),
    /**
     * Where a visitor started the run: the address of the website page that embeds the wizard
     * (`data-page` of the embed tag, else the page's own address); null on the wizard's link.
     */
    origin: text("origin"),
    /** The client that started it over the public API (`x-wizards-client`): web, app, cli, or a registered id. */
    client: text("client"),
    status: text("status", {
      enum: ["waiting_input", "running", "done", "failed", "cancelled"],
    }).notNull(),
    cursor: text("cursor"),
    state: text("state", { mode: "json" }).$type<RunState>().notNull(),
    error: text("error"),
    /** What a running step is asking the person right now (a login, a code); null = nothing. */
    ask: text("ask", { mode: "json" }).$type<RunAsk | null>(),
    /** The person's answer to `ask`, written by the web for the runner that waits on it. */
    answer: text("answer", { mode: "json" }).$type<{ askId: string; answer: AskAnswer } | null>(),
    /** An autopilot drives this test run (an MCP client fills its pages): it asks nobody. */
    unattended: integer("unattended", { mode: "boolean" }).notNull().default(false),
    /**
     * What the device the run is watched from offers as a model (the app's Apple Intelligence),
     * with when it last said so; written by the web, read by the runner (engine/device.ts).
     */
    deviceOffer: text("device_offer", { mode: "json" }).$type<{
      offer: DeviceOffer;
      at: number;
    } | null>(),
    costMicros: integer("cost_micros").notNull().default(0),
    /**
     * The client space a run was started in (docs/plans/client-portal.md): the wizard is its
     * parent's, the run's data and results belong to the client space. Null: a run of its
     * wizard's space.
     */
    clientSpaceId: text("client_space_id").references((): AnySQLiteColumn => space.id, {
      onDelete: "cascade",
    }),
    /**
     * When the firm shared the run with the client space's clients, on purpose; null: it stays
     * the firm's. A client's own runs need none.
     */
    clientSharedAt: integer("client_shared_at", { mode: "timestamp_ms" }),
    /** Set once the result is shared: `/s/<token>` shows it read-only. */
    shareToken: text("share_token"),
    sharedAt: integer("shared_at", { mode: "timestamp_ms" }),
    /** Runs without an account are deleted after this; null keeps the run. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("run_share_token").on(t.shareToken),
    index("run_expires").on(t.expiresAt),
    index("run_wizard").on(t.wizardId, t.createdAt),
    index("run_visitor").on(t.visitorId, t.createdAt),
    index("run_status").on(t.status),
    index("run_client_space").on(t.clientSpaceId, t.createdAt),
  ],
);

export const runEvent = sqliteTable(
  "run_event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    stepId: text("step_id"),
    type: text("type", { enum: ["step_started", "step_done", "tool", "info", "error"] }).notNull(),
    message: text("message").notNull(),
    /** The message as a note of `RUN_NOTES`, for a runner in another language. */
    note: text("note", { mode: "json" }).$type<RunNote>(),
    /** A picture of the run the event is about; shown while the step works. */
    assetId: text("asset_id"),
    createdAt: createdAt(),
  },
  (t) => [index("run_event_run").on(t.runId, t.id)],
);

/**
 * A call the runner put to the run's device, open until the device answers or the runner stops
 * waiting: the stream (any web process) carries it to the phone, and the answer comes back here.
 */
export const deviceCall = sqliteTable(
  "device_call",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    reqId: text("req_id").notNull(),
    request: text("request", { mode: "json" }).$type<DeviceRequest>().notNull(),
    answer: text("answer", { mode: "json" }).$type<DeviceAnswer>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("device_call_req").on(t.reqId), index("device_call_run").on(t.runId)],
);

/** One result sent or published to a share target: what was asked, what happened, where it is. */
export const shareJob = sqliteTable(
  "share_job",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    /** The share target's id, and its name and icon when it was sent. */
    target: text("target").notNull(),
    name: text("name").notNull(),
    icon: text("icon").$type<ShareIcon>().notNull(),
    status: text("status", { enum: ["running", "done", "failed", "cancelled"] }).notNull(),
    request: text("request", { mode: "json" }).$type<ShareRequest>().notNull(),
    events: text("events", { mode: "json" }).$type<ShareJobView["events"]>().notNull().default([]),
    result: text("result", { mode: "json" }).$type<ShareJobView["result"]>(),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("share_job_run").on(t.runId, t.createdAt)],
);

/** What each step of a run cost, in credit micros: the measurements estimates are made from. */
export const runCost = sqliteTable(
  "run_cost",
  {
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    micros: integer("micros").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.runId, t.stepId] })],
);

export const asset = sqliteTable(
  "asset",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id"),
    stepId: text("step_id"),
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    size: integer("size").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("asset_run").on(t.runId)],
);

/**
 * A service imported as a connector, from the integrations registry or a pasted OpenAPI spec /
 * MCP endpoint. The record is engenty's: actions, auth and source, normalised at import time.
 */
export const spaceConnector = sqliteTable(
  "space_connector",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    record: text("record", { mode: "json" }).$type<ImportedConnectorRecord>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.id] })],
);

/**
 * What a space holds for all its wizards: logos, assets (images, graphics, videos) and
 * documents. Its bytes are a blob, by `hash` (files/blobs.ts): the same bytes in Marke and in
 * Wissen are stored once. The first logo is the one end users see.
 */
export const spaceFile = sqliteTable(
  "space_file",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["logo", "asset", "document", "pattern"] }).notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    /** sha256 of its bytes. Null on a file from before 0.16 until `wizards move-files` moved it. */
    hash: text("hash"),
    description: text("description").notNull().default(""),
    /** A web address the file was fetched from, when it was not uploaded. */
    source: text("source"),
    position: integer("position").notNull().default(0),
    /**
     * A document's folder in Knowledge: the page it sits in, null at the top. Its path
     * (`files/<name>`) does not follow it. Its folder deleted, it goes to the top.
     */
    parentId: text("parent_id").references((): AnySQLiteColumn => spacePage.id, {
      onDelete: "set null",
    }),
    /** `pending` while it is read, described and indexed. */
    status: text("status", { enum: ["pending", "ready", "failed"] })
      .notNull()
      .default("ready"),
    error: text("error"),
    /** A document's text as Markdown, in the blob store. */
    textHash: text("text_hash"),
    pages: integer("pages"),
    chars: integer("chars"),
    /** What the index holds of a document; `embeddings` includes the keywords. */
    indexed: text("indexed", { enum: ["embeddings", "keywords"] }),
    /** A plugin's file (`server.spaceData.putFile`): the plugin, its key and what it calls it. */
    origin: text("origin"),
    originKey: text("origin_key"),
    originLabel: text("origin_label"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("space_file_space").on(t.spaceId, t.kind, t.position),
    uniqueIndex("space_file_origin").on(t.spaceId, t.origin, t.originKey),
    index("space_file_hash").on(t.hash),
  ],
);

/**
 * The index of Knowledge: one unit per section of a page, row of a table, file, summary of a
 * category's value, passage of a document read before pages, and passage of a plugin's text
 * (`server.index`). Each unit's text starts with where it stands and its categories. Keywords
 * live in two FTS5 tables, words (`space_chunk_fts`) and trigrams (`space_chunk_tri`), which
 * triggers keep in step (see the migrations); `embedding` is the unit's vector as float32
 * bytes, compared with libSQL's `vector_distance_cos`.
 */
export const spaceChunk = sqliteTable(
  "space_chunk",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    /** The document the passage is of; null for a plugin's text. */
    fileId: text("file_id").references(() => spaceFile.id, { onDelete: "cascade" }),
    /** What the unit is of: a page, a row (with its table), a table (FAQ format: a row), a value. */
    pageId: text("page_id").references((): AnySQLiteColumn => spacePage.id, {
      onDelete: "cascade",
    }),
    rowId: text("row_id").references((): AnySQLiteColumn => spaceTableRow.id, {
      onDelete: "cascade",
    }),
    tableId: text("table_id").references((): AnySQLiteColumn => spaceTable.id, {
      onDelete: "cascade",
    }),
    valueId: text("value_id").references((): AnySQLiteColumn => spaceCategoryValue.id, {
      onDelete: "cascade",
    }),
    /** A section's headings, outermost first, joined by " › ". */
    heading: text("heading"),
    /** The page of the original a section starts on (`<!-- S. 3 -->`). */
    sheet: integer("sheet"),
    /** A plugin's text: the plugin, its key for the text, its title and where the studio shows it. */
    plugin: text("plugin"),
    ref: text("ref"),
    title: text("title"),
    link: text("link"),
    idx: integer("idx").notNull(),
    text: text("text").notNull(),
    embedding: blob("embedding", { mode: "buffer" }),
    /** The model the vector was made with; only vectors of one model are compared. */
    model: text("model"),
    /**
     * Null: the vector is of the text. `image`: of a picture file, `page`: of a picture of a PDF
     * page (`sheet`); the text is what the words find them by.
     */
    kind: text("kind").$type<"image" | "page">(),
  },
  (t) => [
    index("space_chunk_space").on(t.spaceId, t.model),
    index("space_chunk_file").on(t.fileId),
    index("space_chunk_ref").on(t.spaceId, t.plugin, t.ref),
    index("space_chunk_page").on(t.pageId),
    index("space_chunk_row").on(t.rowId),
    index("space_chunk_table").on(t.tableId),
    index("space_chunk_value").on(t.valueId),
  ],
);

// --- Dateien ------------------------------------------------------------------
// File trees another party owns, mounted in a space (docs/plans/media-and-files.md, section 3):
// a folder on this computer for now. A mounted file keeps a pointer, a fingerprint, its
// categories and an index without its text; its bytes stay where they are.

/** A mount: a file tree of a source, shown in the space as Dateien › <name>. */
export const spaceMount = sqliteTable(
  "space_mount",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Its name in a wizard's path (`dateien/<slug>/…`), unique in the space. */
    slug: text("slug").notNull(),
    /** Where it lives: a folder on this computer. */
    kind: text("kind", { enum: ["folder"] }).notNull(),
    /** What the kind needs to reach it: the folder's path. */
    source: text("source", { mode: "json" }).$type<{ path: string }>().notNull(),
    /** `scanning` while it is listed and read, `away` while its source can't be reached. */
    status: text("status", { enum: ["scanning", "ready", "away"] })
      .notNull()
      .default("scanning"),
    error: text("error"),
    /** When the whole tree was last listed against the rows. */
    scannedAt: integer("scanned_at", { mode: "timestamp_ms" }),
    /** A category whose value for a file is the folder of the first level it lies in. */
    folderCategoryId: text("folder_category_id").references(
      (): AnySQLiteColumn => spaceCategory.id,
      { onDelete: "set null" },
    ),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("space_mount_slug").on(t.spaceId, t.slug)],
);

/**
 * A file of a mount: where it is, its fingerprint (size and time, its hash), how far it is
 * indexed. Its row stays when it moves or is renamed (found again by its hash), so its
 * categories do.
 */
export const spaceMountFile = sqliteTable(
  "space_mount_file",
  {
    id: text("id").primaryKey(),
    mountId: text("mount_id")
      .notNull()
      .references(() => spaceMount.id, { onDelete: "cascade" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    /** Its path in the mount, with `/`: `Kunden/A1/angebot.pdf`. */
    path: text("path").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    /** The source's time of its last change, in milliseconds. */
    modified: integer("modified").notNull(),
    /** sha256 of its bytes, once read. */
    hash: text("hash"),
    /** `pending` until read; `ready` indexed; `skipped` kept out of the index (too large, no text). */
    status: text("status", { enum: ["pending", "ready", "skipped", "failed"] })
      .notNull()
      .default("pending"),
    error: text("error"),
    pages: integer("pages"),
    /** Whether a thumbnail stands at `derived/m/<mount>/<id>.jpg`. */
    thumb: integer("thumb", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("space_mount_file_path").on(t.mountId, t.path),
    index("space_mount_file_hash").on(t.mountId, t.hash),
    index("space_mount_file_status").on(t.mountId, t.status),
  ],
);

/**
 * A unit of a mounted file's index, without its text: where it stands in the file's text
 * (`start`, `end`) or which page it shows, and its vector. Its words are in two contentless FTS5
 * tables (`space_mount_unit_fts`, `space_mount_unit_tri`, rowid = id), written when the file is
 * read; a snippet reads the original again.
 */
export const spaceMountUnit = sqliteTable(
  "space_mount_unit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    mountId: text("mount_id")
      .notNull()
      .references(() => spaceMount.id, { onDelete: "cascade" }),
    fileId: text("file_id")
      .notNull()
      .references(() => spaceMountFile.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    /** The section's headings, joined by " › ". */
    heading: text("heading"),
    /** The page of the original it starts on, or the page a `page` unit shows. */
    sheet: integer("sheet"),
    /** Where its passage stands in the file's text, in characters; null for a picture. */
    start: integer("start"),
    end: integer("end"),
    embedding: blob("embedding", { mode: "buffer" }),
    model: text("model"),
    /** Null: the vector is of the text. `image`: of the picture file, `page`: of a PDF page. */
    kind: text("kind").$type<"image" | "page">(),
  },
  (t) => [
    index("space_mount_unit_file").on(t.fileId),
    index("space_mount_unit_space").on(t.spaceId, t.model),
  ],
);

// --- The space's data -------------------------------------------------------
// Tables and pages a space keeps, its own or one of its wizards'. Shared by everyone who works
// in the space, unlike the wizard's store below, which belongs to one person.

/** A table: its columns are engenty data-table columns, its rows in `space_table_row`. */
export const spaceTable = sqliteTable(
  "space_table",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    /** The wizard it belongs to; null: the space's own. */
    wizardId: text("wizard_id").references(() => wizard.id, { onDelete: "cascade" }),
    /**
     * The wizard's shared list it keeps: its title, columns and key come from the wizard's
     * definition, its rows from every run. Null: a table made in the studio.
     */
    list: text("list"),
    /** The column a row is matched on, as the list says. */
    keyColumn: text("key_column"),
    title: text("title").notNull(),
    /** Its name in a path (`tables/<slug>`), unique among the space's tables. */
    slug: text("slug"),
    /**
     * Its folder in Knowledge: the page it sits in, null at the top. Its path does not follow it.
     * Its folder deleted, it goes to the top.
     */
    parentId: text("parent_id").references((): AnySQLiteColumn => spacePage.id, {
      onDelete: "set null",
    }),
    /** Its place among its folder's contents, pages and files among them. */
    position: integer("position").notNull().default(0),
    /** `faq`: a question and its answer per row. */
    format: text("format", { enum: ["faq"] }),
    columns: text("columns", { mode: "json" }).$type<TableColumn[]>().notNull(),
    /**
     * Written by a plugin (`server.spaceData`): the plugin, its key for the item and what it
     * calls where it came from ("Tagesberichte"). Null: made in the studio or uploaded.
     */
    origin: text("origin"),
    originKey: text("origin_key"),
    originLabel: text("origin_label"),
    /** A person changed what its origin wrote: the origin no longer writes it. */
    kept: integer("kept", { mode: "boolean" }).notNull().default(false),
    /** Why a person should look at it ("hardly readable"); null when nothing is in doubt. */
    review: text("review"),
    /** The file it was read from, kept as the evidence. */
    fileId: text("file_id").references(() => spaceFile.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("space_table_space").on(t.spaceId, t.wizardId),
    uniqueIndex("space_table_list").on(t.spaceId, t.wizardId, t.list),
    uniqueIndex("space_table_origin").on(t.spaceId, t.origin, t.originKey),
  ],
);

/** A row of a table: cells by column id. Rows stand in the order they were added. */
export const spaceTableRow = sqliteTable(
  "space_table_row",
  {
    id: text("id").primaryKey(),
    tableId: text("table_id")
      .notNull()
      .references(() => spaceTable.id, { onDelete: "cascade" }),
    /** The key column's value, normalised: saving a row with a known key updates that row. */
    key: text("key"),
    cells: text("cells", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("space_table_row_table").on(t.tableId, t.createdAt),
    index("space_table_row_key").on(t.tableId, t.key),
  ],
);

/**
 * A page: a title and markdown, what the editor shows and an agent reads and writes. A page of
 * the space's own may have sub-pages: a long document split along its own headings.
 */
export const spacePage = sqliteTable(
  "space_page",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    wizardId: text("wizard_id").references(() => wizard.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => spacePage.id, {
      onDelete: "cascade",
    }),
    /** Its place among its parent's sub-pages. */
    position: integer("position").notNull().default(0),
    title: text("title").notNull(),
    /** Its name in a path (`pages/<parent>/<slug>`), unique among its siblings. */
    slug: text("slug"),
    markdown: text("markdown").notNull().default(""),
    /**
     * Written by a plugin (`server.spaceData`): the plugin, its key for the item and what it
     * calls where it came from ("Tagesberichte"). Null: made in the studio or uploaded.
     */
    origin: text("origin"),
    originKey: text("origin_key"),
    originLabel: text("origin_label"),
    /** A person changed what its origin wrote: the origin no longer writes it. */
    kept: integer("kept", { mode: "boolean" }).notNull().default(false),
    /** Why a person should look at it ("hardly readable"); null when nothing is in doubt. */
    review: text("review"),
    /** The file it was read from, kept as the evidence. */
    fileId: text("file_id").references(() => spaceFile.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("space_page_space").on(t.spaceId, t.wizardId),
    index("space_page_parent").on(t.parentId, t.position),
    uniqueIndex("space_page_origin").on(t.spaceId, t.origin, t.originKey),
  ],
);

// --- Sources of Knowledge -------------------------------------------------------
// What fills a folder of Knowledge from outside the space: a website, a sitemap, a list of
// addresses (docs/plans/knowledge-base.md). A plugin brings each kind and its reader
// (`registerKnowledgeSource`); the rows, the runs and what they write are the core's. Everything a
// source writes has the origin `source:<id>`.

/** An entry left out by its address: `pattern` is a part of it, `*` stands for anything. */
export interface SourceRule {
  pattern: string;
  reason: string;
}

/** A Kategorie a source brings: proposed with it, put into the space when it is taken. */
export interface SourceCategory {
  name: string;
  type: "choice" | "date" | "number" | "text" | "boolean";
  unit?: string;
  multiple?: boolean;
  hint?: string;
  values?: string[];
}

/** What an entry became in Knowledge: the studio opens it by its kind and id. */
export interface SourceEntryResult {
  kind: "page" | "table" | "file";
  id: string;
  path: string;
  title: string;
}

export const spaceSource = sqliteTable(
  "space_source",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    /** The kind a plugin registered: `website`, `sitemap`, `urls`. */
    kind: text("kind").notNull(),
    /** The plugin that brings the kind; its reader reads the source. */
    plugin: text("plugin").notNull(),
    address: text("address").notNull(),
    label: text("label").notNull(),
    state: text("state", { enum: ["proposed", "taken"] }).notNull(),
    rules: text("rules", { mode: "json" }).$type<SourceRule[]>().notNull(),
    categories: text("categories", { mode: "json" }).$type<SourceCategory[]>().notNull(),
    /** Read again every so many hours; null: only when asked. */
    everyHours: integer("every_hours"),
    /** What a signal address of the kind names the source by. */
    token: text("token").notNull(),
    status: text("status", { enum: ["idle", "running", "failed"] }).notNull(),
    error: text("error"),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("space_source_space").on(t.spaceId), uniqueIndex("space_source_token").on(t.token)],
);

/** One entry a source holds: an address, whether it is in, and what it became. */
export const spaceSourceEntry = sqliteTable(
  "space_source_entry",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => spaceSource.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    title: text("title"),
    /** Where it stands below the source's folder: the folders' names, outermost first. */
    path: text("path", { mode: "json" }).$type<string[]>().notNull(),
    included: integer("included", { mode: "boolean" }).notNull(),
    reason: text("reason"),
    decidedBy: text("decided_by", { enum: ["rule", "model", "person"] }),
    status: text("status", { enum: ["new", "done", "check", "failed", "kept"] }).notNull(),
    /** The key it was written under: `e:<id>`, or `dir:<path>` for the text of a folder. */
    itemKey: text("item_key"),
    result: text("result", { mode: "json" }).$type<SourceEntryResult | null>(),
    note: text("note"),
    fingerprint: text("fingerprint"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("space_source_entry_address").on(t.sourceId, t.address)],
);

/** A run of a source: what it wrote, kept unchanged, failed on and left out, and its log. */
export const spaceSourceRun = sqliteTable(
  "space_source_run",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => spaceSource.id, { onDelete: "cascade" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["running", "done", "failed", "stopped"] }).notNull(),
    written: integer("written").notNull(),
    unchanged: integer("unchanged").notNull(),
    failed: integer("failed").notNull(),
    leftOut: integer("left_out").notNull(),
    log: text("log", { mode: "json" }).$type<string[]>().notNull(),
  },
  (t) => [index("space_source_run_source").on(t.sourceId, t.startedAt)],
);

// --- Categories -----------------------------------------------------------------
// Typed properties that run across Knowledge: set on pages, rows, tables and files, any number of
// each, so a step filters before it searches.

/** A category of the space: a name, a type and, for a choice, the values it has met. */
export const spaceCategory = sqliteTable(
  "space_category",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", { enum: ["choice", "date", "number", "text", "boolean"] }).notNull(),
    /** A number's unit: `h`, `€`, `kg`. */
    unit: text("unit"),
    /** A choice: several values per item. */
    multiple: integer("multiple", { mode: "boolean" }).notNull().default(false),
    /** A choice whose values are ranked (niedrig, mittel, hoch): their position is the rank. */
    ordered: integer("ordered", { mode: "boolean" }).notNull().default(false),
    /** Where its values come from, said in a few words ("Kopfzeile", "Spalte WLL"). */
    hint: text("hint"),
    /** The plugin that brought it; null: made in the studio. */
    origin: text("origin"),
    /** Proposed, not yet taken: shown to be confirmed, never filled. */
    proposed: integer("proposed", { mode: "boolean" }).notNull().default(false),
    /** A column of a table whose cells are its values for the table's rows. */
    tableId: text("table_id").references(() => spaceTable.id, { onDelete: "set null" }),
    columnId: text("column_id"),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("space_category_name").on(t.spaceId, t.name)],
);

/** A value of a choice: grows as items arrive; its summary is the summary of its items. */
export const spaceCategoryValue = sqliteTable(
  "space_category_value",
  {
    id: text("id").primaryKey(),
    categoryId: text("category_id")
      .notNull()
      .references(() => spaceCategory.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    position: integer("position").notNull().default(0),
    /** The summary: Markdown a model wrote of the value's items, when it last did. */
    summary: text("summary"),
    summaryAt: integer("summary_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("space_category_value_value").on(t.categoryId, t.value)],
);

/**
 * A category set on an item: exactly one of page, row, table, file and mounted file. A choice points to its
 * value; the other types keep theirs typed: a date as milliseconds, a number, a short text, yes
 * or no. A choice with several values has a row per value.
 */
export const spaceItemCategory = sqliteTable(
  "space_item_category",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => spaceCategory.id, { onDelete: "cascade" }),
    pageId: text("page_id").references(() => spacePage.id, { onDelete: "cascade" }),
    rowId: text("row_id").references(() => spaceTableRow.id, { onDelete: "cascade" }),
    tableId: text("table_id").references(() => spaceTable.id, { onDelete: "cascade" }),
    fileId: text("file_id").references(() => spaceFile.id, { onDelete: "cascade" }),
    /** A file of a mount in Dateien: the space's categories hold for those too. */
    mountFileId: text("mount_file_id").references((): AnySQLiteColumn => spaceMountFile.id, {
      onDelete: "cascade",
    }),
    valueId: text("value_id").references(() => spaceCategoryValue.id, { onDelete: "cascade" }),
    text: text("text"),
    num: real("num"),
    at: integer("at"),
    bool: integer("bool", { mode: "boolean" }),
    /** Who set it: a person, the item's origin (a source's structure), or a model reading it. */
    by: text("by", { enum: ["person", "origin", "model"] })
      .notNull()
      .default("person"),
  },
  (t) => [
    index("space_item_category_category").on(t.categoryId, t.valueId),
    index("space_item_category_page").on(t.pageId),
    index("space_item_category_row").on(t.rowId),
    index("space_item_category_table").on(t.tableId),
    index("space_item_category_file").on(t.fileId),
    index("space_item_category_mount_file").on(t.mountFileId),
  ],
);

// --- Skills -------------------------------------------------------------------------
// Instructions in the Agent Skills format the space's wizards follow (docs/plans/skills.md):
// always, or when a step reads one. Text only, the folder's files kept beside the instructions.

export const spaceSkill = sqliteTable(
  "space_skill",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    /** Its name in the format: lower case and hyphens, unique in the space. */
    name: text("name").notNull(),
    description: text("description").notNull(),
    /** The Markdown after the front matter of its `SKILL.md`. */
    body: text("body").notNull().default(""),
    /** The rest of the front matter, kept as it came (`license`, `metadata` …). */
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    /** The other files of its folder, by their path in it. */
    files: text("files", { mode: "json" }).$type<SkillFile[]>().notNull().default([]),
    /** Files for its scripts only, their bytes in the blob store (files/blobs.ts). */
    blobFiles: text("blob_files", { mode: "json" }).$type<SkillBlobFile[]>().notNull().default([]),
    mode: text("mode", { enum: SKILL_MODES }).notNull().default("demand"),
    /** Its scripts run in the sandbox of a step that has one: switched on by a person, never by default. */
    runScripts: integer("run_scripts", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: SKILL_SOURCES }).notNull().default("own"),
    /** skills.sh: `owner/repo/skill`, and the hash of what it had when added. */
    origin: text("origin"),
    originHash: text("origin_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("space_skill_name").on(t.spaceId, t.name)],
);

// --- The broker: RWX ---------------------------------------------------------------
// One table of permissions per space (docs/plans/broker.md, "First: RWX"): who (a guest, a
// person, a role, Goose for a person, a wizard, a plugin) may read, write or execute what (a
// document, a table, a page …; `*` for all of a kind). Each flag is allow, deny or unset; unset
// means deny, and a deny wins over every allow. The runtime asks in broker/rwx.ts.

export const rwxRule = sqliteTable(
  "rwx_rule",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    subjectKind: text("subject_kind", { enum: RWX_SUBJECT_KINDS }).notNull(),
    /** `member`, `admin` or `owner` for a role; a user's, a wizard's or a plugin's id; null for a guest. */
    subjectId: text("subject_id"),
    resourceKind: text("resource_kind", { enum: RWX_RESOURCE_KINDS }).notNull(),
    /** The resource's id, or `*` for every resource of the kind. */
    resourceId: text("resource_id").notNull(),
    r: text("r", { enum: RWX_FLAGS }),
    w: text("w", { enum: RWX_FLAGS }),
    x: text("x", { enum: RWX_FLAGS }),
    /** Who wrote the row: a user's id, or `seed` for the rows every space starts with. */
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("rwx_rule_key").on(
      t.spaceId,
      t.subjectKind,
      t.subjectId,
      t.resourceKind,
      t.resourceId,
    ),
    index("rwx_rule_space").on(t.spaceId),
  ],
);

// --- The studio's assistant ---------------------------------------------------
// One open chat per person and tenant, the same on every page and space; nobody else sees it.
// "New chat" closes it with a dense summary and opens the next one. Messages and summaries are
// searched through `assistant_search` (FTS5 trigrams), which triggers keep in step.

export interface AssistantCardRecord {
  /** The plugin whose tool returned it; empty for the studio's own cards (`templates`). */
  plugin: string;
  tool: string;
  data: unknown;
}

/** A tool the assistant called in a turn, as the chat shows it (AG-UI's tool call). */
export interface AssistantToolCallRecord {
  toolCallId: string;
  toolCallName: string;
  args: unknown;
  /** What the tool gave back, cut short. */
  result?: string;
}

export const assistantChat = sqliteTable(
  "assistant_chat",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    /** Set when the chat is closed; null for the open one. */
    title: text("title"),
    /**
     * Open: what the messages folded away said (`folded` of them, oldest first). Closed: the dense
     * summary of the whole chat — what was asked, what changed, what is still open.
     */
    summary: text("summary"),
    folded: integer("folded").notNull().default(0),
    createdAt: createdAt(),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("assistant_chat_user").on(t.tenantId, t.userId, t.closedAt)],
);

export const assistantMessage = sqliteTable(
  "assistant_message",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => assistantChat.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    /** Cards of plugins' tools, with their data, so an earlier chat shows them again. */
    cards: text("cards", { mode: "json" }).$type<AssistantCardRecord[]>(),
    toolCalls: text("tool_calls", { mode: "json" }).$type<AssistantToolCallRecord[]>(),
    /** The page the person wrote from: route and title (the snapshot of that turn, cut short). */
    page: text("page", { mode: "json" }).$type<{ route: string; title?: string }>(),
    changed: integer("changed", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("assistant_message_chat").on(t.chatId, t.createdAt)],
);

// --- Work's chats (behind `workMode`) --------------------------------------------
// A chat belongs to a space, has members (people, later engenties) and lives in a section of
// the space's sidebar or in none. A sub-thread is a chat with a parent. A private chat is seen by
// its members only; any other chat by everyone of the tenant. The messages are Mastra's: a
// memory thread per chat (thread id = chat id, resource id = the space), in Mastra's tables of
// the same database (services/work-mastra.ts). The chat row keeps what the sidebar shows.

export const chatSection = sqliteTable(
  "chat_section",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("chat_section_space").on(t.spaceId, t.position)],
);

export const chat = sqliteTable(
  "chat",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sectionId: text("section_id").references(() => chatSection.id, { onDelete: "set null" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => chat.id, {
      onDelete: "cascade",
    }),
    private: integer("private", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    /** The last message's time, else when it was made: the sidebar's order. */
    updatedAt: updatedAt(),
    /** The last message for the sidebar: who wrote it ("ai" for the space's AI), its start. */
    lastAuthorId: text("last_author_id"),
    lastAuthorName: text("last_author_name"),
    lastText: text("last_text"),
    /** Since when the space's AI answers here; null while it doesn't. Others follow the turn. */
    answeringSince: integer("answering_since", { mode: "timestamp_ms" }),
  },
  (t) => [index("chat_space").on(t.spaceId, t.updatedAt), index("chat_parent").on(t.parentId)],
);

export const chatMember = sqliteTable(
  "chat_member",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["person", "engenty"] }).notNull(),
    /** A person's user id, an engenty's id. */
    memberId: text("member_id").notNull(),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.kind, t.memberId] }),
    index("chat_member_member").on(t.kind, t.memberId),
  ],
);

/** What one person did with a chat: pinned it, archived it for themselves, read it up to when. */
export const chatState = sqliteTable(
  "chat_state",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    pinnedAt: integer("pinned_at", { mode: "timestamp_ms" }),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    /** Null: never opened, or marked unread. */
    readAt: integer("read_at", { mode: "timestamp_ms" }),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.userId] })],
);

/**
 * A call of a tool that reaches past the space, held for a person's approval (Work chats, step 3
 * piece 4). Approve runs the stored call once with the stored arguments; Deny doesn't. Either way
 * the AI hears of it in the chat and goes on.
 */
export const chatApproval = sqliteTable(
  "chat_approval",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    input: text("input", { mode: "json" }).$type<unknown>(),
    /** Who the turn was for: the call runs with their access, and they may decide. */
    askedBy: text("asked_by").notNull(),
    /**
     * Whose decision it waits for: the asker's (a confirmed action, a plugin's tool), or the
     * space's admins' („Mit Freigabe“ on a connection that signs in as the space, A7).
     */
    heldFor: text("held_for", { enum: ["asker", "admins"] })
      .notNull()
      .default("asker"),
    state: text("state", { enum: ["pending", "approved", "denied", "failed"] })
      .notNull()
      .default("pending"),
    output: text("output", { mode: "json" }).$type<unknown>(),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("chat_approval_chat").on(t.chatId, t.createdAt),
    index("chat_approval_state").on(t.tenantId, t.state),
  ],
);

// --- The wizard's store ------------------------------------------------------
// What a wizard keeps between runs for one person. `holder` is that person: "u:<userId>" for a
// signed-in admin, "v:<visitorId>" for an end user on a shared link.

/** One (wizard, person) pair that has stored something; `usedAt` drives the clean-up. */
export const storeHolder = sqliteTable(
  "store_holder",
  {
    wizardId: text("wizard_id")
      .notNull()
      .references(() => wizard.id, { onDelete: "cascade" }),
    holder: text("holder").notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.wizardId, t.holder] }), index("store_holder_used").on(t.usedAt)],
);

/** A row of one of the wizard's lists. Columns are defined in the wizard, values live here. */
export const storeRow = sqliteTable(
  "store_row",
  {
    id: text("id").primaryKey(),
    wizardId: text("wizard_id")
      .notNull()
      .references(() => wizard.id, { onDelete: "cascade" }),
    holder: text("holder").notNull(),
    list: text("list").notNull(),
    /** The key column's value, normalised; saving a row with a known key updates that row. */
    key: text("key"),
    cells: text("cells", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("store_row_key").on(t.wizardId, t.holder, t.list, t.key),
    index("store_row_list").on(t.wizardId, t.holder, t.list, t.createdAt),
  ],
);

/** A file the wizard keeps (a downloaded invoice, a scan). Content lives in the blob store. */
export const storeFile = sqliteTable(
  "store_file",
  {
    wizardId: text("wizard_id")
      .notNull()
      .references(() => wizard.id, { onDelete: "cascade" }),
    holder: text("holder").notNull(),
    path: text("path").notNull(),
    hash: text("hash").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    source: text("source"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.wizardId, t.holder, t.path] })],
);

/** A connected account or a kept browser session. `data` is encrypted. */
export const storeSecret = sqliteTable(
  "store_secret",
  {
    id: text("id").primaryKey(),
    wizardId: text("wizard_id")
      .notNull()
      .references(() => wizard.id, { onDelete: "cascade" }),
    holder: text("holder").notNull(),
    /** "connection:<id>" or "browser:<host>". */
    slot: text("slot").notNull(),
    provider: text("provider").notNull(),
    /** Shown to the person: the account's address or the site's name. */
    label: text("label").notNull(),
    data: text("data").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("store_secret_slot").on(t.wizardId, t.holder, t.slot)],
);

/** Marketplace entries starred here: the runtime keeps them for offline use. */
export const marketplaceStar = sqliteTable(
  "marketplace_star",
  {
    tenantId: text("tenant_id").notNull(),
    entryId: text("entry_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.entryId] })],
);

/**
 * A connection of a space (docs/plans/capabilities.md, "Connections"): a service the space's
 * admins set up, with how it signs in, who may use it and what each kind of action may do. One
 * that signs in as the space keeps its secret here, sealed; one each person signs in to keeps
 * theirs in `space_connection_sign_in`. Nobody owns it: `set_up_by` only records who did.
 */
export const spaceConnection = sqliteTable(
  "space_connection",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    /** A built-in connector's id (`google-calendar`, `hubspot`) or a `space_connector` of the space. */
    connectorId: text("connector_id").notNull(),
    /** The plugin that set it up through `server.connections`, where one did. */
    plugin: text("plugin"),
    /** What people call it: „Vertrieb“, „Bestellungen“. */
    name: text("name").notNull(),
    /** A `space` sign-in: the account as the provider names it; null until signed in. */
    label: text("label"),
    signIn: text("sign_in", { enum: CONNECTION_SIGN_INS }).notNull(),
    audience: text("audience", { enum: CONNECTION_AUDIENCES }).notNull(),
    rules: text("rules", { mode: "json" }).$type<ConnectionRules>().notNull(),
    /** The connector's actions it is made for (the provider granted what they need); empty: every action. */
    actions: text("actions", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** A `space` sign-in's tokens or keys, sealed; the broker alone unseals them. */
    secret: text("secret"),
    setUpBy: text("set_up_by"),
    setUpAt: integer("set_up_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: updatedAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("space_connection_space").on(t.spaceId)],
);

/** A person's own sign-in to a connection in which each person signs in. `secret` is sealed. */
export const spaceConnectionSignIn = sqliteTable(
  "space_connection_sign_in",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => spaceConnection.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /** The account as the provider names it. */
    label: text("label").notNull(),
    secret: text("secret").notNull(),
    signedInAt: integer("signed_in_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.userId] })],
);

/**
 * Every call that reaches outside through the broker (`broker/call.ts`): who called, where, which
 * connection and action, what was decided and how it went. Append-only; a secret never goes in.
 */
export const brokerLog = sqliteTable(
  "broker_log",
  {
    id: text("id").primaryKey(),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    /** guest, person, admin, goose, plugin, step. */
    whoKind: text("who_kind").notNull(),
    whoId: text("who_id"),
    runId: text("run_id"),
    /** The step of the run that called; null outside a step. */
    stepId: text("step_id"),
    /** The outside client that called, as it names itself (an MCP client, `x-wizards-client`); null inside the runtime. */
    client: text("client"),
    chatId: text("chat_id"),
    wizardId: text("wizard_id"),
    spaceId: text("space_id"),
    connectionId: text("connection_id").notNull(),
    actionId: text("action_id").notNull(),
    /** read, write, destructive, send. */
    kind: text("kind").notNull(),
    /** The input's field names and sizes, one clipped value that is no secret, a hash of the whole. */
    inputSummary: text("input_summary").notNull(),
    /** allow, ask, deny. */
    outcome: text("outcome").notNull(),
    /** Which rule decided (broker/call.ts `decide`): `grant`, `audience`, `rules.write`, `policy`, …; null where none did. */
    rule: text("rule"),
    reason: text("reason"),
    /** ok, declined, nobody, not_connected, or the error's class. */
    result: text("result"),
    resultSize: integer("result_size"),
    critical: integer("critical", { mode: "boolean" }).notNull().default(false),
    /** Which of the critical kinds (broker/log.ts `CriticalKind`); null where the row is not critical. */
    criticalKind: text("critical_kind"),
  },
  (t) => [
    index("broker_log_connection").on(t.connectionId, t.at),
    index("broker_log_space").on(t.spaceId, t.at),
    index("broker_log_critical").on(t.spaceId, t.critical, t.at),
    index("broker_log_run").on(t.runId),
    index("broker_log_wizard").on(t.wizardId, t.kind, t.at),
  ],
);

/**
 * When a person of the tenant was last in the app, and when they last opened Work's bell. The
 * hourly mail of the broker's critical lines goes out only where no admin was in the app since
 * the last one (broker/notify.ts); the bell's count is what came in since the bell was opened.
 */
export const personSeen = sqliteTable("person_seen", {
  userId: text("user_id").primaryKey(),
  seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull(),
  bellSeenAt: integer("bell_seen_at", { mode: "timestamp_ms" }),
});

// --- The two-way sync -----------------------------------------------------------
// A space that syncs with the organization in the cloud (docs/plans/tenant-sync.md). Triggers
// on the synced tables note every write in `sync_change` (see the migration); the cloud numbers
// its changes there, an install finds there what it has not pushed yet.

/** One change of an item: which space, which kind of item, which one. */
export const syncChange = sqliteTable(
  "sync_change",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    spaceId: text("space_id").notNull(),
    kind: text("kind").notNull(),
    item: text("item").notNull(),
    at: integer("at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    index("sync_change_item").on(t.kind, t.item),
    index("sync_change_space").on(t.spaceId, t.seq),
  ],
);

/**
 * Live changes (docs/plans/live-changes.md): triggers (`db/live-triggers.ts`) number every write
 * to an item a studio shows, pulled ones too, so an open studio hears of it. Kept 15 minutes.
 */
export const liveChange = sqliteTable(
  "live_change",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    spaceId: text("space_id"),
    kind: text("kind").notNull(),
    /** `put` or `del`. */
    op: text("op").notNull(),
    item: text("item").notNull(),
    parent: text("parent"),
    at: integer("at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("live_change_at").on(t.at)],
);

/**
 * Who is in a wizard, page or table right now (docs/plans/live-changes.md, 8): a person in an
 * editor, the studio assistant during its turn, an MCP client or API key for a minute after it
 * read or wrote. A signal, never a lock. A row unseen for 45 seconds is gone.
 */
export const livePresence = sqliteTable(
  "live_presence",
  {
    kind: text("kind").notNull(),
    item: text("item").notNull(),
    /** The person's id, or the client's for an agent. */
    who: text("who").notNull(),
    /** One editor of that person: a tab. */
    tab: text("tab").notNull().default(""),
    /** `person`, `agent` (MCP, API), `assistant`, `run`. */
    whoKind: text("who_kind").notNull(),
    name: text("name").notNull(),
    /** The app an agent acts through; for the assistant, whom it acts for. */
    client: text("client"),
    /** Where in the item: a step, a section, a row; and how to say it. */
    place: text("place"),
    placeLabel: text("place_label"),
    /** `viewing` or `editing`. */
    state: text("state").notNull(),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.item, t.who, t.tab] }),
    index("live_presence_seen").on(t.seenAt),
  ],
);

/** One row: `applying` is 1 while an install writes what it pulled, so the triggers note none of it. */
export const syncGuard = sqliteTable("sync_guard", {
  id: integer("id").primaryKey(),
  applying: integer("applying").notNull().default(0),
});

/**
 * The version of an item both sides last agreed on, with the cloud's number of it: the common
 * ancestor a three-way merge starts from. Kept by an install.
 */
export const syncBase = sqliteTable(
  "sync_base",
  {
    kind: text("kind").notNull(),
    item: text("item").notNull(),
    spaceId: text("space_id").notNull(),
    seq: integer("seq").notNull(),
    record: text("record", { mode: "json" }).$type<Record<string, unknown> | null>(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.item] }), index("sync_base_space").on(t.spaceId)],
);

/** An item both sides changed, where the merge was not clean: it waits for the person. */
export const syncConflict = sqliteTable(
  "sync_conflict",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    kind: text("kind").notNull(),
    item: text("item").notNull(),
    /** The cloud's number of its version. */
    seq: integer("seq").notNull(),
    base: text("base", { mode: "json" }).$type<Record<string, unknown> | null>(),
    local: text("local", { mode: "json" }).$type<Record<string, unknown> | null>(),
    remote: text("remote", { mode: "json" }).$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sync_conflict_item").on(t.kind, t.item)],
);

/** A merge the sync made by itself: the notice on the item, and what undoes it. */
export const syncMerge = sqliteTable(
  "sync_merge",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    kind: text("kind").notNull(),
    item: text("item").notNull(),
    /** Labels of the places each side changed. */
    local: text("local", { mode: "json" }).$type<string[]>().notNull(),
    remote: text("remote", { mode: "json" }).$type<string[]>().notNull(),
    /** Both sides before the merge. */
    before: text("before", { mode: "json" })
      .$type<{ local: Record<string, unknown> | null; remote: Record<string, unknown> | null }>()
      .notNull(),
    seen: integer("seen", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("sync_merge_item").on(t.kind, t.item, t.createdAt)],
);

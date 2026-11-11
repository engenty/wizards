import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { note, noteText, RUN_HOST_KINDS, runHostRefSchema } from "@engenty/wizards-shared/run";
import { blobHash, missingBlobsSchema, pushSchema } from "@engenty/wizards-shared/sync";
import { PACKAGE_MIME } from "@engenty/wizards-shared/wizard-package";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { tokenOf } from "../broker/token.js";
import { checkWizard } from "../cli/validate.js";
import { clientOf, clientRefused } from "../clients.js";
import { balanceCredits, canSpend } from "../credits/credits.js";
import { db, schema, withTenant } from "../db/client.js";
import { HostUnfit } from "../engine/hosts.js";
import { runStore } from "../engine/run-store.js";
import { createRun, NoCreditsError } from "../engine/runner.js";
import { env } from "../env.js";
import { feature, remoteFeatures } from "../features.js";
import { allowed } from "../limits.js";
import { newestSeq } from "../live/feed.js";
import { nudge } from "../live/hub.js";
import { followFor, notePush } from "../live/origin.js";
import { managed, tenantInfo } from "../manage.js";
import { authenticate, type Principal, principalOf } from "../mcp/auth.js";
import type { Scope } from "../mcp/scopes.js";
import { ModelUnavailableError, saidOf } from "../model-errors.js";
import { loadedPlugin, pluginIdsOf } from "../plugins/registry.js";
import { asRole, mayBuild, mayCreate } from "../services/access.js";
import { apiRun, apiRuns, apiSpaceDetails, apiSpaces, apiWizards } from "../services/api.js";
import { notFound, ServiceError } from "../services/errors.js";
import { deleteFile, draftFiles, writeFile } from "../services/files.js";
import { asLang, searchMarketplace } from "../services/marketplace.js";
import { requireStudio } from "../services/members-studio.js";
import { exportWizard } from "../services/package.js";
import { siteJob, siteSchema, startSiteJob } from "../services/site.js";
import {
  checkOnServer,
  checkSchema,
  listSyncedSpaces,
  patchSyncedWizard,
  removeSyncedSpace,
  removeSyncedWizard,
  rotateSyncedLink,
  syncDataSchema,
  syncSettingsSchema,
  syncSpaceData,
  syncWizard,
  syncWizardSchema,
} from "../services/synced-spaces.js";
import {
  createWizard,
  ownedWizard,
  publishWizard,
  requireClean,
  writeDraft,
} from "../services/wizards.js";
import {
  adoptSpace,
  blobBytes,
  missingBlobs,
  publishSynced,
  pullChanges,
  pushChanges,
  rotateSynced,
  syncHears,
  syncOverview,
  takeBlob,
} from "../sync/hub.js";
import { codeOf, tenantStatus } from "../tenants/control.js";
import { notFoundAnswer, requestLang, say } from "./lang.js";
import { dispatchAs } from "./plugins.js";

/** A wizard's workspace as a request carries it: each file's bytes as base64. */
const importFilesSchema = z
  .array(z.object({ path: z.string(), mime: z.string().optional(), data: z.string() }))
  .max(200)
  .default([]);
type ImportFile = z.infer<typeof importFilesSchema>[number];

const importSchema = z.object({
  /** An earlier import's wizard: it is updated instead of a new one being made. */
  wizardId: z.string().optional(),
  spaceId: z.string().optional(),
  definition: z.unknown(),
  files: importFilesSchema,
  publish: z.boolean().default(false),
});

/**
 * A run the caller drives on its own machine (`wizards run`): the wizard by its id, its published
 * version; or a definition with its workspace, written as the draft of `wizardId` (or of a new
 * wizard of the space) and started as a test run of it.
 */
const hostStartSchema = z
  .object({
    host: z.enum(RUN_HOST_KINDS),
    /** Where the host answers; without it the host is not reached from here. */
    url: runHostRefSchema.shape.url.optional(),
    wizardId: z.string().min(1).max(200).optional(),
    definition: z.unknown().optional(),
    files: importFilesSchema,
  })
  .refine((body) => body.wizardId !== undefined || body.definition !== undefined, {
    message: "Give a wizardId or a definition.",
  });

/** The host's address on a run whose host this runtime does not reach. */
const UNREACHED_HOST = "local";

/**
 * A whole wizard from outside as the draft of a wizard of the tenant: `wizardId`'s, when it is
 * one, else a new one in `spaceId` (the default space without). Its workspace is replaced by
 * `files`. In the caller's tenant.
 */
async function importDraft(
  who: Principal,
  input: { wizardId?: string; spaceId?: string; definition: unknown; files: ImportFile[] },
) {
  const writer = { source: "mcp" as const, client: who.client };
  let wizardId = input.wizardId;
  if (wizardId) {
    await requireStudio("wizards", wizardId);
    const existing = await ownedWizard(who.userId, wizardId).catch(() => null);
    wizardId = existing?.id;
  }
  if (!wizardId) {
    // The workspace must be there before the definition is checked against it.
    const created = await createWizard(who.userId, { spaceId: input.spaceId }, writer);
    wizardId = created.id;
  }
  const incoming = new Set(input.files.map((f) => f.path));
  for (const old of await draftFiles(wizardId)) {
    if (!incoming.has(old.path)) {
      await deleteFile(who.userId, wizardId, old.path);
    }
  }
  for (const file of input.files) {
    await writeFile(who.userId, wizardId, file.path, Buffer.from(file.data, "base64"), file.mime);
  }
  const current = await ownedWizard(who.userId, wizardId);
  const written = await writeDraft(
    who.userId,
    wizardId,
    { definition: input.definition, baseRevision: current.revision },
    writer,
  );
  return { wizardId, written, current };
}

/** Whether the tenant's runs may be driven elsewhere: they need their services over HTTP. */
async function wizardsRunOn(): Promise<boolean> {
  const switches = await remoteFeatures().catch(() => null);
  return feature("wizardsRun", switches) && feature("runServices", switches);
}

/** What `createRun` starts with, but for who starts it and where. */
interface Start {
  wizardId: string;
  definition: WizardDefinition;
  files: WorkspaceFile[];
  version: number | null;
  mode: "test" | "live";
}

/** A wizard of the space by its id: its published version, as a live run. */
async function publishedStart(who: Principal, spaceId: string, wizardId: string): Promise<Start> {
  await requireStudio("wizards", wizardId);
  const w = await ownedWizard(who.userId, wizardId);
  if (w.spaceId !== spaceId) {
    throw notFound();
  }
  const version =
    w.publishedVersion === null
      ? undefined
      : await db.query.wizardVersion.findFirst({
          where: and(
            eq(schema.wizardVersion.wizardId, w.id),
            eq(schema.wizardVersion.version, w.publishedVersion),
          ),
        });
  if (!version) {
    throw new ServiceError(
      "refused",
      "This wizard isn’t published yet. Publish it, or send its definition to try the draft.",
    );
  }
  return {
    wizardId: w.id,
    definition: version.definition,
    files: version.files,
    version: w.publishedVersion,
    mode: "live",
  };
}

/**
 * A definition with its workspace: checked as `wizards validate` checks it, written as the draft
 * of `wizardId` (or of a new wizard of the space), checked against the space as the studio checks
 * a draft, and started as a test run of that draft.
 */
async function draftStart(
  who: Principal,
  spaceId: string,
  input: { wizardId?: string; definition: unknown; files: ImportFile[] },
): Promise<Start> {
  const bytes = new Map(input.files.map((f) => [f.path, Buffer.from(f.data, "base64")]));
  const checked = await checkWizard({
    definition: input.definition,
    files: [...bytes.keys()],
    read: async (path) => bytes.get(path)?.toString("utf8") ?? null,
  });
  if (!checked.ok) {
    throw new ServiceError("has_issues", note("wizardStillErrors"), { issues: checked.issues });
  }
  if (input.wizardId) {
    await requireStudio("wizards", input.wizardId);
    if ((await ownedWizard(who.userId, input.wizardId)).spaceId !== spaceId) {
      throw notFound();
    }
  }
  const { wizardId } = await importDraft(who, { ...input, spaceId });
  const { definition, files } = await requireClean(await ownedWizard(who.userId, wizardId));
  return { wizardId, definition, files, version: null, mode: "test" };
}

/** Runs a call in the caller's tenant, as the caller's role. */
export const inTenantAs = async <T>(who: Principal, fn: () => T | Promise<T>) => {
  try {
    return await withTenant(who.tenantId, () => asRole(who.role, fn));
  } finally {
    nudge(who.tenantId);
  }
};

/**
 * A call on one space, as `inTenantAs`: refused where the space's Studio is closed to the caller,
 * as the studio API refuses it (services/members-studio.ts).
 */
const inSpaceAs = <T>(who: Principal, spaceId: string, fn: () => T | Promise<T>) =>
  inTenantAs(who, async () => {
    await requireStudio("spaces", spaceId);
    return fn();
  });

const HOUR = 60 * 60 * 1000;

/** Where the account of a managed runtime is looked after: plan, credits, keys. */
const accountUrl = () => env.manage.url || null;

/** Plugins of the plans above Free that a client offers when the tenant lacks them. */
const PRO_PLUGINS = ["contacts", "appointments"];
/** A wizard with its workspace: 25 MB of files as base64, and the definition. */
const WIZARD_BYTES = 48 * 1024 * 1024;

const tooLarge = bodyLimit({
  maxSize: WIZARD_BYTES,
  onError: (c) => c.json({ error: "The request is too large.", code: "too_large" }, 413),
});

/**
 * The caller of an API call, signed in like an MCP client (access token or API key), with the
 * scopes the call needs; or the answer that turns it away.
 */
export async function caller(
  c: Context,
  scopes: Scope[],
  { clients = false }: { clients?: boolean } = {},
): Promise<Principal | Response> {
  const authInfo = await authenticate(c.req.raw);
  if (authInfo instanceof Response) {
    return authInfo;
  }
  const who = principalOf(authInfo);
  // A client of the organization uses its client spaces' elements, nothing else of the API
  // (docs/plans/client-spaces.md).
  if (who.role === "client" && !clients) {
    return c.json({ error: "This isn’t open to clients.", code: "forbidden" }, 403);
  }
  const lacking = lacksScopes(c, who, scopes);
  if (lacking) {
    return lacking;
  }
  if ((await tenantStatus(who.tenantId)) === "suspended") {
    return c.json(
      {
        error: say(c, "accountSuspended"),
        code: "tenant_suspended",
      },
      403,
    );
  }
  return who;
}

/** The answer that turns a caller away who lacks one of `scopes`; null when it has them all. */
function lacksScopes(c: Context, who: Principal, scopes: Scope[]): Response | null {
  return scopes.some((scope) => !who.scopes.includes(scope))
    ? c.json({ error: "This token isn’t allowed to do that.", code: "insufficient_scope" }, 403)
    : null;
}

/**
 * The two-way sync follows the studio's saves: an install pushes a space at most every few
 * seconds while someone edits, and pulls when a page opens.
 */
const TWO_WAY_LIMITS = { push: 1200, pull: 3600 };

function withinTwoWayLimit(c: Context, who: Principal, what: "push" | "pull"): Response | null {
  return allowed(`two-way-${what}:${who.tenantId}`, TWO_WAY_LIMITS[what], HOUR)
    ? null
    : c.json({ error: say(c, "tooManyTransfersTry"), code: "rate_limited" }, 429);
}

/** What one push carries: records, without the files' bytes (they go one by one). */
const twoWayBody = bodyLimit({
  maxSize: 16 * 1024 * 1024,
  onError: (c) => c.json({ error: "The request is too large.", code: "too_large" }, 413),
});

/** A local install sends when it publishes: more than this an hour is not an install at work. */
function withinSyncLimit(c: Context, who: Principal): Response | null {
  return allowed(`sync:${who.tenantId}`, 240, HOUR)
    ? null
    : c.json(
        {
          error: say(c, "tooManyTransfersTry"),
          code: "rate_limited",
        },
        429,
      );
}

/**
 * A plugin's routes for a client with a key or token (the WordPress plugin's Kontakte, Termine):
 * the plugin's own `registerHttpRoute`s, as the key's person. Reading needs `wizards:read`,
 * anything else `wizards:write`. A plugin the tenant's plan lacks answers `403 { code: "plugin" }`.
 */
async function pluginCall(c: Context): Promise<Response> {
  const who = await caller(c, [c.req.method === "GET" ? "wizards:read" : "wizards:write"]);
  if (who instanceof Response) {
    return who;
  }
  const id = c.req.param("id") ?? "";
  if (!(await pluginIdsOf(who.tenantId)).has(id)) {
    return loadedPlugin(id) || PRO_PLUGINS.includes(id)
      ? c.json(
          {
            error: say(c, "pluginNotPartPlan"),
            code: "plugin",
            plugin: id,
          },
          403,
        )
      : c.json(notFoundAnswer(c), 404);
  }
  return inTenantAs(who, () =>
    dispatchAs(c, {
      id: who.userId,
      tenantId: who.tenantId,
      role: who.role,
      name: who.name ?? "",
      email: who.email ?? "",
    }),
  );
}

const runsQuery = z.object({
  space: z.string().optional(),
  wizard: z.string().optional(),
  status: z.enum(["done", "open", "all"]).optional(),
  q: z.string().max(200).optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
});

/**
 * The runtime's API for other programs. `/spaces/…` is how a local install's space comes
 * here: the wizards it publishes, under the ids they have there (docs/manage-contract.md).
 * `POST /wizards/import` takes a whole wizard as a new one of a tenant that builds here.
 */
export const apiRoutes = new Hono()
  // Who the key or token acts for, and what the account has: plan, plugins, spaces, credits.
  .get("/me", async (c) => {
    const who = await caller(c, []);
    if (who instanceof Response) {
      return who;
    }
    const info = managed ? await tenantInfo(who.tenantId).catch(() => null) : null;
    return inTenantAs(who, async () => {
      const plugins = [...(await pluginIdsOf(who.tenantId))].sort();
      const account = accountUrl();
      return c.json({
        user: { id: who.userId, name: who.name ?? "", email: who.email ?? "", role: who.role },
        tenant: {
          id: who.tenantId,
          name: info?.name ?? "",
          plan: info?.plan ?? null,
          credits: await balanceCredits(),
        },
        /** Makes and changes wizards and spaces here; Free builds in the local app. */
        build: await mayBuild(),
        create: await mayCreate(),
        plugins,
        /** What a plan above this one would add. */
        missing: PRO_PLUGINS.filter((id) => !plugins.includes(id)),
        spaces: await apiSpaces(who.userId),
        scopes: who.scopes,
        client: who.client,
        urls: {
          app: env.appUrl,
          embed: `${env.publicUrl}/embed.js`,
          studio: `${env.appUrl}/studio`,
          newWizard: `${env.appUrl}/studio/new`,
          space: `${env.appUrl}/studio/space`,
          account: account,
          billing: account ? `${account}/billing` : null,
          upgrade: account ? `${account}/billing?upgrade=pro` : null,
        },
      });
    });
  })
  // The wizards of the caller's spaces: published ones with their link and ID, drafts without.
  .get("/wizards", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    return inTenantAs(who, async () =>
      c.json({ wizards: await apiWizards(who.userId, c.req.query("space")) }),
    );
  })
  // The published wizard as a `.wizard` package: what a WordPress site runs on its own; with
  // `knowledge=1` the space's pages come along as files (up to the snapshot's cap).
  .get("/wizards/:id/package", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    return inTenantAs(who, async () => {
      await requireStudio("wizards", c.req.param("id"));
      const found = await exportWizard(who.userId, c.req.param("id"), {
        published: true,
        knowledge: c.req.query("knowledge") === "1",
      });
      if (!found) {
        return c.json(
          {
            error: say(c, "wizardNotPublishedYet"),
            code: "not_found",
          },
          404,
        );
      }
      return new Response(new Uint8Array(found.zip), {
        headers: {
          "content-type": PACKAGE_MIME,
          "content-disposition": `attachment; filename="${found.name}"`,
          "cache-control": "no-store",
        },
      });
    });
  })
  // A new wizard from a template, published at once: what a website starts with.
  .post("/wizards", async (c) => {
    const who = await caller(c, ["wizards:write", "wizards:publish"]);
    if (who instanceof Response) {
      return who;
    }
    const body = z
      .object({
        starterId: z.string().min(1).max(200),
        spaceId: z.string().optional(),
        lang: z.string().max(10).optional(),
        publish: z.boolean().default(true),
      })
      .parse(await c.req.json());
    return inTenantAs(who, async () => {
      const writer = { source: "mcp" as const, client: who.client };
      const created = await createWizard(
        who.userId,
        { spaceId: body.spaceId, starterId: body.starterId, lang: body.lang },
        writer,
      );
      let published = false;
      if (body.publish && !created.issues.length) {
        published = await publishWizard(who.userId, created.id).then(
          () => true,
          () => false,
        );
      }
      const wizard = (await apiWizards(who.userId)).find((w) => w.id === created.id);
      return c.json({ wizard, published, issues: created.issues });
    });
  })
  // What a new wizard can start from: the plugins' starters first, then the marketplace's.
  .get("/templates", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    const q = c.req.query("q")?.trim() ?? "";
    return inTenantAs(who, async () => {
      const { entries } = await searchMarketplace({
        q,
        lang: asLang(c.req.query("lang")),
        limit: 40,
      });
      return c.json({
        templates: entries
          .filter((e) => e.usable && (q || e.starter))
          .map((e) => ({
            id: e.id,
            title: e.title,
            pitch: e.pitch,
            avatar: e.avatar,
            language: e.language,
            useCases: e.useCases,
            formats: e.formats,
            plan: e.plan ?? "free",
            plugin: e.plugin ?? null,
            /** Plugins the tenant lacks: a wizard made from it would not run. */
            needs: e.needs ?? [],
            credits: e.credits,
          })),
      });
    });
  })
  // What visitors left: the live runs of the caller's wizards, by pages of 50.
  .get("/runs", async (c) => {
    const who = await caller(c, ["runs:read"]);
    if (who instanceof Response) {
      return who;
    }
    const query = runsQuery.parse(c.req.query());
    return inTenantAs(who, async () =>
      c.json(
        await apiRuns(who.userId, {
          spaceId: query.space,
          wizardId: query.wizard,
          status: query.status,
          q: query.q,
          days: query.days,
          page: query.page,
        }),
      ),
    );
  })
  .get("/runs/:id", async (c) => {
    const who = await caller(c, ["runs:read"]);
    if (who instanceof Response) {
      return who;
    }
    return inTenantAs(who, async () => c.json(await apiRun(who.userId, c.req.param("id"))));
  })
  // The space's own details: title, about, colours, facts, logo, how much Knowledge it holds.
  .get("/space", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    return inTenantAs(who, async () =>
      c.json(await apiSpaceDetails(who.userId, c.req.query("space"))),
    );
  })
  // A website reads itself into the space (services/site.ts); answers with the job to ask after.
  .post("/space/site", tooLarge, async (c) => {
    const who = await caller(c, ["wizards:write"]);
    if (who instanceof Response) {
      return who;
    }
    if (!allowed(`site:${who.tenantId}`, 20, HOUR)) {
      return c.json(
        {
          error: say(c, "tooManyTimesRow"),
          code: "rate_limited",
        },
        429,
      );
    }
    const body = siteSchema.parse(await c.req.json());
    return inTenantAs(who, async () => c.json(await startSiteJob(who, body)));
  })
  .get("/space/site/:job", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    return inTenantAs(who, () => c.json(siteJob(c.req.param("job"))));
  })
  .all("/plugins/:id", pluginCall)
  .all("/plugins/:id/*", pluginCall)
  .get("/spaces", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    return inTenantAs(who, async () => c.json({ spaces: await listSyncedSpaces() }));
  })
  .post("/spaces/check", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    const body = checkSchema.parse(await c.req.json());
    return inTenantAs(who, async () => c.json({ problems: await checkOnServer(body) }));
  })
  // A run the caller drives on its own machine (`wizards run`): the record, the checks and the
  // token here, the run there (docs/plans/runs-on-their-own.md, phase 5).
  .post("/spaces/:spaceId/runs", tooLarge, async (c) => {
    const who = await caller(c, []);
    if (who instanceof Response) {
      return who;
    }
    // While the tenant has it off, the route isn't there.
    if (!(await inTenantAs(who, wizardsRunOn))) {
      return c.json(notFoundAnswer(c), 404);
    }
    const lacking = lacksScopes(c, who, ["runs:host"]);
    if (lacking) {
      return lacking;
    }
    const body = hostStartSchema.parse(await c.req.json());
    const writes = body.definition !== undefined && lacksScopes(c, who, ["wizards:write"]);
    if (writes) {
      return writes;
    }
    if (body.host !== "node") {
      return c.json(
        {
          error: `A run can’t live on a "${body.host}" host yet. Start it on "node".`,
          code: "host",
        },
        400,
      );
    }
    const client = clientOf(c);
    const spaceId = c.req.param("spaceId");
    return inSpaceAs(who, spaceId, async () => {
      // The client that starts it: on a managed runtime the Manage-App's list says which may.
      const refused = clientRefused(client);
      if (refused) {
        return c.json(
          { error: noteText({ code: refused.note }, requestLang(c)), code: refused.code },
          refused.status,
        );
      }
      const start =
        body.definition === undefined
          ? await publishedStart(who, spaceId, body.wizardId ?? "")
          : await draftStart(who, spaceId, { ...body, definition: body.definition });
      if (!(await canSpend())) {
        throw new ServiceError("no_credits", note("creditsUsedUp"));
      }
      let runId: string;
      try {
        runId = await createRun({
          ...start,
          userId: who.userId,
          client,
          drivenOn: { kind: body.host, url: body.url ?? UNREACHED_HOST },
        });
      } catch (err) {
        if (err instanceof HostUnfit) {
          return c.json({ error: err.message, code: "host_unfit", missing: err.missing }, 409);
        }
        if (err instanceof ModelUnavailableError) {
          throw new ServiceError("refused", saidOf(err));
        }
        if (err instanceof NoCreditsError) {
          throw new ServiceError("no_credits", note("creditsUsedUp"));
        }
        throw err;
      }
      // Signed from the record, which names the caller's host now.
      const run = await runStore.get(runId);
      const token = run && (await tokenOf(run));
      if (!(run && token)) {
        throw new Error(`The run ${runId} has no token.`);
      }
      return c.json({
        runId,
        wizardId: run.wizardId,
        token,
        /** Where the run's services answer, under `/api/run-services/v1`. */
        services: env.appUrl,
        host: run.host,
        definition: run.definition,
        files: run.files,
        /** The run as `createRun` left it: where the host's own start finds it too. */
        run: {
          cursor: run.cursor,
          status: run.status,
          state: run.state,
          wakeAt: run.wakeAt?.getTime() ?? null,
          rev: run.rev,
        },
      });
    });
  })
  .put("/spaces/:spaceId/wizards/:wizardId", tooLarge, async (c) => {
    const who = await caller(c, ["wizards:write", "wizards:publish"]);
    if (who instanceof Response) {
      return who;
    }
    const limited = withinSyncLimit(c, who);
    if (limited) {
      return limited;
    }
    const body = syncWizardSchema.parse(await c.req.json());
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json(await syncWizard(c.req.param("spaceId"), c.req.param("wizardId"), body)),
    );
  })
  // The space's own tables and pages, sent with a wizard when they changed.
  .put("/spaces/:spaceId/data", tooLarge, async (c) => {
    const who = await caller(c, ["wizards:write"]);
    if (who instanceof Response) {
      return who;
    }
    const limited = withinSyncLimit(c, who);
    if (limited) {
      return limited;
    }
    const body = syncDataSchema.parse(await c.req.json());
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json(await syncSpaceData(c.req.param("spaceId"), body)),
    );
  })
  .patch("/spaces/:spaceId/wizards/:wizardId", async (c) => {
    const who = await caller(c, ["wizards:publish"]);
    if (who instanceof Response) {
      return who;
    }
    const limited = withinSyncLimit(c, who);
    if (limited) {
      return limited;
    }
    const body = syncSettingsSchema.parse(await c.req.json());
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json(await patchSyncedWizard(c.req.param("spaceId"), c.req.param("wizardId"), body)),
    );
  })
  .post("/spaces/:spaceId/wizards/:wizardId/rotate-link", async (c) => {
    const who = await caller(c, ["wizards:publish"]);
    if (who instanceof Response) {
      return who;
    }
    const limited = withinSyncLimit(c, who);
    if (limited) {
      return limited;
    }
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json(await rotateSyncedLink(who.userId, c.req.param("spaceId"), c.req.param("wizardId"))),
    );
  })
  .delete("/spaces/:spaceId/wizards/:wizardId", async (c) => {
    const who = await caller(c, ["wizards:write"]);
    if (who instanceof Response) {
      return who;
    }
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json(await removeSyncedWizard(who.userId, c.req.param("spaceId"), c.req.param("wizardId"))),
    );
  })
  .delete("/spaces/:spaceId", async (c) => {
    const who = await caller(c, ["wizards:write"]);
    if (who instanceof Response) {
      return who;
    }
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json(await removeSyncedSpace(c.req.param("spaceId"))),
    );
  })
  // --- the two-way sync of a space (docs/manage-contract.md, "Two-way sync of a space") ---
  .get("/sync", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    return inTenantAs(who, async () => c.json(await syncOverview()));
  })
  // What changed in the organization's spaces, as it happens: an install pulls those spaces now
  // instead of at its next round (docs/plans/live-changes.md, 7).
  .get("/sync/live", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    const on = await inTenantAs(who, async () =>
      feature("liveChanges", await remoteFeatures().catch(() => null)),
    );
    if (!on) {
      return c.json(notFoundAnswer(c), 404);
    }
    const install = c.req.header("x-wizards-install") ?? "";
    const raw = c.req.header("last-event-id") ?? c.req.query("since");
    const since = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    c.header("cache-control", "no-cache, no-transform");
    c.header("x-accel-buffering", "no");
    return streamSSE(c, async (stream) => {
      let closed = false;
      let writing = Promise.resolve();
      const write = (event: string, data: unknown, id?: number) => {
        writing = writing.then(() =>
          closed
            ? undefined
            : stream.writeSSE({
                event,
                data: JSON.stringify(data),
                ...(id === undefined ? {} : { id: String(id) }),
              }),
        );
      };
      const stop = await followFor(
        who.tenantId,
        install,
        since,
        (e) => {
          const { event, ...data } = e;
          write(event, data, e.seq);
        },
        (changes) => asRole(who.role, () => syncHears(changes)),
      );
      stream.onAbort(() => {
        closed = true;
        stop();
      });
      const until = Date.now() + 30 * 60_000;
      while (!closed && Date.now() < until) {
        await stream.sleep(Math.min(20_000, until - Date.now()));
        if (!closed) {
          await writing;
          await stream.writeSSE({ event: "ping", data: "" });
        }
      }
      closed = true;
      stop();
    });
  })
  .get("/sync/spaces/:spaceId/changes", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    const limited = withinTwoWayLimit(c, who, "pull");
    if (limited) {
      return limited;
    }
    const since = Math.max(0, Number.parseInt(c.req.query("since") ?? "0", 10) || 0);
    const cursor = c.req.query("cursor") || undefined;
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json(await pullChanges(c.req.param("spaceId"), since, cursor)),
    );
  })
  .post("/sync/spaces/:spaceId/changes", twoWayBody, async (c) => {
    const who = await caller(c, ["wizards:write"]);
    if (who instanceof Response) {
      return who;
    }
    const limited = withinTwoWayLimit(c, who, "push");
    if (limited) {
      return limited;
    }
    const body = pushSchema.parse(await c.req.json());
    return inSpaceAs(who, c.req.param("spaceId"), async () => {
      // The feed numbers this push writes: the live call does not send them back to this install.
      const push = notePush(who.tenantId, c.req.header("x-wizards-install"), await newestSeq());
      try {
        return c.json(await pushChanges(c.req.param("spaceId"), body, who.userId));
      } finally {
        push.done(await newestSeq());
      }
    });
  })
  .post("/sync/spaces/:spaceId/blobs/missing", async (c) => {
    const who = await caller(c, ["wizards:write"]);
    if (who instanceof Response) {
      return who;
    }
    const body = missingBlobsSchema.parse(await c.req.json());
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json({ missing: await missingBlobs(body.hashes) }),
    );
  })
  .put("/sync/spaces/:spaceId/blobs/:hash", tooLarge, async (c) => {
    const who = await caller(c, ["wizards:write"]);
    if (who instanceof Response) {
      return who;
    }
    const hash = blobHash.parse(c.req.param("hash"));
    const data = new Uint8Array(await c.req.arrayBuffer());
    return inSpaceAs(who, c.req.param("spaceId"), async () => {
      await takeBlob(hash, data).catch(() => {
        throw new ServiceError("invalid", "The bytes do not match their hash.");
      });
      return c.json({ ok: true });
    });
  })
  .get("/sync/spaces/:spaceId/blobs/:hash", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    const hash = blobHash.parse(c.req.param("hash"));
    return inSpaceAs(who, c.req.param("spaceId"), async () => {
      const data = await blobBytes(hash).catch(() => null);
      if (!data) {
        return c.json({ error: "There are no such bytes here.", code: "not_found" }, 404);
      }
      return c.body(new Uint8Array(data), 200, { "content-type": "application/octet-stream" });
    });
  })
  .post("/sync/spaces/:spaceId/wizards/:wizardId/publish", async (c) => {
    const who = await caller(c, ["wizards:write", "wizards:publish"]);
    if (who instanceof Response) {
      return who;
    }
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json(await publishSynced(who.userId, c.req.param("spaceId"), c.req.param("wizardId"))),
    );
  })
  .post("/sync/spaces/:spaceId/wizards/:wizardId/rotate-link", async (c) => {
    const who = await caller(c, ["wizards:publish"]);
    if (who instanceof Response) {
      return who;
    }
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json(await rotateSynced(who.userId, c.req.param("spaceId"), c.req.param("wizardId"))),
    );
  })
  .post("/sync/spaces/:spaceId/adopt", async (c) => {
    const who = await caller(c, ["wizards:write"]);
    if (who instanceof Response) {
      return who;
    }
    return inSpaceAs(who, c.req.param("spaceId"), async () =>
      c.json(await adoptSpace(c.req.param("spaceId"))),
    );
  })
  .post("/wizards/import", tooLarge, async (c) => {
    const authInfo = await authenticate(c.req.raw);
    if (authInfo instanceof Response) {
      return authInfo;
    }
    const who = principalOf(authInfo);
    const body = importSchema.parse(await c.req.json());
    if (
      !who.scopes.includes("wizards:write") ||
      (body.publish && !who.scopes.includes("wizards:publish"))
    ) {
      return c.json(
        { error: "This token isn’t allowed to do that.", code: "insufficient_scope" },
        403,
      );
    }
    if ((await tenantStatus(who.tenantId)) === "suspended") {
      return c.json(
        {
          error: say(c, "accountSuspended"),
          code: "tenant_suspended",
        },
        403,
      );
    }
    return inTenantAs(who, async () => {
      const { wizardId, written, current } = await importDraft(who, body);
      if (!body.publish) {
        return c.json({ wizardId, revision: written.revision, issues: written.issues });
      }
      if (written.issues.length) {
        throw new ServiceError("has_issues", note("wizardStillErrors"), {
          issues: written.issues,
          wizardId,
        });
      }
      const published = await publishWizard(who.userId, wizardId);
      // The ID the mobile app takes.
      const code = await codeOf(current.shareToken);
      return c.json({ wizardId, revision: written.revision, issues: [], ...published, code });
    });
  });

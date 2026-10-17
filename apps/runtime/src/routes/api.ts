import { note } from "@engenty-wizards/shared/run";
import { PACKAGE_MIME } from "@engenty-wizards/shared/wizard-package";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { balanceCredits } from "../credits/credits.js";
import { withTenant } from "../db/client.js";
import { env } from "../env.js";
import { allowed } from "../limits.js";
import { managed, tenantInfo } from "../manage.js";
import { authenticate, type Principal, principalOf } from "../mcp/auth.js";
import type { Scope } from "../mcp/scopes.js";
import { loadedPlugin, pluginIdsOf } from "../plugins/registry.js";
import { asRole, mayBuild, mayCreate } from "../services/access.js";
import { apiRun, apiRuns, apiSpaceDetails, apiSpaces, apiWizards } from "../services/api.js";
import { ServiceError } from "../services/errors.js";
import { deleteFile, draftFiles, writeFile } from "../services/files.js";
import { asLang, searchMarketplace } from "../services/marketplace.js";
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
} from "../services/spaces.js";
import { createWizard, ownedWizard, publishWizard, writeDraft } from "../services/wizards.js";
import { codeOf, tenantStatus } from "../tenants/control.js";
import { notFoundAnswer, say } from "./lang.js";
import { dispatchAs } from "./plugins.js";

const importSchema = z.object({
  /** An earlier import's wizard: it is updated instead of a new one being made. */
  wizardId: z.string().optional(),
  projectId: z.string().optional(),
  definition: z.unknown(),
  files: z
    .array(z.object({ path: z.string(), mime: z.string().optional(), data: z.string() }))
    .max(200)
    .default([]),
  publish: z.boolean().default(false),
});

/** Runs a call in the caller's tenant, as the caller's role. */
const inTenantAs = <T>(who: Principal, fn: () => T | Promise<T>) =>
  withTenant(who.tenantId, () => asRole(who.role, fn));

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
async function caller(c: Context, scopes: Scope[]): Promise<Principal | Response> {
  const authInfo = await authenticate(c.req.raw);
  if (authInfo instanceof Response) {
    return authInfo;
  }
  const who = principalOf(authInfo);
  if (scopes.some((scope) => !who.scopes.includes(scope))) {
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
  return who;
}

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
 * The runtime's API for other programs. `/spaces/…` is how a local install's project comes
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
  // `knowledge=1` the project's pages come along as files (up to the snapshot's cap).
  .get("/wizards/:id/package", async (c) => {
    const who = await caller(c, ["wizards:read"]);
    if (who instanceof Response) {
      return who;
    }
    return inTenantAs(who, async () => {
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
        { projectId: body.spaceId, starterId: body.starterId, lang: body.lang },
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
    return inTenantAs(who, async () =>
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
    return inTenantAs(who, async () => c.json(await syncSpaceData(c.req.param("spaceId"), body)));
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
    return inTenantAs(who, async () =>
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
    return inTenantAs(who, async () =>
      c.json(await rotateSyncedLink(who.userId, c.req.param("spaceId"), c.req.param("wizardId"))),
    );
  })
  .delete("/spaces/:spaceId/wizards/:wizardId", async (c) => {
    const who = await caller(c, ["wizards:write"]);
    if (who instanceof Response) {
      return who;
    }
    return inTenantAs(who, async () =>
      c.json(await removeSyncedWizard(who.userId, c.req.param("spaceId"), c.req.param("wizardId"))),
    );
  })
  .delete("/spaces/:spaceId", async (c) => {
    const who = await caller(c, ["wizards:write"]);
    if (who instanceof Response) {
      return who;
    }
    return inTenantAs(who, async () => c.json(await removeSyncedSpace(c.req.param("spaceId"))));
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
      const writer = { source: "mcp" as const, client: who.client };
      let wizardId = body.wizardId;
      if (wizardId) {
        const existing = await ownedWizard(who.userId, wizardId).catch(() => null);
        wizardId = existing?.id;
      }
      if (!wizardId) {
        // The workspace must be there before the definition is checked against it.
        const created = await createWizard(who.userId, { projectId: body.projectId }, writer);
        wizardId = created.id;
      }
      const incoming = new Set(body.files.map((f) => f.path));
      for (const old of await draftFiles(wizardId)) {
        if (!incoming.has(old.path)) {
          await deleteFile(who.userId, wizardId, old.path);
        }
      }
      for (const file of body.files) {
        await writeFile(
          who.userId,
          wizardId,
          file.path,
          Buffer.from(file.data, "base64"),
          file.mime,
        );
      }
      const current = await ownedWizard(who.userId, wizardId);
      const written = await writeDraft(
        who.userId,
        wizardId,
        { definition: body.definition, baseRevision: current.revision },
        writer,
      );
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

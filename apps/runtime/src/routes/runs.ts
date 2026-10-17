import {
  FORMATS,
  isLang,
  LANG_CODE,
  LANGS,
  LIST_FORMATS,
  TEXT_CLASSES,
  type WizardDefinition,
  wizardLang,
} from "@engenty-wizards/shared/definition";
import { TableColumnValueError } from "@engenty-wizards/shared/engenty/data-tables";
import {
  noteText,
  type PublicField,
  type PublicWizard,
  type RunNote,
} from "@engenty-wizards/shared/run";
import {
  machineTranslated,
  type TranslationMemory,
  translateDefinition,
} from "@engenty-wizards/shared/translation";
import { getConnInfo } from "@hono/node-server/conninfo";
import { and, eq } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import { z } from "zod";
import { principalOf } from "../auth/index.js";
import { MARK_FOCUSED_PERSONAL } from "../browser/snapshot.js";
import {
  ConnectError,
  connectionViews,
  connectWithCredentials,
  disconnect,
  finishOAuth,
  oauthStateLang,
  oauthStateRun,
  startOAuth,
} from "../connectors/index.js";
import { finishPluginOAuth, pluginStateTenant } from "../connectors/plugin-connections.js";
import { db, schema, withTenant } from "../db/client.js";
import { answerAsk, pendingAsk } from "../engine/asks.js";
import { answerDevice, offerDevice, openDeviceCalls } from "../engine/device.js";
import { emitEvent, signalChanged, watchRun } from "../engine/events.js";
import { fieldErrorsIn } from "../engine/input.js";
import { fromOwner } from "../engine/owner.js";
import { pushAvailable, setPushDevice } from "../engine/push.js";
import { liveResources } from "../engine/resources.js";
import {
  cancel,
  createRun,
  editOutput,
  goBack,
  NoCreditsError,
  projectIdOf,
  RunConflict,
  RunInputError,
  retry,
  reviewStep,
  runView,
  submitPage,
  talkAllowed,
} from "../engine/runner.js";
import { basePath, env } from "../env.js";
import { loadAsset, saveAsset } from "../files/storage.js";
import { reverseGeocode } from "../geocode.js";
import { allowed, hashIp, verifyTurnstile, wizardUnavailable } from "../limits.js";
import { mintConversation } from "../media/conversation.js";
import { transcribeAudio } from "../media/transcribe.js";
import { errorText, ModelUnavailableError, noteOf } from "../model-errors.js";
import { listDownload, renderDownload, stepHtml } from "../render/downloads.js";
import { HTML_RESPONSE_CSP } from "../render/guard.js";
import { runTicketValid, verifySignedUrl } from "../secrets/signing.js";
import { brandView } from "../services/brand.js";
import { ServiceError } from "../services/errors.js";
import { publicRunners, servePageRunner } from "../services/runners.js";
import { sharedRun, shareImage, shareRun, shareView, unshareRun } from "../services/shares.js";
import {
  isLangCode,
  storedTranslation,
  translateResult,
  translationFor,
  uiTexts,
} from "../services/translations.js";
import { isIconFile, wizardAvatarSvg, wizardIcon } from "../services/wizard-icon.js";
import {
  clearStore,
  deleteRows,
  listRows,
  listSecrets,
  readStoreFile,
  StoreError,
  saveRows,
  scopeOf,
  storeFiles,
  updateRow,
} from "../store/index.js";
import {
  tenantOfLink,
  tenantOfRun,
  tenantStatus,
  tokenOfCode,
  visitorOverLimit,
} from "../tenants/control.js";
import {
  bareMime,
  byteRange,
  inlineSafe,
  uploadLimit,
  uploadMime,
  wizardManifest,
} from "./delivery.js";
import { notFoundAnswer, requestLang, say } from "./lang.js";

const VISITOR_COOKIE = "wz_vid";

/** Kept files a review shows inline. */
const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
/** Assets whose bytes and type someone outside the wizard chose: uploads and collected files. */
const FOREIGN_KINDS = new Set(["upload", "upload-image", "file"]);

export function clientIp(c: Context): string | null {
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) {
    return fwd;
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** A refusal the visitor reads, in the language their request asks for. */
function refuse(c: Context, note: RunNote, status: 400 | 403 | 404 | 409 | 422 | 429 | 502) {
  return c.json({ error: noteText(note, requestLang(c)) }, status);
}

/**
 * The mobile app's own requests (a run's view, downloads) name the visitor in a header: iOS
 * merges a Cookie header the app sets with its own cookie store (`wz_vid=a,wz_vid=a`). The header
 * comes first; a browser never sends it across sites without the runtime's say (CORS), so it is
 * as good as the cookie.
 */
const VISITOR_HEADER = "x-wizards-visitor";

/** An http(s) address without credentials or fragment, or null for anything else. */
function webAddress(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function visitorId(c: Context, create: boolean, embedded = false): string | null {
  let vid = c.req.header(VISITOR_HEADER) || getCookie(c, VISITOR_COOKIE) || null;
  if (!vid && create) {
    vid = nanoid(24);
    const secure = env.appUrl.startsWith("https");
    setCookie(c, VISITOR_COOKIE, vid, {
      httpOnly: true,
      path: basePath || "/",
      maxAge: 60 * 60 * 24 * 365,
      // In a frame on another website the wizard is a third party: a browser keeps its cookie
      // only when the cookie says so, and then apart for each website (CHIPS).
      ...(embedded && secure
        ? ({ sameSite: "None", secure: true, partitioned: true } as const)
        : ({ sameSite: "Lax", secure } as const)),
    });
  }
  return vid;
}

/**
 * The run, if the caller may see it: its visitor, the admin who owns the wizard, the widget of
 * the owner's AI app with its run ticket, or — on the read-only file routes — a signed link
 * handed out to the owner's MCP client.
 */
/** A view's kept state stays small: ticks and choices, not data. */
const MAX_VIEW_STATE = 32_000;

async function accessibleRun(c: Context, runId: string, opts: { signed?: boolean } = {}) {
  const run = await db.query.run.findFirst({ where: eq(schema.run.id, runId) });
  if (!run) {
    return null;
  }
  if (opts.signed && verifySignedUrl(c.req.url)) {
    return run;
  }
  if (runTicketValid(run.id, c.req.query("rt"))) {
    return run;
  }
  const vid = visitorId(c, false);
  if (vid && run.visitorId === vid) {
    return run;
  }
  const user = await principalOf(c);
  if (user && user.tenantId === run.tenantId) {
    return run;
  }
  return null;
}

async function viewOf(run: NonNullable<Awaited<ReturnType<typeof accessibleRun>>>) {
  const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, run.wizardId) });
  return runView(run, await brandView(w?.projectId ?? ""));
}

function commandError(c: Context, err: unknown) {
  if (err instanceof RunInputError) {
    return c.json(
      { error: errorText(err, requestLang(c)), fields: fieldErrorsIn(err.errors, requestLang(c)) },
      422,
    );
  }
  if (err instanceof RunConflict) {
    return c.json({ error: errorText(err, requestLang(c)) }, 409);
  }
  throw err;
}

/**
 * These routes arrive without a session. The tenant comes from the public token or the run id
 * in the path — looked up in the control database, never taken from the request.
 */
function tenantFrom(find: (c: Context) => Promise<string | null>): MiddlewareHandler {
  return async (c, next) => {
    const tenant = await find(c);
    if (!tenant) {
      return c.json(notFoundAnswer(c), 404);
    }
    if ((await tenantStatus(tenant)) === "suspended") {
      return refuse(c, { code: "wizardUnavailable" }, 403);
    }
    return withTenant(tenant, next);
  };
}

const wizardLink = tenantFrom((c) => tenantOfLink(c.req.param("token") ?? "", "wizard"));
const resultLink = tenantFrom((c) => tenantOfLink(c.req.param("token") ?? "", "result"));
const logoLink = tenantFrom((c) => tenantOfLink(c.req.param("id") ?? "", "logo"));
const runTenant = tenantFrom((c) => tenantOfRun(c.req.param("id") ?? ""));

/** Wrong guesses at a wizard's ID, per address and hour: 32^8 IDs stay out of reach. */
const codeMisses = new Map<string, { n: number; since: number }>();
const CODE_MISSES_PER_HOUR = 30;

function codeLookupBlocked(ip: string | null): boolean {
  const key = hashIp(ip) ?? "unknown";
  const entry = codeMisses.get(key);
  if (entry && Date.now() - entry.since > 3600_000) {
    codeMisses.delete(key);
    return false;
  }
  return (entry?.n ?? 0) >= CODE_MISSES_PER_HOUR;
}

function codeMissed(ip: string | null) {
  const key = hashIp(ip) ?? "unknown";
  const entry = codeMisses.get(key) ?? { n: 0, since: Date.now() };
  entry.n += 1;
  codeMisses.set(key, entry);
  if (codeMisses.size > 10_000) {
    codeMisses.delete(codeMisses.keys().next().value as string);
  }
}

/** A plugin's page runner behind a wizard's address, or 404 where the wizard does not offer it. */
async function pageRunner(c: Context, rest: string): Promise<Response> {
  const w = await db.query.wizard.findFirst({
    where: eq(schema.wizard.shareToken, c.req.param("token") ?? ""),
  });
  if (!w || w.publishedVersion === null) {
    return c.json(notFoundAnswer(c), 404);
  }
  const version = await db.query.wizardVersion.findFirst({
    where: and(
      eq(schema.wizardVersion.wizardId, w.id),
      eq(schema.wizardVersion.version, w.publishedVersion),
    ),
  });
  const served = version
    ? await servePageRunner(w, version.definition, c.req.param("runner") ?? "", rest, c.req.raw)
    : null;
  return served ?? c.json(notFoundAnswer(c), 404);
}

/** A wizard's link with its published version, or null where it has none. */
async function publishedWizard(token: string | undefined) {
  const w = await db.query.wizard.findFirst({
    where: eq(schema.wizard.shareToken, token ?? ""),
  });
  if (!w || w.publishedVersion === null) {
    return null;
  }
  const version = await db.query.wizardVersion.findFirst({
    where: and(
      eq(schema.wizardVersion.wizardId, w.id),
      eq(schema.wizardVersion.version, w.publishedVersion),
    ),
  });
  return version ? { w, def: version.definition, version: w.publishedVersion } : null;
}

/** The author offers the wizard translated, and the language is not the one it is written in. */
function wantsTranslation(w: { translate: boolean }, def: WizardDefinition, lang: string): boolean {
  return w.translate && lang !== wizardLang(def);
}

/** What the wizard's pages ask, in order (`PublicWizard.fields`). */
export function pageFields(def: WizardDefinition): PublicField[] {
  return def.steps.flatMap((step) =>
    step.type === "page"
      ? step.fields.map((f) => ({
          id: f.id,
          label: f.label,
          kind: f.kind,
          ...(f.options?.length ? { options: f.options } : {}),
          ...(f.required ? { required: true } : {}),
        }))
      : [],
  );
}

/** What a wizard's page shows before a run: in the viewer's language where `as` is given. */
async function publicBody(
  c: Context,
  w: NonNullable<Awaited<ReturnType<typeof publishedWizard>>>["w"],
  original: WizardDefinition,
  as: { lang: string; memory: TranslationMemory } | null,
): Promise<PublicWizard> {
  const translated = as ? translateDefinition(original, as.memory) : null;
  const def = translated?.def ?? original;
  const reason = await wizardUnavailable(w);
  return {
    token: w.shareToken,
    title: def.title,
    description: def.description,
    avatar: def.avatar,
    intro: def.intro ?? null,
    brand: await brandView(w.projectId),
    turnstileSiteKey: env.turnstile.siteKey || null,
    available: !reason,
    unavailableReason: reason && noteText(reason, requestLang(c)),
    runners: await publicRunners(w, original),
    lang: wizardLang(original),
    translatable: w.translate,
    translation:
      as && translated
        ? {
            lang: as.lang,
            labels: translated.labels,
            machine: machineTranslated(as.memory, original),
          }
        : null,
    fields: pageFields(def),
  };
}

export const publicRoutes = new Hono()
  // A wizard's ID, typed into the mobile app: answers its share token.
  .get("/codes/:code", async (c) => {
    const ip = clientIp(c);
    if (codeLookupBlocked(ip)) {
      return c.json(
        {
          error: say(c, "tooManyTriesWait"),
          code: "too_many_tries",
        },
        429,
      );
    }
    const found = await tokenOfCode(c.req.param("code"));
    if (!found || (await tenantStatus(found.tenantId)) === "suspended") {
      codeMissed(ip);
      return c.json(notFoundAnswer(c), 404);
    }
    return c.json({ token: found.token, url: `${env.publicUrl}/w/${found.token}` });
  })
  .use("/wizards/:token", wizardLink)
  .use("/wizards/:token/*", wizardLink)
  .use("/logos/:id", logoLink)
  .get("/wizards/:token", async (c) => {
    const found = await publishedWizard(c.req.param("token"));
    if (!found) {
      return c.json(notFoundAnswer(c), 404);
    }
    // The page in the viewer's language where it is kept; making it is the POST below.
    const lang = c.req.query("lang");
    const memory =
      isLangCode(lang) && wantsTranslation(found.w, found.def, lang)
        ? await storedTranslation(found.w.id, lang)
        : null;
    return c.json(
      await publicBody(c, found.w, found.def, lang && memory ? { lang, memory } : null),
    );
  })
  // The wizard in the viewer's language: translated now where it is not kept yet.
  .post("/wizards/:token/translation", async (c) => {
    const found = await publishedWizard(c.req.param("token"));
    if (!found) {
      return c.json(notFoundAnswer(c), 404);
    }
    const { lang } = z
      .object({ lang: z.string().regex(LANG_CODE) })
      .parse(await c.req.json().catch(() => ({})));
    if (!wantsTranslation(found.w, found.def, lang)) {
      return refuse(c, { code: "translationOff" }, 403);
    }
    try {
      const memory = await translationFor(found.w.id, found.def, lang, found.version);
      return c.json(await publicBody(c, found.w, found.def, { lang, memory }));
    } catch (err) {
      if (err instanceof ServiceError || err instanceof ModelUnavailableError) {
        return refuse(c, { code: "translationFailed" }, 502);
      }
      throw err;
    }
  })
  // The runner's own words in a language outside LANGS (the wizard's own or a viewer's), booked
  // to this wizard's owner when new.
  .get("/wizards/:token/texts/:lang", async (c) => {
    const found = await publishedWizard(c.req.param("token"));
    const lang = c.req.param("lang");
    if (!found || !isLangCode(lang) || isLang(lang)) {
      return c.json(notFoundAnswer(c), 404);
    }
    // The wizard's own language needs the runner's words too, translation offered or not.
    if (lang !== wizardLang(found.def) && !wantsTranslation(found.w, found.def, lang)) {
      return refuse(c, { code: "translationOff" }, 403);
    }
    try {
      return c.json(await uiTexts(lang));
    } catch (err) {
      if (err instanceof ServiceError || err instanceof ModelUnavailableError) {
        return refuse(c, { code: "translationFailed" }, 502);
      }
      throw err;
    }
  })
  .post("/wizards/:token/runs", async (c) => {
    const w = await db.query.wizard.findFirst({
      where: eq(schema.wizard.shareToken, c.req.param("token")),
    });
    if (!w || w.publishedVersion === null) {
      return c.json(notFoundAnswer(c), 404);
    }
    const reason = await wizardUnavailable(w);
    if (reason) {
      return refuse(c, reason, 403);
    }
    const body = z
      .object({
        turnstileToken: z.string().optional(),
        embedded: z.boolean().optional(),
        // The website page that embeds the wizard: shown with the result.
        origin: z.string().max(2000).optional(),
        // The language the viewer reads the wizard in, translated on request.
        lang: z.string().regex(LANG_CODE).optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const ip = clientIp(c);
    if (!(await verifyTurnstile(body.turnstileToken, ip))) {
      return refuse(c, { code: "confirmHuman" }, 403);
    }
    const vid = visitorId(c, true, body.embedded)!;
    const ipHash = hashIp(ip);
    if (await visitorOverLimit(vid, ipHash)) {
      return refuse(c, { code: "tooManyRuns" }, 429);
    }
    const version = await db.query.wizardVersion.findFirst({
      where: and(
        eq(schema.wizardVersion.wizardId, w.id),
        eq(schema.wizardVersion.version, w.publishedVersion),
      ),
    });
    try {
      const runId = await createRun({
        wizardId: w.id,
        definition: version!.definition,
        files: version!.files,
        version: w.publishedVersion,
        mode: "live",
        visitorId: vid,
        ipHash,
        origin: body.embedded ? webAddress(body.origin) : null,
        lang:
          body.lang &&
          wantsTranslation(w, version!.definition, body.lang) &&
          (await storedTranslation(w.id, body.lang))
            ? body.lang
            : null,
      });
      return c.json({ runId });
    } catch (err) {
      if (err instanceof NoCreditsError || err instanceof ModelUnavailableError) {
        return refuse(c, { code: "wizardUnavailable" }, 403);
      }
      throw err;
    }
  })
  // A plugin's page runner for this wizard: what `/w/<token>/<runner>` serves built, reached here from source.
  .all("/wizards/:token/runners/:runner", (c) => pageRunner(c, ""))
  .all("/wizards/:token/runners/:runner/*", (c) =>
    pageRunner(
      c,
      c.req.path.slice(
        c.req.path.indexOf(`/runners/${c.req.param("runner")}`) +
          `/runners/${c.req.param("runner")}`.length,
      ),
    ),
  )
  // A published wizard as an app of its own: added to a phone's home screen it opens on its link.
  .get("/wizards/:token/manifest.webmanifest", async (c) => {
    const w = await db.query.wizard.findFirst({
      where: eq(schema.wizard.shareToken, c.req.param("token")),
    });
    if (!w || w.publishedVersion === null) {
      return c.notFound();
    }
    const version = await db.query.wizardVersion.findFirst({
      where: and(
        eq(schema.wizardVersion.wizardId, w.id),
        eq(schema.wizardVersion.version, w.publishedVersion),
      ),
    });
    const def = version!.definition;
    const manifest = wizardManifest(w.shareToken, def.title, def.description, w.publishedVersion);
    return c.body(JSON.stringify(manifest), 200, {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
  })
  // Its engenty as the chat button a website shows it behind (`embed.js`).
  .get("/wizards/:token/avatar.svg", async (c) => {
    const w = await db.query.wizard.findFirst({
      where: eq(schema.wizard.shareToken, c.req.param("token")),
    });
    if (!w || w.publishedVersion === null) {
      return c.notFound();
    }
    const version = await db.query.wizardVersion.findFirst({
      where: and(
        eq(schema.wizardVersion.wizardId, w.id),
        eq(schema.wizardVersion.version, w.publishedVersion),
      ),
    });
    return c.body(wizardAvatarSvg(version!.definition.avatar), 200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    });
  })
  // Its icon: the wizard's engenty on its hue with its name; the studio's where none can be drawn.
  .get("/wizards/:token/icons/:file", async (c) => {
    const file = c.req.param("file");
    if (!isIconFile(file)) {
      return c.notFound();
    }
    const w = await db.query.wizard.findFirst({
      where: eq(schema.wizard.shareToken, c.req.param("token")),
    });
    if (!w || w.publishedVersion === null) {
      return c.notFound();
    }
    const version = await db.query.wizardVersion.findFirst({
      where: and(
        eq(schema.wizardVersion.wizardId, w.id),
        eq(schema.wizardVersion.version, w.publishedVersion),
      ),
    });
    const def = version!.definition;
    const png = await wizardIcon(file, def.avatar, def.title);
    if (!png) {
      return c.redirect(
        `${basePath}/studio/${file === "favicon.png" ? "favicon.svg" : `icons/${file}`}`,
      );
    }
    return c.body(png, 200, {
      "content-type": "image/png",
      "cache-control": "public, max-age=3600",
    });
  })
  .get("/logos/:id", async (c) => {
    const found = await loadAsset(c.req.param("id"));
    if (found?.row.kind !== "logo") {
      return c.notFound();
    }
    return c.body(new Uint8Array(found.data), 200, {
      "content-type": found.row.mime,
      "cache-control": "public, max-age=86400",
      // An SVG logo is shown, never run.
      "content-security-policy": "sandbox",
    });
  });

export const runRoutes = new Hono()
  .use("/:id", runTenant)
  .use("/:id/*", runTenant)
  .get("/:id", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    return c.json(await viewOf(run));
  })
  .get("/:id/stream", async (c) => {
    const id = c.req.param("id");
    const first = await accessibleRun(c, id);
    if (!first) {
      return c.json(notFoundAnswer(c), 404);
    }
    return streamSSE(c, async (stream) => {
      let pending = false;
      let closed = false;
      const push = async () => {
        if (pending || closed) {
          return;
        }
        pending = true;
        await new Promise((r) => setTimeout(r, 120));
        pending = false;
        const run = await db.query.run.findFirst({ where: eq(schema.run.id, id) });
        if (run && !closed) {
          await stream.writeSSE({ event: "view", data: JSON.stringify(await viewOf(run)) });
        }
      };
      // Calls the runner put to the device the run is watched from, each sent once per stream.
      const sent = new Set<string>();
      const sendDeviceCalls = async () => {
        for (const call of await openDeviceCalls(id)) {
          if (!(closed || sent.has(call.id))) {
            sent.add(call.id);
            await stream.writeSSE({ event: "device", data: JSON.stringify(call) });
          }
        }
      };
      const unsubscribe = watchRun(id, (signal) => {
        if (!signal.event) {
          void sendDeviceCalls().catch(() => undefined);
        }
        void push();
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      await stream.writeSSE({ event: "view", data: JSON.stringify(await viewOf(first)) });
      await sendDeviceCalls();
      while (!closed) {
        await stream.sleep(20_000);
        if (!closed) {
          await stream.writeSSE({ event: "ping", data: "" });
        }
      }
    });
  })
  // The runner says what the device around it offers the run (the app's Apple Intelligence):
  // from then on short text calls go there first. Renewed on every connect; see engine/device.ts.
  .post("/:id/device", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const offer = z
      .object({
        think: z
          .object({
            classes: z.array(z.enum(TEXT_CLASSES)).max(TEXT_CLASSES.length),
            maxChars: z.number().int().min(500).max(50_000),
          })
          .optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    await offerDevice(run.id, offer);
    return c.json({ ok: true });
  })
  // The device's answer to one call the stream carried as a `device` event.
  .post("/:id/device/:reqId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const answer = z
      .object({ text: z.string().max(200_000).optional(), error: z.string().max(500).optional() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json({ ok: await answerDevice(run.id, c.req.param("reqId"), answer) });
  })
  .post("/:id/pages/:stepId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const { values } = z
      .object({ values: z.record(z.string(), z.unknown()) })
      .parse(await c.req.json());
    try {
      await submitPage(run.id, c.req.param("stepId"), values);
      return c.json({ ok: true });
    } catch (err) {
      return commandError(c, err);
    }
  })
  // What the person did in a step's view — a checklist's ticks, a widget's state — kept with the
  // run, so the next visit shows it. Only while the run waits or is done: a running step owns
  // the state then.
  .put("/:id/views/:stepId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    const stepId = c.req.param("stepId");
    const output = run?.state.outputs[stepId];
    if (!run || !output) {
      return c.json(notFoundAnswer(c), 404);
    }
    if (run.status !== "waiting_input" && run.status !== "done") {
      return c.json({ error: "busy" }, 409);
    }
    const { state } = z
      .object({ state: z.record(z.string(), z.unknown()) })
      .parse(await c.req.json());
    if (JSON.stringify(state).length > MAX_VIEW_STATE) {
      return c.json({ error: "too large" }, 413);
    }
    await db
      .update(schema.run)
      .set({
        state: {
          ...run.state,
          outputs: { ...run.state.outputs, [stepId]: { ...output, view: state } },
        },
      })
      .where(eq(schema.run.id, run.id));
    return c.json({ ok: true });
  })
  // A json step's data, edited in the studio by someone of the team the run belongs to.
  .put("/:id/outputs/:stepId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    const user = await principalOf(c);
    if (!run || !user || user.tenantId !== run.tenantId) {
      return c.json(notFoundAnswer(c), 404);
    }
    const { json } = z
      .object({ json: z.record(z.string(), z.unknown()) })
      .parse(await c.req.json());
    try {
      await editOutput(run.id, c.req.param("stepId"), json);
      return c.json({ ok: true });
    } catch (err) {
      return commandError(c, err);
    }
  })
  .post("/:id/reviews/:stepId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const action = z
      .discriminatedUnion("type", [
        z.object({
          type: z.literal("accept"),
          // A text, or the data of a json step (checked against its schema).
          edits: z
            .record(z.string(), z.union([z.string(), z.record(z.string(), z.unknown())]))
            .optional(),
        }),
        z.object({
          type: z.literal("regenerate"),
          target: z.string(),
          note: z.string().max(2000),
          items: z.array(z.number().int().min(0).max(50)).max(20).optional(),
        }),
      ])
      .parse(await c.req.json());
    try {
      await reviewStep(run.id, c.req.param("stepId"), action);
      return c.json({ ok: true });
    } catch (err) {
      return commandError(c, err);
    }
  })
  .post("/:id/back", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    try {
      await goBack(run.id);
      return c.json({ ok: true });
    } catch (err) {
      return commandError(c, err);
    }
  })
  .post("/:id/retry", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    try {
      await retry(run.id);
      return c.json({ ok: true });
    } catch (err) {
      return commandError(c, err);
    }
  })
  .post("/:id/cancel", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    await cancel(run.id);
    return c.json({ ok: true });
  })
  // The viewer reads the run in another language from now on: null for the wizard's own.
  .post("/:id/lang", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const { lang } = z
      .object({ lang: z.string().regex(LANG_CODE).nullable() })
      .parse(await c.req.json().catch(() => ({})));
    const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, run.wizardId) });
    const own = !lang || lang === wizardLang(run.definition);
    if (!(own || (w && wantsTranslation(w, run.definition, lang)))) {
      return refuse(c, { code: "translationOff" }, 403);
    }
    if (!own) {
      try {
        await translationFor(run.wizardId, run.definition, lang, run.version);
      } catch (err) {
        if (err instanceof ServiceError || err instanceof ModelUnavailableError) {
          return refuse(c, { code: "translationFailed" }, 502);
        }
        throw err;
      }
    }
    await db
      .update(schema.run)
      .set({ lang: own ? null : lang })
      .where(eq(schema.run.id, run.id));
    signalChanged(run.id);
    return c.json({ ok: true });
  })
  // A finished result's text in the language the viewer reads the run in, kept on the run.
  .post("/:id/translate-result", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const { stepId } = z.object({ stepId: z.string() }).parse(await c.req.json().catch(() => ({})));
    const text = run.state.outputs[stepId]?.text;
    if (!(run.lang && text)) {
      return c.json(notFoundAnswer(c), 404);
    }
    if (!run.state.translated?.[run.lang]?.[stepId]) {
      let translated: string;
      try {
        translated = await translateResult(text, run.lang, wizardLang(run.definition));
      } catch (err) {
        if (err instanceof ServiceError || err instanceof ModelUnavailableError) {
          return refuse(c, { code: "translationFailed" }, 502);
        }
        throw err;
      }
      const fresh = await db.query.run.findFirst({ where: eq(schema.run.id, run.id) });
      const state = fresh?.state ?? run.state;
      state.translated = {
        ...state.translated,
        [run.lang]: { ...state.translated?.[run.lang], [stepId]: translated },
      };
      await db.update(schema.run).set({ state }).where(eq(schema.run.id, run.id));
      signalChanged(run.id);
    }
    return c.json({ ok: true });
  })
  // A live conversation on the run: the secret the browser opens the session with.
  .post("/:id/talk", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    if (run.status === "done" || run.status === "cancelled" || run.status === "failed") {
      return refuse(c, { code: "runOver" }, 409);
    }
    if (!(await talkAllowed(run))) {
      return refuse(c, { code: "talkOff" }, 403);
    }
    if (!allowed(`talk:${run.id}`, 20, 3600_000)) {
      return refuse(c, { code: "tryLater" }, 429);
    }
    try {
      const view = await viewOf(run);
      return c.json(await mintConversation(view));
    } catch (err) {
      if (err instanceof ModelUnavailableError) {
        return c.json({ error: errorText(err, requestLang(c)) }, 403);
      }
      console.error("[talk]", err);
      return c.json({ error: errorText(err, requestLang(c)) }, 502);
    }
  })
  // What the person says into the chat's composer, written down — where the browser cannot do it itself.
  .post("/:id/transcribe", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    if (run.status === "done" || run.status === "cancelled" || run.status === "failed") {
      return refuse(c, { code: "runOver" }, 409);
    }
    if (!allowed(`transcribe:${run.id}`, 60, 3600_000)) {
      return refuse(c, { code: "tryLater" }, 429);
    }
    const file = (await c.req.formData()).get("file");
    if (!(file instanceof File) || !file.size || file.size > 10_000_000) {
      return refuse(c, { code: "recordingTooLarge" }, 400);
    }
    try {
      const { text } = await transcribeAudio({
        bytes: new Uint8Array(await file.arrayBuffer()),
        mediaType: file.type.split(";")[0].trim() || "audio/webm",
        call: { runId: run.id },
      });
      return c.json({ text });
    } catch (err) {
      if (err instanceof ModelUnavailableError) {
        return c.json({ error: errorText(err, requestLang(c)) }, 403);
      }
      // Apple Intelligence on this Mac says why in a note (harness/apple.ts).
      if (noteOf(err)) {
        return c.json({ error: errorText(err, requestLang(c)) }, 502);
      }
      throw err;
    }
  })
  .post("/:id/uploads", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const form = await c.req.formData();
    const file = form.get("file");
    // A recorder names its type with codecs ("audio/webm;codecs=opus"); the bare type is kept,
    // and only when it is one a wizard takes. The browser's word is the sender's: anything else
    // is kept as plain bytes, so it can never come back as a page on this origin.
    const mime = uploadMime(file instanceof File ? file.type : "");
    const limit = uploadLimit(mime);
    if (!(file instanceof File) || file.size > limit) {
      return refuse(
        c,
        { code: "fileTooLarge", params: { mb: Math.round(limit / 1_000_000) } },
        400,
      );
    }
    const ref = await saveAsset({
      runId: run.id,
      kind: mime.startsWith("image/") ? "upload-image" : "upload",
      mime,
      name: file.name.slice(0, 120),
      data: new Uint8Array(await file.arrayBuffer()),
    });
    return c.json(ref);
  })
  // The address of where the person stands, for a location field — only when a geocoder is set up.
  .post("/:id/geocode", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const { lat, lng, language } = z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        language: z.enum(LANGS).default("en"),
      })
      .parse(await c.req.json());
    return c.json({ label: await reverseGeocode(lat, lng, language) });
  })
  .get("/:id/assets/:assetId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"), { signed: true });
    if (!run) {
      return c.notFound();
    }
    return serveAsset(c, run, c.req.param("assetId"));
  })
  .get("/:id/steps/:stepId/download", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"), { signed: true });
    if (!run) {
      return c.notFound();
    }
    return serveDownload(c, run, c.req.param("stepId"), c.req.query("format"));
  })
  // --- a running step waits for the person ------------------------------------
  .post("/:id/ask/:askId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const answer = z
      .discriminatedUnion("type", [
        z.object({
          type: z.literal("fill"),
          values: z.record(z.string(), z.string().max(500)),
          remember: z.boolean().optional(),
        }),
        z.object({ type: z.literal("done"), remember: z.boolean().optional() }),
        z.object({ type: z.literal("skip") }),
      ])
      .parse(await c.req.json());
    if (!(await answerAsk(run.id, c.req.param("askId"), answer))) {
      return refuse(c, { code: "askClosed" }, 409);
    }
    return c.json({ ok: true });
  })
  // Who drives the wizard's browser: the wizard, or the person who took it over.
  .get("/:id/browser/seat", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    const resources = run?.status === "running" ? liveResources(run.id) : null;
    if (!resources?.openPage()) {
      // The run may work in another process: its runner answers.
      return (run && (await fromOwner(c, run.id))) || c.json(notFoundAnswer(c), 404);
    }
    return c.json({ seat: resources.seatHolder() });
  })
  // The person takes the wizard's browser over, or hands it back. While they hold it, the
  // wizard's browser steps wait.
  .post("/:id/browser/seat", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    const resources = run?.status === "running" ? liveResources(run.id) : null;
    if (!(run && resources?.openPage())) {
      return (run && (await fromOwner(c, run.id))) || refuse(c, { code: "noBrowser" }, 409);
    }
    const { to } = z.object({ to: z.enum(["person", "agent"]) }).parse(await c.req.json());
    if (resources.seatHolder() !== to) {
      resources.setSeat(to);
      await emitEvent(run.id, run.cursor, "info", {
        code: to === "person" ? "personDrives" : "agentDrives",
      }).catch(() => undefined);
    }
    return c.json({ seat: to });
  })
  // The wizard's browser as it works, as a picture that keeps changing (MJPEG, for an <img>):
  // a new frame whenever the page repaints, at most about five a second. Ends with the run's
  // browser.
  .get("/:id/browser/live", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    const resources = run?.status === "running" ? liveResources(run.id) : null;
    if (!resources?.openPage()) {
      return (run && (await fromOwner(c, run.id))) || c.notFound();
    }
    const boundary = "frame";
    const encoder = new TextEncoder();
    let stop: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let latest: Buffer | null = null;
        let sentAt = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const send = () => {
          timer = null;
          if (!latest) {
            return;
          }
          sentAt = Date.now();
          const head = `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${latest.length}\r\n\r\n`;
          try {
            controller.enqueue(encoder.encode(head));
            controller.enqueue(new Uint8Array(latest));
            controller.enqueue(encoder.encode("\r\n"));
          } catch {
            stop();
          }
          latest = null;
        };
        const unwatch = resources.watchBrowser((frame) => {
          if (!frame) {
            stop();
            try {
              controller.close();
            } catch {
              // already closed by the viewer
            }
            return;
          }
          latest = frame;
          if (!timer) {
            timer = setTimeout(send, Math.max(0, 200 - (Date.now() - sentAt)));
          }
        });
        stop = () => {
          if (timer) {
            clearTimeout(timer);
          }
          unwatch();
        };
      },
      cancel() {
        stop();
      },
    });
    c.req.raw.signal.addEventListener("abort", () => stop());
    return new Response(body, {
      headers: {
        "content-type": `multipart/x-mixed-replace; boundary=${boundary}`,
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  })
  // While the wizard waits for a sign-in, or the person took its browser over, they use its
  // page: click, type, scroll. What they type is theirs: no reading of the page gives it to a
  // model.
  .post("/:id/browser/act", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    const resources = run ? liveResources(run.id) : null;
    if (run?.status === "running" && !resources) {
      // The run works in another process: its runner answers.
      const answered = await fromOwner(c, run.id);
      if (answered) {
        return answered;
      }
    }
    const theirs = run && ((await pendingAsk(run.id)) || resources?.seatHolder() === "person");
    const page = theirs ? resources?.openPage() : null;
    if (!(run && resources && page)) {
      return refuse(c, { code: "notWaiting" }, 409);
    }
    resources.touchSeat();
    const act = z
      .discriminatedUnion("type", [
        z.object({
          type: z.literal("click"),
          fx: z.number().min(0).max(1),
          fy: z.number().min(0).max(1),
        }),
        z.object({ type: z.literal("type"), text: z.string().max(500) }),
        z.object({ type: z.literal("key"), key: z.enum(["Enter", "Tab", "Backspace", "Escape"]) }),
        z.object({ type: z.literal("scroll"), dy: z.number().min(-2000).max(2000) }),
      ])
      .parse(await c.req.json());
    try {
      if (act.type === "click") {
        // A click may open the sign-in in a new tab; the wizard then goes on there.
        const popup = page
          .context()
          .waitForEvent("page", { timeout: 1500 })
          .catch(() => null);
        const size = page.viewportSize() ?? { width: 1280, height: 900 };
        await page.mouse.click(act.fx * size.width, act.fy * size.height);
        const opened = await popup;
        if (opened) {
          resources.adopt(opened);
        }
      } else if (act.type === "type") {
        await page.evaluate(MARK_FOCUSED_PERSONAL).catch(() => undefined);
        await page.keyboard.type(act.text);
      } else if (act.type === "key") {
        await page.keyboard.press(act.key);
      } else {
        await page.mouse.wheel(0, act.dy);
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
    } catch {
      return refuse(c, { code: "pageActFailed" }, 422);
    }
    return c.json({ ok: true });
  })
  // --- the person's accounts ----------------------------------------------------
  .post("/:id/connections/:connectionId/oauth/:connectorId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    const connection = run?.definition.connections?.find(
      (x) => x.id === c.req.param("connectionId"),
    );
    if (!run || !connection) {
      return c.json(notFoundAnswer(c), 404);
    }
    try {
      const url = await startOAuth(
        scopeOf(run),
        await projectIdOf(run),
        run.id,
        connection,
        c.req.param("connectorId"),
        requestLang(c),
      );
      return c.json({ url });
    } catch (err) {
      if (err instanceof ConnectError) {
        return c.json({ error: errorText(err, requestLang(c)) }, 422);
      }
      throw err;
    }
  })
  .post("/:id/connections/:connectionId/credentials/:connectorId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    const connection = run?.definition.connections?.find(
      (x) => x.id === c.req.param("connectionId"),
    );
    if (!run || !connection) {
      return c.json(notFoundAnswer(c), 404);
    }
    const { values } = z
      .object({ values: z.record(z.string(), z.string().max(500)) })
      .parse(await c.req.json());
    try {
      const label = await connectWithCredentials(
        scopeOf(run),
        await projectIdOf(run),
        connection,
        c.req.param("connectorId"),
        values,
      );
      signalChanged(run.id);
      return c.json({ ok: true, label });
    } catch (err) {
      if (err instanceof ConnectError) {
        return c.json({ error: errorText(err, requestLang(c)) }, 422);
      }
      throw err;
    }
  })
  .delete("/:id/connections/:connectionId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    await disconnect(scopeOf(run), c.req.param("connectionId"));
    signalChanged(run.id);
    return c.json({ ok: true });
  })
  // --- the wizard's lists and files for this person -------------------------------
  .post("/:id/lists/:list/rows", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    // A shared list is every run's: the person never sees it.
    const def = run?.definition.lists?.find((l) => l.id === c.req.param("list") && !l.shared);
    if (!run || !def) {
      return c.json(notFoundAnswer(c), 404);
    }
    const { cells } = z
      .object({ cells: z.record(z.string(), z.unknown()) })
      .parse(await c.req.json());
    try {
      await saveRows(scopeOf(run), def, [cells]);
    } catch (err) {
      return listError(c, err);
    }
    signalChanged(run.id);
    return c.json({ ok: true });
  })
  .patch("/:id/lists/:list/rows/:rowId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    // A shared list is every run's: the person never sees it.
    const def = run?.definition.lists?.find((l) => l.id === c.req.param("list") && !l.shared);
    if (!run || !def) {
      return c.json(notFoundAnswer(c), 404);
    }
    const { cells } = z
      .object({ cells: z.record(z.string(), z.unknown()) })
      .parse(await c.req.json());
    try {
      if (!(await updateRow(scopeOf(run), def, c.req.param("rowId"), cells))) {
        return c.json(notFoundAnswer(c), 404);
      }
    } catch (err) {
      return listError(c, err);
    }
    signalChanged(run.id);
    return c.json({ ok: true });
  })
  .delete("/:id/lists/:list/rows/:rowId", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    // A shared list is every run's: the person never sees it.
    const def = run?.definition.lists?.find((l) => l.id === c.req.param("list") && !l.shared);
    if (!run || !def) {
      return c.json(notFoundAnswer(c), 404);
    }
    await deleteRows(scopeOf(run), def, [c.req.param("rowId")]);
    signalChanged(run.id);
    return c.json({ ok: true });
  })
  .get("/:id/lists/:list/download", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    // A shared list is every run's: the person never sees it.
    const def = run?.definition.lists?.find((l) => l.id === c.req.param("list") && !l.shared);
    const format = z.enum(FORMATS).safeParse(c.req.query("format"));
    if (!run || !def || !format.success || !LIST_FORMATS.includes(format.data)) {
      return c.notFound();
    }
    const scope = scopeOf(run);
    const download = await listDownload(
      def,
      await listRows(scope, def),
      format.data,
      `${run.definition.title} ${def.title}`,
      async (path) => {
        const found = await readStoreFile(scope, path).catch(() => null);
        return found ? new Uint8Array(found.data) : null;
      },
    );
    return download ? sendDownload(c, download) : c.notFound();
  })
  .get("/:id/store", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const scope = scopeOf(run);
    const lists = await Promise.all(
      (run.definition.lists ?? [])
        .filter((def) => !def.shared)
        .map(async (def) => ({
          id: def.id,
          title: def.title,
          rows: (await listRows(scope, def)).length,
        })),
    );
    const secrets = await listSecrets(scope);
    return c.json({
      lists,
      files: await storeFiles(scope),
      connections: (
        await connectionViews(
          run.definition.connections ?? [],
          scope,
          await projectIdOf(run),
          requestLang(c),
        )
      ).filter((x) => x.account),
      keepsSignIns: secrets.some((s) => s.slot === "browser"),
    });
  })
  .get("/:id/store/files/:path{.+}", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    const found = run ? await readStoreFile(scopeOf(run), c.req.param("path")) : null;
    if (!found) {
      return c.notFound();
    }
    const name = (found.file.path.split("/").pop() ?? "file").replace(/"/g, "");
    // Shown beside its row in a review: only what a browser draws without running anything of
    // the file's — PDFs and photos. Everything else stays a download.
    if (c.req.query("inline") && INLINE_TYPES.has(found.file.mime)) {
      return c.body(new Uint8Array(found.data), 200, {
        "content-type": found.file.mime,
        "content-disposition": `inline; filename="${name}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=300",
      });
    }
    return c.body(new Uint8Array(found.data), 200, {
      // Stored files come from mail and the web: always a download, never a page of ours.
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
      "x-content-type-options": "nosniff",
    });
  })
  .delete("/:id/store", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    await clearStore(scopeOf(run));
    signalChanged(run.id);
    return c.json({ ok: true });
  })
  // The mobile app's device for this run: told when it is done, failed or waits for the person.
  .post("/:id/notify", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    const body = z
      .object({
        token: z.string().min(8).max(512),
        platform: z.enum(["ios", "android"]),
        lang: z.enum(LANGS).default("en"),
      })
      .parse(await c.req.json());
    await setPushDevice(run.id, body);
    return c.json({ push: pushAvailable() });
  })
  .delete("/:id/notify", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    await setPushDevice(run.id, null);
    return c.json({ ok: true });
  })
  .post("/:id/share", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    try {
      return c.json(await shareRun(run));
    } catch (err) {
      if (err instanceof ServiceError) {
        return c.json(err.toJSON(requestLang(c)), err.status);
      }
      throw err;
    }
  })
  .delete("/:id/share", async (c) => {
    const run = await accessibleRun(c, c.req.param("id"));
    if (!run) {
      return c.json(notFoundAnswer(c), 404);
    }
    await unshareRun(run);
    return c.json({ ok: true });
  });

type RunRow = typeof schema.run.$inferSelect;

function listError(c: Context, err: unknown) {
  if (err instanceof TableColumnValueError || err instanceof StoreError) {
    return c.json({ error: errorText(err, requestLang(c)) }, 422);
  }
  throw err;
}

function sendDownload(
  c: Context,
  download: { data: Uint8Array | string; mime: string; filename: string },
) {
  const data = new Uint8Array(
    typeof download.data === "string" ? new TextEncoder().encode(download.data) : download.data,
  );
  return c.body(data, 200, {
    "content-type": download.mime.startsWith("text/")
      ? `${download.mime}; charset=utf-8`
      : download.mime,
    "content-disposition": `attachment; filename="${download.filename}"`,
  });
}

/**
 * Where an OAuth provider sends the person back after connecting an account. The page tells the
 * wizard's window and closes itself.
 */
export const connectCallback = new Hono().get("/callback", async (c) => {
  const code = c.req.query("code");
  // Connected through the account's Manage-App: a ticket instead of a code.
  const ticket = c.req.query("ticket");
  const state = c.req.query("state");
  let ok = false;
  let said: RunNote =
    c.req.query("error") === "exchange_failed"
      ? { code: "connectFailed" }
      : { code: "connectCancelled" };
  // A plugin's sign-in (server.connections) names its tenant; a wizard's names its run.
  const pluginTenant = state ? pluginStateTenant(state) : null;
  const tenant = state ? (pluginTenant ?? (await tenantOfRun(oauthStateRun(state) ?? ""))) : null;
  const answer = ticket ? { ticket } : code ? { code } : null;
  if (answer && state && tenant) {
    try {
      if (pluginTenant) {
        await withTenant(tenant, () => finishPluginOAuth(answer, state));
      } else {
        const done = await withTenant(tenant, () => finishOAuth(answer, state));
        signalChanged(done.runId);
      }
      ok = true;
      said = { code: "connected" };
    } catch (err) {
      console.error("[connect]", err);
      said = { code: "connectFailed" };
    }
  }
  const message = noteText(said, (state && oauthStateLang(state)) || requestLang(c));
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>engenty wizards</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#333">
<p>${message}</p>
<script>
  // The opener is the studio or a wizard's page: each origin gets the word, the wrong one drops it.
  for (const origin of ${JSON.stringify([...new Set([env.appUrl, env.publicUrl])])}) {
    try { window.opener && window.opener.postMessage({ type: "wizards:connected", ok: ${ok} }, origin); } catch (e) {}
  }
  setTimeout(function () { window.close(); }, ${ok ? 300 : 4000});
</script>`,
  );
});

async function serveAsset(c: Context, run: RunRow, assetId: string) {
  const found = await loadAsset(assetId);
  if (!found || found.row.runId !== run.id) {
    return c.notFound();
  }
  // The stored type is sent only as a bare `type/subtype`: "text/html,x" reads as HTML to a browser.
  const mime = bareMime(found.row.mime) ?? "application/octet-stream";
  // What a person or a plugin uploaded, and files a step collected from mail and the web.
  const foreign = FOREIGN_KINDS.has(found.row.kind);
  const headers: Record<string, string> = {
    "content-type": mime,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    // Nothing opened on its own runs scripts with this origin (an SVG, an XML document, a page).
    // A PDF is left to the browser's own viewer, which a sandbox would keep from starting.
    ...(mime === "application/pdf" ? {} : { "content-security-policy": "sandbox" }),
  };
  // Foreign files are downloads, never pages of ours: only photos, sound, film and PDFs show in place.
  if (foreign && !inlineSafe(mime)) {
    headers["content-disposition"] =
      `attachment; filename="${found.row.name.replace(/["\\\r\n]/g, "")}"`;
  }
  // Generated HTML runs its scripts in an opaque origin and can reach nothing.
  if (mime === "text/html" && !foreign) {
    const html = await stepHtml({
      assets: [{ id: assetId, kind: found.row.kind, mime: found.row.mime, name: "" }],
      at: "",
    });
    headers["content-type"] = "text/html; charset=utf-8";
    headers["content-security-policy"] = HTML_RESPONSE_CSP;
    return c.body(new TextEncoder().encode(html ?? ""), 200, headers);
  }
  if (/^(audio|video)\//.test(mime)) {
    headers["accept-ranges"] = "bytes";
    const size = found.data.byteLength;
    const range = byteRange(c.req.header("range"), size);
    if (range === "unsatisfiable") {
      return c.body(null, 416, { "content-range": `bytes */${size}` });
    }
    if (range) {
      headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
      return c.body(new Uint8Array(found.data.subarray(range.start, range.end + 1)), 206, headers);
    }
  }
  return c.body(new Uint8Array(found.data), 200, headers);
}

async function serveDownload(c: Context, run: RunRow, stepId: string, rawFormat?: string) {
  const format = z.enum(FORMATS).safeParse(rawFormat);
  const step = run.definition.steps.find((s) => s.id === stepId);
  const output = step ? run.state.outputs[step.id] : undefined;
  if (!format.success || !step || !output) {
    return c.notFound();
  }
  const label = run.definition.steps
    .flatMap((s) => (s.type === "result" ? s.deliverables : []))
    .find((d) => d.from === step.id)?.label;
  const download = await renderDownload(
    step,
    output,
    format.data,
    `${run.definition.title} ${label ?? step.title}`,
  );
  if (!download) {
    return c.notFound();
  }
  return sendDownload(c, download);
}

/** Steps a shared link shows: the result's deliverables — never uploads or in-between steps. */
function sharedStepIds(run: RunRow): Set<string> {
  return new Set(
    run.definition.steps.flatMap((s) =>
      s.type === "result" ? s.deliverables.map((d) => d.from) : [],
    ),
  );
}

/** `/api/shares/:token` — a shared result, readable by anyone holding the link until it expires. */
export const shareRoutes = new Hono()
  .use("/:token", resultLink)
  .use("/:token/*", resultLink)
  .get("/:token", async (c) => {
    const run = await sharedRun(c.req.param("token"));
    if (!run) {
      return refuse(c, { code: "linkGone" }, 404);
    }
    return c.json(await shareView(run));
  })
  .get("/:token/image", async (c) => {
    const run = await sharedRun(c.req.param("token"));
    const image = run ? await shareImage(run) : null;
    if (!image) {
      return c.notFound();
    }
    return c.body(image.data as Uint8Array<ArrayBuffer>, 200, {
      "content-type": image.mime,
      "cache-control": "public, max-age=3600",
    });
  })
  .get("/:token/assets/:assetId", async (c) => {
    const run = await sharedRun(c.req.param("token"));
    if (!run) {
      return c.notFound();
    }
    const assetId = c.req.param("assetId");
    const allowed = [...sharedStepIds(run)].some((id) =>
      run.state.outputs[id]?.assets?.some((a) => a.id === assetId),
    );
    return allowed ? serveAsset(c, run, assetId) : c.notFound();
  })
  .get("/:token/steps/:stepId/download", async (c) => {
    const run = await sharedRun(c.req.param("token"));
    const stepId = c.req.param("stepId");
    if (!run || !sharedStepIds(run).has(stepId)) {
      return c.notFound();
    }
    return serveDownload(c, run, stepId, c.req.query("format"));
  });

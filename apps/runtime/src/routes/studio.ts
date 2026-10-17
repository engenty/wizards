import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ASSISTANT_LAYOUTS,
  ASSISTANT_PAGE_BYTES,
  type AssistantEvents,
  type AssistantSignal,
  assistantSignalSchema,
  assistantTurnSchema,
} from "@engenty-wizards/shared/assistant";
import {
  LANGS,
  type Lang,
  MODEL_CLASSES,
  TEXT_CLASSES,
  type WizardDefinition,
  wizardLang,
} from "@engenty-wizards/shared/definition";
import { CATEGORY_TYPES, whereSchema } from "@engenty-wizards/shared/knowledge";
import { PROJECT_FILE_KINDS } from "@engenty-wizards/shared/projects";
import { isCreditsRef } from "@engenty-wizards/shared/providers";
import { note } from "@engenty-wizards/shared/run";
import { wizardTexts } from "@engenty-wizards/shared/translation";
import {
  PACKAGE_EXTENSION,
  PACKAGE_MAX_BYTES,
  PACKAGE_MIME,
} from "@engenty-wizards/shared/wizard-package";
import { generateText } from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import { z } from "zod";
import { type AnswerPart, runStudioAssistant, signalText } from "../agents/studio-assistant.js";
import { chatEngine, setChatEngine, subscriptionClients } from "../agents/subscription.js";
import { scanColors, scanFonts, scanImages, scanLogos } from "../agents/website.js";
import { answerBrowser, awaitBrowser } from "../assistant/browser.js";
import { endRun, signalRun, startRun, takeSignals } from "../assistant/runs.js";
import { accountOverview, linkedAccount, startLink, unlink } from "../auth/account.js";
import type { SessionUser } from "../auth/index.js";
import { createLocalKey, deleteLocalKey, listLocalKeys } from "../auth/keys.js";
import { appStates, connectApps } from "../cli/connect.js";
import { layout } from "../cli/home.js";
import {
  connectorImportSchema,
  importConnector,
  listConnectors,
  previewSource,
  refreshConnector,
  registryService,
  removeConnector,
  searchRegistry,
} from "../connectors/external.js";
import { balanceCredits, canSpend } from "../credits/credits.js";
import { estimateRun } from "../credits/estimate.js";
import { missingModels, stepsWithoutModel } from "../engine/requirements.js";
import { env } from "../env.js";
import { feature, features } from "../features.js";
import { appleStatus } from "../harness/apple.js";
import { freshAuth, loginEnv } from "../harness/env.js";
import {
  detectHarness,
  detectHarnesses,
  HARNESS_IDS,
  type HarnessId,
  harness,
  installSpec,
} from "../harness/index.js";
import {
  closeTerminal,
  openTerminal,
  resizeTerminal,
  subscribeTerminal,
  writeTerminal,
} from "../harness/terminal.js";
import {
  installMail,
  managed,
  renameTenant,
  saveTeamProfile,
  tenantInfo,
  tenantMembers,
  userInfo,
} from "../manage.js";
import { seenApps } from "../mcp/seen.js";
import { generateImageMedia, generateSpeechMedia, generateVideoMedia } from "../media/generate.js";
import { transcribeAudio } from "../media/transcribe.js";
import { errorText, saidOf } from "../model-errors.js";
import {
  checkKey,
  classProblem,
  classWays,
  embeddingModel,
  hasTextModel,
  LOCAL_KEYS,
  localModelSettings,
  ModelUnavailableError,
  modelSettings,
  saveLocalModels,
  saveModels,
  setUpKey,
  setUpOllama,
  storedKey,
  textModel,
} from "../models.js";
import { refreshPro } from "../plugins/pro.js";
import { HTML_RESPONSE_CSP } from "../render/guard.js";
import {
  isAdminRole,
  mayBuild,
  mayCreate,
  projectWritable,
  requireAdmin,
  requireWritable,
} from "../services/access.js";
import { architectTurn } from "../services/architect.js";
import {
  addMessage,
  assistantLayout,
  currentChat,
  earlierChats,
  foldChat,
  newChat,
  openChat,
  readChat,
  turnHistory,
} from "../services/assistant-chats.js";
import { describeGradient } from "../services/brand.js";
import {
  checkForCloud,
  cloudLinked,
  cloudSpaces,
  cloudState,
  forgetCloud,
  publishAndSync,
  pushSharing,
  removeFromCloud,
  replaceCloudSpaces,
  rotateInCloud,
  syncToCloud,
} from "../services/cloud.js";
import { notFound, ServiceError } from "../services/errors.js";
import { deleteFile, listFiles, readFile, writeFile } from "../services/files.js";
import {
  categoryContents,
  listKnowledge,
  resolvePath,
  valueContents,
} from "../services/knowledge.js";
import { writeSummary } from "../services/knowledge-model.js";
import { applyWebsite, finishOnboarding, needsOnboarding } from "../services/onboarding.js";
import { exportWizard, importWizard } from "../services/package.js";
import {
  profileSchema,
  saveProfile,
  saveUserLang,
  userLang,
  userProfile,
} from "../services/profile.js";
import {
  addProjectFile,
  addProjectFileFromUrl,
  fileView,
  orderProjectFiles,
  projectFile,
  projectFileContent,
  projectFiles,
  reindexProjectFile,
  removeProjectFile,
  updateProjectFile,
} from "../services/project-files.js";
import { documentText, queueIndex, searchKnowledge } from "../services/project-index.js";
import {
  createProject,
  deleteProject,
  gradientSchema,
  listProjects,
  maskedServers,
  ownedProject,
  projectLimitOrNull,
  projectPatchSchema,
  updateProject,
} from "../services/projects.js";
import { runnersOf, wizardRunners } from "../services/runners.js";
import { listResults, listRuns, startTestRun } from "../services/runs.js";
import {
  addCategoryValue,
  categoryRow,
  categoryValue,
  deleteCategory,
  deleteCategoryValue,
  mergeCategoryValues,
  orderCategoryValues,
  putCategory,
  renameCategoryValue,
  setItemCategory,
  updateCategory,
} from "../services/space-categories.js";
import {
  addTableRow,
  createPage,
  createTable,
  deletePage,
  deleteTable,
  deleteTableRows,
  getPage,
  getTable,
  listSpaceData,
  orderSubPages,
  updatePage,
  updateTable,
  updateTableRow,
} from "../services/space-data.js";
import {
  deleteTranslation,
  editTranslation,
  isLangCode,
  publishedDefinition,
  translationsOf,
} from "../services/translations.js";
import { draftWidgetPreview } from "../services/widgets.js";
import {
  createWizard,
  deleteWizard,
  draftChanges,
  duplicateWizard,
  listWizards,
  ownedWizard,
  rotateShareLink,
  updateWizardSettings,
  wizardMessages,
  wizardState,
  writableWizard,
  writeDraft,
} from "../services/wizards.js";
import { readSetting, writeSetting } from "../settings.js";
import { codeOf } from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";
import { serverText } from "../texts.js";
import { applyUpdate, updateStatus } from "../update.js";
import { byteRange } from "./delivery.js";
import { notFoundAnswer, requestLang, say } from "./lang.js";

type Vars = { Variables: { user: SessionUser } };

/** The model sources a test call has worked on: the setup is done for those, not for the others. */
async function testedSources(): Promise<string[]> {
  const tested = await readSetting<unknown>("setup-done");
  return Array.isArray(tested) ? (tested as string[]) : [];
}

async function markTested(source: string) {
  const tested = await testedSources();
  if (!tested.includes(source)) {
    await writeSetting("setup-done", [...tested, source]);
  }
}

/**
 * The chosen source has passed a test call and can still answer: its client is there and signed
 * in. Where Apple Intelligence thinks the short classes, the test ran there; a client behind High
 * and Highest is no condition then.
 */
async function setupDone(): Promise<boolean> {
  const { source, bindings } = localModelSettings();
  if (!(await testedSources()).includes(source)) {
    return false;
  }
  const client = bindings.standard.startsWith("apple:") ? null : harness(source);
  if (client) {
    const status = await detectHarness(client.id);
    return Boolean(status?.version) && status?.auth !== "none";
  }
  return hasTextModel();
}

const modelsInput = z.object({
  source: z.enum([...HARNESS_IDS, "account", "own"]).optional(),
  bindings: z.partialRecord(z.enum(MODEL_CLASSES), z.string().max(160)).optional(),
  ollamaUrl: z.string().max(200).optional(),
  creditFallback: z.boolean().optional(),
  keys: z.partialRecord(z.enum(LOCAL_KEYS), z.string().max(400)).optional(),
});

/** Alone the person changes everything; in a team its owner and admins. */
function mayChangeModels(user: SessionUser): boolean {
  return !managed || user.role === "owner" || user.role === "admin";
}

/** A binding the cloud can run: a provider's model or the credits, no client, no local model. */
function cloudBinding(ref: string): boolean {
  return (
    isCreditsRef(ref) || /^(openai|anthropic|google|fal|elevenlabs|replicate|gateway):/.test(ref)
  );
}

const TEST_TEXT = {
  de: {
    image:
      "Ein kleiner, freundlicher Zauberhut aus orangem Filz auf einem Holztisch, weiches Licht, flache Illustration.",
    speech: "Hallo! So klingt die Stimme deiner Wizards.",
    video: "Ein orangefarbener Zauberhut dreht sich langsam auf einem Holztisch, weiches Licht.",
  },
  en: {
    image:
      "A small, friendly wizard hat of orange felt on a wooden table, soft light, flat illustration.",
    speech: "Hello! This is how your wizards sound.",
    video: "An orange wizard hat slowly turns on a wooden table, soft light.",
  },
} as const;

const asDataUrl = (bytes: Uint8Array, mime: string) =>
  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

/** One second of silence as WAV: what a voice note test listens to where nothing speaks. */
function silentWav(): Uint8Array {
  const rate = 16_000;
  const samples = rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(buf);
}

interface ClassTest {
  ok: boolean;
  ms: number;
  ref?: string;
  /** What a text model answered, or what was heard in a voice note. */
  reply?: string;
  /** The image, voice or clip that came back, as a data URL. */
  media?: string;
  error?: string;
}

async function testClass(cls: (typeof MODEL_CLASSES)[number], lang: Lang): Promise<ClassTest> {
  const started = Date.now();
  const signal = AbortSignal.timeout(cls === "video" ? 300_000 : 120_000);
  const done = (result: Omit<ClassTest, "ok" | "ms">): ClassTest => ({
    ok: true,
    ms: Date.now() - started,
    ...result,
  });
  try {
    if ((TEXT_CLASSES as readonly string[]).includes(cls)) {
      const resolved = await textModel(cls as (typeof TEXT_CLASSES)[number]);
      const result = await generateText({
        model: resolved.model,
        prompt: "Reply with the single word: OK",
        maxOutputTokens: 20,
        abortSignal: signal,
      });
      return done({ ref: resolved.ref, reply: result.text.trim().slice(0, 200) });
    }
    if (cls === "image") {
      const image = await generateImageMedia({
        prompt: TEST_TEXT[lang].image,
        aspectRatio: "1:1",
        abortSignal: signal,
      });
      return done({ ref: image.system, media: asDataUrl(image.bytes, image.mime) });
    }
    if (cls === "speech") {
      const voice = await generateSpeechMedia({
        text: TEST_TEXT[lang].speech,
        abortSignal: signal,
      });
      return done({ ref: voice.system, media: asDataUrl(voice.bytes, voice.mime) });
    }
    if (cls === "video") {
      const clip = await generateVideoMedia({
        prompt: TEST_TEXT[lang].video,
        aspectRatio: "16:9",
        duration: 4,
        resolution: "480p",
        abortSignal: signal,
      });
      return done({ ref: clip.system, media: asDataUrl(clip.bytes, clip.mime) });
    }
    // A voice note: the test voice where one speaks here, else a second of silence.
    const voice = (await classProblem("speech"))
      ? null
      : await generateSpeechMedia({ text: TEST_TEXT[lang].speech, abortSignal: signal }).catch(
          () => null,
        );
    const heard = await transcribeAudio({
      bytes: voice?.bytes ?? silentWav(),
      mediaType: voice?.mime ?? "audio/wav",
      abortSignal: signal,
    });
    return done({ reply: heard.text.slice(0, 300) });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    return { ok: false, ms: Date.now() - started, error: message.slice(0, 500) };
  }
}

/** The size of an inline terminal, as the page lays it out. */
/** Whether the studio assistant's developer mode is offered to this person. */
async function assistantDevFor(user: SessionUser): Promise<boolean> {
  return managed ? (await userInfo(user.id)).admin : env.assistantDev;
}

const terminalSize = z.object({
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(4).max(200).optional(),
});

export const studio = new Hono<Vars>()
  .get("/me", async (c) => {
    const user = c.get("user");
    // A runtime that runs alone may be linked to an account: its credits and the cloud to publish to.
    const linked = managed ? null : await linkedAccount();
    const overview = linked ? await accountOverview() : null;
    const profile = await userProfile(user);
    // What the Manage-App says of the tenant: its plan and feature switches; and of the person.
    const info = managed ? await tenantInfo(user.tenantId).catch(() => null) : null;
    const person = managed ? await userInfo(user.id) : null;
    return c.json({
      user: { id: user.id, name: profile.name, email: profile.email, image: user.image ?? null },
      /** What the person says about themselves; name and e-mail are the account's when managed. */
      profile,
      /** The language the person picked, wherever they picked it; null until they do. */
      lang: await userLang(user),
      tenant: {
        id: user.tenantId,
        role: user.role,
        /** The plan the team is on; null alone, or where the Manage-App names none. */
        plan: info?.plan ?? null,
      },
      /** The feature switches: the code's defaults, what the Manage-App says of the team and the person, this install's file. */
      features: features(
        managed ? { ...info?.features, ...person?.features } : overview?.tenant.features,
      ),
      /** The studio assistant's developer mode may be switched on: ASSISTANT_DEV here, the platform's admins when managed. */
      assistantDev: await assistantDevFor(user),
      mode: managed ? "managed" : "local",
      /** The tenant's balance; null where the runtime resolves models itself. */
      credits: managed ? await balanceCredits() : null,
      /** Where the account, members, API keys and credits are managed. */
      manageUrl: managed ? env.manage.url : null,
      account: linked
        ? {
            name: linked.name,
            email: linked.email,
            /** The team the account's space belongs to, as the Manage-App names it. */
            team: overview?.tenant.name ?? null,
            credits: overview?.tenant.balanceCredits ?? null,
            /** What of the credits ends on a date, the nearest first. */
            expiring: overview?.tenant.expiring ?? [],
            url: env.local.accountUrl,
            cloudUrl: env.local.cloudUrl,
            signedIn: Boolean(overview),
          }
        : null,
      models: managed ? null : localModelSettings(),
      /** Apple Intelligence on this Mac: offered where the machine can run it (harness/apple.ts). */
      apple: managed ? null : await appleStatus(),
      /** The AI clients this runtime can think with — installed or not, and how each is signed in. */
      harnesses: managed ? [] : await detectHarnesses(),
      /** Installed AI clients whose subscription can answer the studio chat. */
      subscriptions: managed ? [] : await subscriptionClients(),
      /** A runtime that runs alone keeps its setup in front until a test call has worked on the chosen source and the way is still open. */
      setupDone: managed ? true : await setupDone(),
      /** The cloud studio's first visit: the short wizard that names the team and fills the space (services/onboarding.ts). */
      onboarding: await needsOnboarding(user),
      /** What answers the studio chat: a model of class `highest`, or the admin's own subscription. */
      chatEngine: managed ? "models" : await chatEngine(await hasTextModel()),
      aiReady: (await hasTextModel()) || (!managed && (await subscriptionClients()).length > 0),
      mcpUrl: `${env.appUrl}/api/mcp`,
      /**
       * One project: the studio shows no project switcher; null: as many as wanted. `build:
       * false`: nothing is made or changed here; the studio shows what the person's local
       * install synced. `create`: the person makes and deletes here (builds, and is no mere
       * member). `members`: the people the plan allows, null for no limit.
       */
      limits: {
        projects: await projectLimitOrNull(),
        build: await mayBuild(),
        create: await mayCreate(),
        members: info?.limits.members ?? null,
      },
    });
  })
  // The team as the Manage-App keeps it: its people, who is invited, the places the plan gives.
  .get("/team", async (c) => {
    if (!managed) {
      return c.json(
        {
          error: say(c, "onlyAvailableCloud"),
          code: "not_managed",
        },
        404,
      );
    }
    const user = c.get("user");
    const [info, team] = await Promise.all([
      tenantInfo(user.tenantId).catch(() => null),
      tenantMembers(currentTenant()),
    ]);
    return c.json({
      ...team,
      plan: info?.plan ?? null,
      /** Where members are invited and roles changed: the account pages of the Manage-App. */
      manageUrl: env.manage.url,
      /** Whether this person manages the team there. */
      canManage: isAdminRole(user.role),
    });
  })

  // A runtime that runs alone says when a newer release is out and can run the update itself;
  // `?fresh=1` asks GitHub now instead of within the hour.
  .get("/update", async (c) =>
    managed
      ? c.json(
          {
            error: say(c, "onlyAvailableComputer"),
            code: "not_local",
          },
          404,
        )
      : c.json(await updateStatus(c.req.query("fresh") === "1")),
  )
  .post("/update", async (c) => {
    if (managed) {
      return c.json(
        {
          error: say(c, "onlyAvailableComputer"),
          code: "not_local",
        },
        404,
      );
    }
    applyUpdate();
    return c.json(await updateStatus());
  })

  .put("/profile", async (c) =>
    c.json(await saveProfile(c.get("user"), profileSchema.parse(await c.req.json()))),
  )
  .put("/lang", async (c) => {
    const { lang } = z.object({ lang: z.enum(LANGS) }).parse(await c.req.json());
    await saveUserLang(c.get("user"), lang);
    return c.json({ lang });
  })

  // --- the studio's assistant -------------------------------------------------
  // One open chat per person and tenant, on every page; turns stream as SSE events shaped like
  // AG-UI's (packages/shared/src/assistant.ts).
  .get("/assistant/chat", async (c) => c.json(await currentChat(c.get("user"))))
  .post("/assistant/chat/new", async (c) => c.json(await newChat(c.get("user"))))
  .get("/assistant/chats", async (c) => c.json({ chats: await earlierChats(c.get("user")) }))
  .get("/assistant/chats/:id", async (c) =>
    c.json(await readChat(c.get("user"), c.req.param("id"))),
  )
  .get("/assistant/layout", async (c) => c.json({ layout: await assistantLayout(c.get("user")) }))
  .put("/assistant/layout", async (c) => {
    const { layout } = z.object({ layout: z.enum(ASSISTANT_LAYOUTS) }).parse(await c.req.json());
    await writeSetting(`assistant-layout:${c.get("user").tenantId}:${c.get("user").id}`, layout);
    return c.json({ layout });
  })
  // Live chat reads answers aloud with the speech model where one is set up; else the browser's voices.
  .get("/assistant/voice", async (c) => c.json({ way: (await classWays()).speech.kind }))
  .post("/assistant/speak", async (c) => {
    const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(await c.req.json());
    if ((await classWays()).speech.kind === "none") {
      throw new ServiceError("refused", note("noLanguageModelSet"));
    }
    if (!(await canSpend())) {
      throw new ServiceError("no_credits", note("creditsUsedUp"));
    }
    const voice = await generateSpeechMedia({ text, abortSignal: c.req.raw.signal });
    return c.body(new Uint8Array(voice.bytes), 200, { "content-type": voice.mime });
  })
  // A message written while a turn runs: the turn takes it before its next step or after its answer.
  .post("/assistant/run/:runId/signal", async (c) => {
    const body = assistantSignalSchema.parse(await c.req.json());
    const taken = signalRun(c.get("user").id, c.req.param("runId"), body);
    return c.json({ ok: taken }, taken ? 200 : 404);
  })
  // A browser tool's result: the turn that waits for it goes on.
  .post("/assistant/tool/:callId", async (c) => {
    const body = z.object({ result: z.unknown() }).parse(await c.req.json());
    const taken = answerBrowser(c.get("user").id, c.req.param("callId"), body.result ?? null);
    return c.json({ ok: taken }, taken ? 200 : 404);
  })
  .post("/assistant/turn", async (c) => {
    const user = c.get("user");
    const body = assistantTurnSchema
      .extend({ lang: z.enum(LANGS).default("en") })
      .parse(await c.req.json());
    if (!(await canSpend())) {
      throw new ServiceError("no_credits", note("creditsUsedUp"));
    }
    const project = body.projectId ? await ownedProject(user.id, body.projectId) : null;
    const writable = project ? await projectWritable(project) : false;
    // The page's snapshot is cut, not refused: a page that says too much still gets an answer.
    const page =
      body.page && JSON.stringify(body.page).length > ASSISTANT_PAGE_BYTES
        ? { route: body.page.route, title: body.page.title, view: body.page.view }
        : (body.page ?? null);
    const chat = await openChat(user);
    const debug = Boolean(body.debug) && (await assistantDevFor(user));
    let history = await turnHistory(user, chat);
    const runId = nanoid(10);
    const userMessageId = await addMessage(chat.id, {
      role: "user",
      content: body.message,
      page: page ? { route: page.route, title: page.title } : null,
    });
    startRun(runId, user.id);
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      const send = <K extends keyof AssistantEvents>(event: K, data: AssistantEvents[K]) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      let messageId = nanoid(14);
      await send("run_started", { threadId: chat.id, runId, messageId: userMessageId });
      // The answer's text since the last message written meanwhile.
      let reply = "";
      let changed = false;
      let steps = 0;
      /** What the answer said and did up to messages written meanwhile; null when nothing. */
      const storePart = async (before: AnswerPart) => {
        changed ||= before.changed;
        return before.reply || before.toolCalls.length || before.cards.length
          ? await addMessage(chat.id, { role: "assistant", content: before.reply, ...before })
          : null;
      };
      /** The messages written meanwhile, after the part of the answer before them. */
      const storeSignals = async (taken: AssistantSignal[], answerId: string | null) => {
        for (const [i, s] of taken.entries()) {
          const stored = await addMessage(chat.id, { role: "user", content: s.message });
          await send("signal", {
            ref: s.ref,
            messageId: stored,
            content: s.message,
            answerId: i === 0 ? answerId : null,
          });
        }
        reply = "";
        messageId = nanoid(14);
      };
      try {
        let message = body.message;
        for (;;) {
          const result = await runStudioAssistant({
            user,
            chat,
            history,
            project,
            writable,
            message,
            page,
            browserTools: body.tools,
            lang: body.lang,
            signal: abort.signal,
            onText: (delta) => {
              reply += delta;
              void send("text", { messageId, delta });
            },
            onActivity: (label) => void send("activity", { label }),
            onChanged: () => void send("changed", {}),
            onCard: (card) => void send("card", card),
            onToolCall: (call) => void send("tool_call", call),
            onToolResult: (result) => void send("tool_result", result),
            callBrowser: (call) => awaitBrowser(user.id, call.toolCallId, abort.signal),
            takeSignals: () => takeSignals(runId),
            onSignal: async (taken, before) => storeSignals(taken, await storePart(before)),
            ...(debug
              ? {
                  onPrompt: (prompt) => void send("prompt", prompt),
                  onStep: (step) => void send("step", { ...step, step: ++steps }),
                }
              : {}),
          });
          // Written after the answer's last step: the turn goes on with it.
          const left = takeSignals(runId);
          if (!left.length || abort.signal.aborted) {
            changed ||= result.changed;
            reply = result.reply || (changed ? serverText(body.lang, "done") : "");
            const stored = await addMessage(chat.id, {
              role: "assistant",
              content: reply,
              cards: result.cards,
              toolCalls: result.toolCalls,
              changed: result.changed,
            });
            await send("done", { messageId: stored, reply, changed });
            break;
          }
          // The next answer knows this one: it is stored before the history is read again.
          const answerId = await storePart(result);
          history = await turnHistory(user, chat);
          await storeSignals(left, answerId);
          message = signalText(left);
        }
      } catch (err) {
        console.error("[studio-assistant]", err);
        if (reply.trim()) {
          await addMessage(chat.id, { role: "assistant", content: reply.trim() }).catch(() => null);
        }
        await send("error", {
          message:
            err instanceof ServiceError || err instanceof ModelUnavailableError
              ? errorText(err, body.lang)
              : serverText(body.lang, "somethingWrong"),
        });
      }
      endRun(runId);
      // Older messages fold into the chat's running summary once enough have piled up.
      void foldChat(chat.id).catch((err) => console.error("[studio-assistant] fold:", err));
    });
  })

  // --- projects --------------------------------------------------------------
  .get("/projects", async (c) => {
    const projects = await listProjects(c.get("user").id, requestLang(c));
    const build = await mayBuild();
    return c.json(
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        brand: p.brand,
        facts: p.facts,
        mcpServers: maskedServers(p),
        wizardCount: p.wizardCount,
        /** `local`: synced from a local install, where it is changed. */
        origin: p.origin,
        syncedAt: p.syncedAt?.toISOString() ?? null,
        readOnly: p.origin === "local" || !build,
      })),
    );
  })
  .post("/projects", async (c) => {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(await c.req.json());
    return c.json(await createProject(c.get("user").id, body.name));
  })
  .patch("/projects/:id", async (c) => {
    const patch = projectPatchSchema.parse(await c.req.json());
    await updateProject(c.get("user").id, c.req.param("id"), patch);
    return c.json({ ok: true });
  })
  // --- what a project holds for all its wizards: logos, assets, documents -------
  .get("/projects/:id/files", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    return c.json({
      files: (await projectFiles(project.id)).map(fileView),
      /** Whether documents get vectors, or the index works on keywords alone. */
      embeddings: Boolean(await embeddingModel().catch(() => null)),
    });
  })
  .post("/projects/:id/files", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    const kind = z.enum(PROJECT_FILE_KINDS).parse(c.req.query("kind"));
    const file = (await c.req.formData()).get("file");
    if (!(file instanceof File)) {
      throw new ServiceError("invalid", note("chooseFile"));
    }
    const row = await addProjectFile(project.id, {
      kind,
      name: file.name,
      mime: file.type.split(";")[0].trim().toLowerCase(),
      data: new Uint8Array(await file.arrayBuffer()),
    });
    return c.json(fileView(row));
  })
  .post("/projects/:id/files/url", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    const input = z
      .object({ url: z.string().min(1).max(500_000), kind: z.enum(PROJECT_FILE_KINDS) })
      .parse(await c.req.json());
    const url = /^(https?:\/\/|data:)/i.test(input.url) ? input.url : `https://${input.url}`;
    try {
      return c.json({ file: fileView(await addProjectFileFromUrl(project.id, { ...input, url })) });
    } catch (err) {
      // A web page where a logo or an asset was asked for: its logos or pictures, to pick from.
      if (err instanceof ServiceError && err.data.reason === "page") {
        const page = String(err.data.url ?? url);
        const scan = input.kind === "logo" ? scanLogos : scanImages;
        return c.json({ candidates: await scan(page) });
      }
      throw err;
    }
  })
  .post("/projects/:id/colors/scan", async (c) => {
    await ownedProject(c.get("user").id, c.req.param("id"));
    const { url } = z.object({ url: z.string().min(1).max(2000) }).parse(await c.req.json());
    const colors = await scanColors(url).catch(() => {
      throw new ServiceError("invalid", note("pageNotReached"));
    });
    return c.json({ colors });
  })
  // A gradient from the admin's words, or theirs changed as they say. Nothing is saved.
  .post("/projects/:id/gradients/describe", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    const { text, gradient } = z
      .object({
        text: z.string().trim().min(1).max(1000),
        gradient: gradientSchema
          .pick({ name: true, type: true, angle: true, stops: true })
          .optional(),
      })
      .parse(await c.req.json());
    if (!(await canSpend())) {
      throw new ServiceError("no_credits", note("creditsUsedUp"));
    }
    try {
      return c.json({
        gradient: await describeGradient(project.brand.colors ?? [], text, gradient),
      });
    } catch (err) {
      if (err instanceof ModelUnavailableError) {
        throw new ServiceError("refused", saidOf(err));
      }
      throw err;
    }
  })
  .post("/projects/:id/fonts/scan", async (c) => {
    await ownedProject(c.get("user").id, c.req.param("id"));
    const { url } = z.object({ url: z.string().min(1).max(2000) }).parse(await c.req.json());
    const fonts = await scanFonts(url).catch(() => {
      throw new ServiceError("invalid", note("pageNotReached"));
    });
    return c.json({ fonts });
  })
  .put("/projects/:id/files/order", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    const body = z
      .object({ kind: z.enum(PROJECT_FILE_KINDS), ids: z.array(z.string()).max(200) })
      .parse(await c.req.json());
    await orderProjectFiles(project.id, body.kind, body.ids);
    return c.json({ ok: true });
  })
  .patch("/projects/:id/files/:fileId", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    const patch = z
      .object({ name: z.string().max(120).optional(), description: z.string().max(600).optional() })
      .parse(await c.req.json());
    return c.json(fileView(await updateProjectFile(project.id, c.req.param("fileId"), patch)));
  })
  .post("/projects/:id/files/:fileId/reindex", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    return c.json(fileView(await reindexProjectFile(project.id, c.req.param("fileId"))));
  })
  .delete("/projects/:id/files/:fileId", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    await removeProjectFile(project.id, c.req.param("fileId"));
    return c.json({ ok: true });
  })
  .get("/projects/:id/files/:fileId/content", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    const { row, data } = await projectFileContent(project.id, c.req.param("fileId"));
    const headers: Record<string, string> = {
      "content-type": row.mime,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      // An uploaded SVG or HTML file is shown, never run. A PDF is left to the browser's own
      // viewer, which a sandbox would keep from starting.
      ...(row.mime === "application/pdf" ? {} : { "content-security-policy": "sandbox" }),
    };
    if (/^(audio|video)\//.test(row.mime)) {
      headers["accept-ranges"] = "bytes";
      const range = byteRange(c.req.header("range"), data.byteLength);
      if (range === "unsatisfiable") {
        return c.body(null, 416, { "content-range": `bytes */${data.byteLength}` });
      }
      if (range) {
        headers["content-range"] = `bytes ${range.start}-${range.end}/${data.byteLength}`;
        return c.body(new Uint8Array(data.subarray(range.start, range.end + 1)), 206, headers);
      }
    }
    return c.body(new Uint8Array(data), 200, headers);
  })
  // A document as the models read it: its text as Markdown, or the start of it.
  .get("/projects/:id/files/:fileId/text", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    const row = await projectFile(project.id, c.req.param("fileId"));
    const limit = z.coerce
      .number()
      .int()
      .min(100)
      .max(400_000)
      .catch(200_000)
      .parse(c.req.query("limit"));
    const text = await documentText(row);
    return c.json({ text: text.slice(0, limit), chars: text.length });
  })
  // What a search of Knowledge finds for a question: the items an agent step would get.
  .post("/projects/:id/search", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    const body = z
      .object({ query: z.string().min(1).max(400), where: whereSchema.optional() })
      .parse(await c.req.json());
    return c.json(await searchKnowledge(project.id, body.query, { where: body.where }));
  })
  .delete("/projects/:id", async (c) => {
    await deleteProject(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })

  // --- connectors: services imported from the integrations registry ------------
  .post("/connectors/search", async (c) => {
    const { query } = z.object({ query: z.string().min(1).max(200) }).parse(await c.req.json());
    return c.json(await searchRegistry(query));
  })
  .get("/connectors/registry/:domain", async (c) =>
    c.json(await registryService(c.req.param("domain"))),
  )
  .post("/connectors/preview", async (c) => {
    const body = z
      .object({
        domain: z.string().min(1).max(253).optional(),
        sourceKind: z.enum(["openapi", "mcp"]),
        sourceUrl: z.string().url(),
      })
      .parse(await c.req.json());
    return c.json(await previewSource(body));
  })
  .get("/projects/:id/connectors", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    return c.json(await listConnectors(project.id));
  })
  .post("/projects/:id/connectors", async (c) => {
    const user = c.get("user");
    const project = await ownedProject(user.id, c.req.param("id"));
    return c.json(
      await importConnector(user.id, project.id, connectorImportSchema.parse(await c.req.json())),
    );
  })
  .post("/projects/:id/connectors/:connectorId/refresh", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    return c.json(await refreshConnector(project.id, c.req.param("connectorId"), null));
  })
  .delete("/projects/:id/connectors/:connectorId", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    await removeConnector(project.id, c.req.param("connectorId"));
    return c.json({ ok: true });
  })

  // The runs of the space's wizards that reached their result: of one wizard, or of all.
  .get("/projects/:id/results", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    const query = z
      .object({
        wizard: z.string().optional(),
        q: z.string().max(200).optional(),
        mode: z.enum(["live", "test"]).optional(),
        days: z.coerce.number().int().min(1).max(3650).optional(),
      })
      .parse(c.req.query());
    return c.json(
      await listResults(project.id, {
        wizardId: query.wizard || undefined,
        q: query.q,
        mode: query.mode,
        days: query.days,
      }),
    );
  })

  // --- Knowledge: its items and categories ------------------------------------
  .get("/projects/:id/knowledge", async (c) =>
    c.json(await listKnowledge(c.get("user").id, c.req.param("id"))),
  )
  // What a link in a page names (`pages/bgb/p-281`): the studio opens it.
  .get("/projects/:id/resolve", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    const found = await resolvePath(project.id, z.string().max(600).parse(c.req.query("path")));
    if (!found) {
      throw notFound();
    }
    return c.json(found);
  })
  .post("/projects/:id/categories", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    await requireWritable(project);
    const body = z
      .object({
        name: z.string().min(1).max(80),
        type: z.enum(CATEGORY_TYPES),
        unit: z.string().max(20).nullish(),
        multiple: z.boolean().optional(),
        ordered: z.boolean().optional(),
        hint: z.string().max(120).nullish(),
        values: z.array(z.string().max(200)).max(200).optional(),
        tableId: z.string().nullish(),
        columnId: z.string().nullish(),
      })
      .parse(await c.req.json());
    const row = await putCategory(project.id, body);
    return c.json({ id: row.id });
  })
  .patch("/categories/:id", async (c) => {
    const row = await categoryRow(c.req.param("id"));
    await ownedProject(c.get("user").id, row.projectId);
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        unit: z.string().max(20).nullish(),
        multiple: z.boolean().optional(),
        ordered: z.boolean().optional(),
        hint: z.string().max(120).nullish(),
        proposed: z.literal(false).optional(),
        position: z.number().int().min(0).optional(),
      })
      .parse(await c.req.json());
    await updateCategory(row.id, body);
    return c.json({ ok: true });
  })
  .delete("/categories/:id", async (c) => {
    const row = await categoryRow(c.req.param("id"));
    await ownedProject(c.get("user").id, row.projectId);
    await deleteCategory(row.id);
    return c.json({ ok: true });
  })
  .post("/categories/:id/values", async (c) => {
    const row = await categoryRow(c.req.param("id"));
    await ownedProject(c.get("user").id, row.projectId);
    const { value } = z.object({ value: z.string().min(1).max(200) }).parse(await c.req.json());
    return c.json(await addCategoryValue(row.id, value));
  })
  .put("/categories/:id/values/order", async (c) => {
    const row = await categoryRow(c.req.param("id"));
    await ownedProject(c.get("user").id, row.projectId);
    const { ids } = z.object({ ids: z.array(z.string()).max(500) }).parse(await c.req.json());
    await orderCategoryValues(row.id, ids);
    return c.json({ ok: true });
  })
  .get("/values/:id", async (c) => c.json(await valueContents(c.get("user").id, c.req.param("id"))))
  // Everything that has a category: the entries its page lists.
  .get("/categories/:id/items", async (c) =>
    c.json(await categoryContents(c.get("user").id, c.req.param("id"))),
  )
  .patch("/values/:id", async (c) => {
    const { category } = await categoryValue(c.req.param("id"));
    await ownedProject(c.get("user").id, category.projectId);
    const { value } = z.object({ value: z.string().min(1).max(200) }).parse(await c.req.json());
    await renameCategoryValue(c.req.param("id"), value);
    return c.json({ ok: true });
  })
  .post("/values/:id/merge", async (c) => {
    const { category } = await categoryValue(c.req.param("id"));
    await ownedProject(c.get("user").id, category.projectId);
    const { into } = z.object({ into: z.string() }).parse(await c.req.json());
    await mergeCategoryValues(c.req.param("id"), into);
    return c.json({ ok: true });
  })
  .delete("/values/:id", async (c) => {
    const { category } = await categoryValue(c.req.param("id"));
    await ownedProject(c.get("user").id, category.projectId);
    await deleteCategoryValue(c.req.param("id"));
    return c.json({ ok: true });
  })
  // The summary of a value: a model writes it from the value's items.
  .post("/values/:id/summary", async (c) => {
    const { category } = await categoryValue(c.req.param("id"));
    const project = await ownedProject(c.get("user").id, category.projectId);
    await requireWritable(project);
    return c.json({ summary: await writeSummary(c.req.param("id")) });
  })
  // A category a person sets on an item: `p:<page>`, `t:<table>`, `r:<row>`, `f:<file>`.
  .put("/projects/:id/items/:key/categories/:categoryId", async (c) => {
    const project = await ownedProject(c.get("user").id, c.req.param("id"));
    await requireWritable(project);
    const key = c.req.param("key");
    const id = key.slice(2);
    const ref =
      key[0] === "p"
        ? { pageId: id }
        : key[0] === "t"
          ? { tableId: id }
          : key[0] === "r"
            ? { rowId: id }
            : key[0] === "f"
              ? { fileId: id }
              : null;
    if (!ref || key[1] !== ":") {
      throw new ServiceError("invalid", note("unknownEntry"));
    }
    const { values } = z
      .object({ values: z.array(z.union([z.string().max(300), z.number(), z.boolean()])).max(50) })
      .parse(await c.req.json());
    if (await setItemCategory(project.id, ref, c.req.param("categoryId"), values)) {
      queueIndex(key[0] === "p" ? `P:${id}` : key);
    }
    return c.json({ ok: true });
  })

  // --- the space's tables and pages --------------------------------------------
  .get("/projects/:id/data", async (c) =>
    c.json(await listSpaceData(c.get("user").id, c.req.param("id"))),
  )
  .post("/projects/:id/tables", async (c) => {
    const body = z
      .object({
        title: z.string().max(120),
        wizardId: z.string().nullish(),
        columns: z.unknown().optional(),
        format: z.enum(["faq"]).nullish(),
      })
      .parse(await c.req.json());
    return c.json(await createTable(c.get("user").id, c.req.param("id"), body, requestLang(c)));
  })
  .get("/tables/:id", async (c) => c.json(await getTable(c.get("user").id, c.req.param("id"))))
  .patch("/tables/:id", async (c) => {
    const body = z
      .object({
        title: z.string().max(120).optional(),
        wizardId: z.string().nullish(),
        columns: z.unknown().optional(),
        format: z.enum(["faq"]).nullish(),
        review: z.null().optional(),
      })
      .parse(await c.req.json());
    await updateTable(c.get("user").id, c.req.param("id"), body);
    return c.json({ ok: true });
  })
  .delete("/tables/:id", async (c) => {
    await deleteTable(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/tables/:id/rows", async (c) => {
    const body = z
      .object({ cells: z.record(z.string(), z.unknown()).optional() })
      .parse(await c.req.json());
    return c.json(await addTableRow(c.get("user").id, c.req.param("id"), body.cells));
  })
  .patch("/tables/:id/rows/:rowId", async (c) => {
    const body = z.object({ cells: z.record(z.string(), z.unknown()) }).parse(await c.req.json());
    return c.json(
      await updateTableRow(c.get("user").id, c.req.param("id"), c.req.param("rowId"), body.cells),
    );
  })
  .post("/tables/:id/rows/delete", async (c) => {
    const body = z.object({ ids: z.array(z.string()).max(5000) }).parse(await c.req.json());
    await deleteTableRows(c.get("user").id, c.req.param("id"), body.ids);
    return c.json({ ok: true });
  })
  .post("/projects/:id/pages", async (c) => {
    const body = z
      .object({
        title: z.string().max(200),
        wizardId: z.string().nullish(),
        parentId: z.string().nullish(),
        markdown: z.string().optional(),
      })
      .parse(await c.req.json());
    return c.json(await createPage(c.get("user").id, c.req.param("id"), body));
  })
  .get("/pages/:id", async (c) => c.json(await getPage(c.get("user").id, c.req.param("id"))))
  .patch("/pages/:id", async (c) => {
    const body = z
      .object({
        title: z.string().max(200).optional(),
        wizardId: z.string().nullish(),
        parentId: z.string().nullish(),
        markdown: z.string().optional(),
        review: z.null().optional(),
      })
      .parse(await c.req.json());
    await updatePage(c.get("user").id, c.req.param("id"), body);
    return c.json({ ok: true });
  })
  .put("/pages/:id/order", async (c) => {
    const { ids } = z.object({ ids: z.array(z.string()).max(5000) }).parse(await c.req.json());
    await orderSubPages(c.get("user").id, c.req.param("id"), ids);
    return c.json({ ok: true });
  })
  .delete("/pages/:id", async (c) => {
    await deletePage(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })

  // --- wizards ---------------------------------------------------------------
  .get("/projects/:id/wizards", async (c) => {
    const user = c.get("user");
    await ownedProject(user.id, c.req.param("id"));
    const wizards = await listWizards(user.id, c.req.param("id"));
    // A local install with an account: where each wizard stands in its cloud, for the cards.
    const linked = await cloudLinked();
    return c.json(
      await Promise.all(
        wizards.map(async (w) => ({ ...w, cloud: linked ? await cloudState(w.id) : null })),
      ),
    );
  })
  .post("/wizards", async (c) => {
    const body = z
      .object({
        projectId: z.string(),
        starterId: z.string().optional(),
        lang: z.string().optional(),
      })
      .parse(await c.req.json());
    const { id } = await createWizard(c.get("user").id, body);
    return c.json({ id });
  })
  // A wizard as a file, and a new wizard made of such a file.
  .post("/projects/:id/wizards/import", async (c) => {
    const file = (await c.req.formData()).get("file");
    if (!(file instanceof File) || !file.size || file.size > PACKAGE_MAX_BYTES) {
      throw new ServiceError("invalid", note("chooseWizardFileMb", { PACKAGE_EXTENSION }));
    }
    return c.json(
      await importWizard(
        c.get("user").id,
        c.req.param("id"),
        new Uint8Array(await file.arrayBuffer()),
        file.name,
        requestLang(c),
      ),
    );
  })
  .get("/wizards/:id/export", async (c) => {
    const found = await exportWizard(c.get("user").id, c.req.param("id"), {
      published: c.req.query("published") === "1",
      knowledge: c.req.query("knowledge") === "1",
    });
    if (!found) {
      return c.json(
        {
          error: say(c, "wizardNotPublishedYet"),
        },
        404,
      );
    }
    const { name, zip } = found;
    return c.body(new Uint8Array(zip), 200, {
      "content-type": PACKAGE_MIME,
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "private, no-store",
    });
  })
  .get("/wizards/:id", async (c) => {
    const user = c.get("user");
    const w = await ownedWizard(user.id, c.req.param("id"));
    const messages = await wizardMessages(w.id);
    const project = await ownedProject(user.id, w.projectId);
    return c.json({
      ...(await wizardState(w)),
      /** Shown and run here, changed elsewhere: a local install's wizard, or nothing is built here. */
      readOnly: !(await projectWritable(project)),
      blank: messages.length === 0 && !w.starter,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        changed: m.changed,
        source: m.source,
        client: m.client,
      })),
      mcpServers: project.mcpServers.map((s) => ({ id: s.id, name: s.name })),
    });
  })
  .put("/wizards/:id/draft", async (c) => {
    const body = z
      .object({ definition: z.unknown(), baseRevision: z.number().int().min(0) })
      .parse(await c.req.json());
    const { revision, issues } = await writeDraft(c.get("user").id, c.req.param("id"), body);
    return c.json({ ok: true, revision, issues });
  })
  .patch("/wizards/:id", async (c) => {
    const patch = z
      .object({
        shareEnabled: z.boolean().optional(),
        dailyRunLimit: z.number().int().min(1).max(10_000).optional(),
        projectId: z.string().optional(),
        runners: z.object({ default: z.string(), enabled: z.array(z.string()).max(20) }).optional(),
        translate: z.boolean().optional(),
      })
      .parse(await c.req.json());
    await updateWizardSettings(c.get("user").id, c.req.param("id"), patch);
    // The copy in the cloud of a linked account is shared the same way.
    if (
      patch.shareEnabled !== undefined ||
      patch.dailyRunLimit !== undefined ||
      patch.runners !== undefined ||
      patch.translate !== undefined
    ) {
      await pushSharing(c.get("user").id, c.req.param("id"));
    }
    return c.json({ ok: true });
  })
  // The languages the published wizard is kept in, each original text with its translation.
  .get("/wizards/:id/translations", async (c) => {
    const w = await ownedWizard(c.get("user").id, c.req.param("id"));
    const def = await publishedDefinition(w);
    const kept = await translationsOf(w.id);
    return c.json({
      lang: def ? wizardLang(def) : wizardLang(w.draft),
      texts: def ? wizardTexts(def) : [],
      translations: kept.map((t) => ({
        lang: t.lang,
        texts: t.texts,
        updatedAt: t.updatedAt.toISOString(),
      })),
    });
  })
  // The author's own lines for a language: they replace what a model wrote.
  .put("/wizards/:id/translations/:lang", async (c) => {
    const w = await writableWizard(c.get("user").id, c.req.param("id"));
    const def = await publishedDefinition(w);
    const lang = c.req.param("lang");
    if (!(def && isLangCode(lang))) {
      return c.json(notFoundAnswer(c), 404);
    }
    const { lines } = z
      .object({ lines: z.record(z.string(), z.string().max(4000)) })
      .parse(await c.req.json());
    await editTranslation(w.id, def, lang, lines);
    return c.json({ ok: true });
  })
  .delete("/wizards/:id/translations/:lang", async (c) => {
    const w = await writableWizard(c.get("user").id, c.req.param("id"));
    await deleteTranslation(w.id, c.req.param("lang"));
    return c.json({ ok: true });
  })
  // The wizard's ID for the mobile app, beside its link.
  .get("/wizards/:id/code", async (c) => {
    const w = await ownedWizard(c.get("user").id, c.req.param("id"));
    return c.json({ code: await codeOf(w.shareToken) });
  })
  // A new link here, and for the copy in the cloud of a linked account: the old ones stop.
  .post("/wizards/:id/rotate-link", async (c) => {
    const rotated = await rotateShareLink(c.get("user").id, c.req.param("id"));
    const cloud = managed ? null : await rotateInCloud(c.get("user").id, c.req.param("id"));
    return c.json({ ...rotated, cloud });
  })
  .post("/wizards/:id/duplicate", async (c) =>
    c.json(await duplicateWizard(c.get("user").id, c.req.param("id"))),
  )
  .delete("/wizards/:id", async (c) => {
    if (!managed) {
      await removeFromCloud(c.get("user").id, c.req.param("id"));
    }
    await deleteWizard(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  // With an account linked the published version also goes to its cloud: `cloud` says how that went.
  .post("/wizards/:id/publish", async (c) =>
    c.json(await publishAndSync(c.get("user").id, c.req.param("id"))),
  )
  // What publishing the draft would change: the steps and files, its last test, the cost of a run before and after.
  .get("/wizards/:id/changes", async (c) => {
    const w = await ownedWizard(c.get("user").id, c.req.param("id"));
    const { published, ...found } = await draftChanges(w);
    const cost = async (def: WizardDefinition) =>
      estimateRun(w.id, null, def, await stepsWithoutModel(def));
    const [before, after] = published ? await Promise.all([cost(published), cost(w.draft)]) : [];
    return c.json({
      ...found,
      cost:
        before?.available && after?.available
          ? { before: before.credits, after: after.credits }
          : null,
    });
  })
  // What a run of the draft is expected to cost, per step and in total.
  .get("/wizards/:id/estimate", async (c) => {
    const w = await ownedWizard(c.get("user").id, c.req.param("id"));
    return c.json(await estimateRun(w.id, null, w.draft, await stepsWithoutModel(w.draft)));
  })
  // The runners this tenant has: the home's channel filter and the icons on its cards.
  .get("/runners", async (c) => c.json(await runnersOf()))
  // The runners this tenant has, how each fits the draft, and how the wizard is offered.
  .get("/wizards/:id/runners", async (c) => {
    const w = await ownedWizard(c.get("user").id, c.req.param("id"));
    return c.json(await wizardRunners(w));
  })
  // The models the draft needs that this runtime cannot serve, by class, with the steps that call them.
  .get("/wizards/:id/models", async (c) => {
    const w = await ownedWizard(c.get("user").id, c.req.param("id"));
    return c.json({ missing: await missingModels(w.draft, requestLang(c)) });
  })
  // A runtime that runs alone: the wizard's copy in the cloud of the linked account.
  .get("/wizards/:id/cloud", async (c) => {
    const w = await ownedWizard(c.get("user").id, c.req.param("id"));
    const linked = await cloudLinked();
    return c.json({ linked, ...(linked ? await cloudState(w.id) : { copy: null, error: null }) });
  })
  // Sends the published version again: after a try that failed, or a change of the project.
  .post("/wizards/:id/cloud", async (c) => {
    if (!(await cloudLinked())) {
      return c.notFound();
    }
    return c.json({
      linked: true,
      ...(await syncToCloud(c.get("user").id, c.req.param("id"))),
    });
  })
  // What the cloud would lack for the draft, before it is published.
  .get("/wizards/:id/cloud/check", async (c) => {
    if (!(await cloudLinked())) {
      return c.notFound();
    }
    return c.json(await checkForCloud(c.get("user").id, c.req.param("id")));
  })
  // The projects of local installs the account's cloud holds.
  .get("/cloud/spaces", async (c) => {
    if (!(await cloudLinked())) {
      return c.notFound();
    }
    return c.json({ spaces: await cloudSpaces() });
  })
  // Another install's project is in the way: it goes, and what is published here is sent.
  .post("/cloud/replace", async (c) => {
    if (!(await cloudLinked())) {
      return c.notFound();
    }
    return c.json(await replaceCloudSpaces(c.get("user").id));
  })
  .post("/wizards/:id/chat", async (c) => {
    const user = c.get("user");
    const wizardId = c.req.param("id");
    const { message } = z
      .object({ message: z.string().min(1).max(8000) })
      .parse(await c.req.json());
    await writableWizard(user.id, wizardId);
    if (!(await canSpend())) {
      throw new ServiceError("no_credits", note("creditsUsedUp"));
    }
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      try {
        const result = await architectTurn(user.id, wizardId, message, requestLang(c), {
          signal: abort.signal,
          onText: (delta) => {
            void stream.writeSSE({ event: "text", data: JSON.stringify(delta) });
          },
          onActivity: (label) => {
            void stream.writeSSE({ event: "activity", data: JSON.stringify(label) });
          },
          onThought: (line) => {
            void stream.writeSSE({ event: "thought", data: JSON.stringify(line) });
          },
          onBuilding: () => {
            void stream.writeSSE({ event: "building", data: "1" });
          },
        });
        await stream.writeSSE({ event: "done", data: JSON.stringify(result) });
      } catch (err) {
        console.error("[architect]", err);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            message:
              err instanceof ServiceError
                ? errorText(err, requestLang(c))
                : say(c, "somethingWentWrongTry"),
          }),
        });
      }
    });
  })
  // What the admin says into the composer, written down — where the browser cannot do it itself.
  .post("/transcribe", async (c) => {
    const file = (await c.req.formData()).get("file");
    if (!(file instanceof File) || !file.size || file.size > 10_000_000) {
      throw new ServiceError("invalid", note("recordingMbMost"));
    }
    if (!(await canSpend())) {
      throw new ServiceError("no_credits", note("creditsUsedUp"));
    }
    try {
      const { text } = await transcribeAudio({
        bytes: new Uint8Array(await file.arrayBuffer()),
        mediaType: file.type || "audio/webm",
      });
      return c.json({ text });
    } catch (err) {
      if (err instanceof ModelUnavailableError) {
        throw new ServiceError("refused", saidOf(err));
      }
      throw err;
    }
  })
  .post("/wizards/:id/test-runs", async (c) =>
    c.json(await startTestRun(c.get("user").id, c.req.param("id"))),
  )
  .get("/wizards/:id/runs", async (c) =>
    c.json(await listRuns(c.get("user").id, c.req.param("id"))),
  )

  // --- workspace -------------------------------------------------------------
  .get("/wizards/:id/files", async (c) =>
    c.json(await listFiles(c.get("user").id, c.req.param("id"))),
  )
  .get("/wizards/:id/files/:path{.+}", async (c) => {
    const { file, data } = await readFile(c.get("user").id, c.req.param("id"), c.req.param("path"));
    return c.body(new Uint8Array(data), 200, {
      "content-type": file.mime,
      "content-disposition": `attachment; filename="${file.path.split("/").pop()}"`,
      "cache-control": "private, no-cache",
    });
  })
  .put("/wizards/:id/files/:path{.+}", async (c) => {
    const data = new Uint8Array(await c.req.arrayBuffer());
    const file = await writeFile(
      c.get("user").id,
      c.req.param("id"),
      c.req.param("path"),
      data,
      c.req.header("content-type")?.split(";")[0],
    );
    return c.json(file);
  })
  .delete("/wizards/:id/files/:path{.+}", async (c) => {
    await deleteFile(c.get("user").id, c.req.param("id"), c.req.param("path"));
    return c.json({ ok: true });
  })
  .get("/wizards/:id/widgets/:stepId/preview", async (c) => {
    const html = await draftWidgetPreview(
      c.get("user").id,
      c.req.param("id"),
      c.req.param("stepId"),
    );
    return c.body(new TextEncoder().encode(html), 200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": HTML_RESPONSE_CSP,
      "cache-control": "no-store",
    });
  })

  // --- a runtime that runs alone: its keys, models and linked account -----------
  .get("/api-keys", async (c) => (managed ? c.notFound() : c.json(await listLocalKeys())))
  .post("/api-keys", async (c) => {
    if (managed) {
      return c.notFound();
    }
    const { name } = z.object({ name: z.string().min(1).max(32) }).parse(await c.req.json());
    return c.json(await createLocalKey(name));
  })
  .delete("/api-keys/:id", async (c) => {
    if (managed) {
      return c.notFound();
    }
    await deleteLocalKey(c.req.param("id"));
    return c.json({ ok: true });
  })
  // The person's AI apps on this machine (Claude Desktop, Cursor, Codex …) and whether they
  // have this install's MCP server: the same as `wizards connect`.
  .get("/local/apps", async (c) => (managed ? c.notFound() : c.json(await appStates(layout()))))
  .post("/local/apps/:id", async (c) => {
    if (managed) {
      return c.notFound();
    }
    const { connect } = z.object({ connect: z.boolean() }).parse(await c.req.json());
    const [done] = await connectApps(layout(), [c.req.param("id")], !connect);
    if (!done) {
      return c.json({ error: say(c, "unknownApp"), code: "not_found" }, 404);
    }
    // Not done is an answer too: the app's file is no plain JSON, here is what to paste.
    return c.json(done.outcome);
  })
  // What each AI client did with the MCP server since the start: the test on "Integrate".
  .get("/integrations/seen", (c) => c.json(seenApps(c.get("user").tenantId)))
  .get("/local/models", (c) => (managed ? c.notFound() : c.json(localModelSettings())))
  .put("/local/models", async (c) => {
    if (managed) {
      return c.notFound();
    }
    await saveLocalModels(modelsInput.parse(await c.req.json()));
    return c.json(localModelSettings());
  })
  // --- models: where each class runs, own API keys, the credits behind them -----------------
  // Alone for this machine; on a Manage-App's runtime for the team, whose admins change it.
  .get("/models", async (c) => c.json(await modelSettings(requestLang(c))))
  .put("/models", async (c) => {
    if (!mayChangeModels(c.get("user"))) {
      return c.json(
        {
          error: say(c, "onlyTeamAdminsChange"),
          code: "forbidden",
        },
        403,
      );
    }
    const input = modelsInput.parse(await c.req.json());
    // In the cloud nothing runs on a machine's client or local model.
    if (
      managed &&
      (input.source ||
        input.ollamaUrl ||
        Object.values(input.bindings ?? {}).some((ref) => ref && !cloudBinding(ref)))
    ) {
      return c.json(
        {
          error: say(c, "notAvailableCloud"),
          code: "not_local",
        },
        400,
      );
    }
    // Own keys and bindings to a provider's model are a feature of the team's plan.
    // When the Manage-App can't say what the plan holds, own keys wait: nothing is taken unchecked.
    const own =
      Object.values(input.keys ?? {}).some((key) => key?.trim()) ||
      Object.values(input.bindings ?? {}).some((ref) => ref && !isCreditsRef(ref));
    if (managed && own) {
      const info = await tenantInfo(c.get("user").tenantId).catch((err) => {
        console.error("[models] plan of the tenant:", err);
        return null;
      });
      if (!info) {
        return c.json(
          {
            error: say(c, "planUnavailable"),
            code: "manage_unavailable",
          },
          503,
        );
      }
      if (!feature("ownKeys", info.features)) {
        return c.json(
          {
            error: info.plan?.name
              ? say(c, "ownKeysNotInPlan", { plan: info.plan.name })
              : say(c, "ownKeysNotInTeamPlan"),
            code: "plan",
          },
          403,
        );
      }
    }
    await saveModels(input);
    return c.json(await modelSettings(requestLang(c)));
  })
  // Whether a provider takes a key — the one typed, or the one stored. Nothing is generated.
  .post("/models/keys/:provider/check", async (c) => {
    const provider = z.enum(LOCAL_KEYS).parse(c.req.param("provider"));
    const { key } = z
      .object({ key: z.string().max(400).optional() })
      .parse(await c.req.json().catch(() => ({})));
    const value = key?.trim() || (await storedKey(provider));
    if (!value) {
      return c.json({
        ok: false,
        message: say(c, "noApiKeySet"),
      });
    }
    return c.json(await checkKey(provider, value, requestLang(c)));
  })
  // One call on a class, as a run makes it: text answers a word, an image, a voice or a short
  // clip comes back to look at, a voice note comes back as text. Paid like any call.
  .post("/models/test", async (c) => {
    if (!mayChangeModels(c.get("user"))) {
      return c.json(
        {
          error: say(c, "onlyTeamAdminsTest"),
          code: "forbidden",
        },
        403,
      );
    }
    const { cls, lang } = z
      .object({ cls: z.enum(MODEL_CLASSES), lang: z.enum(LANGS).default("en") })
      .parse(await c.req.json());
    return c.json(await testClass(cls, lang));
  })
  // The setup's test of one key, or of Ollama: a working one is put to use and ends the setup.
  .post("/local/keys/:provider", async (c) => {
    if (managed) {
      return c.notFound();
    }
    const provider = z.enum(LOCAL_KEYS).parse(c.req.param("provider"));
    const { key } = z
      .object({ key: z.string().max(400).optional() })
      .parse(await c.req.json().catch(() => ({})));
    const result = await setUpKey(provider, key, requestLang(c));
    if (result.ok && result.text) {
      await markTested("own");
    }
    return c.json(result);
  })
  .post("/local/ollama", async (c) => {
    if (managed) {
      return c.notFound();
    }
    const { url } = z.object({ url: z.string().url().max(200) }).parse(await c.req.json());
    const result = await setUpOllama(url, requestLang(c));
    if (result.ok) {
      await markTested("own");
    }
    return c.json(result);
  })
  // One short call on a class, as a run would make it: shows that the way to the model is open.
  .post("/local/models/test", async (c) => {
    if (managed) {
      return c.notFound();
    }
    const { cls } = z
      .object({ cls: z.enum(TEXT_CLASSES).default("classifier") })
      .parse(await c.req.json().catch(() => ({})));
    const started = Date.now();
    // The source this call runs on: the person may pick another one while it is under way.
    const source = localModelSettings().source;
    try {
      const resolved = await textModel(cls);
      const result = await generateText({
        model: resolved.model,
        prompt: "Reply with the single word: OK",
        maxOutputTokens: 20,
        abortSignal: AbortSignal.timeout(120_000),
      });
      // A working call is what ends the setup — for the source it ran on.
      await markTested(source);
      return c.json({
        ok: true,
        ref: resolved.ref,
        reply: result.text.trim().slice(0, 200),
        ms: Date.now() - started,
      });
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      return c.json({ ok: false, error: message.slice(0, 500), ms: Date.now() - started });
    }
  })
  // --- the AI clients on this machine: looked at afresh, signed in through the inline terminal ----
  .post("/local/harness/:id/detect", async (c) => {
    const id = c.req.param("id") as HarnessId;
    if (managed || !harness(id)) {
      return c.notFound();
    }
    return c.json({ harness: await detectHarness(id, true) });
  })
  .post("/local/harness/:id/install", async (c) => {
    const spec = managed ? null : await installSpec(c.req.param("id"));
    if (!spec) {
      return c.notFound();
    }
    const { cols, rows } = terminalSize.parse(await c.req.json().catch(() => ({})));
    const cwd = join(env.dataDir, "harness");
    mkdirSync(cwd, { recursive: true });
    // The page asks again once the command is over: then the client is there, or its output says why not.
    const terminal = await openTerminal({ ...spec, cwd, cols, rows });
    return c.json({ terminal });
  })
  .post("/local/harness/:id/login", async (c) => {
    const id = c.req.param("id") as HarnessId;
    const client = harness(id);
    if (managed || !client) {
      return c.notFound();
    }
    const { cols, rows } = terminalSize.parse(await c.req.json().catch(() => ({})));
    const cwd = join(env.dataDir, "harness");
    mkdirSync(cwd, { recursive: true });
    const terminal = await openTerminal({
      bin: client.bin,
      args: client.login.args,
      cwd,
      env: { ...(await loginEnv(client)), ...client.login.env },
      cols,
      rows,
      // Signed in: the client says so on its own, and the settings learn it right away.
      until: async () => (await freshAuth(client)) !== "none",
      onDone: () => void detectHarness(id, true),
    });
    return c.json({ terminal });
  })
  .get("/local/terminal/:id/stream", (c) => {
    if (managed) {
      return c.notFound();
    }
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      let ended = false;
      // One write after the other, and all of them out before the stream ends: the last one is
      // the exit, and a page that comes after the end gets everything at once.
      let written = Promise.resolve();
      const done = new Promise<void>((resolve) => {
        const unsubscribe = subscribeTerminal(id, (event) => {
          written = written.then(() =>
            stream.writeSSE({ event: event.type, data: JSON.stringify(event) }),
          );
          if (event.type === "exit") {
            ended = true;
            resolve();
          }
        });
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
      // The page keeps the stream open while the terminal lives; a heartbeat keeps proxies from closing it.
      const beat = setInterval(() => {
        if (!ended) {
          void stream.writeSSE({ event: "ping", data: "" });
        }
      }, 15_000);
      await done;
      clearInterval(beat);
      await written;
    });
  })
  .post("/local/terminal/:id/input", async (c) => {
    if (managed) {
      return c.notFound();
    }
    const { data } = z.object({ data: z.string().max(10_000) }).parse(await c.req.json());
    writeTerminal(c.req.param("id"), data);
    return c.json({ ok: true });
  })
  .post("/local/terminal/:id/resize", async (c) => {
    if (managed) {
      return c.notFound();
    }
    const { cols, rows } = z
      .object({ cols: z.number().int().min(10).max(500), rows: z.number().int().min(4).max(200) })
      .parse(await c.req.json());
    resizeTerminal(c.req.param("id"), cols, rows);
    return c.json({ ok: true });
  })
  .delete("/local/terminal/:id", (c) => {
    if (managed) {
      return c.notFound();
    }
    closeTerminal(c.req.param("id"));
    return c.json({ ok: true });
  })
  .put("/local/chat", async (c) => {
    if (managed) {
      return c.notFound();
    }
    const { engine } = z.object({ engine: z.enum(["models", "claude"]) }).parse(await c.req.json());
    await setChatEngine(engine);
    return c.json({ ok: true });
  })
  // The address the system browser opens: the account's sign-in, or — for someone without an
  // account — its sign-up page with the invitation code, which then goes on to the sign-in.
  // --- the first visit of a cloud studio: who the team is, its website, first documents -----
  .put("/team", async (c) => {
    if (!managed) {
      return c.json(
        {
          error: say(c, "onlyAvailableCloud"),
          code: "not_managed",
        },
        404,
      );
    }
    await requireAdmin();
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await c.req.json());
    const info = await renameTenant(c.get("user").tenantId, name);
    return c.json({ name: info.name });
  })
  // What the team uses engenty for, and the questions that fit: kept at the Manage-App.
  .put("/team/profile", async (c) => {
    if (!managed) {
      return c.json(
        {
          error: say(c, "onlyAvailableCloud"),
          code: "not_managed",
        },
        404,
      );
    }
    await requireAdmin();
    const field = (max: number) => z.string().trim().max(max).nullable().optional();
    const profile = z
      .object({
        kind: z.enum(["personal", "club", "small", "corp"]),
        size: field(40),
        sector: field(120),
        role: field(120),
        need: field(2000),
        legalName: field(200),
        phone: field(40),
        website: field(400),
      })
      .parse(await c.req.json());
    const user = c.get("user");
    await saveTeamProfile(user.tenantId, user.id, requestLang(c) === "de" ? "de" : "en", profile);
    return c.json({ ok: true });
  })
  .post("/onboarding/done", async (c) => {
    if (!managed) {
      return c.json(
        {
          error: say(c, "onlyAvailableCloud"),
          code: "not_managed",
        },
        404,
      );
    }
    await finishOnboarding(c.get("user").tenantId);
    return c.json({ ok: true });
  })
  .post("/projects/:id/website", async (c) => {
    const user = c.get("user");
    const project = await ownedProject(user.id, c.req.param("id"));
    const { url } = z.object({ url: z.string().trim().min(3).max(400) }).parse(await c.req.json());
    return c.json(await applyWebsite(user.id, project.id, url));
  })
  // The install command and the first steps, mailed to the signed-in person by the Manage-App.
  .post("/install-mail", async (c) => {
    if (!managed) {
      return c.json(
        {
          error: say(c, "onlyAvailableCloud"),
          code: "not_managed",
        },
        404,
      );
    }
    const { lang } = z
      .object({ lang: z.enum(LANGS).default("en") })
      .parse(await c.req.json().catch(() => ({})));
    await installMail(c.get("user").email, lang);
    return c.json({ ok: true });
  })

  .post("/account/link", async (c) => {
    if (managed) {
      return c.notFound();
    }
    const input = z
      .object({ signup: z.boolean().optional(), code: z.string().max(64).optional() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json({ url: await startLink(input) });
  })
  .delete("/account", async (c) => {
    if (managed) {
      return c.notFound();
    }
    await unlink();
    await forgetCloud();
    // Pro modules went with the account's plan; installed ones stay on disk.
    await refreshPro();
    // Models that ran on the account's credits have nothing to run on now; another source stays.
    if (localModelSettings().source === "account") {
      await saveLocalModels({ source: "own" });
    }
    return c.json({ ok: true });
  });

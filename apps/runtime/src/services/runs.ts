import {
  dataRef,
  FIELD_WAYS,
  type Field,
  formatsFor,
  isDecidedField,
  type Step,
  shownFields,
  slotText,
  waitDurationMs,
  wizardLang,
} from "@engenty/wizards-shared/definition";
import { note, type RunState, type RunTimeline, type RunView } from "@engenty/wizards-shared/run";
import { and, count, desc, eq, gte, inArray, isNull, max, or, sql } from "drizzle-orm";
import { canSpend, MICROS_PER_CREDIT } from "../credits/credits.js";
import { db, schema } from "../db/client.js";
import {
  answerersOf,
  answeringNarrowed,
  type Caller,
  doorCaller,
  hiddenWhileAsked,
  mayAct,
  mayGoBackFrom,
  whoOf,
} from "../engine/answerers.js";
import { answerAsk } from "../engine/asks.js";
import { emitEvent, recentEvents, watchRun } from "../engine/events.js";
import { fieldErrorsIn } from "../engine/input.js";
import {
  answerTurn,
  cancel,
  createRun,
  formContext,
  goBack,
  NoCreditsError,
  type ReviewAction,
  RunConflict,
  RunInputError,
  retry,
  reviewStep,
  runView,
  submitPage,
} from "../engine/runner.js";
import { managed } from "../manage.js";
import { ModelUnavailableError, saidOf } from "../model-errors.js";
import { prompt } from "../prompts.js";
import { signedUrl } from "../secrets/signing.js";
import { currentTenant } from "../tenants/tenant.js";
import { roleOf } from "./access.js";
import { brandView } from "./brand.js";
import { notFound, ServiceError } from "./errors.js";
import { readsOf } from "./space-parent.js";
import { storedTranslation } from "./translations.js";
import { ownedWizard, requireClean, shareUrl, studioUrl } from "./wizards.js";

type RunRow = typeof schema.run.$inferSelect;

/** Test runs an MCP client started with answers: pages are filled and reviews accepted for it. */
const autopilots = new Set<string>();

export async function startTestRun(
  userId: string,
  wizardId: string,
  autopilot?: { answers: Record<string, unknown>; acceptReviews: boolean },
) {
  const w = await ownedWizard(userId, wizardId);
  const { definition, files } = await requireClean(w);
  if (!(await canSpend())) {
    throw new ServiceError("no_credits", note("creditsUsedUp"));
  }
  const runId = await createRun({
    wizardId: w.id,
    definition,
    files,
    version: null,
    mode: "test",
    userId,
    unattended: Boolean(autopilot),
  }).catch((err) => {
    throw err instanceof ModelUnavailableError ? new ServiceError("refused", saidOf(err)) : err;
  });
  if (autopilot) {
    fly(runId, autopilot.answers, autopilot.acceptReviews);
  }
  return { runId };
}

function fly(runId: string, answers: Record<string, unknown>, acceptReviews: boolean) {
  autopilots.add(runId);
  let busy = false;
  let again = false;
  const land = () => {
    autopilots.delete(runId);
    unsubscribe();
    clearTimeout(timeout);
  };
  const step = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        const run = await db.query.run.findFirst({ where: eq(schema.run.id, runId) });
        if (
          !run ||
          run.status === "done" ||
          run.status === "failed" ||
          run.status === "cancelled"
        ) {
          land();
          return;
        }
        if (run.status !== "waiting_input") {
          continue;
        }
        const current = run.definition.steps.find((s) => s.id === run.cursor);
        if (current?.type === "form") {
          const values = Object.fromEntries(
            current.fields.filter((f) => f.id in answers).map((f) => [f.id, answers[f.id]]),
          );
          await submitPage(runId, current.id, values);
        } else if (current?.type === "review" && acceptReviews) {
          await reviewStep(runId, current.id, { type: "accept" });
        } else {
          land();
          return;
        }
      } while (again);
    } catch (err) {
      const message =
        err instanceof RunInputError
          ? note("answersMissing", {
              answers: err.errors.map((e) =>
                note("fieldError", { field: e.field, message: e.message }),
              ),
            })
          : saidOf(err);
      await emitEvent(runId, null, "error", message).catch(() => undefined);
      land();
    } finally {
      busy = false;
    }
  };
  const unsubscribe = watchRun(runId, () => {
    void step();
  });
  const timeout = setTimeout(land, 30 * 60_000);
  void step();
}

/**
 * A run the caller may see: any test run of their tenant, or a run they started themselves
 * from an MCP client (run_wizard). `test` narrows it to test runs; `live` takes every live run of
 * the tenant, what visitors started (the results `/api/v1/runs` lists with `runs:read`).
 */
/** A person at an MCP or API door, as the role the Manage-App gives them. */
async function callerOfUser(userId: string): Promise<Caller> {
  return { userId, role: await roleOf(userId), local: !managed };
}

/** A run the caller may answer as it stands: `ownedRun` says they see it, this that it is theirs. */
async function answerableRun(userId: string, runId: string): Promise<RunRow> {
  const run = await ownedRun(userId, runId);
  if (!(await mayAct(run, await callerOfUser(userId)))) {
    throw new ServiceError("forbidden", { code: "notYourStep" });
  }
  return run;
}

async function ownedRun(userId: string, runId: string, only?: "test" | "live"): Promise<RunRow> {
  const run = await db.query.run.findFirst({
    where: and(
      eq(schema.run.id, runId),
      eq(schema.run.tenantId, currentTenant()),
      only
        ? eq(schema.run.mode, only)
        : or(eq(schema.run.mode, "test"), eq(schema.run.userId, userId)),
    ),
  });
  if (!run) {
    throw notFound();
  }
  return run;
}

/** Still moving: running, or waiting on a page the autopilot is about to fill. */
function moving(run: RunRow) {
  return run.status === "running" || (run.status === "waiting_input" && autopilots.has(run.id));
}

/** A run a plugin's door may read: any run of the current tenant, by id. */
export async function pluginRun(runId: string): Promise<RunRow> {
  const run = await db.query.run.findFirst({
    where: and(eq(schema.run.id, runId), eq(schema.run.tenantId, currentTenant())),
  });
  if (!run) {
    throw notFound();
  }
  return run;
}

/**
 * A run a plugin's door may answer: the door speaks for the run's visitor (`plugins/runs.ts`), so
 * it answers what asks them, and nothing asked of the organization.
 */
export async function pluginAnswerableRun(runId: string): Promise<RunRow> {
  const run = await pluginRun(runId);
  if (!(await mayAct(run, doorCaller(run)))) {
    throw new ServiceError("forbidden", { code: "notYourStep" });
  }
  return run;
}

/** Loads the run again while it works, up to `seconds` (at most 45), and gives it as it stands. */
export async function waitRun(load: () => Promise<RunRow>, seconds: number): Promise<RunRow> {
  const deadline = Date.now() + Math.min(45, Math.max(0, seconds)) * 1000;
  let run = await load();
  while (moving(run) && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const unsubscribe = watchRun(run.id, () => {
        unsubscribe();
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        unsubscribe();
        resolve();
      }, deadline - Date.now());
    });
    run = await load();
  }
  return run;
}

async function waitWhileMoving(
  userId: string,
  runId: string,
  seconds: number,
  only?: "test" | "live",
): Promise<RunRow> {
  const deadline = Date.now() + seconds * 1000;
  let run = await ownedRun(userId, runId, only);
  while (moving(run) && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const unsubscribe = watchRun(runId, () => {
        unsubscribe();
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        unsubscribe();
        resolve();
      }, deadline - Date.now());
    });
    run = await ownedRun(userId, runId, only);
  }
  return run;
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)} … [${text.length - max} more characters]`
    : text;
}

function deliverableFormats(run: RunRow, step: Step) {
  const possible = formatsFor(step);
  const listed = run.definition.steps
    .flatMap((s) => (s.type === "result" ? s.deliverables : []))
    .find((d) => d.from === step.id);
  return listed ? listed.formats.filter((f) => possible.includes(f)) : [];
}

/**
 * What a client needs besides the plain field: a slot's times as the person reads them, and the
 * one value of them to send back.
 */
function slotHints(run: RunRow, field: Field, options: string[] | undefined) {
  if (field.kind !== "slot") {
    return {};
  }
  const lang = wizardLang(run.definition);
  const value = run.state.values[field.id];
  return {
    times: (options ?? []).map((o) => ({ value: o, label: slotText(o, lang) })),
    ...(typeof value === "string" ? { valueText: slotText(value, lang) } : {}),
    hint: options?.length ? prompt("mcp", "hint.slot") : prompt("mcp", "hint.slot_none"),
  };
}

/** Where the person can go on in a browser: the run page of a live run, the studio for a test. */
/** The live run's page — the wizard itself, never the studio. A test run has none. */
async function browserUrl(run: RunRow): Promise<string | null> {
  if (run.mode === "test") {
    return null;
  }
  const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, run.wizardId) });
  return w ? `${shareUrl(w.shareToken)}/${run.id}` : null;
}

/**
 * What a run waits for. `draft`: what a door that asks one field at a time has so far, so a
 * field's `shown` follows those answers as it follows the form on the screen.
 */
async function waitingFor(
  run: RunRow,
  current: Step | null,
  draft?: Record<string, unknown>,
  viewer?: Caller,
) {
  // What someone else is asked is theirs: the door hears that, and nothing of what it asks.
  if (viewer && !(await mayAct(run, viewer))) {
    return run.status === "waiting_input" && current
      ? {
          answeredBy: whoOf(current),
          title: current.title,
          hint: prompt("mcp", "hint.answered_by"),
        }
      : undefined;
  }
  if (run.status === "running" && run.ask) {
    const ask = run.ask;
    return ask.kind === "confirm"
      ? {
          ask: ask.id,
          kind: ask.kind,
          reason: ask.again
            ? prompt("mcp", "reason.confirm_again", { service: ask.service })
            : ask.reason,
          service: ask.service,
          action: ask.action.summary,
          input: clip(ask.input, 1500),
          hint: ask.again ? prompt("mcp", "hint.confirm_again") : prompt("mcp", "hint.confirm"),
        }
      : {
          ask: ask.id,
          kind: ask.kind,
          reason: ask.reason,
          site: ask.site.host,
          hint: prompt("mcp", "hint.sign_in"),
        };
  }
  if (run.status === "sleeping" && current) {
    const pause = run.state.pause;
    // Waiting for a person has no time: the next look says nothing about when they act.
    return {
      wait: current.id,
      title: current.title,
      until: pause && pause.kind !== "retry" ? null : (run.wakeAt?.toISOString() ?? null),
      ...(pause ? { pause } : {}),
      hint:
        pause?.kind === "retry"
          ? prompt("mcp", "hint.pause_retry")
          : pause?.kind === "credits"
            ? prompt("mcp", "hint.pause_credits")
            : pause?.kind === "sign_in"
              ? prompt("mcp", "hint.pause_sign_in")
              : prompt("mcp", "hint.sleeping"),
    };
  }
  if (run.status === "waiting_signal" && current?.type === "wait") {
    return {
      wait: current.id,
      title: current.title,
      until: run.wakeAt?.toISOString() ?? null,
      signal: current.signal?.name ?? null,
      hint: prompt("mcp", "hint.waiting_signal"),
    };
  }
  if (run.status !== "waiting_input" || !current) {
    return undefined;
  }
  if (run.state.turn?.question && run.state.turn.stepId === current.id) {
    return {
      question: run.state.turn.question,
      title: current.title,
      hint: prompt("mcp", "hint.question"),
    };
  }
  if (current.type === "form") {
    // What the page knows from before it, the choices its fields take from data, the fields a
    // decision kept: a field left out here is not asked, as the run page leaves it out.
    const ctx = await formContext(run, current);
    const fields = current.fields
      .filter((f) => !isDecidedField(f) || ctx.decided.includes(f.id))
      .map((f) => (ctx.options[f.id]?.length ? { ...f, options: ctx.options[f.id] } : f));
    const page = {
      ...Object.fromEntries(
        fields.filter((f) => f.id in run.state.values).map((f) => [f.id, run.state.values[f.id]]),
      ),
      ...draft,
    };
    const shown = new Set(shownFields(fields, ctx.known, page).map((f) => f.id));
    return {
      form: current.id,
      title: current.title,
      ...(run.wakeAt ? { until: run.wakeAt.toISOString() } : {}),
      /** What the fields' conditions read from before the page, by reference. */
      known: ctx.known,
      fields: fields.map((f) => ({
        id: f.id,
        label: f.label,
        kind: f.kind,
        required: Boolean(f.required),
        options: f.options,
        placeholder: f.placeholder,
        help: f.help,
        default: f.default,
        value: run.state.values[f.id],
        columns: f.columns,
        ...slotHints(run, f, f.options),
        ...(f.multiple ? { multiple: true } : {}),
        // A file, a recording or a signature comes from the person's device: the run page.
        inChat: FIELD_WAYS[f.kind] !== "device",
        // A field with a condition is asked only while it holds; one on another field of this
        // page holds or not as the person answers. `shown` says so for what is known now.
        ...(f.when ? { when: f.when, shown: shown.has(f.id) } : {}),
      })),
      hint: prompt("mcp", "hint.page"),
    };
  }
  if (current.type === "review") {
    return {
      review: current.id,
      title: current.title,
      show: current.show,
      editable: Boolean(current.edit),
      ...(run.wakeAt ? { until: run.wakeAt.toISOString() } : {}),
      ...(current.approve ? { approve: true } : {}),
      hint: current.approve ? prompt("mcp", "hint.review_approve") : prompt("mcp", "hint.review"),
    };
  }
  return undefined;
}

/** What a run did so far, for a client without the run page: outputs, links, cost, errors. */
export async function runReport(
  userId: string,
  runId: string,
  waitSeconds = 0,
  only?: "test" | "live",
) {
  return runReportOf(
    await waitWhileMoving(userId, runId, waitSeconds, only),
    undefined,
    await callerOfUser(userId),
  );
}

/** The report of a run as it stands; `draft` as for `waitingFor`. */
export async function runReportOf(run: RunRow, draft?: Record<string, unknown>, viewer?: Caller) {
  const current = run.definition.steps.find((s) => s.id === run.cursor) ?? null;
  const base = `/api/runs/${run.id}`;
  const hidden = viewer ? await hiddenWhileAsked(run, viewer) : [];
  const outputs = run.definition.steps.flatMap((step) => {
    const output = run.state.outputs[step.id];
    if (!output || hidden.includes(step.id)) {
      return [];
    }
    // A document, a dashboard or a widget drawn as one picture: for a door that shows pictures
    // with a link. A generated image is a picture already.
    const picture =
      formatsFor(step).includes("png") && !(step.type === "generate" && step.asset === "image")
        ? signedUrl(`${base}/steps/${step.id}/download?format=png`)
        : null;
    return [
      {
        stepId: step.id,
        title: step.title,
        text: output.text ? clip(output.text, 1500) : undefined,
        json: output.json === undefined ? undefined : clip(JSON.stringify(output.json), 1500),
        assets: (output.assets ?? []).map((a) => ({
          name: a.name,
          mime: a.mime,
          url: signedUrl(`${base}/assets/${a.id}`),
        })),
        downloads: Object.fromEntries(
          deliverableFormats(run, step).map((f) => [
            f,
            signedUrl(`${base}/steps/${step.id}/download?format=${f}`),
          ]),
        ),
        picture,
      },
    ];
  });
  return {
    runId: run.id,
    wizardId: run.wizardId,
    mode: run.mode,
    lang: wizardLang(run.definition),
    status: moving(run) ? "running" : run.status,
    step: current ? { id: current.id, type: current.type, title: current.title } : null,
    /** Steps behind the run: answered pages and reviews, every step with a result, the end. */
    passed: run.definition.steps
      .filter(
        (s) =>
          run.state.history.includes(s.id) ||
          run.state.outputs[s.id] ||
          (run.status === "done" && s.id === run.cursor),
      )
      .map((s) => s.id),
    waitingFor: await waitingFor(run, current, draft, viewer),
    error: run.error,
    credits: Math.ceil(run.costMicros / MICROS_PER_CREDIT),
    events: (await recentEvents(run.id, 0, 15)).map((e) => ({
      step: e.stepId,
      type: e.type,
      message: e.message,
    })),
    outputs,
    /** What the result names as the run's data, once it is done; a step kept from the viewer stays out. */
    ...(run.status === "done" && run.state.data
      ? { data: shownData(run, run.state.data, hidden) }
      : {}),
    browserUrl: await browserUrl(run),
    ...(run.mode === "test" ? { studioUrl: studioUrl(run.wizardId) } : {}),
  };
}

export type RunReport = Awaited<ReturnType<typeof runReportOf>>;

/** The run's data without the keys that read a step kept from the viewer. */
function shownData(run: RunRow, data: Record<string, unknown>, hidden: string[]) {
  const result = run.definition.steps.find((s) => s.id === run.cursor);
  const refs = result?.type === "result" ? (result.data ?? {}) : {};
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => {
      const [head, id] = dataRef(refs[key] ?? "").split(".");
      return !(head === "steps" && hidden.includes(id));
    }),
  );
}

export const testRunReport = (userId: string, runId: string, waitSeconds = 0) =>
  runReport(userId, runId, waitSeconds, "test");

/** A command the run refused, as a tool error the client can act on. */
export function refusedInput(err: unknown): never {
  if (err instanceof RunInputError) {
    throw new ServiceError("invalid", saidOf(err), { fields: fieldErrorsIn(err.errors, "en") });
  }
  if (err instanceof RunConflict) {
    throw new ServiceError("refused", saidOf(err));
  }
  throw err;
}

/**
 * Runs the published version of a wizard for the admin, from their own AI client: a live run
 * that is theirs — no visitor, no share link needed. With answers the first page is filled. In a
 * client space the wizard is its parent's and the run belongs to the client space
 * (docs/plans/client-portal.md).
 */
export async function startRun(
  userId: string,
  wizardId: string,
  answers: Record<string, unknown> = {},
  {
    clientSpaceId = null,
    chatId = null,
  }: { clientSpaceId?: string | null; chatId?: string | null } = {},
) {
  const w = await ownedWizard(userId, wizardId);
  if (w.publishedVersion === null) {
    throw new ServiceError(
      "refused",
      "This wizard isn’t published yet. Publish it, or try the draft with start_test_run.",
    );
  }
  const version = await db.query.wizardVersion.findFirst({
    where: and(
      eq(schema.wizardVersion.wizardId, w.id),
      eq(schema.wizardVersion.version, w.publishedVersion),
    ),
  });
  if (!version) {
    throw notFound();
  }
  if (!(await canSpend())) {
    throw new ServiceError("no_credits", note("creditsUsedUp"));
  }
  const runId = await createRun({
    wizardId: w.id,
    definition: version.definition,
    files: version.files,
    version: w.publishedVersion,
    mode: "live",
    userId,
    clientSpaceId,
    chatId,
  }).catch((err) => {
    if (err instanceof ModelUnavailableError) {
      throw new ServiceError("refused", saidOf(err));
    }
    if (err instanceof NoCreditsError) {
      throw new ServiceError("no_credits", note("creditsUsedUp"));
    }
    throw err;
  });
  const first = version.definition.steps[0];
  if (first?.type !== "form" || !Object.keys(answers).length) {
    return { runId, refused: null };
  }
  // A first page someone else answers isn't filled by whoever starts the run.
  const started = await db.query.run.findFirst({ where: eq(schema.run.id, runId) });
  if (started && !(await mayAct(started, await callerOfUser(userId)))) {
    return { runId, refused: null };
  }
  const values = Object.fromEntries(
    first.fields.filter((f) => f.id in answers).map((f) => [f.id, answers[f.id]]),
  );
  // The run is there either way; what did not fit is answered again with answer_form.
  try {
    await submitPage(runId, first.id, values, { userId });
    return { runId, refused: null };
  } catch (err) {
    if (err instanceof RunInputError) {
      return { runId, refused: fieldErrorsIn(err.errors, "en") };
    }
    throw err;
  }
}

export async function answerRunForm(
  userId: string,
  runId: string,
  stepId: string,
  values: Record<string, unknown>,
) {
  await answerableRun(userId, runId);
  await submitPage(runId, stepId, values, { userId }).catch(refusedInput);
}

export async function reviewRun(
  userId: string,
  runId: string,
  stepId: string,
  action: ReviewAction,
) {
  await answerableRun(userId, runId);
  await reviewStep(runId, stepId, action, { userId }).catch(refusedInput);
}

export async function controlRun(
  userId: string,
  runId: string,
  action: "back" | "retry" | "cancel",
) {
  const run = await answerableRun(userId, runId);
  if (
    action === "back" &&
    (await answeringNarrowed()) &&
    !mayGoBackFrom(run, await callerOfUser(userId), await answerersOf(run))
  ) {
    throw new ServiceError("forbidden", { code: "notYourStep" });
  }
  const command = { back: (id: string) => goBack(id, { userId }), retry, cancel }[action];
  await command(runId).catch(refusedInput);
}

/** Answers what a running step asks: allow a change in a connected account, or skip it. */
export async function answerRunAsk(
  userId: string,
  runId: string,
  askId: string,
  answer: "allow" | "skip",
) {
  await answerableRun(userId, runId);
  if (!(await answerAsk(runId, askId, answer === "allow" ? { type: "done" } : { type: "skip" }))) {
    throw new ServiceError("refused", { code: "askClosed" });
  }
}

/** Answers what a durable step asked: its turn goes on with that. */
export async function answerRunQuestion(userId: string, runId: string, answer: string) {
  await answerableRun(userId, runId);
  await answerTurn(runId, answer).catch(refusedInput);
}

/**
 * One step of the draft as a run shows it there, without a run: the studio's preview of the
 * step chosen. Answers and outputs of the steps before it come from the wizard's latest
 * finished test run, else its latest one. Nothing is stored and nothing runs: pages wait for
 * input, steps that work show their working screen, the result shows as done. `lang`: in a
 * language the wizard is kept in, else its own.
 */
export async function draftStepView(
  userId: string,
  wizardId: string,
  stepId: string,
  lang: string | null,
): Promise<RunView> {
  const w = await ownedWizard(userId, wizardId);
  const def = w.draft;
  const step = def.steps.find((s) => s.id === stepId);
  if (!step) {
    throw notFound();
  }
  // The latest finished test run has every answer and output; else the latest one at all.
  const tests = and(eq(schema.run.wizardId, w.id), eq(schema.run.mode, "test"));
  const latest =
    (await db.query.run.findFirst({
      where: and(tests, eq(schema.run.status, "done")),
      orderBy: desc(schema.run.createdAt),
    })) ?? (await db.query.run.findFirst({ where: tests, orderBy: desc(schema.run.createdAt) }));
  const before = new Set(def.steps.slice(0, def.steps.indexOf(step)).map((s) => s.id));
  const state: RunState = {
    values: latest?.state.values ?? {},
    outputs: Object.fromEntries(
      Object.entries(latest?.state.outputs ?? {}).filter(([id]) => before.has(id)),
    ),
    history: (latest?.state.history ?? []).filter((id) => before.has(id)),
    notes: {},
  };
  const status: RunRow["status"] =
    step.type === "form" || step.type === "review"
      ? "waiting_input"
      : step.type === "result"
        ? "done"
        : step.type === "wait"
          ? step.signal
            ? "waiting_signal"
            : "sleeping"
          : "running";
  const now = new Date();
  // That run lends its id too: the outputs' files are reached through it.
  const run: RunRow = {
    ...(latest ?? {
      id: `draft-${w.id}`,
      wizardId: w.id,
      unsent: null,
      tenantId: w.tenantId,
      files: [],
      grant: null,
      version: null,
      mode: "test" as const,
      runner: null,
      startedBy: null,
      occurrence: null,
      visitorId: null,
      userId,
      impersonatedBy: null,
      ipHash: null,
      origin: null,
      client: null,
      unattended: false,
      deviceOffer: null,
      costMicros: 0,
      sharedAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    }),
    definition: def,
    label: null,
    driving: false,
    status,
    wakeAt:
      step.type === "wait" && (step.for ?? step.signal?.timeout)
        ? new Date(now.getTime() + waitDurationMs((step.for ?? step.signal?.timeout) as string))
        : null,
    claim: 0,
    rev: 0,
    cursor: step.id,
    state,
    lang: lang && lang !== wizardLang(def) && (await storedTranslation(w.id, lang)) ? lang : null,
    error: null,
    ask: null,
    answer: null,
    clientSpaceId: null,
    chatId: null,
    clientSharedAt: null,
    shareToken: null,
  };
  const view = await runView(run, await brandView(w.spaceId, def.themes));
  // What the latest run said while it worked, and when, is its own: nothing works here.
  return { ...view, events: [] };
}

/** A wizard's runs, newest first; with `q`, those whose label holds those words. */
export async function listRuns(userId: string, wizardId: string, q?: string) {
  const w = await ownedWizard(userId, wizardId);
  const words = q?.trim();
  const rows = await db.query.run.findMany({
    where: and(
      eq(schema.run.wizardId, w.id),
      words
        ? sql`${schema.run.label} LIKE ${`%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} ESCAPE '\\'`
        : undefined,
    ),
    orderBy: [desc(schema.run.createdAt)],
    limit: 100,
  });
  const assetCounts = rows.length
    ? await db
        .select({ runId: schema.asset.runId, n: count() })
        .from(schema.asset)
        .where(
          inArray(
            schema.asset.runId,
            rows.map((r) => r.id),
          ),
        )
        .groupBy(schema.asset.runId)
    : [];
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    status: r.status,
    label: r.label,
    wakeAt: r.wakeAt?.toISOString() ?? null,
    pause: r.state.pause?.kind ?? null,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    credits: Math.ceil(r.costMicros / MICROS_PER_CREDIT),
    assets: assetCounts.find((a) => a.runId === r.id)?.n ?? 0,
    stepTitle: r.definition.steps.find((s) => s.id === r.cursor)?.title ?? null,
    /** The token of its shared result (`/s/<token>`); null while it is not shared. */
    shareToken: r.status === "done" ? r.shareToken : null,
    /** The start that began it; null: a person did. */
    startedBy: r.startedBy ?? null,
  }));
}

/** How many lines of a run's log its timeline shows; a run of weeks may have thousands. */
const TIMELINE_LINES = 500;

/** One run for its timeline in the runs panel. `canAct`: the person looking may push it on or stop it. */
export async function runTimeline(run: RunRow, canAct: boolean): Promise<RunTimeline> {
  const [lines] = await db
    .select({ n: count() })
    .from(schema.runEvent)
    .where(eq(schema.runEvent.runId, run.id));
  const [started] = await db
    .select({ note: schema.runEvent.note })
    .from(schema.runEvent)
    .where(and(eq(schema.runEvent.runId, run.id), eq(schema.runEvent.type, "run_started")))
    .limit(1);
  const name = started?.note?.params?.name;
  const wait =
    run.status === "waiting_signal"
      ? await db.query.runWait.findFirst({ where: eq(schema.runWait.runId, run.id) })
      : null;
  const step = run.definition.steps.find((s) => s.id === run.cursor);
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    label: run.label,
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    wakeAt:
      run.status === "sleeping" || run.status === "waiting_signal" || run.status === "waiting_input"
        ? (run.wakeAt?.toISOString() ?? null)
        : null,
    pause: run.status === "sleeping" ? (run.state.pause?.kind ?? null) : null,
    credits: Math.ceil(run.costMicros / MICROS_PER_CREDIT),
    stepTitle: step?.title ?? null,
    startedBy: typeof name === "string" ? name : null,
    signal: wait ? { name: wait.name, key: wait.key } : null,
    teamStep: run.status === "waiting_input" && whoOf(step) === "team",
    canAct,
    steps: run.definition.steps.map((s) => ({ id: s.id, title: s.title })),
    events: await recentEvents(run.id, 0, TIMELINE_LINES),
    total: lines?.n ?? 0,
  };
}

/** What the results of a space are narrowed to. */
export interface ResultsFilter {
  /** One wizard's. */
  wizardId?: string;
  /** Words in the wizard's title, or in what the run was given and produced. */
  q?: string;
  mode?: "live" | "test";
  /** Done within the last this many days. */
  days?: number;
}

/**
 * The results of a space: its wizards' runs that reached their result, newest first, narrowed by
 * `filter`; and each wizard with how many it has and when its last one came, the latest first.
 */
export async function listResults(spaceId: string, filter: ResultsFilter = {}) {
  // A client space shows the runs started in it, of its parent's wizards; a space only its own
  // (docs/plans/client-portal.md). With `orgSpaces` a space under the root shows its own wizards'
  // runs and the runs of the root's wizards started in it (docs/plans/org-spaces.md).
  const reads = await readsOf(spaceId);
  const client = reads?.as === "client" ? spaceId : null;
  const wizardSpaces =
    reads?.as === "client"
      ? [reads.parentId]
      : reads?.as === "root"
        ? [spaceId, reads.parentId]
        : [spaceId];
  const inSpace = client
    ? eq(schema.run.clientSpaceId, client)
    : reads?.as === "root"
      ? or(
          and(eq(schema.wizard.spaceId, spaceId), isNull(schema.run.clientSpaceId)),
          and(eq(schema.wizard.spaceId, reads.parentId), eq(schema.run.clientSpaceId, spaceId)),
        )
      : isNull(schema.run.clientSpaceId);
  const wizards = await db
    .select({
      id: schema.wizard.id,
      spaceId: schema.wizard.spaceId,
      title: schema.wizard.title,
      results: count(schema.run.id),
      lastAt: max(schema.run.updatedAt),
    })
    .from(schema.wizard)
    .leftJoin(
      schema.run,
      and(eq(schema.run.wizardId, schema.wizard.id), eq(schema.run.status, "done"), inSpace),
    )
    .where(
      and(
        inArray(schema.wizard.spaceId, wizardSpaces),
        eq(schema.wizard.tenantId, currentTenant()),
      ),
    )
    .groupBy(schema.wizard.id)
    // Wizards without a result last: SQLite sorts null below every time.
    .orderBy(desc(max(schema.run.updatedAt)), desc(schema.wizard.updatedAt));
  const q = filter.q?.trim().toLowerCase();
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const titled = like
    ? new Set(wizards.filter((w) => w.title.toLowerCase().includes(q as string)).map((w) => w.id))
    : null;
  const ids = wizards.map((w) => w.id).filter((id) => !filter.wizardId || id === filter.wizardId);
  // The runs of this space, by the wizards listed: the root's only those started here.
  const fromRoot = new Set(wizards.filter((w) => w.spaceId !== spaceId).map((w) => w.id));
  const runsHere =
    reads?.as === "root"
      ? or(
          and(
            inArray(schema.run.wizardId, ids.filter((id) => !fromRoot.has(id)).concat("")),
            isNull(schema.run.clientSpaceId),
          ),
          and(
            inArray(schema.run.wizardId, [...fromRoot].concat("")),
            eq(schema.run.clientSpaceId, spaceId),
          ),
        )
      : inSpace;
  const rows = ids.length
    ? await db
        .select({
          id: schema.run.id,
          wizardId: schema.run.wizardId,
          mode: schema.run.mode,
          version: schema.run.version,
          costMicros: schema.run.costMicros,
          updatedAt: schema.run.updatedAt,
          clientSharedAt: schema.run.clientSharedAt,
        })
        .from(schema.run)
        .where(
          and(
            inArray(schema.run.wizardId, ids),
            eq(schema.run.status, "done"),
            runsHere,
            filter.mode ? eq(schema.run.mode, filter.mode) : undefined,
            filter.days
              ? gte(schema.run.updatedAt, new Date(Date.now() - filter.days * 86_400_000))
              : undefined,
            like
              ? or(
                  titled?.size ? inArray(schema.run.wizardId, [...titled]) : undefined,
                  sql`lower(${schema.run.state}) like ${like} escape '\\'`,
                )
              : undefined,
          ),
        )
        .orderBy(desc(schema.run.updatedAt))
        .limit(100)
    : [];
  const assetCounts = rows.length
    ? await db
        .select({ runId: schema.asset.runId, n: count() })
        .from(schema.asset)
        .where(
          inArray(
            schema.asset.runId,
            rows.map((r) => r.id),
          ),
        )
        .groupBy(schema.asset.runId)
    : [];
  return {
    wizards: wizards.map((w) => ({
      id: w.id,
      title: w.title,
      results: w.results,
      lastAt: w.lastAt ? new Date(w.lastAt).toISOString() : null,
    })),
    runs: rows.map((r) => ({
      id: r.id,
      wizardId: r.wizardId,
      mode: r.mode,
      version: r.version,
      doneAt: r.updatedAt.toISOString(),
      credits: Math.ceil(r.costMicros / MICROS_PER_CREDIT),
      assets: assetCounts.find((a) => a.runId === r.id)?.n ?? 0,
      ...(client ? { clientShared: Boolean(r.clientSharedAt) } : {}),
    })),
  };
}

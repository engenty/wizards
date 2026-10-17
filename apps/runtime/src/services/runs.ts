import {
  FIELD_WAYS,
  type Field,
  formatsFor,
  isDecidedField,
  type Step,
  shownFields,
  slotText,
  wizardLang,
} from "@engenty-wizards/shared/definition";
import { note } from "@engenty-wizards/shared/run";
import { and, count, desc, eq, gte, inArray, max, or, sql } from "drizzle-orm";
import { canSpend, MICROS_PER_CREDIT } from "../credits/credits.js";
import { db, schema } from "../db/client.js";
import { answerAsk } from "../engine/asks.js";
import { emitEvent, recentEvents, watchRun } from "../engine/events.js";
import { fieldErrorsIn } from "../engine/input.js";
import {
  cancel,
  createRun,
  goBack,
  NoCreditsError,
  pageContext,
  type ReviewAction,
  RunConflict,
  RunInputError,
  retry,
  reviewStep,
  submitPage,
} from "../engine/runner.js";
import { ModelUnavailableError, saidOf } from "../model-errors.js";
import { signedUrl } from "../secrets/signing.js";
import { currentTenant } from "../tenants/tenant.js";
import { notFound, ServiceError } from "./errors.js";
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
        if (current?.type === "page") {
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

/** A run a plugin's door may drive: any run of the current tenant, by id. */
export async function pluginRun(runId: string): Promise<RunRow> {
  const run = await db.query.run.findFirst({
    where: and(eq(schema.run.id, runId), eq(schema.run.tenantId, currentTenant())),
  });
  if (!run) {
    throw notFound();
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
    hint: options?.length
      ? "One appointment time: show the person the labels, answer with the value of the one they pick, exactly as given."
      : "No times are free right now: tell the person.",
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
async function waitingFor(run: RunRow, current: Step | null, draft?: Record<string, unknown>) {
  if (run.status === "running" && run.ask) {
    const ask = run.ask;
    return ask.kind === "confirm"
      ? {
          ask: ask.id,
          kind: ask.kind,
          reason: ask.reason,
          service: ask.service,
          action: ask.action.summary,
          input: clip(ask.input, 1500),
          hint: "Ask the person, then answer_ask with allow or skip.",
        }
      : {
          ask: ask.id,
          kind: ask.kind,
          reason: ask.reason,
          site: ask.site.host,
          hint: "A sign-in: the person types it on the run page (browserUrl).",
        };
  }
  if (run.status !== "waiting_input" || !current) {
    return undefined;
  }
  if (current.type === "page") {
    // What the page knows from before it, the choices its fields take from data, the fields a
    // decision kept: a field left out here is not asked, as the run page leaves it out.
    const ctx = await pageContext(run, current);
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
      page: current.id,
      title: current.title,
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
      hint: "Ask the fields in order; skip a field whose `when` does not hold on the answers so far (a hidden one is not required and not kept).",
    };
  }
  if (current.type === "review") {
    return {
      review: current.id,
      title: current.title,
      show: current.show,
      editable: Boolean(current.edit),
      hint: "Show the person the outputs, then review_step: accept, or regenerate one with a note.",
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
  return runReportOf(await waitWhileMoving(userId, runId, waitSeconds, only));
}

/** The report of a run as it stands; `draft` as for `waitingFor`. */
export async function runReportOf(run: RunRow, draft?: Record<string, unknown>) {
  const current = run.definition.steps.find((s) => s.id === run.cursor) ?? null;
  const base = `/api/runs/${run.id}`;
  const outputs = run.definition.steps.flatMap((step) => {
    const output = run.state.outputs[step.id];
    if (!output) {
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
    waitingFor: await waitingFor(run, current, draft),
    error: run.error,
    credits: Math.ceil(run.costMicros / MICROS_PER_CREDIT),
    events: (await recentEvents(run.id, 0, 15)).map((e) => ({
      step: e.stepId,
      type: e.type,
      message: e.message,
    })),
    outputs,
    browserUrl: await browserUrl(run),
    ...(run.mode === "test" ? { studioUrl: studioUrl(run.wizardId) } : {}),
  };
}

export type RunReport = Awaited<ReturnType<typeof runReportOf>>;

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
 * that is theirs — no visitor, no share link needed. With answers the first page is filled.
 */
export async function startRun(
  userId: string,
  wizardId: string,
  answers: Record<string, unknown> = {},
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
  if (first?.type !== "page" || !Object.keys(answers).length) {
    return { runId, refused: null };
  }
  const values = Object.fromEntries(
    first.fields.filter((f) => f.id in answers).map((f) => [f.id, answers[f.id]]),
  );
  // The run is there either way; what did not fit is answered again with answer_page.
  try {
    await submitPage(runId, first.id, values);
    return { runId, refused: null };
  } catch (err) {
    if (err instanceof RunInputError) {
      return { runId, refused: fieldErrorsIn(err.errors, "en") };
    }
    throw err;
  }
}

export async function answerRunPage(
  userId: string,
  runId: string,
  stepId: string,
  values: Record<string, unknown>,
) {
  await ownedRun(userId, runId);
  await submitPage(runId, stepId, values).catch(refusedInput);
}

export async function reviewRun(
  userId: string,
  runId: string,
  stepId: string,
  action: ReviewAction,
) {
  await ownedRun(userId, runId);
  await reviewStep(runId, stepId, action).catch(refusedInput);
}

export async function controlRun(
  userId: string,
  runId: string,
  action: "back" | "retry" | "cancel",
) {
  await ownedRun(userId, runId);
  const command = { back: goBack, retry, cancel }[action];
  await command(runId).catch(refusedInput);
}

/** Answers what a running step asks: allow a change in a connected account, or skip it. */
export async function answerRunAsk(
  userId: string,
  runId: string,
  askId: string,
  answer: "allow" | "skip",
) {
  await ownedRun(userId, runId);
  if (!(await answerAsk(runId, askId, answer === "allow" ? { type: "done" } : { type: "skip" }))) {
    throw new ServiceError("refused", { code: "askClosed" });
  }
}

export async function listRuns(userId: string, wizardId: string) {
  const w = await ownedWizard(userId, wizardId);
  const rows = await db.query.run.findMany({
    where: eq(schema.run.wizardId, w.id),
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
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    credits: Math.ceil(r.costMicros / MICROS_PER_CREDIT),
    assets: assetCounts.find((a) => a.runId === r.id)?.n ?? 0,
    stepTitle: r.definition.steps.find((s) => s.id === r.cursor)?.title ?? null,
  }));
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
export async function listResults(projectId: string, filter: ResultsFilter = {}) {
  const wizards = await db
    .select({
      id: schema.wizard.id,
      title: schema.wizard.title,
      results: count(schema.run.id),
      lastAt: max(schema.run.updatedAt),
    })
    .from(schema.wizard)
    .leftJoin(
      schema.run,
      and(eq(schema.run.wizardId, schema.wizard.id), eq(schema.run.status, "done")),
    )
    .where(and(eq(schema.wizard.projectId, projectId), eq(schema.wizard.tenantId, currentTenant())))
    .groupBy(schema.wizard.id)
    // Wizards without a result last: SQLite sorts null below every time.
    .orderBy(desc(max(schema.run.updatedAt)), desc(schema.wizard.updatedAt));
  const q = filter.q?.trim().toLowerCase();
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const titled = like
    ? new Set(wizards.filter((w) => w.title.toLowerCase().includes(q as string)).map((w) => w.id))
    : null;
  const ids = wizards.map((w) => w.id).filter((id) => !filter.wizardId || id === filter.wizardId);
  const rows = ids.length
    ? await db
        .select({
          id: schema.run.id,
          wizardId: schema.run.wizardId,
          mode: schema.run.mode,
          version: schema.run.version,
          costMicros: schema.run.costMicros,
          updatedAt: schema.run.updatedAt,
        })
        .from(schema.run)
        .where(
          and(
            inArray(schema.run.wizardId, ids),
            eq(schema.run.status, "done"),
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
    })),
  };
}

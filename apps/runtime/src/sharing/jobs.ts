import { noteText } from "@engenty/wizards-shared/run";
import type {
  ShareChoice,
  ShareJobView,
  ShareLang,
  ShareRequest,
} from "@engenty/wizards-shared/sharing";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import {
  brokerCall,
  brokerConnected,
  brokerSend,
  GUEST_MAILS_PER_RUN,
  type Refusal,
  whereOfRun,
  whoOf,
} from "../broker/index.js";
import { BROKER_SHARE_PATH, brokerPost } from "../broker/remote.js";
import { askPerson } from "../engine/asks.js";
import { signalChanged } from "../engine/events.js";
import { releaseResources } from "../engine/resources.js";
import { inProcessContext, loadSpace, spaceIdOf } from "../engine/runner.js";
import type { RunRow } from "../engine/types.js";
import { env } from "../env.js";
import { errorText } from "../model-errors.js";
import { opensAccounts } from "../secrets/accounts.js";
import { ServiceError } from "../services/errors.js";
import { shareRun } from "../services/shares.js";
import { holderOf, scopeOf } from "../store/index.js";
import { serverText } from "../texts.js";
import { SHARE_STEP } from "./agent.js";
import { shareFiles } from "./files.js";
import { type OfferedTarget, offeredTargets, targetScope } from "./index.js";
import {
  addJobEvent,
  createJob,
  finishJob,
  JOB_LOOK_MS,
  JOB_TOUCH_MS,
  jobCount,
  jobRow,
  runningJob,
  sentCount,
  setWorking,
  touchJob,
  workingJob,
} from "./state.js";
import { parseRecipients } from "./targets/email.js";
import { line, type Said, type ShareContext, ShareError, sayIn } from "./types.js";

/** What the person filled in does not do: per field, what is wrong. `_files` and `_account` name the other steps. */
export class ShareInputError extends Error {
  constructor(
    readonly fields: Record<string, string>,
    said: string,
  ) {
    super(Object.values(fields)[0] ?? said);
  }
}

/** Jobs one run of a person without an account may start. */
const VISITOR_JOBS = 20;

/** A link people elsewhere can open: not one that points at this machine. */
function publicOrigin(): boolean {
  const host = new URL(env.appUrl).hostname;
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "127.0.0.1" ||
    host === "[::1]"
  );
}

/** A share target's account, held by the run's store like a wizard's connections. */
const heldBy = (run: RunRow, def: ConnectionDef, spaceId: string) =>
  ({ kind: "store_secret", def, scope: scopeOf(run), spaceId }) as const;

function contextOf(
  run: RunRow,
  spaceId: string,
  entry: OfferedTarget,
  who: { member: boolean; lang: ShareLang },
  job: { id: string; signal: AbortSignal; sentBefore: number } | null,
): ShareContext {
  const connection = entry.target.connection?.() ?? null;
  const signal = job?.signal ?? new AbortController().signal;
  // The run is done and the person sends its result on: the one call the broker takes of a run
  // that is done (broker/over.ts).
  const where = { ...whereOfRun(run, holderOf(run), spaceId), share: true };
  const emit = (message: Said) =>
    job ? addJobEvent(run.id, job.id, sayIn(who.lang, message)) : Promise.resolve();
  const ask: ShareContext["ask"] = (question) =>
    !job || run.unattended
      ? Promise.resolve(null)
      : askPerson(run.id, { ...question, stepId: SHARE_STEP }, signal);
  return {
    ...targetScope(run, spaceId, who.lang),
    signal,
    member: who.member,
    sentBefore: job?.sentBefore ?? 0,
    emit,
    ask,
    connected: () =>
      connection ? brokerConnected(heldBy(run, connection, spaceId)) : Promise.resolve(null),
    call: async (action, input, work) => {
      const name = sayIn(who.lang, entry.target.name);
      if (!connection) {
        throw new ShareError(line("shareConnectFirst", { name }));
      }
      // The person filled the form and sent it: a write is theirs, nothing asks again.
      const out = await brokerCall({
        who: whoOf(holderOf(run)),
        where,
        connection: heldBy(run, connection, spaceId),
        action,
        input,
        ctx: { ask, confirmed: true },
        ...(typeof work === "function" ? { handler: work } : work ? { named: work } : {}),
      });
      if (!out.ok) {
        throw new ShareError(
          out.refused === "not_connected"
            ? line("shareConnectFirst", { name })
            : (refusalLine(out.refused) ?? out.reason),
        );
      }
      return out.result as never;
    },
    sendFromServer: async (recipients, input, handler) => {
      const out = await brokerSend({
        who: whoOf(holderOf(run)),
        where,
        recipients,
        input,
        handler,
      });
      if (!out.ok) {
        throw new ShareError(refusalLine(out.refused) ?? out.reason);
      }
      return out.result as never;
    },
    link: async () => (publicOrigin() ? (await shareRun(run)).url : null),
    step: async () =>
      inProcessContext(run, await loadSpace(run), structuredClone(run.state), signal, {
        stepId: SHARE_STEP,
        share: true,
        emit: (_type, message) =>
          emit(typeof message === "string" ? message : noteText(message, who.lang)),
        ask,
      }),
  };
}

/** What the person reads when the broker refuses a guest's send; null for the other refusals. */
function refusalLine(refused: Refusal): Said | null {
  switch (refused) {
    case "not_allowed_recipient":
      return line("shareGuestRecipient");
    case "channel_not_fixed":
      return line("shareGuestChannel");
    case "run_limit":
      return line("shareGuestRunMails", { mails: GUEST_MAILS_PER_RUN });
    case "day_limit":
      return line("shareGuestDayMails");
    default:
      return null;
  }
}

async function entryOf(run: RunRow, spaceId: string, key: string, member: boolean) {
  const entry = (await offeredTargets(run, spaceId, member)).find((e) => e.key === key);
  if (!entry) {
    throw new ServiceError("not_found", { server: "shareTargetUnknown" });
  }
  return entry;
}

/**
 * Sends a finished result to one target. Answers as soon as the job stands; the work goes on in
 * the background and shows in the run's view. One job per run at a time. A process that opens no
 * connected account hands the work to the broker, which does it as it would its own (`workShare`).
 */
export async function startShare(
  run: RunRow,
  request: ShareRequest,
  who: { member: boolean },
): Promise<ShareJobView> {
  if (run.status !== "done") {
    throw new ServiceError("refused", { server: "shareOnlyDone" });
  }
  // A job that was cancelled while its last call was on its way still holds the run here.
  if (workingJob(run.id) || (await runningJob(run.id))) {
    throw new ServiceError("refused", { server: "shareBusy" });
  }
  // A run of someone without an account sends a limited number of times: it is no mail relay.
  if (!who.member && (await jobCount(run.id)) >= VISITOR_JOBS) {
    throw new ServiceError("refused", { server: "shareTooOften" });
  }
  const lang = request.lang ?? "en";
  const spaceId = await spaceIdOf(run);
  const entry = await entryOf(run, spaceId, request.target, who.member);
  const { target } = entry;

  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const field of target.fields) {
    const value = String(request.values[field.id] ?? "")
      .trim()
      .slice(0, field.kind === "textarea" ? 20_000 : 2000);
    values[field.id] = value;
    if (!value) {
      if (field.required) {
        errors[field.id] = serverText(lang, "shareRequired");
      }
      continue;
    }
    if (field.kind === "url" && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(value)) {
      errors[field.id] = serverText(lang, "shareNeedsHttps");
    }
    if (field.kind === "emails") {
      try {
        parseRecipients(value);
      } catch (err) {
        errors[field.id] = errorText(err, lang);
      }
    }
  }
  const items = target.takes === "files" ? request.items.slice(0, 20) : [];
  if (target.needsFiles && !items.length) {
    errors._files = serverText(lang, "sharePickFile");
  }
  const connection = target.connection?.() ?? null;
  if (connection && !(await brokerConnected(heldBy(run, connection, spaceId)))) {
    errors._account = serverText(lang, "shareConnectAccount");
  }
  if (Object.keys(errors).length) {
    throw new ShareInputError(errors, serverText(lang, "shareCheckInput"));
  }

  const job = await createJob({
    runId: run.id,
    target: target.id,
    name: entry.label ?? sayIn(lang, target.name),
    icon: target.icon,
    request: { target: request.target, items, values, lang },
  });
  if (opensAccounts()) {
    await workShare(run, job.id, who.member);
  } else {
    await handShare(run.id, job.id, who.member).catch((err) =>
      finishJob(run.id, job.id, {
        status: "failed",
        error: `${serverText(lang, "shareFailed")}: ${String((err as Error)?.message ?? err).slice(0, 240)}`,
      }),
    );
  }
  return job;
}

/** What a process without the accounts' key sends the broker for a job it stood up. */
export interface HandedShare {
  runId: string;
  jobId: string;
  member: boolean;
}

/** Hands the job to the broker; it answers once the work has begun there. */
async function handShare(runId: string, jobId: string, member: boolean) {
  await brokerPost(BROKER_SHARE_PATH, { runId, jobId, member } satisfies HandedShare);
}

/**
 * Does a job that stands as a row: in the process that stood it up, or in the broker that
 * process handed it to. Answers once the work has begun. The work looks at the job's row while it
 * goes on: a job cancelled in another process stops here, and the touched row tells the others
 * that someone works on it.
 */
export async function workShare(run: RunRow, jobId: string, member: boolean): Promise<void> {
  const row = await jobRow(jobId);
  if (row?.status !== "running") {
    return;
  }
  const request = row.request;
  const lang = request.lang ?? "en";
  const busy = workingJob(run.id);
  if (busy) {
    if (busy.jobId !== jobId) {
      await finishJob(run.id, jobId, { status: "failed", error: serverText(lang, "shareBusy") });
    }
    return;
  }
  const spaceId = await spaceIdOf(run);
  const abort = new AbortController();
  setWorking(run.id, { jobId, abort });
  let entry: OfferedTarget;
  try {
    entry = await entryOf(run, spaceId, request.target, member);
  } catch (err) {
    setWorking(run.id, null);
    await finishJob(run.id, jobId, { status: "failed", error: errorText(err, lang) });
    return;
  }
  const { target } = entry;
  const ctx = contextOf(
    run,
    spaceId,
    entry,
    { member, lang },
    { id: jobId, signal: abort.signal, sentBefore: await sentCount(run.id, target.id) },
  );
  let looks = 0;
  const watch = setInterval(() => {
    looks += 1;
    const going =
      looks % (JOB_TOUCH_MS / JOB_LOOK_MS) === 0
        ? touchJob(jobId)
        : jobRow(jobId).then((now) => now?.status === "running");
    void going.then(
      (still) => {
        if (!still) {
          abort.abort();
        }
      },
      () => undefined,
    );
  }, JOB_LOOK_MS);
  watch.unref();

  void (async () => {
    try {
      if (request.items.length) {
        await ctx.emit({ server: "sharePreparing" });
      }
      const files = await shareFiles(run, request.items);
      const outcome = await target.send({ values: request.values, files }, ctx);
      await finishJob(
        run.id,
        jobId,
        abort.signal.aborted
          ? { status: "cancelled" }
          : {
              status: "done",
              result: { summary: sayIn(lang, outcome.summary), url: outcome.url ?? null },
            },
      );
    } catch (err) {
      if (!abort.signal.aborted && !(err instanceof ShareError)) {
        console.error(`[share ${run.id} → ${target.id}]`, err);
      }
      await finishJob(
        run.id,
        jobId,
        abort.signal.aborted
          ? { status: "cancelled" }
          : {
              status: "failed",
              error:
                err instanceof ShareError
                  ? errorText(err, lang)
                  : `${serverText(lang, "shareFailed")}: ${String((err as Error)?.message ?? err).slice(0, 240)}`,
            },
      ).catch(() => undefined);
    } finally {
      clearInterval(watch);
      setWorking(run.id, null);
      await releaseResources(run.id).catch(() => undefined);
      signalChanged(run.id);
    }
  })();
}

/**
 * Stops the job a run is working on; what it already sent stays sent. The row says so: the
 * process at work on it, here or the broker, stops when it next looks.
 */
export async function cancelShare(runId: string, jobId?: string): Promise<boolean> {
  const job = await runningJob(runId);
  if (!job || (jobId && job.id !== jobId)) {
    return false;
  }
  workingJob(runId)?.abort.abort();
  await finishJob(runId, job.id, { status: "cancelled" });
  return true;
}

/** The choices of a form field that come from the connected account (Slack's channels). */
export async function shareChoices(
  run: RunRow,
  key: string,
  field: string,
  who: { member: boolean; lang: ShareLang },
): Promise<ShareChoice[]> {
  const spaceId = await spaceIdOf(run);
  const entry = await entryOf(run, spaceId, key, who.member);
  if (!entry.target.choices) {
    return [];
  }
  return entry.target.choices(field, contextOf(run, spaceId, entry, who, null));
}

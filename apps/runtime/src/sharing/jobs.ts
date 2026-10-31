import { noteText } from "@engenty/wizards-shared/run";
import type {
  ShareChoice,
  ShareJobView,
  ShareLang,
  ShareRequest,
} from "@engenty/wizards-shared/sharing";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { brokerCall, brokerConnected, whereOfRun, whoOf } from "../broker/index.js";
import { askPerson } from "../engine/asks.js";
import { signalChanged } from "../engine/events.js";
import { releaseResources } from "../engine/resources.js";
import { loadSpace, makeContext, spaceIdOf } from "../engine/runner.js";
import type { RunRow } from "../engine/types.js";
import { env } from "../env.js";
import { errorText } from "../model-errors.js";
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
  jobCount,
  sentCount,
  setWorking,
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
    call: async (action, input, handler) => {
      const name = sayIn(who.lang, entry.target.name);
      if (!connection) {
        throw new ShareError(line("shareConnectFirst", { name }));
      }
      // The person filled the form and sent it: a write is theirs, nothing asks again.
      const out = await brokerCall({
        who: whoOf(holderOf(run)),
        where: whereOfRun(run, holderOf(run), spaceId),
        connection: heldBy(run, connection, spaceId),
        action,
        input,
        ctx: { ask, confirmed: true },
        handler,
      });
      if (!out.ok) {
        throw new ShareError(
          out.refused === "not_connected" ? line("shareConnectFirst", { name }) : out.reason,
        );
      }
      return out.result as never;
    },
    link: async () => (publicOrigin() ? (await shareRun(run)).url : null),
    step: async () =>
      makeContext(run, await loadSpace(run), structuredClone(run.state), signal, {
        stepId: SHARE_STEP,
        emit: (_type, message) =>
          emit(typeof message === "string" ? message : noteText(message, who.lang)),
        ask,
      }),
  };
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
 * the background and shows in the run's view. One job per run at a time.
 */
export async function startShare(
  run: RunRow,
  request: ShareRequest,
  who: { member: boolean },
): Promise<ShareJobView> {
  if (run.status !== "done") {
    throw new ServiceError("refused", { server: "shareOnlyDone" });
  }
  if (workingJob(run.id)) {
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
  const abort = new AbortController();
  setWorking(run.id, { jobId: job.id, abort });
  const ctx = contextOf(
    run,
    spaceId,
    entry,
    { member: who.member, lang },
    { id: job.id, signal: abort.signal, sentBefore: await sentCount(run.id, target.id) },
  );

  void (async () => {
    try {
      if (items.length) {
        await ctx.emit({ server: "sharePreparing" });
      }
      const files = await shareFiles(run, items);
      const outcome = await target.send({ values, files }, ctx);
      await finishJob(
        run.id,
        job.id,
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
        job.id,
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
      setWorking(run.id, null);
      await releaseResources(run.id).catch(() => undefined);
      signalChanged(run.id);
    }
  })();

  return job;
}

/** Stops the job a run is working on; what it already sent stays sent. */
export async function cancelShare(runId: string, jobId?: string): Promise<boolean> {
  const job = workingJob(runId);
  if (!job || (jobId && job.jobId !== jobId)) {
    return false;
  }
  job.abort.abort();
  await finishJob(runId, job.jobId, { status: "cancelled" });
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

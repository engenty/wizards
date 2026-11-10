import { createHash } from "node:crypto";
import type { PluginRunReport, PluginRunSignal, PluginRuns } from "@engenty/wizards/plugin";
import { fieldErrorsIn } from "@engenty/wizards-engine/input";
import {
  LANGS,
  type Lang,
  MESSAGE_SIGNAL,
  textLang,
  wizardLang,
} from "@engenty/wizards-shared/definition";
import { note, noteText, type RunNote, waitsOnJob } from "@engenty/wizards-shared/run";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema, withTenant } from "../db/client.js";
import {
  answeringNarrowed,
  doorCaller,
  mayAct,
  mayGoBackFrom,
  mayWithdraw,
} from "../engine/answerers.js";
import { answerAsk } from "../engine/asks.js";
import { emitEvent, watchRun } from "../engine/events.js";
import {
  answerTurn,
  cancel,
  createRun,
  GuestBudgetError,
  goBack,
  NoCreditsError,
  RunInputError,
  retry,
  reviewStep,
  signalRun,
  submitPage,
} from "../engine/runner.js";
import { saveAsset } from "../files/storage.js";
import { checkUpload } from "../files/upload-check.js";
import { wizardUnavailable } from "../limits.js";
import { transcribeAudio } from "../media/transcribe.js";
import { errorText, ModelUnavailableError } from "../model-errors.js";
import { uploadMime } from "../routes/delivery.js";
import { runTicket } from "../secrets/signing.js";
import { notFound, ServiceError } from "../services/errors.js";
import { runnerSettingsOf, runnersOf } from "../services/runners.js";
import {
  pluginAnswerableRun,
  pluginRun,
  refusedInput,
  runReportOf,
  waitRun,
} from "../services/runs.js";
import { shareUrl } from "../services/wizards.js";
import { visitorOverLimit } from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * `wizards.server.runs`: the functions behind the MCP tools, for a plugin's door. A run started
 * here is a live run of the published wizard for a person of that door; the plugin keeps who
 * the person is, the runtime keeps a hash of it as the run's visitor, so what the wizard
 * remembers is theirs on the run page too.
 */

/** A person of a door as the run's visitor: a hash, never the number or the account itself. */
function visitorOf(person: { channel: string; id: string }): string {
  return `p:${createHash("sha256").update(`${person.channel}:${person.id}`).digest("hex").slice(0, 32)}`;
}

export function runsApiFor(pluginId: string): PluginRuns {
  return {
    async start(input) {
      const w = await db.query.wizard.findFirst({
        where: and(
          eq(schema.wizard.tenantId, currentTenant()),
          "token" in input
            ? eq(schema.wizard.shareToken, input.token)
            : eq(schema.wizard.id, input.wizardId),
        ),
      });
      if (!w || w.publishedVersion === null) {
        throw notFound();
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
      const reason = await wizardUnavailable(w);
      if (reason) {
        throw new ServiceError("refused", noteText(reason, wizardLang(version.definition)));
      }
      const visitorId = visitorOf(input.person);
      if (await visitorOverLimit(visitorId, null)) {
        throw new ServiceError(
          "refused",
          noteText({ code: "tooManyRuns" }, wizardLang(version.definition)),
        );
      }
      const runId = await createRun({
        wizardId: w.id,
        definition: version.definition,
        files: version.files,
        version: w.publishedVersion,
        mode: "live",
        visitorId,
        runner: input.runner ?? pluginId,
      }).catch((err) => {
        if (err instanceof ModelUnavailableError) {
          throw new ServiceError(
            "refused",
            errorText(err, textLang(wizardLang(version.definition))),
          );
        }
        if (err instanceof GuestBudgetError) {
          throw new ServiceError(
            "refused",
            noteText({ code: "guestBudget" }, wizardLang(version.definition)),
          );
        }
        if (err instanceof NoCreditsError) {
          throw new ServiceError(
            "no_credits",
            noteText({ code: "wizardRunOutCredits" }, wizardLang(version.definition)),
          );
        }
        throw err;
      });
      const first = version.definition.steps[0];
      let refused: { field: string; message: string }[] | null = null;
      // A first page the team answers isn't filled by whoever starts the run.
      const started = await pluginRun(runId);
      if (
        first?.type === "form" &&
        input.answers &&
        Object.keys(input.answers).length &&
        (await mayAct(started, doorCaller(started)))
      ) {
        const answers = input.answers;
        const values = Object.fromEntries(
          first.fields.filter((f) => f.id in answers).map((f) => [f.id, answers[f.id]]),
        );
        try {
          await submitPage(runId, first.id, values, { visitorId });
        } catch (err) {
          if (!(err instanceof RunInputError)) {
            throw err;
          }
          refused = fieldErrorsIn(err.errors, "en");
        }
      }
      return { runId, ticket: runTicket(runId), refused };
    },
    async report(runId, options) {
      const run = await waitRun(() => pluginRun(runId), options?.waitSeconds ?? 0);
      return (await runReportOf(run, options?.draft, doorCaller(run))) as PluginRunReport;
    },
    async message(runId, input) {
      const run = await pluginRun(runId);
      const sent = await signalRun(run.id, {
        data: { text: input.text },
        source: `plugin:${pluginId}`,
        delivery: input.delivery,
        only: MESSAGE_SIGNAL,
      });
      return sent ? { runs: sent.runs } : null;
    },
    async wizards(runner) {
      const rows = await db.query.wizard.findMany({
        where: and(
          eq(schema.wizard.tenantId, currentTenant()),
          isNotNull(schema.wizard.publishedVersion),
        ),
        orderBy: asc(schema.wizard.createdAt),
      });
      const available = await runnersOf();
      const offered = rows.filter((w) => runnerSettingsOf(w, available).enabled.includes(runner));
      const versions = offered.length
        ? await db.query.wizardVersion.findMany({
            where: inArray(
              schema.wizardVersion.wizardId,
              offered.map((w) => w.id),
            ),
          })
        : [];
      return offered.flatMap((w) => {
        const version = versions.find(
          (v) => v.wizardId === w.id && v.version === w.publishedVersion,
        );
        return version
          ? [
              {
                wizardId: w.id,
                token: w.shareToken,
                title: version.definition.title,
                lang: textLang(wizardLang(version.definition)),
              },
            ]
          : [];
      });
    },
    async answerForm(runId, stepId, values) {
      const run = await pluginAnswerableRun(runId);
      await submitPage(runId, stepId, values, doorCaller(run)).catch(refusedInput);
    },
    async review(runId, stepId, action) {
      const run = await pluginAnswerableRun(runId);
      await reviewStep(runId, stepId, action, doorCaller(run)).catch(refusedInput);
    },
    async answerAsk(runId, askId, answer) {
      const run = await pluginAnswerableRun(runId);
      if (
        !(await answerAsk(runId, askId, answer === "allow" ? { type: "done" } : { type: "skip" }))
      ) {
        throw new ServiceError(
          "refused",
          noteText({ code: "askClosed" }, wizardLang(run.definition)),
        );
      }
    },
    async answerQuestion(runId, answer) {
      await pluginAnswerableRun(runId);
      await answerTurn(runId, answer).catch(refusedInput);
    },
    async control(runId, action) {
      const opened = await pluginRun(runId);
      if (action === "cancel" && (await mayWithdraw(opened, doorCaller(opened)))) {
        await emitEvent(runId, opened.cursor, "stopped", note("runWithdrawn"));
        await cancel(runId).catch(refusedInput);
        return;
      }
      const run = await pluginAnswerableRun(runId);
      if (
        action === "back" &&
        (await answeringNarrowed()) &&
        !mayGoBackFrom(run, doorCaller(run), [])
      ) {
        throw new ServiceError("forbidden", { code: "notYourStep" });
      }
      const command = { back: goBack, retry, cancel }[action];
      await command(runId).catch(refusedInput);
    },
    subscribe(runId, listener) {
      // The listener runs inside the tenant the subscription was made in, as the events do.
      const tenantId = currentTenant();
      // Changes the runner makes in another process reach the plugin too, each event once.
      return watchRun(runId, (signal) => {
        const event = signal.event;
        const shaped: PluginRunSignal = {
          runId,
          event: event
            ? {
                id: event.id,
                at: event.at,
                stepId: event.stepId,
                type: event.type,
                message: event.message,
                note: event.note
                  ? {
                      code: event.note.code,
                      text: Object.fromEntries(
                        LANGS.map((lang) => [lang, noteText(event.note as RunNote, lang)]),
                      ) as Record<Lang, string>,
                    }
                  : null,
              }
            : null,
        };
        void withTenant(tenantId, () => listener(shaped));
      });
    },
    async handoffUrl(runId) {
      const run = await pluginRun(runId);
      // The link answers as the run's person: a door hands on its own visitor's runs, nobody else's.
      if ((await answeringNarrowed()) && !run.visitorId) {
        throw new ServiceError("forbidden", { code: "notYourStep" });
      }
      const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, run.wizardId) });
      if (!w) {
        throw notFound();
      }
      return `${shareUrl(w.shareToken)}/${run.id}?rt=${encodeURIComponent(runTicket(run.id))}`;
    },
    async upload(runId, file) {
      await pluginAnswerableRun(runId);
      // The type comes from the channel's sender: kept only when it is one a wizard takes.
      const checked = await checkUpload({
        name: file.name,
        mime: uploadMime(file.mime),
        data: file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data),
      });
      const asset = await saveAsset({
        runId,
        kind: checked.mime.startsWith("image/") ? "image" : "file",
        ...checked,
      });
      return { assetId: asset.id };
    },
    async transcribe(runId, file) {
      const run = await pluginAnswerableRun(runId);
      if (run.status === "done" || run.status === "cancelled" || run.status === "failed") {
        throw new ServiceError(
          "refused",
          noteText({ code: "runOver" }, wizardLang(run.definition)),
        );
      }
      if ((run.status === "sleeping" && !waitsOnJob(run)) || run.status === "waiting_signal") {
        throw new ServiceError(
          "refused",
          noteText({ code: "runSleeps" }, wizardLang(run.definition)),
        );
      }
      const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      if (!bytes.length || bytes.length > 10_000_000) {
        throw new ServiceError(
          "invalid",
          noteText({ code: "recordingTooLarge" }, wizardLang(run.definition)),
        );
      }
      const { text } = await transcribeAudio({
        bytes,
        mediaType: file.mime.split(";")[0].trim() || "audio/ogg",
        call: { runId: run.id },
      }).catch((err) => {
        if (err instanceof ModelUnavailableError) {
          throw new ServiceError("refused", errorText(err, textLang(wizardLang(run.definition))));
        }
        throw err;
      });
      return { text };
    },
  };
}

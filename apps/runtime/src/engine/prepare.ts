import { allFields, isAudioValue } from "@engenty-wizards/shared/definition";
import { extFor, loadAsset } from "../files/storage.js";
import { listenPieces, transcribeAudio } from "../media/transcribe.js";
import type { StepContext } from "./types.js";

/**
 * Gets the person's answers ready for a step that works on its own: a voice note is listened to
 * once and kept as text with the answer, and a recording or signature that is not this run's own
 * upload is dropped. Runs before every automatic step; what is already done costs nothing.
 */
export async function prepareInputs(ctx: StepContext): Promise<void> {
  const values = ctx.state.values;
  for (const field of allFields(ctx.def)) {
    const value = values[field.id];
    if (field.kind === "signature" && typeof value === "string") {
      const drawn = await loadAsset(value);
      if (drawn?.row.runId !== ctx.runId || !drawn.row.mime.startsWith("image/")) {
        delete values[field.id];
      }
      continue;
    }
    if (field.kind === "file" && field.listen) {
      await listenTo(ctx, field.id, field.label, value);
      continue;
    }
    if (field.kind !== "audio" || !isAudioValue(value)) {
      continue;
    }
    if (value.transcript !== undefined) {
      continue;
    }
    const found = await loadAsset(value.asset);
    if (!found || found.row.runId !== ctx.runId || !/^(audio|video)\//.test(found.row.mime)) {
      delete values[field.id];
      continue;
    }
    await ctx.emit("info", { code: "listen", params: { label: field.label } });
    try {
      const transcript = await transcribeAudio({
        bytes: new Uint8Array(found.data),
        mediaType: found.row.mime,
        abortSignal: ctx.signal,
        call: ctx.call,
        language: value.lang,
      });
      await ctx.chargeUsd(transcript.costUsd);
      values[field.id] = { ...value, transcript: transcript.text };
    } catch (err) {
      if (ctx.signal.aborted) {
        throw err;
      }
      // The step goes on without the words; the next one tries again.
      console.error(`[run ${ctx.runId}] transcribe ${field.id}`, err);
      await ctx.emit("info", {
        code: "listenFailed",
        params: { label: field.label },
      });
    }
  }
}

/** A recording in a file field with `listen`: written down once, piece by piece with its times. */
async function listenTo(ctx: StepContext, id: string, label: string, value: unknown) {
  if (ctx.state.heard?.[id]) {
    return;
  }
  // Several recordings: the first is the one that is cut.
  const first = Array.isArray(value) ? value[0] : value;
  const found = typeof first === "string" && first ? await loadAsset(first) : null;
  if (!found || found.row.runId !== ctx.runId || !/^(audio|video)\//.test(found.row.mime)) {
    return;
  }
  await ctx.emit("info", { code: "listen", params: { label } });
  try {
    const { pieces, costUsd } = await listenPieces({
      bytes: new Uint8Array(found.data),
      ext: extFor(found.row.mime),
      abortSignal: ctx.signal,
      call: ctx.call,
    });
    await ctx.chargeUsd(costUsd);
    ctx.state.heard = { ...ctx.state.heard, [id]: pieces };
  } catch (err) {
    if (ctx.signal.aborted) {
      throw err;
    }
    // The step goes on without the words; the next one tries again.
    console.error(`[run ${ctx.runId}] listen ${id}`, err);
    await ctx.emit("info", { code: "listenFailed", params: { label } });
  }
}

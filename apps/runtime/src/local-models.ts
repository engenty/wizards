import { MODEL_JOBS, type OfferedModel } from "@engenty/model-setup";
import { OllamaModels } from "@engenty/model-setup/server";
import { layout } from "./cli/home.js";
import { env } from "./env.js";
import { embeddingModel, forgetLocalModels, localOllamaUrl } from "./models.js";

/**
 * The models in Ollama on this computer (@engenty/model-setup), with the ones the Manage-App
 * offers per job (`GET /v1/local-models` of the account's Manage-App). Text, search and decisions
 * each pick their model from it.
 */

/** The share of the computer's memory a model may take and still leave room for the rest. */
const MEMORY_SHARE = 0.7;

/** The Manage-App's list at the last look: kept for an hour, asked again after five minutes when it did not answer. */
let offered: { models: OfferedModel[] | null; at: number } | null = null;

async function offeredModels(): Promise<OfferedModel[] | null> {
  if (offered && Date.now() < offered.at) {
    return offered.models;
  }
  let models: OfferedModel[] | null = null;
  try {
    const res = await fetch(`${env.local.accountUrl}/v1/local-models`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = res.ok ? ((await res.json()) as { models?: OfferedModel[] }) : null;
    models = body?.models?.filter((m) => MODEL_JOBS.includes(m.job)) ?? null;
  } catch {
    // Asked again in five minutes.
  }
  offered = { models, at: Date.now() + (models ? 60 : 5) * 60_000 };
  return models;
}

/** The model the spaces are indexed with now. */
const embeddedBy = async () => (await embeddingModel().catch(() => null))?.ref ?? null;

export const ollamaModels = new OllamaModels({
  url: localOllamaUrl,
  offered: offeredModels,
  share: MEMORY_SHARE,
  logs: () => layout().logs,
  changed: forgetLocalModels,
  // Where the pulled model is the embedding model now, the spaces are indexed with it after.
  async pulling() {
    const before = await embeddedBy();
    return async () => {
      if ((await embeddedBy()) !== before) {
        const { reindexAll } = await import("./services/space-index.js");
        await reindexAll();
      }
    };
  },
});

import { join } from "node:path";
import { setupRoutes, type TerminalError, Terminals, Tested } from "@engenty/model-setup/server";
import { MODEL_CLASSES, TEXT_CLASSES, type TextClass } from "@engenty/wizards-shared/definition";
import { note } from "@engenty/wizards-shared/run";
import { generateText } from "ai";
import { z } from "zod";
import { env } from "../env.js";
import { clientSetup, HARNESS_IDS } from "../harness/index.js";
import { ollamaModels } from "../local-models.js";
import {
  DECISION_CHOICES,
  EMBEDDING_CHOICES,
  LOCAL_KEYS,
  type LocalKey,
  localModelSettings,
  saveLocalModels,
  setUpKey,
  setUpOllama,
  textModel,
} from "../models.js";
import { ServiceError } from "../services/errors.js";
import { readSetting, writeSetting } from "../settings.js";
import { requestLang } from "./lang.js";

/**
 * The setup of a runtime that runs alone (@engenty/model-setup): its clients, its keys and
 * models, and the call that ends it.
 */

/** What a page may change of the models. */
export const modelsInput = z.object({
  source: z.enum([...HARNESS_IDS, "account", "own"]).optional(),
  bindings: z.partialRecord(z.enum(MODEL_CLASSES), z.string().max(160)).optional(),
  ollamaUrl: z.string().max(200).optional(),
  creditFallback: z.boolean().optional(),
  decision: z.enum(DECISION_CHOICES).optional(),
  embedding: z.enum(EMBEDDING_CHOICES).optional(),
  decisionLocal: z.string().max(120).optional(),
  embeddingLocal: z.string().max(120).optional(),
  keys: z.partialRecord(z.enum(LOCAL_KEYS), z.string().max(400)).optional(),
});

/** The model sources a test call has worked on: the setup is done for those, not for the others. */
export const testedSources = new Tested({
  async read() {
    const tested = await readSetting<unknown>("setup-done");
    return Array.isArray(tested) ? (tested as string[]) : [];
  },
  write: (sources) => writeSetting("setup-done", sources),
});

export const localSetup = setupRoutes({
  clients: clientSetup,
  terminals: new Terminals(),
  workDir: () => join(env.dataDir, "harness"),
  tested: testedSources,
  ollama: ollamaModels,
  models: {
    source: () => localModelSettings().source,
    settings: () => localModelSettings(),
    save: async (_c, body) => {
      await saveLocalModels(modelsInput.parse(body));
    },
    classes: TEXT_CLASSES,
    async test(cls) {
      const resolved = await textModel(cls as TextClass);
      const result = await generateText({
        model: resolved.model,
        prompt: "Reply with the single word: OK",
        maxOutputTokens: 20,
        abortSignal: AbortSignal.timeout(120_000),
      });
      return { ref: resolved.ref, text: result.text };
    },
    providers: LOCAL_KEYS,
    key: (c, provider, key) => setUpKey(provider as LocalKey, key, requestLang(c)),
    ollama: (c, url) => setUpOllama(url, requestLang(c)),
  },
});

/** A terminal that does not serve, as the person reads it. */
export function terminalRefused(err: TerminalError): ServiceError {
  switch (err.code) {
    case "gone":
      return new ServiceError("not_found", note("terminalNoLongerExists"));
    case "not_started":
      return new ServiceError("refused", note("commandNotStarted", { detail: err.detail }));
    default:
      return new ServiceError("refused", note("builtTerminalNotAvailable"));
  }
}

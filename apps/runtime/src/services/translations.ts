import { createHash } from "node:crypto";
import {
  isLang,
  LANG_CODE,
  langNameEn,
  validateWizard,
  type WizardDefinition,
  wizardLang,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { note, RUN_NOTES, type UiTexts } from "@engenty/wizards-shared/run";
import { RUNNER_TEXTS } from "@engenty/wizards-shared/runner-texts";
import type { Line, Plural, TextTable } from "@engenty/wizards-shared/texts";
import { pluralRules } from "@engenty/wizards-shared/texts";
import {
  keepsPlaceholders,
  missingTexts,
  type TranslationMemory,
  translateDefinition,
} from "@engenty/wizards-shared/translation";
import { generateText, jsonSchema, Output } from "ai";
import { and, eq } from "drizzle-orm";
import { control, controlDb, db, schema } from "../db/client.js";
import { textModel } from "../models.js";
import { prompt } from "../prompts.js";
import { currentTenant } from "../tenants/tenant.js";
import { ServiceError } from "./errors.js";

/**
 * A wizard in its viewer's language, on request (docs/plans/wizard-translation.md): one call per
 * wizard and language on the `low` class at effort low, kept and shared by every viewer;
 * the runner's own words once per language for the whole runtime. Booked to the wizard's owner
 * like any call of the tenant.
 */

/** About this many texts per call: a quarter of the runner's words come back in about 10 s. */
const CHUNK = 110;

/** Calls under way, so viewers at the same moment share one. */
const pending = new Map<string, Promise<unknown>>();

function once<T>(key: string, make: () => Promise<T>): Promise<T> {
  const running = pending.get(key) as Promise<T> | undefined;
  if (running) {
    return running;
  }
  const started = make().finally(() => pending.delete(key));
  pending.set(key, started);
  return started;
}

export function isLangCode(value: unknown): value is string {
  return typeof value === "string" && LANG_CODE.test(value);
}

function failed(): ServiceError {
  return new ServiceError("refused", note("translationFailed"));
}

/**
 * Texts into a language, one call per chunk, the chunks at once. Each answer keeps exactly the
 * placeholders of its text; one that does not is asked for again once, then the call fails.
 */
async function translate(
  texts: Record<string, string>,
  opts: { from: string; to: string; what: string; extra?: string },
): Promise<Record<string, string>> {
  const keys = Object.keys(texts);
  const chunks: string[][] = [];
  const parts = Math.max(1, Math.ceil(keys.length / CHUNK));
  const size = Math.ceil(keys.length / parts);
  for (let i = 0; i < keys.length; i += size) {
    chunks.push(keys.slice(i, i + size));
  }
  const model = await textModel("low", { effort: "low" });
  // The model sees short keys (t0, t1, …): some providers allow only letters, digits, "_", "."
  // and "-" in a schema's property names, and a text's own key may hold anything.
  const call = async (chunk: string[]): Promise<Record<string, string>> => {
    const ids = chunk.map((_, i) => `t${i}`);
    const schema = jsonSchema<Record<string, string>>({
      type: "object",
      properties: Object.fromEntries(ids.map((id) => [id, { type: "string" }])),
      required: ids,
      additionalProperties: false,
    });
    const result = await generateText({
      model: model.model,
      output: Output.object({ schema }),
      system: prompt("services", "translate.system", {
        what: opts.what,
        from: langNameEn(opts.from),
        to: langNameEn(opts.to),
        tone: prompt("services", "translate.tone", { language: langNameEn(opts.to) }),
        extra: opts.extra ? `\n${opts.extra}` : "",
      }),
      prompt: JSON.stringify(Object.fromEntries(chunk.map((k, i) => [ids[i], texts[k]])), null, 1),
    });
    return Object.fromEntries(chunk.map((k, i) => [k, result.output[ids[i]]]));
  };
  const out: Record<string, string> = {};
  const answers = await Promise.all(chunks.map(call));
  for (const answer of answers) {
    Object.assign(out, answer);
  }
  const wrong = keys.filter(
    (k) => typeof out[k] !== "string" || !keepsPlaceholders(texts[k], out[k]),
  );
  if (wrong.length) {
    const again = await call(wrong);
    for (const k of wrong) {
      if (typeof again[k] !== "string" || !keepsPlaceholders(texts[k], again[k])) {
        console.warn(`translation into ${opts.to} lost a placeholder: ${texts[k]}`);
        throw failed();
      }
      out[k] = again[k];
    }
  }
  return out;
}

// --- a wizard's texts --------------------------------------------------------------------------

export async function storedTranslation(
  wizardId: string,
  lang: string,
): Promise<TranslationMemory | null> {
  const row = await db.query.wizardTranslation.findFirst({
    where: and(
      eq(schema.wizardTranslation.wizardId, wizardId),
      eq(schema.wizardTranslation.lang, lang),
    ),
  });
  return row?.texts ?? null;
}

/** The version of a wizard viewers see, or null before it is published. */
export async function publishedDefinition(w: {
  id: string;
  publishedVersion: number | null;
}): Promise<WizardDefinition | null> {
  if (w.publishedVersion === null) {
    return null;
  }
  const version = await db.query.wizardVersion.findFirst({
    where: and(
      eq(schema.wizardVersion.wizardId, w.id),
      eq(schema.wizardVersion.version, w.publishedVersion),
    ),
  });
  return version?.definition ?? null;
}

/** The languages a wizard is kept in, for its author. */
export async function translationsOf(wizardId: string) {
  return db.query.wizardTranslation.findMany({
    where: eq(schema.wizardTranslation.wizardId, wizardId),
    columns: { lang: true, texts: true, version: true, updatedAt: true },
  });
}

async function keep(wizardId: string, lang: string, texts: TranslationMemory, version?: number) {
  await db
    .insert(schema.wizardTranslation)
    .values({ wizardId, lang, texts, version: version ?? null })
    .onConflictDoUpdate({
      target: [schema.wizardTranslation.wizardId, schema.wizardTranslation.lang],
      set: { texts, ...(version === undefined ? {} : { version }), updatedAt: new Date() },
    });
}

/**
 * Whether the definition written in a translation still passes what its original passes: the
 * schema, and no validator issue the original does not have.
 */
function stillValid(def: WizardDefinition, translated: WizardDefinition): boolean {
  if (!wizardSchema.safeParse(translated).success) {
    return false;
  }
  const before = new Set(validateWizard(def).map((i) => `${i.stepId}:${i.message}`));
  return validateWizard(translated).every((i) => before.has(`${i.stepId}:${i.message}`));
}

/**
 * A wizard's translation into a language with every text of `def` in it: what is kept, and
 * what it lacks translated now and kept for every later viewer.
 */
export function translationFor(
  wizardId: string,
  def: WizardDefinition,
  lang: string,
  version?: number | null,
): Promise<TranslationMemory> {
  return once(`${currentTenant()}:${wizardId}:${lang}`, async () => {
    const memory = (await storedTranslation(wizardId, lang)) ?? {};
    const missing = missingTexts(def, memory);
    if (!missing.length) {
      return memory;
    }
    const keys = Object.fromEntries(missing.map((text, i) => [`t${i}`, text]));
    let answer: Record<string, string>;
    try {
      answer = await translate(keys, {
        from: wizardLang(def),
        to: lang,
        what: prompt("services", "translate.wizard"),
      });
    } catch (err) {
      if (err instanceof ServiceError) {
        throw err;
      }
      console.warn(`translating wizard ${wizardId} into ${lang} failed: ${(err as Error).message}`);
      throw failed();
    }
    const next: TranslationMemory = { ...memory };
    for (const [key, text] of Object.entries(keys)) {
      next[text] = { text: answer[key], by: "machine" };
    }
    if (!stillValid(def, translateDefinition(def, next).def)) {
      throw failed();
    }
    await keep(wizardId, lang, next, version ?? undefined);
    return next;
  });
}

/** The author's own lines: they replace what is kept and are marked theirs. */
export async function editTranslation(
  wizardId: string,
  def: WizardDefinition,
  lang: string,
  lines: Record<string, string>,
) {
  const memory = (await storedTranslation(wizardId, lang)) ?? {};
  for (const [original, text] of Object.entries(lines)) {
    if (!keepsPlaceholders(original, text)) {
      throw new ServiceError("invalid", note("translationPlaceholder", { text: original }));
    }
    memory[original] = { text, by: "author" };
  }
  if (!stillValid(def, translateDefinition(def, memory).def)) {
    throw failed();
  }
  await keep(wizardId, lang, memory);
}

export async function deleteTranslation(wizardId: string, lang: string) {
  await db
    .delete(schema.wizardTranslation)
    .where(
      and(eq(schema.wizardTranslation.wizardId, wizardId), eq(schema.wizardTranslation.lang, lang)),
    );
}

/** A finished result's text in another language, for the run that asks. */
export async function translateResult(text: string, lang: string, from: string): Promise<string> {
  const answer = await translate(
    { result: text },
    {
      from,
      to: lang,
      what: prompt("services", "translate.result"),
      extra: prompt("services", "translate.result.extra"),
    },
  );
  return answer.result;
}

// --- the runner's own words --------------------------------------------------------------------

/** The English lines the runner's words in another language are made from. */
function sources(): { runner: Record<string, Line>; notes: Record<string, Line> } {
  return { runner: RUNNER_TEXTS.en, notes: RUN_NOTES.en };
}

const SOURCE = createHash("sha256").update(JSON.stringify(sources())).digest("hex").slice(0, 16);

/** A table as single texts: a plural line once per plural category of the language. */
function flatten(lines: Record<string, Line>, cats: string[]): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, line] of Object.entries(lines)) {
    if (typeof line === "string") {
      flat[key] = line;
    } else {
      for (const cat of cats) {
        flat[`${key}#${cat}`] = line[cat as keyof Plural] ?? line.other;
      }
    }
  }
  return flat;
}

function unflatten(flat: Record<string, string>, lines: Record<string, Line>): TextTable {
  const table: TextTable = {};
  for (const [key, line] of Object.entries(lines)) {
    if (typeof line === "string") {
      table[key] = flat[key];
    } else {
      const plural: Plural = { other: flat[`${key}#other`] ?? line.other };
      for (const [k, text] of Object.entries(flat)) {
        if (k.startsWith(`${key}#`)) {
          plural[k.slice(key.length + 1) as keyof Plural] = text;
        }
      }
      table[key] = plural;
    }
  }
  return table;
}

/**
 * The runner's words in a language outside `LANGS`: kept for the runtime, made when a viewer
 * first asks and again when the English tables changed.
 */
export function uiTexts(lang: string): Promise<UiTexts> {
  if (isLang(lang)) {
    throw new ServiceError("invalid", note("translationFailed"));
  }
  return once(`ui:${lang}`, async () => {
    const row = await controlDb.query.uiTranslation.findFirst({
      where: eq(control.uiTranslation.lang, lang),
    });
    if (row && row.source === SOURCE) {
      return { lang, ...row.texts };
    }
    const cats = pluralRules(lang).resolvedOptions().pluralCategories as string[];
    const src = sources();
    const flat = { ...flatten(src.runner, cats) };
    const notes = flatten(src.notes, cats);
    for (const [k, v] of Object.entries(notes)) {
      flat[`note:${k}`] = v;
    }
    let answer: Record<string, string>;
    try {
      answer = await translate(flat, {
        from: "en",
        to: lang,
        what: prompt("services", "translate.runner"),
        extra: prompt("services", "translate.runner.extra", {
          categories: cats.join(", #"),
          language: langNameEn(lang),
        }),
      });
    } catch (err) {
      if (err instanceof ServiceError) {
        throw err;
      }
      console.warn(`translating the runner into ${lang} failed: ${(err as Error).message}`);
      throw failed();
    }
    const runnerFlat: Record<string, string> = {};
    const notesFlat: Record<string, string> = {};
    for (const [k, v] of Object.entries(answer)) {
      if (k.startsWith("note:")) {
        notesFlat[k.slice(5)] = v;
      } else {
        runnerFlat[k] = v;
      }
    }
    const texts = {
      runner: unflatten(runnerFlat, src.runner),
      notes: unflatten(notesFlat, src.notes),
    };
    await controlDb
      .insert(control.uiTranslation)
      .values({ lang, source: SOURCE, texts })
      .onConflictDoUpdate({
        target: control.uiTranslation.lang,
        set: { source: SOURCE, texts, createdAt: new Date() },
      });
    return { lang, ...texts };
  });
}

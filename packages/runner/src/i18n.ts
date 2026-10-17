import type { Lang } from "@engenty-wizards/shared/definition";
import { noteText, type RunNote } from "@engenty-wizards/shared/run";
import { RUNNER_TEXTS, type RunnerKey } from "@engenty-wizards/shared/runner-texts";
import { lineText, type TextTable, textOf } from "@engenty-wizards/shared/texts";
import { useSyncExternalStore } from "react";

export type { Lang };
/**
 * What the runner says to the person running a wizard: its table lives in shared/runner-texts,
 * where the runtime reads it too (a language outside `LANGS` is translated from its English).
 */
export { RUNNER_TEXTS, type RunnerKey };

/** The language the runner speaks: set by the host (`configureRunner`, `setRunnerLang`). */
export let lang: Lang = "en";

/**
 * A language outside `LANGS`, translated on request (`GET /api/public/texts/:lang`): its lines
 * win over `lang`'s, and what it lacks is said in English. Null: the runner speaks `lang`.
 */
export interface RunnerTable {
  lang: string;
  runner: TextTable;
  notes: TextTable;
}
let table: RunnerTable | null = null;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function setRunnerLang(next: Lang) {
  if (next === lang) {
    return;
  }
  lang = next;
  changed();
}

/** Speaks a translated language from its table, or `lang` again with null. */
export function setRunnerTable(next: RunnerTable | null) {
  if (next === table) {
    return;
  }
  table = next;
  changed();
}

/** The translated table in effect, for a host that shows the runner's words itself. */
export function runnerTable(): RunnerTable | null {
  return table;
}

/** The language the person reads, by its code: the translated one, else `lang`. */
export function runnerLangCode(): string {
  return table?.lang ?? lang;
}

/** The language, for a component that must render again when it changes. */
export function useRunnerLang(): string {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return runnerLangCode();
}

/** What a run reports, in the language the person reads: its note where it has one. */
export function eventText(ev: { message: string; note?: RunNote | null }): string {
  return (ev.note && noteText(ev.note, runnerLangCode(), table?.notes)) || ev.message;
}

/**
 * What the choices of a translated wizard show, by value (`RunView.translation.labels`): the
 * answer keeps the value, the person reads the label.
 */
let labels: Record<string, string> = {};

export function setChoiceLabels(next: Record<string, string> | null | undefined) {
  labels = next ?? {};
}

/** What a choice shows: its translated label, else its value. */
export function choiceLabel(value: string): string {
  return labels[value] ?? value;
}

/** A string in the runner's language: its plural form by `{count}` or `{n}`, its gaps filled. */
export function t(key: RunnerKey, vars?: Record<string, string | number>): string {
  const own = table?.runner[key];
  if (table && own !== undefined) {
    return lineText(own, table.lang, vars);
  }
  return textOf(RUNNER_TEXTS, key, table ? "en" : lang, vars);
}

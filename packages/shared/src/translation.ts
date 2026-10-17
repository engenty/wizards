// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import type { Field, WizardDefinition } from "./definition.js";

/**
 * A wizard translated for its viewer, on request: what the person reads is written in their
 * language, what the wizard runs on stays as the author wrote it. Never translated: ids,
 * branches and their statements, the instructions of AI steps, `{{…}}` placeholders, and the
 * values of choices — a choice shows a translated label and keeps its value.
 */

/** Fields whose `options` are choices the person reads (a slot's are dates, written by the runner). */
function choiceField(field: Field): boolean {
  return field.kind === "select" || field.kind === "multiselect";
}

type Visit = (text: string | undefined, write: (next: string) => void) => void;

/** Every text of a definition the person reads, with the way to write it back. */
function visitTexts(def: WizardDefinition, visit: Visit, choices: Visit) {
  visit(def.title, (t) => {
    def.title = t;
  });
  visit(def.description, (t) => {
    def.description = t;
  });
  visit(def.intro, (t) => {
    def.intro = t;
  });
  for (const list of def.lists ?? []) {
    visit(list.title, (t) => {
      list.title = t;
    });
    visit(list.description, (t) => {
      list.description = t;
    });
    for (const column of list.columns ?? []) {
      visit(column.name, (t) => {
        column.name = t;
      });
      const options = (
        "format" in column
          ? (column.format as { options?: { label?: string }[] } | undefined)
          : undefined
      )?.options;
      for (const option of options ?? []) {
        visit(option.label, (t) => {
          option.label = t;
        });
      }
    }
  }
  for (const connection of def.connections ?? []) {
    visit(connection.title, (t) => {
      connection.title = t;
    });
    visit(connection.description, (t) => {
      connection.description = t;
    });
  }
  for (const step of def.steps) {
    visit(step.title, (t) => {
      step.title = t;
    });
    visit(step.description, (t) => {
      step.description = t;
    });
    if ("working" in step) {
      visit(step.working, (t) => {
        step.working = t;
      });
    }
    // What an AI step's output fields hold: the headings a review and the result show them under.
    if (step.type === "agent") {
      for (const field of step.output?.fields ?? []) {
        visit(field.description, (t) => {
          field.description = t;
        });
      }
    }
    if (step.type === "page") {
      visit(step.cta, (t) => {
        step.cta = t;
      });
      for (const field of step.fields) {
        visit(field.label, (t) => {
          field.label = t;
        });
        visit(field.help, (t) => {
          field.help = t;
        });
        visit(field.placeholder, (t) => {
          field.placeholder = t;
        });
        for (const column of field.columns ?? []) {
          visit(column.label, (t) => {
            column.label = t;
          });
        }
        if (choiceField(field)) {
          for (const option of field.options ?? []) {
            choices(option, () => undefined);
          }
        }
      }
    }
    if (step.type === "result") {
      visit(step.message, (t) => {
        step.message = t;
      });
      for (const deliverable of step.deliverables) {
        visit(deliverable.label, (t) => {
          deliverable.label = t;
        });
      }
    }
  }
}

/** The texts of a definition the person reads, each once, in the order they appear. */
export function wizardTexts(def: WizardDefinition): string[] {
  const seen = new Set<string>();
  const add: Visit = (text) => {
    if (text?.trim()) {
      seen.add(text);
    }
  };
  visitTexts(structuredClone(def), add, add);
  return [...seen];
}

/** `{{…}}` placeholders and `{name}` gaps: what a translation keeps exactly. */
const KEPT = /\{\{[^}]*\}\}|\{\w+\}/g;

/** Whether a translated text keeps every placeholder and gap of its original, no more, no fewer. */
export function keepsPlaceholders(original: string, translated: string): boolean {
  const of = (text: string) => (text.match(KEPT) ?? []).sort().join("\u0000");
  return of(original) === of(translated);
}

/** A translation as it is kept: each original text with its translation and who wrote it. */
export interface TranslationEntry {
  text: string;
  by: "machine" | "author";
}

export type TranslationMemory = Record<string, TranslationEntry>;

/** The texts of a definition a translation does not have yet. */
export function missingTexts(def: WizardDefinition, memory: TranslationMemory): string[] {
  return wizardTexts(def).filter((text) => !memory[text]);
}

/**
 * The definition in the viewer's language: a copy with every text the memory has written in,
 * and the labels of the choices beside it (`labels[value]`), the values untouched.
 */
export function translateDefinition(
  def: WizardDefinition,
  memory: TranslationMemory,
): { def: WizardDefinition; labels: Record<string, string> } {
  const copy = structuredClone(def);
  const labels: Record<string, string> = {};
  visitTexts(
    copy,
    (text, write) => {
      const entry = text ? memory[text] : undefined;
      if (entry) {
        write(entry.text);
      }
    },
    (value) => {
      const entry = value ? memory[value] : undefined;
      if (value && entry) {
        labels[value] = entry.text;
      }
    },
  );
  return { def: copy, labels };
}

/** Whether every text of the memory came from the author, or some from a model. */
export function machineTranslated(memory: TranslationMemory, def: WizardDefinition): boolean {
  return wizardTexts(def).some((text) => memory[text]?.by !== "author");
}

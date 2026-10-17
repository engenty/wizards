import type { Lang } from "@engenty-wizards/shared/definition";
import { noteText, type RunNote } from "@engenty-wizards/shared/run";
import type { Gap } from "@engenty-wizards/shared/texts";
import { type ServerKey, serverText } from "./texts.js";

/** A line of the server's own table (`texts.ts`) a failure says, in the asker's language. */
export interface ServerLine {
  server: ServerKey;
  params?: Record<string, Gap | undefined>;
}

/**
 * A failure the person reads, given as a note of `RUN_NOTES` or a line of the server's table
 * where it has one: a run shows it in the wizard's language, a response in the asker's, and the
 * message keeps the English line for the log. Free text has neither.
 */
export class NotedError extends Error {
  readonly note: RunNote | null;
  readonly line: ServerLine | null;

  constructor(said: string | RunNote | ServerLine) {
    super(
      typeof said === "string"
        ? said
        : "server" in said
          ? serverText("en", said.server, said.params)
          : noteText(said, "en"),
    );
    this.note = typeof said === "string" || "server" in said ? null : said;
    this.line = typeof said !== "string" && "server" in said ? said : null;
  }
}

/** A class has nothing to run on: no key, no account, no installed client — the person can fix it in the settings. */
export class ModelUnavailableError extends NotedError {}

/** The note a failure carries, or null. */
export function noteOf(err: unknown): RunNote | null {
  return err instanceof NotedError ? err.note : null;
}

/** What a failure says, to pass on: its note where it has one, else its message. */
export function saidOf(err: unknown): string | RunNote {
  return noteOf(err) ?? (err as Error)?.message ?? String(err);
}

/** A failure in a language: its note or server line where it has one, else its message as it is. */
export function errorText(err: unknown, lang: Lang): string {
  const note = noteOf(err);
  if (note) {
    return noteText(note, lang);
  }
  if (err instanceof NotedError && err.line) {
    return serverText(lang, err.line.server, err.line.params);
  }
  return (err as Error)?.message ?? String(err);
}

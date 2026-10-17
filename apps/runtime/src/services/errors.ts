import type { Lang } from "@engenty-wizards/shared/definition";
import { note, type RunNote } from "@engenty-wizards/shared/run";
import { errorText, NotedError, type ServerLine } from "../model-errors.js";

/** What a service call can refuse. The studio routes answer it as HTTP, the MCP tools as a tool error. */
export type ServiceErrorCode =
  | "not_found"
  | "invalid"
  | "has_issues"
  | "revision_conflict"
  | "no_credits"
  | "refused"
  /** Nothing is changed here: the project is a local install's, or the tenant builds elsewhere. */
  | "read_only"
  /** The person's role in the team does not allow it: a member edits wizards, an admin makes and deletes. */
  | "forbidden";

const STATUS: Record<ServiceErrorCode, 400 | 402 | 403 | 404 | 409> = {
  not_found: 404,
  invalid: 400,
  has_issues: 400,
  revision_conflict: 409,
  no_credits: 402,
  refused: 400,
  read_only: 403,
  forbidden: 403,
};

export class ServiceError extends NotedError {
  constructor(
    readonly code: ServiceErrorCode,
    said: string | RunNote | ServerLine,
    readonly data: Record<string, unknown> = {},
  ) {
    super(said);
  }

  get status() {
    return STATUS[this.code];
  }

  /** The answer, its words in the asker's language; English where none is known. */
  toJSON(lang: Lang = "en") {
    return { error: errorText(this, lang), code: this.code, ...this.data };
  }
}

export const notFound = () => new ServiceError("not_found", note("notFound"));

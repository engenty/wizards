import type { ActionClassification, NormalizedAction } from "../types.js";

/**
 * Map an HTTP method (plus path hints) onto the connections-framework action
 * groups. Groups drive default policy (read→allow, write/destructive→ask) and
 * the approval contract, so lean conservative: anything ambiguous is `write`,
 * clearly irreversible verbs are `destructive`.
 */
const DESTRUCTIVE_PATH_HINT =
  /\b(delete|remove|destroy|purge|revoke|cancel|terminate)\b/iu;

export function classifyHttpOperation(
  method: string,
  pathTemplate: string
): ActionClassification {
  const m = method.toLowerCase();
  if (m === "get" || m === "head" || m === "options") {
    return "read";
  }
  if (m === "delete") {
    return "destructive";
  }
  if (DESTRUCTIVE_PATH_HINT.test(pathTemplate)) {
    return "destructive";
  }
  return "write";
}

/**
 * MCP tool annotations → classification. `readOnlyHint` is trusted for reads;
 * `destructiveHint` for destructive; everything else defaults to `write`
 * (server-provided hints are advisory, so no hint never yields `read`).
 */
export function classifyMcpTool(annotations: {
  destructiveHint?: boolean;
  readOnlyHint?: boolean;
}): ActionClassification {
  if (annotations.readOnlyHint === true) {
    return "read";
  }
  if (annotations.destructiveHint === true) {
    return "destructive";
  }
  return "write";
}

/** Words that say an action sends something to other people. */
const SEND_WORDS = new Set([
  "send",
  "sends",
  "mail",
  "mails",
  "email",
  "emails",
  "message",
  "messages",
  "post",
  "posts",
  "notify",
  "notification",
  "notifications",
  "reply",
  "forward",
  "sms",
]);

/** Words that say it does not: a draft is kept, an edit or a delete is its own kind. */
const NOT_SEND_WORDS = new Set([
  "draft",
  "drafts",
  "update",
  "edit",
  "delete",
  "remove",
  "destroy",
  "purge",
  "revoke",
  "trash",
  "archive",
  "settings",
]);

/** The words of an id or summary: `sendEmail`, `send_email`, "Send an e-mail" alike. */
function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/e-mail/giu, "email")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/**
 * The group an imported action runs under. Neither an OpenAPI spec nor an MCP server says that
 * an action sends something, so until the registry carries a group this is a guess by name: an
 * action that is no read, whose id or summary says send, mail, message, post or notify (and not
 * draft, update or delete), is a `send`. The HTTP method an OpenAPI action's id or summary
 * starts with (`post_users`, "POST /users") is no word of the action's. Everything else keeps
 * its classification.
 */
export function groupOf(
  action: Pick<NormalizedAction, "classification" | "id" | "summary" | "invoke">
): ActionClassification {
  if (action.classification === "read" || action.classification === "send") {
    return action.classification;
  }
  const id = wordsOf(action.id);
  const summary = wordsOf(action.summary);
  if (action.invoke.kind === "http") {
    const method = action.invoke.method.toLowerCase();
    if (id[0] === method) {
      id.shift();
    }
    if (summary[0] === method) {
      summary.shift();
    }
  }
  const words = [...id, ...summary];
  if (words.some((w) => NOT_SEND_WORDS.has(w))) {
    return action.classification;
  }
  return words.some((w) => SEND_WORDS.has(w)) ? "send" : action.classification;
}

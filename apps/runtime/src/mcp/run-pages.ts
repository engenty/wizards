import { createHmac } from "node:crypto";
import {
  type CallToolResult,
  createRequestStateCodec,
  type InputRequest,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { env } from "../env.js";
import { ServiceError } from "../services/errors.js";
import {
  answerRunAsk,
  answerRunForm,
  answerRunQuestion,
  type RunReport,
  reviewRun,
  runReport,
} from "../services/runs.js";
import type { Principal } from "./auth.js";

/**
 * A run's pages as questions the app asks the person itself (MCP elicitation, protocol
 * 2026-07-28, multi-round-trip): when the client says it shows forms, a run tool that leaves the
 * run waiting answers `inputRequired` with the page, and the client calls the same tool again
 * with the person's answer. The answer goes into the run here, past the model, and the call goes
 * on to the next page or the run's report. Clients without it get `waitingFor` and answer with
 * the run tools, as before.
 */

/** Where a run was when its page went to the person. Sealed: it comes back through the client. */
export interface PageState {
  runId: string;
  kind: "form" | "review" | "ask" | "question" | "page";
  /** The form's or review's step, the ask's id. */
  id: string;
}

const PAGE = "page";
/** How long an answered page waits for the run to reach its next page. */
const AFTER_ANSWER_SECONDS = 20;
/** A page waits this long for the person; the run itself waits on. */
const PAGE_TTL_SECONDS = 60 * 60;
/** As many fields as a form question may have before the run page takes over. */
const MAX_FIELDS = 12;

const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

const codec = createRequestStateCodec<PageState>({
  key: createHmac("sha256", env.authSecret).update("mcp.run-pages").digest(),
  ttlSeconds: PAGE_TTL_SECONDS,
  // A page's state is the person's own: it does not work for another token's person.
  bind: (ctx) => {
    const who = ctx.http?.authInfo?.extra as Partial<Principal> | undefined;
    return `${who?.tenantId ?? ""}\n${who?.userId ?? ""}`;
  },
});

/** For the server's options: checks a page's state when it comes back. */
export const requestStateVerify = codec.verify;

/** The client shows forms the server asks for, on this request. */
export function asksPages(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = envelope?.[CLIENT_CAPABILITIES] as { elicitation?: { form?: unknown } } | undefined;
  const elicitation = caps?.elicitation;
  // An empty `elicitation` capability means forms (the url mode is declared on its own).
  return Boolean(elicitation && (elicitation.form || Object.keys(elicitation).length === 0));
}

type Field = {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  options?: string[];
  help?: string;
  inChat: boolean;
  when?: unknown;
  times?: { value: string; label: string }[];
};

type Waiting = {
  form?: string;
  title?: string;
  fields?: Field[];
  review?: string;
  approve?: boolean;
  ask?: string;
  kind?: string;
  service?: string;
  action?: string;
  input?: string;
  reason?: string;
  question?: string;
};

/** A form field as an elicitation property, or nothing when only the run page can ask it. */
function propertyOf(field: Field): Record<string, unknown> | null {
  const base = { title: field.label, ...(field.help ? { description: field.help } : {}) };
  switch (field.kind) {
    case "text":
    case "textarea":
      return { type: "string", ...base };
    case "email":
      return { type: "string", format: "email", ...base };
    case "url":
      return { type: "string", format: "uri", ...base };
    case "date":
      return { type: "string", format: "date", ...base };
    case "number":
      return { type: "number", ...base };
    case "toggle":
      return { type: "boolean", ...base };
    case "select":
      return field.options?.length ? { type: "string", enum: field.options, ...base } : null;
    case "slot":
      return field.times?.length
        ? {
            type: "string",
            oneOf: field.times.map((t) => ({ const: t.value, title: t.label })),
            ...base,
          }
        : null;
    case "multiselect":
      return field.options?.length
        ? { type: "array", items: { type: "string", enum: field.options }, ...base }
        : null;
    default:
      return null;
  }
}

/** The run page in the person's browser, for what a form question cannot ask. */
function onThePage(report: RunReport, title: string): InputRequest | null {
  return report.browserUrl
    ? inputRequired.elicitUrl({ message: title, url: report.browserUrl })
    : null;
}

/** What the person is asked for the page the run waits on; nothing when it waits on no one. */
export function pageOf(report: RunReport): { state: PageState; request: InputRequest } | null {
  const w = (report as { waitingFor?: Waiting }).waitingFor;
  if (!w) {
    return null;
  }
  const runId = report.runId;
  if (w.question) {
    return {
      state: { runId, kind: "question", id: report.step?.id ?? "" },
      request: inputRequired.elicit({
        message: w.question,
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string", title: w.title ?? "Answer" } },
          required: ["answer"],
        },
      }),
    };
  }
  if (w.ask && w.kind === "confirm") {
    const what = [w.reason, w.service && w.action ? `${w.service}: ${w.action}` : "", w.input]
      .filter(Boolean)
      .join("\n\n");
    return {
      state: { runId, kind: "ask", id: w.ask },
      request: inputRequired.elicit({
        message: what,
        requestedSchema: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              title: "Allow this?",
              oneOf: [
                { const: "allow", title: "Allow" },
                { const: "skip", title: "Skip" },
              ],
            },
          },
          required: ["answer"],
        },
      }),
    };
  }
  if (w.ask) {
    const request = onThePage(report, w.reason ?? w.title ?? report.step?.title ?? "");
    return request ? { state: { runId, kind: "page", id: w.ask }, request } : null;
  }
  if (w.review) {
    const outputs = report.outputs
      .map((o) => (o.text ? `${o.title}\n${o.text}` : o.title))
      .join("\n\n");
    return {
      state: { runId, kind: "review", id: w.review },
      request: inputRequired.elicit({
        message: [w.title, outputs].filter(Boolean).join("\n\n"),
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              title: w.title ?? "Review",
              oneOf: [
                { const: "accept", title: "Accept" },
                ...(w.approve ? [{ const: "decline", title: "Decline" }] : []),
              ],
            },
            note: { type: "string", title: "Note" },
          },
          required: ["decision"],
        },
      }),
    };
  }
  if (w.form && w.fields) {
    const title = w.title ?? report.step?.title ?? "";
    const fields = w.fields;
    const properties = fields.map((f) => [f.id, f.inChat && !f.when ? propertyOf(f) : null]);
    // A page with a field only the run page asks, or fields that depend on each other, goes
    // whole to the run page.
    if (fields.length > MAX_FIELDS || properties.some(([, p]) => p === null)) {
      const request = onThePage(report, title);
      return request ? { state: { runId, kind: "page", id: w.form }, request } : null;
    }
    return {
      state: { runId, kind: "form", id: w.form },
      request: inputRequired.elicit({
        message: title,
        requestedSchema: {
          type: "object",
          properties: Object.fromEntries(properties) as never,
          required: fields.filter((f) => f.required).map((f) => f.id),
        },
      }),
    };
  }
  return null;
}

/** Puts the person's answer into the run. Answered elsewhere meanwhile: nothing to do. */
export async function answerPage(
  userId: string,
  state: PageState,
  content: Record<string, unknown>,
): Promise<void> {
  try {
    if (state.kind === "form") {
      await answerRunForm(userId, state.runId, state.id, content);
    } else if (state.kind === "question") {
      await answerRunQuestion(userId, state.runId, String(content.answer ?? ""));
    } else if (state.kind === "ask") {
      await answerRunAsk(
        userId,
        state.runId,
        state.id,
        content.answer === "allow" ? "allow" : "skip",
      );
    } else if (state.kind === "review") {
      const note = typeof content.note === "string" && content.note ? content.note : undefined;
      await reviewRun(
        userId,
        state.runId,
        state.id,
        content.decision === "decline" ? { type: "decline", note } : { type: "accept", note },
      );
    }
  } catch (err) {
    const now = await runReport(userId, state.runId);
    const still = pageOf(now)?.state;
    // The page was answered on the run page or in the widget: the run went on without this.
    if (!(err instanceof ServiceError) || (still?.kind === state.kind && still.id === state.id)) {
      throw err;
    }
  }
}

/** What a run tool's own work came to: the run's report, or the tool's failed answer. */
export type Started = RunReport | { failed: CallToolResult };

/**
 * Runs a run tool with its pages asked of the person. `start` is what the tool does on its first
 * call (start the run, answer a page) and gives the run's report; `finish` turns the report into
 * the tool's answer once the run waits on no one the client can ask.
 */
export async function withPages(
  ctx: ServerContext,
  who: Principal,
  start: () => Promise<Started>,
  finish: (report: RunReport) => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult | InputRequiredResult> {
  if (!asksPages(ctx)) {
    const first = await start();
    return "failed" in first ? first.failed : finish(first);
  }
  const state = ctx.mcpReq.requestState<PageState>();
  let report: RunReport;
  if (state) {
    const answer = inputResponse(ctx.mcpReq.inputResponses, PAGE);
    if (answer.kind === "elicit" && answer.action !== "accept") {
      // The person put the page off or said no: the run waits, the client hears it.
      const now = await runReport(who.userId, state.runId);
      return finish({ ...now, unanswered: true } as RunReport);
    }
    if (answer.kind === "elicit" && state.kind !== "page") {
      await answerPage(who.userId, state, answer.content ?? {});
    }
    report = await runReport(who.userId, state.runId, AFTER_ANSWER_SECONDS);
  } else {
    const first = await start();
    if ("failed" in first) {
      return first.failed;
    }
    report = first;
  }
  const page = pageOf(report);
  if (!page) {
    return finish(report);
  }
  return inputRequired({
    inputRequests: { [PAGE]: page.request },
    requestState: await codec.mint(page.state, ctx),
  });
}

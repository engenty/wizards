import { createHash } from "node:crypto";
import { z } from "zod";
import { callOutside } from "../elements/outside.js";
import { ELEMENT_SPECS } from "../elements/specs.js";
import { controlRun, type RunReport, runReport } from "../services/runs.js";
import type { Principal } from "./auth.js";
import { answer, withFlow } from "./elements.js";
import { answerPage, pageOf } from "./run-pages.js";

/**
 * Long runs as MCP tasks (the Tasks extension, SEP-2663, protocol 2026-07-28; experimental).
 * A client that declares `io.modelcontextprotocol/tasks` gets `wizard_run` back as a task at
 * once: the task is the run itself (its id is the run's), so nothing is kept for it beside the
 * run, and a runtime that restarts keeps every task. The client asks `tasks/get` how it stands;
 * a page the run waits on is the task's `input_required` with the page as an elicitation
 * (mcp/run-pages.ts), the answer comes with `tasks/update`; `tasks/cancel` cancels the run.
 *
 * The MCP SDK has no runtime for the extension, so these requests are answered here, in front
 * of it (mcp/handler.ts), after the token was checked. Everything else goes to the SDK.
 */

const EXTENSION = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const POLL_MS = 3000;

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

const taskParams = z.object({ taskId: z.string().min(1) });
const updateParams = taskParams.extend({
  inputResponses: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

function reply(id: Rpc["id"], result: Record<string, unknown>): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function refuse(id: Rpc["id"], code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** The client said, on this request, that it follows tasks. */
function followsTasks(rpc: Rpc): boolean {
  const caps = rpc.params?._meta?.[CLIENT_CAPABILITIES] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  return Boolean(caps?.extensions?.[EXTENSION]);
}

/**
 * The key of the page a run waits on. The extension wants a key unique over the task's life: a
 * client keeps the answers by it, so a later page under the same key would count as answered.
 * The key names the page and what it holds now, so the same page again (after going back) is
 * a new key.
 */
function pageKey(report: RunReport, page: { state: { kind: string; id: string } }): string {
  const fields = (report as { waitingFor?: { fields?: { id: string; value?: unknown }[] } })
    .waitingFor?.fields;
  const values = JSON.stringify((fields ?? []).map((f) => [f.id, f.value ?? null]));
  const digest = createHash("sha256").update(values).digest("base64url").slice(0, 12);
  return `${page.state.kind}-${page.state.id}-${(report.passed ?? []).length}-${digest}`;
}

/** The run as a task: how it stands, what it asks, what it came to. */
async function taskOf(who: Principal, report: RunReport): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const base = {
    taskId: report.runId,
    createdAt: now,
    lastUpdatedAt: now,
    // A run lives as long as the space keeps it.
    ttlMs: null,
    pollIntervalMs: POLL_MS,
  };
  const status = report.status as string;
  if (status === "done") {
    const result = await withFlow(who.userId, answer({ ok: true, result: report }), report);
    return { ...base, status: "completed", result };
  }
  if (status === "failed") {
    return {
      ...base,
      status: "failed",
      error: { code: -32603, message: String(report.error ?? "The run failed.") },
    };
  }
  if (status === "cancelled") {
    return { ...base, status: "cancelled" };
  }
  const page = pageOf(report);
  if (page) {
    return {
      ...base,
      status: "input_required",
      statusMessage: report.step?.title,
      inputRequests: { [pageKey(report, page)]: page.request },
    };
  }
  return { ...base, status: "working", statusMessage: report.step?.title };
}

/**
 * Answers a request of the Tasks extension, or `wizard_run` called as a task; nothing for every
 * other request. Runs in the token's tenant and role.
 */
export async function runTaskRequest(who: Principal, body: unknown): Promise<Response | null> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const rpc = body as Rpc;
  const method = rpc.method;
  const mayRun = who.scopes.includes("elements:run") || who.scopes.includes("runs:test");
  if (method === "tools/call" && rpc.params?.name === "wizard_run" && followsTasks(rpc)) {
    if (!mayRun) {
      return null;
    }
    const input = ELEMENT_SPECS.wizard_run.input
      .extend({ spaceId: z.string().optional() })
      .safeParse(rpc.params.arguments ?? {});
    if (!input.success) {
      return refuse(rpc.id, -32602, "Invalid arguments for wizard_run.");
    }
    const { spaceId, ...args } = input.data;
    const started = await callOutside(
      {
        userId: who.userId,
        role: who.role,
        client: who.client,
        tenantId: who.tenantId,
        scopes: who.scopes,
      },
      spaceId,
      "wizard_run",
      { ...args, waitSeconds: 0 },
      AbortSignal.timeout(60_000),
    );
    if (!started.ok) {
      // A run that never started is no task: the call fails as it would without one.
      return reply(rpc.id, { resultType: "complete", ...answer(started) });
    }
    const task = await taskOf(who, started.result as RunReport);
    const { result: _result, inputRequests: _asks, ...handle } = task;
    return reply(rpc.id, { resultType: "task", ...handle });
  }
  if (method !== "tasks/get" && method !== "tasks/update" && method !== "tasks/cancel") {
    return null;
  }
  if (!mayRun) {
    return refuse(rpc.id, -32602, "Unknown task.");
  }
  const parsed = updateParams.safeParse(rpc.params ?? {});
  if (!parsed.success) {
    return refuse(rpc.id, -32602, "Invalid task request.");
  }
  const { taskId, inputResponses } = parsed.data;
  // Another person's run, or none: the same answer, so a task's existence stays unknown.
  const report = await runReport(who.userId, taskId).catch(() => null);
  if (!report) {
    return refuse(rpc.id, -32602, "Unknown task.");
  }
  if (method === "tasks/cancel") {
    await controlRun(who.userId, taskId, "cancel").catch(() => undefined);
    return reply(rpc.id, {
      resultType: "complete",
      ...(await taskOf(who, await runReport(who.userId, taskId))),
    });
  }
  if (method === "tasks/update") {
    const page = pageOf(report);
    // The answer to the page the run waits on now; one to an earlier page finds it answered.
    const response = (page ? inputResponses?.[pageKey(report, page)] : undefined) as
      | { action?: string; content?: Record<string, unknown> }
      | undefined;
    if (page && response?.action === "accept" && page.state.kind !== "page") {
      await answerPage(who.userId, page.state, response.content ?? {});
    }
    return reply(rpc.id, { resultType: "complete" });
  }
  return reply(rpc.id, { resultType: "complete", ...(await taskOf(who, report)) });
}

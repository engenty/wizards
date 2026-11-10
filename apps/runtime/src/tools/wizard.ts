import { quickJs, WIZARD_CODE_MEMORY_MB } from "@engenty/wizards-engine/quickjs";
import { StepError } from "@engenty/wizards-engine/types";
import type { AgentStep } from "@engenty/wizards-shared/definition";
import type { AssetRef } from "@engenty/wizards-shared/run";
import { note } from "@engenty/wizards-shared/run";
import type { UploadRef } from "@engenty/wizards-shared/run-services";
import {
  sandboxToolHostsMissing,
  wizardCodeOf,
  wizardToolCallName,
} from "@engenty/wizards-shared/wizard-code";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { keepsOwnRows } from "../broker/effect.js";
import { brokerHost, whereOf } from "../broker/index.js";
import { summarizeInput, writeLog } from "../broker/log.js";
import { stepCaller } from "../elements/caller.js";
import {
  loadWizardTool,
  schemaZod,
  WIZARD_TOOL_LIMITS,
  type WizardTool,
} from "../engine/wizard-code.js";
import { prompt } from "../prompts.js";
import type { InProcessContext } from "../run-services/in-process.js";
import { snapshotFile } from "../services/files.js";
import type { DataResult } from "../store/data.js";
import { runData } from "../store/data-access.js";
import { askOf, PAID_TOOLS, toolCallIdOf, wizardToolScope } from "./code.js";
import { assertPublicUrl, safeFetch } from "./net-guard.js";
import { holderWho } from "./plugin.js";
import { clip } from "./shared.js";
import { sandboxTool } from "./wizard-sandbox.js";

/**
 * A wizard's function tools (docs/plans/wizard-code.md): `tools/<name>.ts` in its workspace, named
 * `wizard.<name>` in a step's `tools`. A sandbox tool, `tools/<name>/TOOL.md`, is named the same
 * way and runs in the run's sandbox (wizard-sandbox.ts). The file exports `description`, `input`
 * (JSON Schema), an optional `output` and `run(input, { fetch, tools, db })`. The step's model
 * calls it like any tool.
 *
 * The code is untrusted (marketplace, imports, guests): it runs in QuickJS like a code step
 * (packages/engine/src/quickjs.ts), with no modules, files or timers. Its way out is what `run` gets:
 * `fetch` through the broker, to the step's `hosts` only, the step's other tools, and where the
 * wizard keeps data, `db` to its database (store/data-access.ts). Each call is a line of the
 * broker's log, and so is each request and statement it makes.
 */

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const FETCH_ID = "__fetch";
const DB_ID = "__db";

/** What `db.query` and `db.exec` hand the runtime. */
const dbCall = z.object({
  mode: z.enum(["read", "write"]),
  sql: z.string().min(1).max(20_000),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  scope: z.enum(["person", "shared"]).default("person"),
});

/** The external function QuickJS defines for a tool id (packages/engine/src/quickjs.ts). */
const externalOf = (id: string) => `external_${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

/**
 * The program of one call: the tool's code, the step's tools, `fetch` and `db` (where the wizard
 * keeps data), and the call of `run`.
 */
function callProgram(body: string, input: unknown, toolKeys: string[], data: boolean): string {
  const tools = toolKeys
    .map(
      (key) =>
        `${JSON.stringify(key)}: (args) => globalThis[${JSON.stringify(externalOf(key))}](args)`,
    )
    .join(",\n  ");
  return `${body}
const __tools = Object.freeze({
  ${tools}
});
const __fetch = async (url, init = {}) => {
  const r = await globalThis[${JSON.stringify(externalOf(FETCH_ID))}]({
    url: String(url),
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    body: init.body === undefined || init.body === null ? null : String(init.body),
  });
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    url: r.url,
    headers: { get: (name) => r.headers[String(name).toLowerCase()] ?? null },
    text: async () => r.body,
    json: async () => JSON.parse(r.body),
  };
};
${
  data
    ? `const __dbCall = (mode) => (sql, params, options) =>
  globalThis[${JSON.stringify(externalOf(DB_ID))}]({
    mode,
    sql: String(sql),
    ...(params === undefined || params === null ? {} : { params }),
    scope: options?.scope ?? "person",
  });
const __db = Object.freeze({ query: __dbCall("read"), exec: __dbCall("write") });`
    : "const __db = undefined;"
}
if (typeof run !== "function") throw new Error("The tool defines no function run(input).");
return await run(${JSON.stringify(input)}, { fetch: __fetch, tools: __tools, db: __db });`;
}

/** What a response of `fetch` hands the function: its status, a few headers and the body as text. */
interface Fetched {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * The tools a step's function may call: the ones the server runs itself, without credits on each
 * call, the browser (a page worked step by step) and the step's other wizard tools left out.
 */
function callableBy(
  others: Record<string, any>,
  browser: Record<string, unknown>,
  wizardOwn: ReadonlySet<string>,
) {
  return Object.fromEntries(
    Object.entries(others).filter(
      ([key, tool]) =>
        typeof tool?.execute === "function" &&
        !PAID_TOOLS.has(key) &&
        !(key in browser) &&
        !wizardOwn.has(key),
    ),
  );
}

/**
 * The wizard's tools a step names (`wizard.<name>`): function tools over the step's other tools,
 * sandbox tools in the run's sandbox. A step that names a tool its workspace lacks, one that
 * doesn't load, a sandbox tool whose hosts the step doesn't list or that this run has no sandbox
 * for fails: the wizard or the server is the problem, not the model.
 */
export async function wizardTools(
  step: AgentStep,
  ctx: InProcessContext,
  others: Record<string, any>,
  browser: Record<string, unknown>,
  made: { assets: AssetRef[]; uploads: UploadRef[] },
): Promise<Record<string, any>> {
  const tools: Record<string, any> = {};
  const paths = ctx.files.map((f) => f.path);
  const own = step.tools.flatMap((id) => {
    const code = wizardCodeOf(id);
    return code?.kind === "tool" ? [{ id, name: code.name }] : [];
  });
  const callable = callableBy(
    others,
    browser,
    new Set(own.map((code) => wizardToolCallName(code.name))),
  );
  for (const { id, name } of own) {
    const loaded = await loadWizardTool(name, paths, async (path) => {
      const file = await snapshotFile(ctx.files, path);
      return file ? file.data.toString("utf8") : null;
    });
    if (!loaded) {
      throw new StepError(note("wizardToolMissing", { name: id }));
    }
    if (!loaded.ok) {
      throw new StepError(note("wizardToolBroken", { name: id, detail: loaded.issues[0] }));
    }
    const callName = wizardToolCallName(name);
    const tool = loaded.tool;
    if (tool.kind === "function") {
      // A program: each of its calls keeps its own row, and a crash repeats the whole program.
      tools[callName] = keepsOwnRows(functionTool(id, callName, tool, step, ctx, callable));
      continue;
    }
    const missing = sandboxToolHostsMissing(tool.hosts, step.hosts ?? []);
    if (missing.length) {
      throw new StepError(
        note("wizardToolBroken", {
          name: id,
          detail: `it reaches ${missing.join(", ")}, which the step doesn't list in its hosts.`,
        }),
      );
    }
    // A guest's run has a sandbox only where SANDBOX_GUESTS gives it one (engine/resources.ts).
    if (!(await ctx.resources.runSandboxCapabilities())) {
      throw new StepError(note("wizardToolNoSandbox", { name: id }));
    }
    tools[callName] = sandboxTool(
      id,
      callName,
      tool,
      ctx,
      () => ctx.resources.sandboxHandle(),
      made,
    );
  }
  return tools;
}

function functionTool(
  id: string,
  callName: string,
  declared: WizardTool,
  step: AgentStep,
  ctx: InProcessContext,
  callable: Record<string, any>,
) {
  const body = declared.body;
  const output = declared.output ? schemaZod(declared.output) : null;
  const limits = WIZARD_TOOL_LIMITS;
  const toolKeys = Object.keys(callable);
  const data = Boolean(ctx.def.data);
  const caller = data ? stepCaller(ctx) : null;
  const target = { def: ctx.def, files: ctx.files, store: ctx.store };
  return createTool({
    id: callName,
    description: declared.description,
    inputSchema: schemaZod(declared.input) as z.ZodType<Record<string, unknown>>,
    execute: async (input, options) => {
      const started = Date.now();
      await ctx.emit("tool", { code: "runsTool", params: { name: id } });
      const context = options as {
        agent?: { toolCallId?: string };
        mastra?: unknown;
        requestContext?: unknown;
        workspace?: unknown;
      };
      const inScope = wizardToolScope(toolCallIdOf(context, callName, input));
      let calls = 0;
      const counted = () => {
        if (++calls > limits.maxCalls) {
          throw new Error(
            `One call of ${id} makes at most ${limits.maxCalls} requests and tool calls.`,
          );
        }
      };
      const fetchFor = async (args: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | null;
      }): Promise<Fetched> => {
        counted();
        const method = String(args?.method ?? "GET").toUpperCase();
        if (!METHODS.has(method)) {
          throw new Error(`fetch takes ${[...METHODS].join(", ")}, not ${method}.`);
        }
        const safe = await assertPublicUrl(String(args?.url ?? ""));
        const out = await brokerHost({
          who: holderWho(ctx),
          where: whereOf(ctx),
          url: safe,
          method,
          only: step.hosts ?? [],
          action: id,
          effect: {
            turn: ctx.turn,
            toolCallId: toolCallIdOf(undefined, FETCH_ID, {
              method,
              url: args.url,
              body: args.body,
            }),
          },
          ask: askOf(ctx),
          handler: async (idempotencyKey) => {
            const res = await safeFetch(safe.toString(), {
              method,
              signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(limits.timeoutMs)]),
              headers: {
                ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
                ...(args.headers ?? {}),
              },
              body: method === "GET" || method === "HEAD" ? undefined : (args.body ?? undefined),
            });
            const headers: Record<string, string> = {};
            for (const name of ["content-type", "location", "retry-after", "etag"]) {
              const value = res.headers.get(name);
              if (value) {
                headers[name] = value;
              }
            }
            const text = method === "HEAD" ? "" : await res.text();
            if (text.length > limits.answerChars) {
              throw new Error(
                `The response of ${safe.hostname} has ${text.length} characters; a tool reads at most ${limits.answerChars}.`,
              );
            }
            return { status: res.status, url: res.url || safe.toString(), headers, body: text };
          },
        });
        if (out.ok) {
          return out.result;
        }
        const host = safe.hostname;
        throw new Error(
          out.refused === "run_ended"
            ? prompt("tools", "note.run_ended")
            : out.refused === "may_have_happened"
              ? prompt("tools", "note.host_may_have_happened", { host })
              : prompt("tools", "note.wizard_tool_host", { host, tool: id }),
        );
      };
      // The wizard's code, called by the model: the guest rule of a model's SQL holds for it.
      const dbFor = async (args: unknown): Promise<DataResult> => {
        counted();
        const parsed = dbCall.safeParse(args);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new Error(
            `db: ${issue?.path.join(".") || "the call"}: ${issue?.message ?? "invalid"}`,
          );
        }
        const { mode, sql, params, scope } = parsed.data;
        return runData(caller!, target, {
          action: `${id}:db.${mode === "read" ? "query" : "exec"}`,
          by: "model",
          scope,
          sql,
          params,
          mode,
        });
      };
      const callTool = async (key: string, args: unknown) => {
        counted();
        const tool = callable[key];
        const answer = await tool.execute(args, {
          mastra: context?.mastra,
          requestContext: context?.requestContext,
          abortSignal: ctx.signal,
          workspace: context?.workspace,
        });
        if (answer && typeof answer === "object" && "validationErrors" in answer) {
          throw new Error(
            String((answer as { message?: string }).message ?? `Invalid input for ${key}`),
          );
        }
        const size = JSON.stringify(answer ?? null)?.length ?? 0;
        if (size > limits.answerChars) {
          throw new Error(
            prompt("tools", "note.code_answer_too_long", {
              tool: key,
              size,
              answerChars: limits.answerChars,
            }),
          );
        }
        return answer;
      };

      const finish = async (result: string, answer?: unknown) => {
        await writeLog({
          at: new Date(started),
          durationMs: Date.now() - started,
          ...whoWhere(ctx),
          connectionId: `tool:${id}`,
          actionId: id,
          kind: "run",
          inputSummary: summarizeInput(input),
          outcome: "allow",
          rule: null,
          reason: "The step lists the wizard's tool.",
          result,
          resultSize: answer === undefined ? null : (JSON.stringify(answer ?? null)?.length ?? 0),
        });
      };

      if (JSON.stringify(input ?? null).length > limits.inputChars) {
        await finish("too_long");
        return { error: `The arguments are longer than ${limits.inputChars} characters.` };
      }
      const ran = await inScope(() =>
        quickJs({ memoryLimitMb: WIZARD_CODE_MEMORY_MB }).run({
          program: callProgram(body, input, toolKeys, data),
          toolIds: [FETCH_ID, ...(data ? [DB_ID] : []), ...toolKeys],
          dispatch: (key, args) =>
            inScope(() =>
              key === FETCH_ID
                ? fetchFor(args as Parameters<typeof fetchFor>[0])
                : key === DB_ID
                  ? dbFor(args)
                  : callTool(key, args),
            ),
          timeout: limits.timeoutMs,
          abortSignal: ctx.signal,
        }),
      );
      if (!ran.success) {
        const logs = (ran.logs ?? []).join("\n").slice(-limits.logChars);
        await finish(ran.error?.name || "Error");
        return {
          error: ran.error?.message ?? "unknown error",
          ...(logs ? { logs } : {}),
        };
      }
      if (output) {
        const checked = output.safeParse(ran.result);
        if (!checked.success) {
          const issue = checked.error.issues[0];
          await finish("output_unfit", ran.result);
          return {
            error: prompt("tools", "note.wizard_tool_output", {
              tool: id,
              where: issue?.path.join(".") || "the result",
              problem: issue?.message ?? "",
            }),
          };
        }
      }
      await finish("ok", ran.result);
      const answer = JSON.stringify(ran.result ?? null) ?? "null";
      return answer.length > limits.resultChars
        ? { result: clip(answer, limits.resultChars) }
        : (ran.result ?? null);
    },
  });
}

/** The log row's who and where for a call of the step. */
export function whoWhere(ctx: InProcessContext) {
  const who = holderWho(ctx);
  const where = whereOf(ctx);
  return {
    whoKind: who.kind,
    whoId: who.id ?? null,
    runId: where.runId ?? null,
    stepId: where.stepId ?? null,
    client: where.client ?? null,
    chatId: where.chatId ?? null,
    wizardId: where.wizardId ?? null,
    spaceId: where.spaceId ?? null,
  };
}

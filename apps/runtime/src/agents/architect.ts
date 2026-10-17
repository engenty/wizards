import { anthropic } from "@ai-sdk/anthropic";
import type { Lang } from "@engenty-wizards/shared/definition";
import { SURFACE_GUIDE } from "@engenty-wizards/shared/surface";
import { isTextMime } from "@engenty-wizards/shared/workspace";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  connectorsLine,
  exampleWizard,
  type GuideConnector,
  type GuideServer,
  type GuideTool,
  mcpServersLine,
  PRINCIPLES,
  pluginToolsLine,
  SCHEMA_DOC,
  WIDGET_GUIDE,
} from "../authoring/guide.js";
import { wizardOpSchema } from "../authoring/ops.js";
import { importFromRegistry, listConnectors, searchRegistry } from "../connectors/external.js";
import {
  agentModel,
  attachTools,
  costOf,
  gatewayTools,
  type ResolvedModel,
  textModel,
  totalUsage,
} from "../models.js";
import { pluginToolsOf } from "../plugins/registry.js";
import { htmlToMarkdown } from "../render/convert.js";
import { deleteFile, listFiles, readFileText, writeFile } from "../services/files.js";
import { checkDraftWidget } from "../services/widgets.js";
import { editWizard, ownedWizard, writeDraft } from "../services/wizards.js";
import { currentTenant } from "../tenants/tenant.js";
import { type ServerKey, serverText } from "../texts.js";
import { assertPublicUrl, safeFetch } from "../tools/net-guard.js";
import { attempt as attemptTool, imageOutput } from "../tools/shared.js";
import { runScript } from "../widgets/script.js";
import { thoughtLine } from "./thought.js";

export interface ArchitectInput {
  userId: string;
  wizardId: string;
  message: string;
  history: { role: "user" | "assistant"; content: string }[];
  mcpServers: GuideServer[];
  connectors: GuideConnector[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  /** The language the admin reads the lines about its work in. */
  lang?: Lang;
  /** A short line about what the architect is doing right now ("Loading lake shapes …"). */
  onActivity?: (label: string) => void;
  /** The latest line of its reasoning, for the line under the activity. */
  onThought?: (line: string) => void;
  onBuilding?: () => void;
  /** Pictures the admin attached to this message, for the model to look at. */
  images?: ChatImage[];
}

/** A picture sent with a chat message; its bytes go to the model, not just its name. */
export interface ChatImage {
  path: string;
  mime: string;
  data: Uint8Array;
}

const MAX_STEPS = 45;

export interface ArchitectResult {
  reply: string;
  /** The architect wrote the draft or the workspace during the turn. */
  changed: boolean;
  /** It ran out of steps before it finished. */
  unfinished: boolean;
  costUsd: number;
}

function systemPrompt(
  mcp: GuideServer[],
  connectors: GuideConnector[],
  pluginTools: GuideTool[],
): string {
  return `You design wizards for "engenty wizards": a page-by-page flow an end user walks through, where AI steps research, write, draw images, render video, build documents, dashboards and interactive widgets, or write into other systems.

You talk to the ADMIN who builds the wizard. Answer in the admin's language, briefly and warmly. Never mention JSON, ids, schemas, files or templates to them — talk about pages, questions, steps, the widget and results.

${SCHEMA_DOC}
${PRINCIPLES}
${WIDGET_GUIDE}

Surface catalog (for surface steps and output.surface):
${SURFACE_GUIDE}

${mcpServersLine(mcp)}

${connectorsLine(connectors)}${pluginToolsLine(pluginTools)}

Example of a complete wizard:
\`\`\`json
${exampleWizard()}
\`\`\`

HOW YOU WORK
- You change the wizard ONLY through tools: edit_wizard (small ops) or replace_wizard (new or mostly rewritten). Every write returns the validator's issues — fix them before you finish.
- Widgets and their data live in the workspace: list_files, read_file, write_file, delete_file, download_files. Then check_widget, look at the screenshot, fix, check again.
- Order: 1. write the wizard's steps, 2. fetch only the reference data the widget truly needs (one download_files call for all of it), 3. write the widget and its sample.json, 4. check_widget and fix, 5. answer. You have about 30 tool calls — never spend them on exploring.
- A message that starts "New step" or "Neuer Schritt" comes from the studio's step panel or diagram: add exactly that one step in the place it names – of the kind in brackets, or the kind that fits best when none is named – and build it completely: a page's fields, an AI step's instructions and output, a view's components and data, a widget with its HTML and sample.json. Read what it needs from the steps before it, and leave the other steps as they are unless the new step needs a change there. With "Only if:" / "Nur wenn:" or "AI decides:" / "KI entscheidet:" the new step is a branch that only some runs take: put it right after the step before it, and give that step a rule to the new step (a "when" condition written from the admin's words against the data known there, or an "ask" statement for AI decides) plus an "otherwise" rule (only "goto") to the step every other run went to before; the new step then goes on to that same step as the next in the list. Keep that step's other rules.
- Call independent tools in the same step (they run together).
- Never retype data you downloaded. Reshape it with run_script (output to a file), or let the widget read the raw files with wizard.json() and transform them when it starts.
- Work in few, purposeful steps: every tool call costs the admin time and credits.
- Services the wizard should work in for the person: find_connectors, import_connector (it returns the actions), then a connection for it in the wizard. list_connectors shows what the project has.
- Research what you need to prepare (web_search, web_fetch) — e.g. which lakes, their outlines, a chart library.
- Finish with one to three sentences to the admin: what you built or changed, and at most one suggestion. If they only asked a question, just answer it.`;
}

/** Turns a tool call into the line the admin sees while it runs. */
function activity(tool: string, args: Record<string, unknown>, lang: Lang = "en"): string | null {
  const say = (key: ServerKey, params?: Record<string, string>) => serverText(lang, key, params);
  const host = (u: unknown) => {
    try {
      return new URL(String(u)).hostname;
    } catch {
      return "";
    }
  };
  switch (tool) {
    case "replace_wizard":
    case "edit_wizard":
      return say("doingFlow");
    case "write_file":
      return args.path
        ? say("doingWriteFile", { path: String(args.path) })
        : say("doingWriteAFile");
    case "download_files":
      return say("doingDownload");
    case "web_fetch":
      return args.url ? say("doingReadSite", { host: host(args.url) }) : say("doingReadWeb");
    case "web_search":
      return say("doingWebSearch");
    case "check_widget":
      return say("doingTestWidget");
    case "run_script":
      return args.output
        ? say("doingPrepare", { output: String(args.output) })
        : say("doingCalculate");
    case "list_files":
    case "read_file":
      return say("doingLookFiles");
    case "delete_file":
      return say("doingTidyFiles");
    default:
      return null;
  }
}

/** A tool failure the model can read and fix, instead of a crashed turn: the whole message. */
const attempt = <T>(run: () => Promise<T>) => attemptTool(run, { limit: Number.POSITIVE_INFINITY });

function buildTools(input: ArchitectInput, resolved: ResolvedModel<unknown>, wrote: () => void) {
  const { userId, wizardId } = input;
  const signal = input.signal;
  const projectId = async () => (await ownedWizard(userId, wizardId)).projectId;
  const tools: Record<string, any> = {
    find_connectors: createTool({
      id: "find_connectors",
      description:
        "Search the integrations registry for a service that can be imported as a connector (from its OpenAPI spec or MCP server). Returns domains with a short description.",
      inputSchema: z.object({ query: z.string().describe("Service name, e.g. Notion") }),
      execute: async ({ query }) =>
        attempt(async () => ({ services: await searchRegistry(query) })),
    }),
    import_connector: createTool({
      id: "import_connector",
      description:
        "Import a service from the registry into this project as a connector. Returns its id, tool prefix, how people connect (OAuth, API key, none) and its actions with their marks (read / write / destructive). Importing again returns the existing one.",
      inputSchema: z.object({
        domain: z.string().describe("A domain from find_connectors, e.g. notion.com"),
        kind: z
          .enum(["mcp", "openapi"])
          .optional()
          .describe("Default: the service's MCP server if it has one, else its OpenAPI spec."),
      }),
      execute: async ({ domain, kind }) =>
        attempt(async () => {
          const result = await importFromRegistry(userId, await projectId(), { domain, kind });
          wrote();
          return result;
        }),
    }),
    list_connectors: createTool({
      id: "list_connectors",
      description: "The connectors this project has imported, with every action.",
      inputSchema: z.object({}),
      execute: async () =>
        attempt(async () => ({ connectors: await listConnectors(await projectId()) })),
    }),
    replace_wizard: createTool({
      id: "replace_wizard",
      description:
        "Replace the whole wizard. Use for a new wizard or a rewrite. Returns the validator's issues.",
      inputSchema: z.object({ wizard: z.record(z.string(), z.unknown()) }),
      execute: async ({ wizard }) =>
        attempt(async () => {
          const w = await ownedWizard(userId, wizardId);
          const { issues } = await writeDraft(userId, wizardId, {
            definition: wizard,
            baseRevision: w.revision,
          });
          wrote();
          return { ok: true, issues };
        }),
    }),
    edit_wizard: createTool({
      id: "edit_wizard",
      description:
        "Change the wizard with ops, applied in order: set_meta, set_lists {lists} and set_connections {connections} (each replaces the whole array), upsert_step (the complete step; replaces the step with that id or inserts it before/after another), remove_step, move_step. Returns the validator's issues.",
      inputSchema: z.object({ ops: z.array(wizardOpSchema).min(1) }),
      execute: async ({ ops }) =>
        attempt(async () => {
          const w = await ownedWizard(userId, wizardId);
          const { issues } = await editWizard(
            userId,
            wizardId,
            { ops, baseRevision: w.revision },
            { source: "studio" },
          );
          wrote();
          return { ok: true, issues };
        }),
    }),
    list_files: createTool({
      id: "list_files",
      description: "The files in the wizard's workspace (path, mime, size).",
      inputSchema: z.object({}),
      execute: async () =>
        attempt(async () =>
          (await listFiles(userId, wizardId)).map(({ path, mime, size }) => ({ path, mime, size })),
        ),
    }),
    read_file: createTool({
      id: "read_file",
      description: "Read a workspace file as text.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) =>
        attempt(async () => {
          const f = await readFileText(userId, wizardId, path);
          return f.text === null
            ? { path: f.path, mime: f.mime, size: f.size, note: "binary file" }
            : {
                path: f.path,
                text:
                  f.text.length > 60_000
                    ? `${f.text.slice(0, 60_000)}\n…[${f.text.length - 60_000} more characters]`
                    : f.text,
              };
        }),
    }),
    write_file: createTool({
      id: "write_file",
      description:
        "Create or overwrite a text file in the workspace (HTML, JS, CSS, JSON, CSV, SVG). Max 5 MB.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) =>
        attempt(async () => {
          const f = await writeFile(userId, wizardId, path, content);
          wrote();
          return { ok: true, path: f.path, size: f.size };
        }),
    }),
    delete_file: createTool({
      id: "delete_file",
      description: "Delete a workspace file.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) =>
        attempt(async () => {
          await deleteFile(userId, wizardId, path);
          wrote();
          return { ok: true };
        }),
    }),
    download_files: createTool({
      id: "download_files",
      description:
        "Download public URLs straight into the workspace — all at once (libraries from cdnjs/jsdelivr, GeoJSON outlines, CSV, images). The content does not pass through you; you get each file's size and first characters. Requests to the same host are spaced one second apart (fair use of OpenStreetMap and others).",
      inputSchema: z.object({
        files: z
          .array(z.object({ url: z.string(), path: z.string() }))
          .min(1)
          .max(40),
      }),
      execute: async ({ files }) => {
        const results: unknown[] = [];
        const lastHit = new Map<string, number>();
        for (const { url, path } of files) {
          const host = (() => {
            try {
              return new URL(url).hostname;
            } catch {
              return "";
            }
          })();
          const wait = (lastHit.get(host) ?? 0) + 1000 - Date.now();
          if (wait > 0) {
            await new Promise((r) => setTimeout(r, wait));
          }
          lastHit.set(host, Date.now());
          results.push(
            await attempt(async () => {
              const res = await safeFetch(url, {
                signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
                headers: { "user-agent": "engenty-wizards/0.1 (widget builder)" },
              });
              if (!res.ok) {
                return { path, error: `HTTP ${res.status}` };
              }
              const data = new Uint8Array(await res.arrayBuffer());
              const mime = res.headers.get("content-type")?.split(";")[0];
              const f = await writeFile(userId, wizardId, path, data, mime);
              wrote();
              return {
                path: f.path,
                size: f.size,
                start: isTextMime(f.mime) ? Buffer.from(data.slice(0, 160)).toString("utf8") : null,
              };
            }),
          );
        }
        return { results };
      },
    }),
    run_script: createTool({
      id: "run_script",
      description:
        "Run JavaScript over workspace files in a browser without network — to reshape downloaded data (simplify outlines, merge files, compute bounds or SVG paths) instead of retyping it. The body of an async function: `files` maps each input path to its text; return a string or a JSON value. With `output`, the result is saved as that workspace file.",
      inputSchema: z.object({
        script: z.string(),
        inputs: z.array(z.string()).describe("Workspace paths to pass in `files`."),
        output: z.string().optional(),
      }),
      execute: async ({ script, inputs, output }) =>
        attempt(async () => {
          const files: Record<string, string> = {};
          for (const path of inputs) {
            const f = await readFileText(userId, wizardId, path);
            if (f.text !== null) {
              files[f.path] = f.text;
            }
          }
          const result = await runScript(script, files);
          const text = typeof result === "string" ? result : JSON.stringify(result);
          if (output) {
            const f = await writeFile(userId, wizardId, output, text ?? "");
            wrote();
            return { ok: true, path: f.path, size: f.size, start: (text ?? "").slice(0, 400) };
          }
          return {
            result: (text ?? "").length > 8000 ? `${text.slice(0, 8000)} …[truncated]` : text,
          };
        }),
    }),
    web_fetch: createTool({
      id: "web_fetch",
      description: "Read a public web page or API response (Markdown/text, first 6000 chars).",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) =>
        attempt(async () => {
          const safe = await assertPublicUrl(url);
          const res = await safeFetch(safe.toString(), {
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
            headers: { "user-agent": "Mozilla/5.0 (compatible; engenty-wizards/0.1)" },
          });
          const type = res.headers.get("content-type") ?? "";
          const body = await res.text();
          const text = type.includes("html") ? htmlToMarkdown(body) : body;
          return { status: res.status, content: text.slice(0, 6000) };
        }),
    }),
    check_widget: createTool({
      id: "check_widget",
      description:
        "Load a widget step in a real browser with its sample data (or the data you pass): returns script errors, whether it registered a timeline, and a screenshot you can look at.",
      inputSchema: z.object({
        stepId: z.string(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async ({ stepId, data }) =>
        attempt(async () => {
          const r = await checkDraftWidget(userId, wizardId, stepId, data);
          return {
            errors: r.errors,
            timelineSeconds: r.duration,
            size: r.size,
            bundleBytes: r.bytes,
            screenshot: Buffer.from(r.png).toString("base64"),
          };
        }),
      toModelOutput: imageOutput("screenshot"),
    }),
  };
  if (resolved.vendor === "anthropic") {
    tools.web_search = anthropic.tools.webSearch_20250305({ maxUses: 5 });
  } else if (resolved.gateway) {
    tools.web_search = gatewayTools.perplexitySearch({ maxResults: 6 });
  }
  return tools;
}

/** One studio turn: the architect reads the draft and its workspace and changes them with tools. */
export async function runArchitect(input: ArchitectInput): Promise<ArchitectResult> {
  const w = await ownedWizard(input.userId, input.wizardId);
  const files = await listFiles(input.userId, input.wizardId);
  let changed = false;
  // Building a wizard is the hardest job here: widgets are code.
  const resolved = await textModel("highest");
  const tools = buildTools(input, resolved, () => {
    changed = true;
  });
  attachTools(resolved, tools);
  const agent = new Agent({
    id: "architect",
    name: "Architect",
    // The system prompt is long and identical on every turn: cache it.
    instructions: {
      role: "system",
      content: systemPrompt(
        input.mcpServers,
        input.connectors,
        await pluginToolsOf(currentTenant()),
      ),
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    model: agentModel(resolved),
    tools,
  });
  const context = [
    `Current wizard (revision ${w.revision}):\n\`\`\`json\n${JSON.stringify(w.draft)}\n\`\`\``,
    `Workspace files: ${files.length ? files.map((f) => `${f.path} (${f.size} B)`).join(", ") : "none"}`,
    input.message,
  ].join("\n\n");
  const stream = await agent.stream(
    [
      ...input.history
        .slice(-10)
        .map((m) =>
          m.role === "user"
            ? { role: "user" as const, content: m.content }
            : { role: "assistant" as const, content: m.content },
        ),
      {
        role: "user" as const,
        content: input.images?.length
          ? [
              { type: "text" as const, text: context },
              ...input.images.map((i) => ({
                type: "file" as const,
                data: i.data,
                mediaType: i.mime,
                filename: i.path,
              })),
            ]
          : context,
      },
    ],
    {
      maxSteps: MAX_STEPS,
      abortSignal: input.signal,
      modelSettings: { maxOutputTokens: 32_000 },
    },
  );
  let reply = "";
  let steps = 0;
  // A big write_file streams its arguments for minutes; name the file as soon as its path arrives.
  const streaming = new Map<string, { tool: string; args: string; named: boolean }>();
  let reasoning = "";
  let thought: string | null = null;
  for await (const chunk of stream.fullStream as AsyncIterable<any>) {
    const payload = chunk.payload ?? chunk;
    if (chunk.type === "reasoning-start") {
      reasoning = "";
    } else if (chunk.type === "reasoning-delta") {
      reasoning += payload.text ?? "";
      const line = thoughtLine(reasoning);
      if (line && line !== thought) {
        thought = line;
        input.onThought?.(line);
      }
    } else if (chunk.type === "text-delta") {
      const text: string = payload.text ?? payload.delta ?? "";
      reply += text;
      input.onText?.(text);
    } else if (chunk.type === "tool-call-input-streaming-start") {
      streaming.set(payload.toolCallId, { tool: payload.toolName, args: "", named: false });
      const label = activity(payload.toolName, {}, input.lang);
      if (label) {
        input.onActivity?.(label);
      }
    } else if (chunk.type === "tool-call-delta") {
      const s = streaming.get(payload.toolCallId);
      if (s && !s.named) {
        s.args += payload.argsTextDelta ?? "";
        const path = s.args.match(/"path"\s*:\s*"([^"]+)"/)?.[1];
        if (path) {
          s.named = true;
          const label = activity(s.tool, { path }, input.lang);
          if (label) {
            input.onActivity?.(label);
          }
        }
      }
    } else if (chunk.type === "tool-call") {
      const label = activity(
        payload.toolName,
        (payload.args ?? payload.input ?? {}) as never,
        input.lang,
      );
      if (label) {
        input.onActivity?.(label);
      }
      if (payload.toolName === "replace_wizard" || payload.toolName === "edit_wizard") {
        input.onBuilding?.();
      }
      // Keep what it says before and after a tool call apart.
      if (reply.trim() && !reply.endsWith("\n\n")) {
        input.onText?.("\n\n");
        reply += "\n\n";
      }
    } else if (chunk.type === "step-finish") {
      steps += 1;
    } else if (chunk.type === "error") {
      throw payload.error ?? new Error("architect stream error");
    }
  }
  const usage = await totalUsage(stream);
  return {
    reply: reply.trim(),
    changed,
    unfinished: steps >= MAX_STEPS,
    costUsd: costOf(resolved, usage),
  };
}

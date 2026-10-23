import { anthropic } from "@ai-sdk/anthropic";
import {
  DEFINITION_VERSION,
  type Lang,
  upgradeDefinition,
} from "@engenty/wizards-shared/definition";
import { isTextMime } from "@engenty/wizards-shared/workspace";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  exampleWizard,
  type GuideConnector,
  type GuideServer,
  type GuideTool,
  projectLines,
} from "../authoring/guide.js";
import { wizardOpSchema } from "../authoring/ops.js";
import { importFromRegistry, listConnectors, searchRegistry } from "../connectors/external.js";
import {
  agentModel,
  attachTools,
  type ChatWay,
  chatModel,
  costOf,
  gatewayTools,
  type ResolvedModel,
  totalUsage,
} from "../models.js";
import { pluginToolsOf } from "../plugins/registry.js";
import { prompt } from "../prompts.js";
import { htmlToMarkdown } from "../render/convert.js";
import { contentPolicy } from "../safety.js";
import { sandboxGuideLine } from "../sandbox/index.js";
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
  /** What answers: the text classes, a provider's key or the credits (a subscription runs on its own). */
  way: ChatWay;
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
  return `${prompt("architect", "system", {
    persona: prompt("architect", "persona"),
    schema: prompt("authoring", "schema"),
    principles: prompt("authoring", "principles", { sandbox: sandboxGuideLine() }),
    widgets: prompt("authoring", "widgets"),
    surfaces: prompt("authoring", "surfaces"),
    project_tools: projectLines(mcp, connectors, pluginTools),
    example: exampleWizard(),
    how_you_work: prompt("architect", "how_you_work"),
  })}\n\n${contentPolicy()}`;
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
      description: prompt("mcp", "tool.find_connectors"),
      inputSchema: z.object({ query: z.string().describe("Service name, e.g. Notion") }),
      execute: async ({ query }) =>
        attempt(async () => ({ services: await searchRegistry(query) })),
    }),
    import_connector: createTool({
      id: "import_connector",
      description: prompt("mcp", "tool.import_connector"),
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
      description: prompt("mcp", "tool.list_connectors"),
      inputSchema: z.object({}),
      execute: async () =>
        attempt(async () => ({ connectors: await listConnectors(await projectId()) })),
    }),
    replace_wizard: createTool({
      id: "replace_wizard",
      description: prompt("mcp", "tool.replace_wizard"),
      inputSchema: z.object({ wizard: z.record(z.string(), z.unknown()) }),
      execute: async ({ wizard }) =>
        attempt(async () => {
          const w = await ownedWizard(userId, wizardId);
          const { revision, issues } = await writeDraft(userId, wizardId, {
            // Written from today's authoring guide: today's version, said or not.
            definition: upgradeDefinition(wizard, DEFINITION_VERSION),
            baseRevision: w.revision,
          });
          wrote();
          return { ok: true, revision, issues };
        }),
    }),
    edit_wizard: createTool({
      id: "edit_wizard",
      description: prompt("mcp", "tool.edit_wizard"),
      inputSchema: z.object({ ops: z.array(wizardOpSchema).min(1) }),
      execute: async ({ ops }) =>
        attempt(async () => {
          const w = await ownedWizard(userId, wizardId);
          const { revision, issues } = await editWizard(
            userId,
            wizardId,
            { ops, baseRevision: w.revision },
            { source: "studio" },
          );
          wrote();
          return { ok: true, revision, issues };
        }),
    }),
    list_files: createTool({
      id: "list_files",
      description: prompt("mcp", "tool.list_files"),
      inputSchema: z.object({}),
      execute: async () =>
        attempt(async () =>
          (await listFiles(userId, wizardId)).map(({ path, mime, size }) => ({ path, mime, size })),
        ),
    }),
    read_file: createTool({
      id: "read_file",
      description: prompt("mcp", "tool.read_file"),
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
      description: prompt("architect", "tool.write_file"),
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
      description: prompt("mcp", "tool.delete_file"),
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
      description: prompt("architect", "tool.download_files"),
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
      description: prompt("architect", "tool.run_script"),
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
      description: prompt("architect", "tool.web_fetch"),
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
      description: prompt("mcp", "tool.check_widget"),
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
  const resolved = await chatModel(input.way, "high");
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
  const context = prompt("architect", "turn.context", {
    revision: w.revision,
    draft: JSON.stringify(w.draft),
    files: files.length ? files.map((f) => `${f.path} (${f.size} B)`).join(", ") : "none",
    message: input.message,
  });
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

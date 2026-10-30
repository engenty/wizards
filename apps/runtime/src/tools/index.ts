import { anthropic } from "@ai-sdk/anthropic";
import type { AgentStep } from "@engenty/wizards-shared/definition";
import type { AssetRef } from "@engenty/wizards-shared/run";
import { isTextMime } from "@engenty/wizards-shared/workspace";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { documentMime, parseDocument } from "../documents/parse.js";
import type { StepContext } from "../engine/types.js";
import { generateImageMedia } from "../media/generate.js";
import { markMedia } from "../media/marking.js";
import { gatewayTools, isHarnessVendor, type ResolvedModel, searchAllowed } from "../models.js";
import { prompt } from "../prompts.js";
import { htmlToMarkdown } from "../render/convert.js";
import { type ExecResult, shellToolDescription } from "../sandbox/index.js";
import { snapshotFile } from "../services/files.js";
import { hasStoreFiles } from "../store/index.js";
import { browserTools } from "./browser.js";
import { codeTool } from "./code.js";
import { connectorTools } from "./connector.js";
import { mailTools } from "./mail.js";
import { assertPublicUrl, safeFetch } from "./net-guard.js";
import { pageTools } from "./pages.js";
import { pluginTools, spaceContextOf } from "./plugin.js";
import { clip, FileKeeper } from "./shared.js";
import { skillTools } from "./skills.js";
import { spaceTools } from "./space.js";
import { storeTools, type UploadRef } from "./store.js";

export interface StepTools {
  tools: Record<string, any>;
  /** Assets the tools made during the step (screenshots, images, exported files). */
  assets: AssetRef[];
  /** How to write a program over the tools, with the `code` tool. */
  instructions?: string;
}

/**
 * Whether a fetched body is text a model can read: a text type, or no type and next to no
 * bytes that only decode as replacement or control characters.
 */
function isReadable(type: string, body: string): boolean {
  if (
    isTextMime(type) ||
    type.includes("html") ||
    type.includes("xml") ||
    type.includes("json") ||
    type.includes("javascript")
  ) {
    return true;
  }
  if (type && type !== "application/octet-stream") {
    return false;
  }
  const sample = body.slice(0, 4000);
  let odd = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0xfffd || code < 0x09 || (code > 0x0d && code < 0x20)) {
      odd++;
    }
  }
  return odd <= sample.length * 0.01;
}

/**
 * Whether a step has no use for the wizard's store: it declares no tools and no connections,
 * got no uploads, and the wizard keeps no lists. Its files may still be there (`buildStepTools`).
 */
export function storeIdle(
  step: Pick<AgentStep, "tools" | "connections">,
  lists: number,
  uploads: number,
): boolean {
  return step.tools.length === 0 && !step.connections?.length && lists === 0 && uploads === 0;
}

/** The tools an agent step may use: exactly what its definition allowlists. */
export async function buildStepTools(
  step: AgentStep,
  ctx: StepContext,
  resolved: ResolvedModel<unknown>,
  uploads: UploadRef[],
): Promise<StepTools> {
  const tools: Record<string, any> = {};
  const assets: AssetRef[] = [];
  const allowed = new Set(step.tools);

  // A tier without web search leaves the tool out; the builder says so before a run.
  if (allowed.has("web_search") && (await searchAllowed())) {
    // Anthropic models search natively; other models search through the AI Gateway's tool.
    if (resolved.vendor === "anthropic") {
      tools.web_search = anthropic.tools.webSearch_20250305({ maxUses: 8 });
    } else if (isHarnessVendor(resolved.vendor)) {
      // An installed client searches with its own tool; naming it here switches it on.
      tools.web_search = createTool({
        id: "web_search",
        description: prompt("tools", "tool.web_search"),
        inputSchema: z.object({ query: z.string() }),
        execute: async () => ({ error: "The client searches itself." }),
      });
    } else if (resolved.gateway) {
      tools.web_search = gatewayTools.perplexitySearch({ maxResults: 8 });
    }
  }

  if (allowed.has("web_fetch") || allowed.has("web_search")) {
    tools.web_fetch = createTool({
      id: "web_fetch",
      description: prompt("tools", "tool.web_fetch"),
      inputSchema: z.object({ url: z.string().describe("Absolute http(s) URL") }),
      execute: async ({ url }) => {
        const safe = await assertPublicUrl(url);
        await ctx.emit("tool", { code: "reads", params: { name: safe.hostname } });
        const res = await safeFetch(safe.toString(), {
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
          headers: { "user-agent": "Mozilla/5.0 (compatible; engenty-wizards/0.1)" },
        });
        const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        const data = new Uint8Array(await res.arrayBuffer());
        const name = new URL(res.url || safe.toString()).pathname.split("/").pop() || "download";
        const mime = documentMime(name, type);
        // A PDF or Word file is read by its own text; an image or other bytes are not text at all.
        if (mime === "application/pdf" || mime.includes("word")) {
          const doc = await parseDocument(
            { data, name, mime },
            { charge: (usd) => ctx.chargeUsd(usd), signal: ctx.signal, call: ctx.call },
          ).catch(() => null);
          return doc
            ? { status: res.status, url: res.url, content: clip(doc.markdown) }
            : { status: res.status, url: res.url, error: `The ${mime} file could not be read.` };
        }
        const body = new TextDecoder().decode(data);
        if (!isReadable(type, body)) {
          return {
            status: res.status,
            url: res.url,
            type: type || "unknown",
            bytes: data.length,
            note: type.startsWith("image/")
              ? prompt("tools", "note.web_fetch_image")
              : prompt("tools", "note.web_fetch_binary"),
          };
        }
        const text = type.includes("html") ? htmlToMarkdown(body) : body;
        return { status: res.status, url: res.url, content: clip(text) };
      },
    });
  }

  if (allowed.has("http")) {
    tools.http_request = createTool({
      id: "http_request",
      description: prompt("tools", "tool.http_request"),
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        url: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
        json: z.unknown().optional().describe("JSON body"),
      }),
      execute: async ({ method, url, headers, json }) => {
        const safe = await assertPublicUrl(url);
        await ctx.emit("tool", `${method} ${safe.hostname}${safe.pathname}`);
        const res = await safeFetch(safe.toString(), {
          method,
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
          headers: {
            ...(json !== undefined ? { "content-type": "application/json" } : {}),
            ...headers,
          },
          body: json !== undefined ? JSON.stringify(json) : undefined,
        });
        return { status: res.status, body: clip(await res.text(), 8000) };
      },
    });
  }

  const files = new FileKeeper(ctx, assets);

  // The browser is one page, worked step by step, and it asks the person to sign in.
  const browser = allowed.has("browser") ? await browserTools(ctx, assets, files) : {};
  Object.assign(tools, browser);

  // The wizard's lists and files, the documents the person gave and the space's documents are
  // always at hand. An installed client gets tools over an MCP bridge its CLI starts for every
  // call, seconds of its own: a step with no use for the store goes without its tools, and
  // without others (Knowledge, a workspace file) the client answers without the bridge.
  const idle =
    isHarnessVendor(resolved.vendor) &&
    storeIdle(step, ctx.def.lists?.length ?? 0, uploads.length) &&
    !(await hasStoreFiles(ctx.store));
  if (!idle) {
    Object.assign(tools, storeTools(ctx, uploads, files));
  }
  Object.assign(tools, await spaceTools(ctx));
  // The run's sandbox: a guest's run has none unless SANDBOX_GUESTS says so (engine/resources.ts).
  const sandbox = allowed.has("sandbox") ? ctx.resources.sandboxCapabilities() : null;
  Object.assign(
    tools,
    await skillTools(
      ctx,
      sandbox ? { handle: () => ctx.resources.sandboxHandle(), workdir: sandbox.workdir } : null,
    ),
  );
  Object.assign(tools, mailTools(step, ctx, files));
  Object.assign(tools, await connectorTools(step, ctx, files));
  Object.assign(tools, await pluginTools(step, ctx));
  Object.assign(tools, (await spaceContextOf(ctx)).tools);

  if (allowed.has("pages")) {
    Object.assign(tools, pageTools(ctx));
  }

  if (sandbox) {
    const timeoutMs = (seconds?: number) => Math.min((seconds ?? 120) * 1000, 600_000);
    const report = (result: ExecResult) => ({
      exitCode: result.exitCode,
      stdout: clip(result.stdout, 8000),
      stderr: clip(result.stderr, 4000),
    });
    tools.run_command = createTool({
      id: "run_command",
      description: shellToolDescription(sandbox),
      inputSchema: z.object({ command: z.string(), timeoutSeconds: z.number().optional() }),
      execute: async ({ command, timeoutSeconds }) => {
        await ctx.emit("tool", { code: "runs", params: { command: command.slice(0, 80) } });
        return report(
          await ctx.resources
            .sandboxHandle()
            .exec(command, { timeoutMs: timeoutMs(timeoutSeconds) }),
        );
      },
    });
    tools.export_file = createTool({
      id: "export_file",
      description: prompt("tools", "tool.export_file"),
      inputSchema: z.object({
        path: z.string(),
        mime: z.string().describe("e.g. image/png, text/csv"),
      }),
      execute: async ({ path, mime }) => {
        let bytes: Uint8Array;
        try {
          bytes = await ctx.resources.sandboxHandle().readFile(path);
        } catch (err) {
          return { error: (err as Error).message || "file not found" };
        }
        const ref = await ctx.saveAsset({
          kind: mime.startsWith("image/") ? "image" : "file",
          mime,
          name: path.split("/").pop() ?? "file",
          data: Buffer.from(bytes),
        });
        assets.push(ref);
        return { saved: true, assetId: ref.id };
      },
    });
  }

  if (allowed.has("image")) {
    tools.generate_image = createTool({
      id: "generate_image",
      description: prompt("tools", "tool.generate_image"),
      inputSchema: z.object({
        prompt: z.string(),
        aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"]).optional(),
      }),
      execute: async ({ prompt, aspectRatio }) => {
        await ctx.emit("tool", { code: "drawing" });
        const media = await generateImageMedia({
          call: ctx.call,
          prompt,
          aspectRatio,
          abortSignal: ctx.signal,
        });
        await ctx.chargeUsd(media.costUsd);
        const ref = await ctx.saveAsset({
          kind: "image",
          mime: media.mime,
          name: "image.png",
          data: markMedia(media.bytes, media.mime, { origin: "generated", system: media.system }),
          ai: "generated",
        });
        assets.push(ref);
        return { saved: true, assetId: ref.id };
      },
    });
  }

  // The wizard's workspace (reference data, price lists, templates) is always readable.
  if (ctx.files.length) {
    tools.read_workspace_file = createTool({
      id: "read_workspace_file",
      description: prompt("tools", "tool.read_workspace_file", {
        files: ctx.files
          .slice(0, 60)
          .map((f) => f.path)
          .join(", "),
      }),
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const found = await snapshotFile(ctx.files, path);
        if (!found) {
          return { error: `No file ${path}` };
        }
        return isTextMime(found.file.mime)
          ? { path, text: clip(found.data.toString("utf8"), 40_000) }
          : { path, mime: found.file.mime, size: found.file.size, note: "binary file" };
      },
    });
  }

  // An installed client writes and runs code of its own.
  let instructions: string | undefined;
  if (allowed.has("code") && !isHarnessVendor(resolved.vendor)) {
    const code = codeTool(
      Object.fromEntries(Object.entries(tools).filter(([key]) => !(key in browser))),
      ctx,
    );
    if (code) {
      tools[code.tool.id] = code.tool;
      instructions = code.instructions;
    }
  }

  return {
    tools,
    assets,
    instructions,
  };
}

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { BridgeTool } from "@engenty/local-models/clients";
import {
  type CallToolResult,
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import { env } from "../env.js";

/**
 * The tools of one model call, served over MCP to the AI client installed on this machine
 * while it answers that call. A bridge lives as long as the call: it opens with it, is reached
 * through a random path on the loopback address, and closes with it. Nothing but this process
 * knows the path; the client works through the tools itself and comes back with the answer.
 */

type Handler = { fetch(request: Request): Promise<Response> };

const bridges = new Map<string, Handler>();

const textOf = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);

type Shaped =
  | { type: "json" | "text"; value: unknown }
  | {
      type: "content";
      value: { type: string; text?: string; data?: string; mediaType?: string }[];
    };

/** A tool's result as MCP content: text, or the blocks its `toModelOutput` shapes (text and images). */
function contentOf(tool: BridgeTool, output: unknown): CallToolResult {
  const shaped = tool.toModelOutput?.(output) as Shaped | undefined;
  if (shaped?.type === "content") {
    return {
      content: shaped.value.map((part) =>
        part.type === "image-data"
          ? { type: "image", data: part.data ?? "", mimeType: part.mediaType ?? "image/png" }
          : { type: "text", text: part.text ?? textOf(part) },
      ),
    };
  }
  return { content: [{ type: "text", text: textOf(shaped ? shaped.value : output) }] };
}

export function openBridge(tools: BridgeTool[]): { url: string; close(): void } {
  const token = randomBytes(24).toString("base64url");
  // The client's requests arrive on their own; the tools run as the call that opened the bridge —
  // in its tenant, as its person.
  const inCall = AsyncLocalStorage.snapshot();
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "step", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );
      for (const tool of tools) {
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: fromJsonSchema(tool.inputSchema as any),
          },
          (async (args: unknown) => {
            try {
              return contentOf(tool, await inCall(() => tool.execute(args)));
            } catch (err) {
              return {
                isError: true,
                content: [{ type: "text", text: (err as Error)?.message ?? String(err) }],
              };
            }
          }) as any,
        );
      }
      return server;
    },
    { legacy: "stateless" },
  );
  bridges.set(token, handler);
  return {
    url: `http://127.0.0.1:${env.port}/api/mcp/bridge/${token}`,
    close: () => {
      bridges.delete(token);
    },
  };
}

/** Answers an MCP request of an open bridge; a closed or unknown one is not found. */
export function bridgeRequest(token: string, request: Request): Promise<Response> {
  const handler = bridges.get(token);
  if (!handler) {
    return Promise.resolve(new Response("not found", { status: 404 }));
  }
  return handler.fetch(request);
}

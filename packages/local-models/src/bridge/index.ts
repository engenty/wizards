import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  type CallToolResult,
  type ContentBlock,
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import type { Bridge, BridgeTool } from "../clients/model.js";

/**
 * The tools of one model call or one turn, served over MCP to an installed client (Claude Code,
 * Codex, Cursor Agent) while it answers. Each open bridge has a token; the host mounts one route
 * that answers them all and takes the token from the path or from the bearer header. A bridge
 * opens with its call or turn and closes with it: a closed token is not found.
 *
 * Only MCP happens here: list the tools, call one, turn its result into MCP content. What a person
 * sees of a call (an activity line, a card that asks, a held approval) is the host's, in the
 * tool's `execute`.
 */

export type { Bridge, BridgeTool } from "../clients/model.js";

/** One open bridge: its token and how to close it. */
export interface OpenBridge {
  token: string;
  close(): void;
}

interface Open {
  handler: { fetch(request: Request): Promise<Response> };
  closed: AbortController;
}

const textOf = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);

type Part = { type: string; text?: string; data?: string; mediaType?: string; value?: unknown };

/** One part of a tool's `content` output as an MCP block: text, or a picture. */
function blockOf(part: Part): ContentBlock {
  if (part.type === "text") {
    return { type: "text", text: part.text ?? "" };
  }
  if (
    (part.type === "image-data" || part.type === "file-data" || part.type === "media") &&
    (part.type === "image-data" || part.mediaType?.startsWith("image/"))
  ) {
    return { type: "image", data: part.data ?? "", mimeType: part.mediaType ?? "image/png" };
  }
  return { type: "text", text: textOf(part) };
}

/**
 * A tool's result as MCP content. With `toModelOutput`, what it shapes: `text`, `json`, `content`
 * (text and pictures), `error-text` and `error-json` as a failed result. Without it, a string as
 * text and anything else as JSON.
 */
export function contentOf(
  tool: Pick<BridgeTool, "toModelOutput">,
  output: unknown,
): CallToolResult {
  const shaped = (tool.toModelOutput?.(output) ?? undefined) as Part | undefined;
  if (!shaped || typeof shaped !== "object" || !("type" in shaped)) {
    return { content: [{ type: "text", text: textOf(output) }] };
  }
  switch (shaped.type) {
    case "content":
      return { content: ((shaped.value as Part[]) ?? []).map(blockOf) };
    case "error-text":
    case "error-json":
      return { isError: true, content: [{ type: "text", text: textOf(shaped.value) }] };
    case "text":
    case "json":
      return { content: [{ type: "text", text: textOf(shaped.value) }] };
    default:
      return { content: [{ type: "text", text: textOf(output) }] };
  }
}

const notFound = () =>
  Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message: "This call is over." } },
    { status: 404 },
  );

/** The bearer token of a request, or an empty string. */
export function bearerOf(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
}

/** The bridges a host has open, and the one route that answers them all. */
export class Bridges {
  private readonly open_ = new Map<string, Open>();
  private readonly name: string;
  private readonly version: string;

  constructor(options: { name?: string; version?: string } = {}) {
    this.name = options.name ?? "step";
    this.version = options.version ?? "1";
  }

  /**
   * Opens the tools of one call or turn. `token`: the host's own; left out, 24 random bytes. The
   * tools run in the async context of the code that opens the bridge (its tenant, its person),
   * however the client's requests arrive.
   */
  open(tools: BridgeTool[], options: { token?: string } = {}): OpenBridge {
    const token = options.token ?? randomBytes(24).toString("base64url");
    const inCall = AsyncLocalStorage.snapshot();
    const closed = new AbortController();
    const handler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: this.name, version: this.version },
          { capabilities: { tools: {} } },
        );
        for (const tool of tools) {
          server.registerTool(
            tool.name,
            {
              description: tool.description,
              inputSchema: fromJsonSchema(tool.inputSchema as any),
            },
            (async (args: unknown, ctx: { mcpReq?: { signal?: AbortSignal } }) => {
              const signal = ctx?.mcpReq?.signal
                ? AbortSignal.any([closed.signal, ctx.mcpReq.signal])
                : closed.signal;
              try {
                return contentOf(tool, await inCall(() => tool.execute(args, { signal })));
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
    this.open_.set(token, { handler, closed });
    return {
      token,
      close: () => {
        const entry = this.open_.get(token);
        if (entry) {
          this.open_.delete(token);
          entry.closed.abort();
        }
      },
    };
  }

  /**
   * Answers one MCP request of an open bridge. The token is `token` where the host took it from
   * the path, else the request's bearer. A closed or unknown token is not found.
   */
  fetch(request: Request, token?: string): Promise<Response> {
    const entry = this.open_.get(token ?? bearerOf(request));
    return entry ? entry.handler.fetch(request) : Promise.resolve(notFound());
  }

  /**
   * The `bridge` of ClientModel: each call opens its tools at `<baseUrl>/<token>`, for clients
   * that take a URL and no header. The host routes `<baseUrl>/:token` to `fetch`.
   */
  at(baseUrl: string): Bridge {
    const base = baseUrl.replace(/\/+$/, "");
    return (tools) => {
      const bridge = this.open(tools);
      return { url: `${base}/${bridge.token}`, close: bridge.close };
    };
  }
}

import { type ChatEvent, issuesIn, parseLine, record } from "./chat.js";
import type { Client } from "./client.js";
import { type ClientAuth, type EnvSpec, probeVersion, resolveEnv, run } from "./env.js";
import { clientFailure } from "./failure.js";
import { type ClientAnswer, type ClientCall, ClientModel } from "./model.js";
import { lastJson, runClient } from "./run.js";

/**
 * Claude Code: `claude -p` answers on the person's sign-in — the client's keychain, or the key
 * or token their login shell sets. Tools go over MCP; structured output is validated by the
 * client (`--json-schema`); web search is its own tool.
 */

export const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim() || "claude";

const spec: EnvSpec = {
  id: "claude",
  passThrough:
    /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|CLAUDE_CONFIG_DIR$|AWS_(PROFILE|REGION|DEFAULT_REGION|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$|GOOGLE_APPLICATION_CREDENTIALS$|CLOUD_ML_REGION$)/,
  keyVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  async auth(env): Promise<ClientAuth> {
    try {
      const { stdout } = await run(CLAUDE_BIN, ["auth", "status", "--json"], {
        timeout: 15_000,
        env,
      });
      const status = JSON.parse(stdout.trim()) as { loggedIn?: boolean; authMethod?: string };
      if (!status.loggedIn) {
        return "none";
      }
      return status.authMethod === "api_key" ? "api_key" : "subscription";
    } catch {
      return "none";
    }
  },
};

/** What the client prints last with `--output-format json`. */
export interface ClaudeResult {
  type?: string;
  /** On a failure: why, e.g. error_max_turns, error_during_execution. */
  subtype?: string;
  is_error?: boolean;
  /** On a failure: what went wrong, where the client says. */
  errors?: unknown[];
  result?: unknown;
  structured_output?: unknown;
  session_id?: string;
  stop_reason?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** The client's result as the model call wants it: text (or the structured output as JSON) and usage. */
export function claudeAnswer(event: ClaudeResult): ClientAnswer {
  const u = event.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    text:
      event.structured_output !== undefined
        ? JSON.stringify(event.structured_output)
        : typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result ?? ""),
    usage: {
      input: (u.input_tokens ?? 0) + cacheRead + cacheWrite,
      cacheRead,
      cacheWrite,
      output: u.output_tokens ?? 0,
    },
    meta: { costUsd: event.total_cost_usd ?? 0, turns: event.num_turns ?? 1 },
    sessionId: event.session_id,
    stopReason: event.stop_reason,
  };
}

class ClaudeCodeModel extends ClientModel {
  readonly provider = "claude-code";
  protected override readonly nativeSchema = true;

  protected async invoke(call: ClientCall): Promise<ClientAnswer> {
    const builtin: string[] = [];
    if (call.files.length) {
      builtin.push("Read");
    }
    if (call.webSearch) {
      builtin.push("WebSearch");
    }
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      this.modelId,
      "--tools",
      builtin.join(","),
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
    ];
    if (call.system) {
      args.push("--system-prompt", call.system);
    }
    if (call.effort) {
      args.push("--effort", call.effort);
    }
    if (call.schema) {
      // The CLI checks the schema with no dialects loaded: one that names its own is refused.
      const { $schema: _dialect, ...schema } = call.schema as Record<string, unknown>;
      args.push("--json-schema", JSON.stringify(schema));
    }
    if (call.bridgeUrl) {
      args.push(
        "--mcp-config",
        JSON.stringify({ mcpServers: { step: { type: "http", url: call.bridgeUrl } } }),
      );
    }
    const allowed = [...builtin, ...(call.bridgeUrl ? ["mcp__step"] : [])];
    if (allowed.length) {
      args.push("--allowedTools", allowed.join(","));
    }
    if (call.files.length) {
      args.push("--add-dir", call.dir);
    }
    const { stdout, stderr, code } = await runClient(CLAUDE_BIN, args, {
      cwd: call.dir,
      env: (await resolveEnv(spec)).env,
      signal: call.signal,
      stdin: call.prompt,
    });
    const event = lastJson<ClaudeResult>(stdout);
    if (!event) {
      throw clientFailure(this.client, stderr.trim() || `exit ${code}`);
    }
    if (event.is_error) {
      // A failed run carries no result, only why (subtype) and sometimes what (errors).
      const why = [
        typeof event.result === "string" ? event.result : "",
        event.subtype ?? "",
        ...(event.errors ?? []).map((e) => (typeof e === "string" ? e : JSON.stringify(e))),
        event.num_turns ? `after ${event.num_turns} turns` : "",
      ].filter(Boolean);
      throw clientFailure(
        this.client,
        why.join(" – ") || "error",
        JSON.stringify(event).slice(0, 2000),
      );
    }
    return claudeAnswer(event);
  }
}

export const claude: Client = {
  ...spec,
  id: "claude",
  name: "Claude Code",
  bin: CLAUDE_BIN,
  version: (env) =>
    probeVersion(CLAUDE_BIN, env, (stdout) => stdout.trim().split(/\s+/)[0] || stdout.trim()),
  login: { args: ["auth", "login"], interactive: false },
  model: (alias, options) => new ClaudeCodeModel(claude, alias || "sonnet", options),
  args: (call) => [
    // The message comes on stdin, so pictures can go with it.
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // Names a tool as it starts and streams the thinking; whole messages still follow.
    "--include-partial-messages",
    // No built-in tools: `--allowedTools` alone would not take them away.
    "--tools",
    "",
    "--strict-mcp-config",
    ...(call.mcp
      ? ["--mcp-config", call.mcp.configFile ?? "", "--allowedTools", `mcp__${call.mcp.name}`]
      : []),
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--append-system-prompt",
    call.system,
    ...(call.model ? ["--model", call.model] : []),
    ...(call.session ? ["--resume", call.session] : []),
  ],
  stdin: (call) =>
    `${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: call.message },
          ...call.images.map((i) => ({
            type: "image",
            source: { type: "base64", media_type: i.mime, data: i.base64 },
          })),
        ],
      },
    })}\n`,
  events(line) {
    const event = parseLine(line);
    if (!event) {
      return [];
    }
    if (event.type === "stream_event") {
      const e = event.event ?? {};
      if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
        return [
          { kind: "tool", name: String(e.content_block.name ?? ""), args: {}, started: false },
        ];
      }
      if (e.type === "content_block_start" && e.content_block?.type === "thinking") {
        return [{ kind: "thinkingStart" }];
      }
      if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta") {
        return [{ kind: "thinking", text: e.delta.thinking ?? "" }];
      }
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        return [{ kind: "writing", text: String(e.delta.text ?? "") }];
      }
      return [];
    }
    if (event.type === "user") {
      const out: ChatEvent[] = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_result") {
          const text = Array.isArray(block.content)
            ? block.content.find((c: { type?: string }) => c.type === "text")?.text
            : block.content;
          out.push({ kind: "toolDone", issues: issuesIn(text) });
        }
      }
      return out;
    }
    if (event.type === "assistant") {
      const out: ChatEvent[] = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          out.push({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") {
          out.push({
            kind: "tool",
            name: String(block.name ?? ""),
            args: record(block.input),
            started: true,
          });
        }
      }
      return out;
    }
    if (event.type === "result") {
      const out: ChatEvent[] = [];
      if (event.session_id) {
        out.push({ kind: "session", id: String(event.session_id) });
      }
      if (event.is_error) {
        out.push({ kind: "failure", detail: String(event.result ?? "error") });
      } else if (typeof event.result === "string") {
        out.push({ kind: "result", text: event.result });
      }
      return out;
    }
    return [];
  },
  signedOut: (detail) => /authenticat|log ?in|oauth|credential/i.test(detail),
};

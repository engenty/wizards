import type { Effort, TextClass } from "@engenty-wizards/shared/definition";
import { note } from "@engenty-wizards/shared/run";
import { resolveEnv, run } from "./env.js";
import {
  failureOf,
  type HarnessAnswer,
  type HarnessCall,
  HarnessModel,
  lastJson,
  runClient,
} from "./model.js";
import type { EnvSpec, Harness, HarnessAuth } from "./types.js";

/**
 * Claude Code: `claude -p` answers on the person's sign-in — the client's keychain, or the key
 * or token their login shell sets. Tools go over MCP; structured output is validated by the
 * client (`--json-schema`); web search is its own tool.
 */

export const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim() || "claude";

const CLASSES: Record<TextClass, string> = {
  classifier: "haiku",
  standard: "sonnet",
  high: "opus",
  highest: "opus",
};

const spec: EnvSpec = {
  id: "claude",
  passThrough:
    /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|CLAUDE_CONFIG_DIR$|AWS_(PROFILE|REGION|DEFAULT_REGION|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$|GOOGLE_APPLICATION_CREDENTIALS$|CLOUD_ML_REGION$)/,
  keyVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  async auth(env): Promise<HarnessAuth> {
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

export async function claudeEnv(): Promise<NodeJS.ProcessEnv> {
  return (await resolveEnv(spec)).env;
}

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
export function claudeAnswer(event: ClaudeResult): HarnessAnswer {
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

class ClaudeCodeModel extends HarnessModel {
  readonly provider = "claude-code";
  protected override readonly nativeSchema = true;

  protected async invoke(call: HarnessCall): Promise<HarnessAnswer> {
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
      args.push("--json-schema", JSON.stringify(call.schema));
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
      env: await claudeEnv(),
      signal: call.signal,
      stdin: call.prompt,
    });
    const event = lastJson<ClaudeResult>(stdout);
    if (!event) {
      throw failureOf(this.harness, stderr.trim() || `exit ${code}`);
    }
    if (event.is_error) {
      // A failed run carries no result, only why (subtype) and sometimes what (errors).
      const why = [
        typeof event.result === "string" ? event.result : "",
        event.subtype ?? "",
        ...(event.errors ?? []).map((e) => (typeof e === "string" ? e : JSON.stringify(e))),
        event.num_turns ? `after ${event.num_turns} turns` : "",
      ].filter(Boolean);
      console.warn("[claude] the client failed:", JSON.stringify(event).slice(0, 2000));
      throw failureOf(this.harness, why.join(" – ") || "error");
    }
    return claudeAnswer(event);
  }
}

export const claude: Harness = {
  ...spec,
  name: "Claude Code",
  bin: CLAUDE_BIN,
  classes: CLASSES,
  async version(env) {
    try {
      const { stdout } = await run(CLAUDE_BIN, ["--version"], { timeout: 5000, env });
      return stdout.trim().split(/\s+/)[0] || stdout.trim();
    } catch {
      return null;
    }
  },
  login: { args: ["auth", "login"], interactive: false },
  model: (alias: string, effort?: Effort) => new ClaudeCodeModel(claude, alias || "sonnet", effort),
  exhausted: note("anthropicAccountClaudeCode"),
};

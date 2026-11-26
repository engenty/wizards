import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { issuesIn, parseLine, record } from "./chat.js";
import type { Client } from "./client.js";
import { type ClientAuth, type EnvSpec, probeVersion, resolveEnv, run } from "./env.js";
import { clientFailure } from "./failure.js";
import { type ClientAnswer, type ClientCall, ClientModel } from "./model.js";
import { runClient } from "./run.js";

/**
 * Codex: `codex exec` answers on the ChatGPT sign-in kept in CODEX_HOME. The person's own
 * config is left out so none of their MCP servers start for a call; tools go over MCP through
 * a config override; structured output is validated by the client (`--output-schema`).
 */

export const CODEX_BIN = process.env.CODEX_BIN?.trim() || "codex";

const spec: EnvSpec = {
  id: "codex",
  passThrough: /^CODEX_HOME$/,
  keyVars: [],
  async auth(env): Promise<ClientAuth> {
    try {
      const { stdout, stderr } = await run(CODEX_BIN, ["login", "status"], {
        timeout: 15_000,
        env,
      });
      const text = `${stdout}\n${stderr}`;
      if (/not logged in/i.test(text)) {
        return "none";
      }
      if (/api key/i.test(text)) {
        return "api_key";
      }
      return /logged in/i.test(text) ? "subscription" : "none";
    } catch {
      return "none";
    }
  },
};

/** One line of `codex exec --json`. */
export interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string } | string;
  message?: string;
  thread_id?: string;
}

/** The events of one run as the model call wants them: the last agent message and the usage. */
export function codexAnswer(stdout: string): {
  answer: ClientAnswer | null;
  failure: string | null;
} {
  let text: string | null = null;
  let usage: ClientAnswer["usage"];
  let failure: string | null = null;
  let sessionId: string | undefined;
  for (const line of stdout.split("\n")) {
    let event: CodexEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started") {
      sessionId = event.thread_id;
    } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
      text = event.item.text ?? "";
    } else if (event.type === "turn.completed") {
      const u = event.usage ?? {};
      usage = {
        input: u.input_tokens ?? 0,
        cacheRead: u.cached_input_tokens ?? 0,
        cacheWrite: u.cache_write_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      };
    } else if (event.type === "turn.failed" || event.type === "error") {
      failure =
        typeof event.error === "string"
          ? event.error
          : (event.error?.message ?? event.message ?? "error");
    }
  }
  return {
    answer: text === null ? null : { text, usage, sessionId },
    failure,
  };
}

/** The arguments every headless `codex exec` starts with: read-only, no approvals, nothing of the person's config. */
export function codexExecArgs(dir: string, webSearch: boolean): string[] {
  return [
    "exec",
    "-",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-s",
    "read-only",
    "-C",
    dir,
    "-c",
    'approval_policy="never"',
    "-c",
    `web_search="${webSearch ? "live" : "disabled"}"`,
  ];
}

class CodexModel extends ClientModel {
  readonly provider = "codex";
  protected override readonly nativeSchema = true;

  protected async invoke(call: ClientCall): Promise<ClientAnswer> {
    const args = codexExecArgs(call.dir, call.webSearch);
    if (this.modelId !== "default") {
      args.push("-m", this.modelId);
    }
    if (call.effort) {
      args.push("-c", `model_reasoning_effort="${call.effort}"`);
    }
    if (call.system) {
      // A JSON string is a TOML basic string: the instructions travel as one config value.
      args.push("-c", `developer_instructions=${JSON.stringify(call.system)}`);
    }
    if (call.bridgeUrl) {
      args.push(
        "-c",
        `mcp_servers.step.url="${call.bridgeUrl}"`,
        "-c",
        "mcp_servers.step.startup_timeout_sec=30",
        "-c",
        "mcp_servers.step.tool_timeout_sec=600",
        // The tools are the host's own: they run without the client asking anyone.
        "-c",
        'mcp_servers.step.default_tools_approval_mode="approve"',
      );
    }
    if (call.schema) {
      const file = join(call.dir, "schema.json");
      writeFileSync(file, JSON.stringify(call.schema));
      args.push("--output-schema", file);
    }
    const { stdout, stderr, code } = await runClient(CODEX_BIN, args, {
      cwd: call.dir,
      env: (await resolveEnv(spec)).env,
      signal: call.signal,
      stdin: call.prompt,
    });
    const { answer, failure } = codexAnswer(stdout);
    if (failure || !answer) {
      throw clientFailure(this.client, failure ?? stderr.trim() ?? `exit ${code}`);
    }
    return answer;
  }
}

/** The Codex features that bring tools of their own; the chat works through MCP only. */
const CODEX_TOOLS_OFF = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "browser_use",
  "in_app_browser",
  "computer_use",
  "image_generation",
  "multi_agent",
  "goals",
  "sleep_tool",
  "tool_suggest",
  "skill_search",
  "memories",
];

export const codex: Client = {
  ...spec,
  id: "codex",
  name: "Codex",
  bin: CODEX_BIN,
  tools: true,
  version: (env) =>
    probeVersion(CODEX_BIN, env, (stdout) => {
      const words = stdout.trim().split(/\s+/);
      return words[words.length - 1] || null;
    }),
  login: { args: ["login"], interactive: false },
  model: (alias, options) => new CodexModel(codex, alias || "default", options),
  args(call) {
    const mcp = call.mcp;
    const options = [
      "--json",
      "--skip-git-repo-check",
      ...(call.model ? ["-m", call.model] : []),
      // Only the host's tools: none of the person's own MCP servers start.
      "--ignore-user-config",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'approval_policy="never"',
      "-c",
      'web_search="disabled"',
      // `-c features.…` rather than `--disable`: a feature a later Codex drops is only ignored.
      ...CODEX_TOOLS_OFF.flatMap((f) => ["-c", `features.${f}=false`]),
      // A JSON string is a TOML basic string: the instructions travel as one config value.
      "-c",
      `developer_instructions=${JSON.stringify(call.system)}`,
      ...(mcp
        ? [
            "-c",
            `mcp_servers.${mcp.name}.url=${JSON.stringify(mcp.url)}`,
            // The key comes from the environment, not the command line, where any process could read it.
            "-c",
            `mcp_servers.${mcp.name}.bearer_token_env_var="${mcp.keyVar}"`,
            "-c",
            `mcp_servers.${mcp.name}.startup_timeout_sec=30`,
            "-c",
            `mcp_servers.${mcp.name}.tool_timeout_sec=600`,
            // The tools are the host's own: they run without the client asking anyone.
            "-c",
            `mcp_servers.${mcp.name}.default_tools_approval_mode="approve"`,
          ]
        : []),
    ];
    // `-i` takes several files, so the pictures come last, after the prompt ("-" = stdin).
    const images = call.images.flatMap((i) => ["-i", i.file]);
    return call.session
      ? ["exec", "resume", call.session, "-", ...options, ...images]
      : ["exec", "-", ...options, ...images];
  },
  stdin: (call) => call.message,
  events(line) {
    const event = parseLine(line);
    if (!event) {
      return [];
    }
    const item = event.item ?? {};
    if (event.type === "thread.started" && event.thread_id) {
      return [{ kind: "session", id: String(event.thread_id) }];
    }
    if (item.type === "mcp_tool_call" && event.type === "item.started") {
      return [
        {
          kind: "tool",
          name: String(item.tool ?? ""),
          args: record(item.arguments),
          started: true,
        },
      ];
    }
    if (item.type === "mcp_tool_call" && event.type === "item.completed") {
      const text = (item.result?.content ?? []).find((c: { type?: string }) => c.type === "text");
      return [{ kind: "toolDone", issues: issuesIn(text?.text) }];
    }
    if (event.type === "item.completed" && item.type === "agent_message" && item.text?.trim()) {
      // A message can end in a line break; the turn puts one blank line between messages.
      return [{ kind: "text", text: String(item.text).trim() }];
    }
    if (event.type === "item.completed" && item.type === "reasoning" && item.text) {
      return [
        { kind: "thinkingStart" },
        { kind: "thinking", text: String(item.text), whole: true },
      ];
    }
    if (event.type === "turn.failed") {
      const error = event.error;
      return [
        {
          kind: "failure",
          detail: typeof error === "string" ? error : String(error?.message ?? "error"),
        },
      ];
    }
    // A top-level `error` is often a retry ("Reconnecting... 1/5"); turn.failed ends the turn.
    return [];
  },
  signedOut: (detail) =>
    /\b401\b|unauthori[sz]ed|not logged in|codex login|authenticat|log ?in/i.test(detail),
};

import { CLAUDE_BIN } from "../harness/claude.js";
import { CODEX_BIN } from "../harness/codex.js";
import { CURSOR_BIN } from "../harness/cursor.js";

/**
 * How each installed client answers one turn of the studio chat: the command line, what goes
 * on stdin, and what its output lines mean. Every client reaches only this server's MCP tools
 * (named `wizards`) and keeps the conversation itself; the turn keeps the id it reports.
 */
export type SubscriptionClient = "claude" | "codex" | "cursor";

export const SUBSCRIPTION_CLIENTS: readonly SubscriptionClient[] = ["claude", "codex", "cursor"];

/** What one turn hands the client. */
export interface ChatCall {
  /** The instructions the architect works by. */
  system: string;
  message: string;
  /** The conversation to continue, as the client named it last time. */
  session: string | null;
  /** This server's MCP endpoint. */
  mcpUrl: string;
  /** The folder the client runs in: Claude's MCP config, Cursor's workspace. */
  dir: string;
  /** Claude: the MCP config file. */
  mcpConfigFile?: string;
  /** The pictures pasted with the message: base64 for Claude, files for Codex. */
  images: { mime: string; base64: string; file: string }[];
}

/** What one line of the client's output says. */
export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; started: boolean }
  | { kind: "thinkingStart" }
  | { kind: "thinking"; text: string }
  | { kind: "session"; id: string }
  | { kind: "failure"; detail: string }
  /** The client's own summary of the answer, used where no text came before it. */
  | { kind: "result"; text: string };

export interface ChatClient {
  id: SubscriptionClient;
  name: string;
  bin: string;
  args(call: ChatCall): string[];
  stdin(call: ChatCall): string;
  events(line: string): ChatEvent[];
  /** Whether a failure the client reports means its sign-in is missing or expired. */
  signedOut(detail: string): boolean;
}

/** The environment variable Codex reads this server's bearer key from. */
export const CODEX_KEY_VAR = "WIZARDS_MCP_KEY";

function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

const claude: ChatClient = {
  id: "claude",
  name: "Claude Code",
  bin: CLAUDE_BIN,
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
    "--mcp-config",
    call.mcpConfigFile ?? "",
    "--allowedTools",
    "mcp__wizards",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--append-system-prompt",
    call.system,
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
    const event = parse(line);
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
      return [];
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

const codex: ChatClient = {
  id: "codex",
  name: "Codex",
  bin: CODEX_BIN,
  args(call) {
    const options = [
      "--json",
      "--skip-git-repo-check",
      // Only this server's tools: none of the person's own MCP servers start.
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
      "-c",
      `mcp_servers.wizards.url=${JSON.stringify(call.mcpUrl)}`,
      // The key comes from the environment, not the command line, where any process could read it.
      "-c",
      `mcp_servers.wizards.bearer_token_env_var="${CODEX_KEY_VAR}"`,
      "-c",
      "mcp_servers.wizards.startup_timeout_sec=30",
      "-c",
      "mcp_servers.wizards.tool_timeout_sec=600",
      // The tools are this server's own: they run without the client asking anyone.
      "-c",
      'mcp_servers.wizards.default_tools_approval_mode="approve"',
    ];
    // `-i` takes several files, so the pictures come last, after the prompt ("-" = stdin).
    const images = call.images.flatMap((i) => ["-i", i.file]);
    return call.session
      ? ["exec", "resume", call.session, "-", ...options, ...images]
      : ["exec", "-", ...options, ...images];
  },
  stdin: (call) => call.message,
  events(line) {
    const event = parse(line);
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
    if (event.type === "item.completed" && item.type === "agent_message" && item.text?.trim()) {
      // A message can end in a line break; the turn puts one blank line between messages.
      return [{ kind: "text", text: String(item.text).trim() }];
    }
    if (event.type === "item.completed" && item.type === "reasoning" && item.text) {
      return [{ kind: "thinkingStart" }, { kind: "thinking", text: String(item.text) }];
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

const cursor: ChatClient = {
  id: "cursor",
  name: "Cursor Agent",
  bin: CURSOR_BIN,
  // The workspace (call.dir) holds the instructions as AGENTS.md, the MCP server and the
  // permissions in .cursor/: see cursorWorkspace().
  args: (call) => [
    "-p",
    "--output-format",
    "stream-json",
    "--workspace",
    call.dir,
    "--approve-mcps",
    ...(call.session ? ["--resume", call.session] : []),
  ],
  stdin: (call) => call.message,
  events(line) {
    const event = parse(line);
    if (!event) {
      return [];
    }
    const out: ChatEvent[] = [];
    if (event.type === "system" && event.session_id) {
      out.push({ kind: "session", id: String(event.session_id) });
    } else if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          out.push({ kind: "text", text: block.text });
        }
      }
    } else if (event.type === "tool_call" && event.subtype === "started") {
      const call = record(event.tool_call);
      // The call as its protobuf JSON: { mcpToolCall: { args: { toolName, args, … } } }.
      const mcp = record(record(call.mcpToolCall).args);
      if (mcp.toolName || mcp.name) {
        out.push({
          kind: "tool",
          name: String(mcp.toolName ?? mcp.name),
          args: record(mcp.args),
          started: true,
        });
      }
    } else if (event.type === "thinking" && event.subtype === "delta") {
      out.push({ kind: "thinking", text: String(event.text ?? "") });
    } else if (event.type === "result") {
      if (event.session_id) {
        out.push({ kind: "session", id: String(event.session_id) });
      }
      if (event.is_error) {
        out.push({ kind: "failure", detail: String(event.result ?? "error") });
      } else if (typeof event.result === "string") {
        out.push({ kind: "result", text: event.result });
      }
    }
    return out;
  },
  signedOut: (detail) => /authenticat|log ?in|CURSOR_API_KEY|unauthori[sz]ed|\b401\b/i.test(detail),
};

export const CHAT_CLIENTS: Record<SubscriptionClient, ChatClient> = { claude, codex, cursor };

/**
 * Cursor Agent's workspace files: the instructions, this server as its MCP server, and the
 * permissions. The CLI also loads the servers of ~/.cursor/mcp.json and `--approve-mcps`
 * approves them all, so each of those is denied by name; a deny wins over an allow.
 */
export function cursorWorkspace(input: {
  system: string;
  mcpUrl: string;
  key: string;
  /** The server names in the person's own ~/.cursor/mcp.json. */
  ownServers: string[];
}): Record<string, string> {
  return {
    "AGENTS.md": input.system,
    ".cursor/mcp.json": JSON.stringify({
      mcpServers: {
        wizards: { url: input.mcpUrl, headers: { Authorization: `Bearer ${input.key}` } },
      },
    }),
    ".cursor/cli.json": JSON.stringify({
      permissions: {
        allow: ["Mcp(wizards:*)"],
        deny: [
          "Shell(*)",
          "Read(**)",
          "Write(**)",
          ...input.ownServers.filter((s) => s !== "wizards").map((s) => `Mcp(${s}:*)`),
        ],
      },
    }),
  };
}

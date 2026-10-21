import { describe, expect, it } from "vitest";
import {
  CHAT_CLIENTS,
  type ChatCall,
  CODEX_KEY_VAR,
  cursorWorkspace,
} from "../src/agents/chat-clients";

const call = (over: Partial<ChatCall> = {}): ChatCall => ({
  system: 'Work on wizard "w1".\nAnswer briefly.',
  message: "Bau etwas",
  session: null,
  mcpUrl: "http://127.0.0.1:4000/api/mcp",
  dir: "/data/subscription",
  mcpConfigFile: "/data/subscription/mcp.json",
  images: [],
  ...over,
});

/** The values of every `-c key=value` pair. */
const configs = (args: string[]) =>
  args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));

describe("Claude Code in the studio chat", () => {
  const claude = CHAT_CLIENTS.claude;

  it("gets no tools of its own and only our MCP server", () => {
    const args = claude.args(call());
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/data/subscription/mcp.json");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__wizards");
    expect(args).not.toContain("--resume");
    expect(claude.args(call({ session: "s-1" }))).toEqual(
      expect.arrayContaining(["--resume", "s-1"]),
    );
  });

  it("names a tool, the text and the session from its stream", () => {
    expect(
      claude.events(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "mcp__wizards__edit_wizard", input: { path: "a.md" } },
              { type: "text", text: "Fertig." },
            ],
          },
        }),
      ),
    ).toEqual([
      { kind: "tool", name: "mcp__wizards__edit_wizard", args: { path: "a.md" }, started: true },
      { kind: "text", text: "Fertig." },
    ]);
    expect(
      claude.events(JSON.stringify({ type: "result", is_error: true, session_id: "s", result: "x" })),
    ).toEqual([
      { kind: "session", id: "s" },
      { kind: "failure", detail: "x" },
    ]);
  });

  it("knows a missing sign-in", () => {
    expect(claude.signedOut("Invalid API key · Please run /login")).toBe(true);
    expect(claude.signedOut("OAuth token has expired")).toBe(true);
    expect(claude.signedOut("error_max_turns")).toBe(false);
  });
});

describe("Codex in the studio chat", () => {
  const codex = CHAT_CLIENTS.codex;

  it("runs read-only with our MCP server, its key from the environment", () => {
    const args = codex.args(call());
    expect(args.slice(0, 2)).toEqual(["exec", "-"]);
    expect(args).toContain("--ignore-user-config");
    expect(args).not.toContain("--ephemeral");
    const c = configs(args);
    expect(c).toEqual(
      expect.arrayContaining([
        'sandbox_mode="read-only"',
        'approval_policy="never"',
        'web_search="disabled"',
        "features.shell_tool=false",
        "features.unified_exec=false",
        'mcp_servers.wizards.url="http://127.0.0.1:4000/api/mcp"',
        `mcp_servers.wizards.bearer_token_env_var="${CODEX_KEY_VAR}"`,
        'mcp_servers.wizards.default_tools_approval_mode="approve"',
      ]),
    );
    // The instructions are one TOML string, line breaks and quotes escaped.
    expect(c).toContain(`developer_instructions=${JSON.stringify(call().system)}`);
    // No key on the command line.
    expect(args.join(" ")).not.toMatch(/Bearer|wiz_/);
  });

  it("continues a conversation and attaches pictures after the prompt", () => {
    const args = codex.args(
      call({
        session: "01a1-thread",
        images: [{ mime: "image/png", base64: "", file: "/data/subscription/images/a.png" }],
      }),
    );
    expect(args.slice(0, 4)).toEqual(["exec", "resume", "01a1-thread", "-"]);
    expect(args.slice(-2)).toEqual(["-i", "/data/subscription/images/a.png"]);
    expect(codex.stdin(call())).toBe("Bau etwas");
  });

  it("reads its JSON lines", () => {
    const lines = [
      { type: "thread.started", thread_id: "t-1" },
      {
        type: "item.started",
        item: {
          id: "item_1",
          type: "mcp_tool_call",
          server: "wizards",
          tool: "edit_wizard",
          arguments: { path: "wizard.json" },
          status: "in_progress",
        },
      },
      { type: "item.completed", item: { id: "item_2", type: "reasoning", text: "**Planning**" } },
      { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "Erledigt." } },
      { type: "item.completed", item: { id: "item_0", type: "error", message: "ignored setting" } },
      { type: "error", message: "Reconnecting... 1/5 (401 Unauthorized)" },
      { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } },
    ].flatMap((l) => codex.events(JSON.stringify(l)));
    expect(lines).toEqual([
      { kind: "session", id: "t-1" },
      { kind: "tool", name: "edit_wizard", args: { path: "wizard.json" }, started: true },
      { kind: "thinkingStart" },
      { kind: "thinking", text: "**Planning**" },
      { kind: "text", text: "Erledigt." },
      { kind: "failure", detail: "unexpected status 401 Unauthorized" },
    ]);
  });

  it("knows a missing sign-in", () => {
    expect(
      codex.signedOut(
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      ),
    ).toBe(true);
    expect(codex.signedOut("Not logged in")).toBe(true);
    expect(
      codex.signedOut("thread/resume failed: no rollout found for thread id 01a1 (code -32600)"),
    ).toBe(false);
  });
});

describe("Cursor Agent in the studio chat", () => {
  const cursor = CHAT_CLIENTS.cursor;

  it("works in the wizard's workspace and continues its chat", () => {
    expect(cursor.args(call({ dir: "/data/subscription/cursor/w1" }))).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--workspace",
      "/data/subscription/cursor/w1",
      "--approve-mcps",
    ]);
    expect(cursor.args(call({ session: "chat-9" })).slice(-2)).toEqual(["--resume", "chat-9"]);
  });

  it("allows our MCP server only and denies the person's own", () => {
    const files = cursorWorkspace({
      system: "Work on w1.",
      mcpUrl: "http://127.0.0.1:4000/api/mcp",
      key: "wiz_k",
      ownServers: ["engenty-wizards", "github", "wizards"],
    });
    expect(files["AGENTS.md"]).toBe("Work on w1.");
    expect(JSON.parse(files[".cursor/mcp.json"])).toEqual({
      mcpServers: {
        wizards: {
          url: "http://127.0.0.1:4000/api/mcp",
          headers: { Authorization: "Bearer wiz_k" },
        },
      },
    });
    expect(JSON.parse(files[".cursor/cli.json"]).permissions).toEqual({
      allow: ["Mcp(wizards:*)"],
      deny: ["Shell(*)", "Read(**)", "Write(**)", "Mcp(engenty-wizards:*)", "Mcp(github:*)"],
    });
  });

  it("reads its stream", () => {
    const lines = [
      { type: "system", subtype: "init", session_id: "c-1", model: "auto" },
      { type: "thinking", subtype: "delta", text: "Reading the wizard." },
      {
        type: "tool_call",
        subtype: "started",
        call_id: "1",
        tool_call: {
          mcpToolCall: {
            args: {
              name: "wizards-get_wizard",
              args: { id: "w1" },
              toolName: "get_wizard",
              providerIdentifier: "wizards",
            },
          },
        },
      },
      { type: "tool_call", subtype: "completed", call_id: "1", tool_call: {} },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Ok." }] } },
      { type: "result", subtype: "success", is_error: false, result: "Ok.", session_id: "c-1" },
    ].flatMap((l) => cursor.events(JSON.stringify(l)));
    expect(lines).toEqual([
      { kind: "session", id: "c-1" },
      { kind: "thinking", text: "Reading the wizard." },
      { kind: "tool", name: "get_wizard", args: { id: "w1" }, started: true },
      { kind: "text", text: "Ok." },
      { kind: "session", id: "c-1" },
      { kind: "result", text: "Ok." },
    ]);
  });

  it("knows a missing sign-in", () => {
    expect(
      cursor.signedOut(
        "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.",
      ),
    ).toBe(true);
    expect(cursor.signedOut("Error: chat not found")).toBe(false);
  });
});

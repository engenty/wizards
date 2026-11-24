import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChatEvent, issuesIn, parseLine, record } from "./chat.js";
import type { Client } from "./client.js";
import { type ClientAuth, type EnvSpec, probeVersion, resolveEnv, run } from "./env.js";
import { clientFailure } from "./failure.js";
import { type ClientAnswer, type ClientCall, ClientModel } from "./model.js";
import { lastJson, runClient } from "./run.js";

/**
 * Cursor Agent: `cursor-agent -p` answers on the Cursor sign-in. The call's folder is its
 * workspace: the instructions as AGENTS.md, the tools as an MCP server in .cursor/mcp.json.
 * The answer is asked for as JSON where a schema is wanted.
 */

export const CURSOR_BIN = process.env.CURSOR_AGENT_BIN?.trim() || "cursor-agent";

/** The escape sequences a terminal app draws with. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

const spec: EnvSpec = {
  id: "cursor",
  passThrough: /^CURSOR_API_KEY$/,
  keyVars: ["CURSOR_API_KEY"],
  async auth(env): Promise<ClientAuth> {
    try {
      const { stdout, stderr } = await run(CURSOR_BIN, ["status"], { timeout: 15_000, env });
      // The client draws on the terminal even here: the control sequences are taken out.
      const text = `${stdout}\n${stderr}`.replace(ANSI, "");
      if (/not logged in/i.test(text) || !/logged in/i.test(text)) {
        return "none";
      }
      return env.CURSOR_API_KEY ? "api_key" : "subscription";
    } catch {
      return "none";
    }
  },
};

/** What the client prints with `--output-format json`. */
export interface CursorResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  session_id?: string;
  duration_ms?: number;
}

class CursorModel extends ClientModel {
  readonly provider = "cursor-agent";

  protected async invoke(call: ClientCall): Promise<ClientAnswer> {
    if (call.system) {
      writeFileSync(join(call.dir, "AGENTS.md"), call.system);
    }
    if (call.bridgeUrl) {
      mkdirSync(join(call.dir, ".cursor"), { recursive: true });
      writeFileSync(
        join(call.dir, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { step: { url: call.bridgeUrl } } }),
      );
      // The call's tools are all on the bridge: the client runs no commands and writes no files.
      writeFileSync(
        join(call.dir, ".cursor", "cli.json"),
        JSON.stringify({
          permissions: { allow: ["Mcp(step:*)"], deny: ["Shell(*)", "Write(**)"] },
        }),
      );
    }
    const args = ["-p", "--output-format", "json", "--workspace", call.dir, "--approve-mcps"];
    if (this.modelId !== "auto") {
      args.push("--model", this.modelId);
    }
    if (!call.bridgeUrl) {
      // Nothing to work through: the client answers, it does not edit.
      args.push("--mode", "ask");
    }
    const { stdout, stderr, code } = await runClient(CURSOR_BIN, args, {
      cwd: call.dir,
      env: (await resolveEnv(spec)).env,
      signal: call.signal,
      stdin: call.prompt,
    });
    const event = lastJson<CursorResult>(stdout);
    if (!event) {
      throw clientFailure(this.client, stderr.trim() || `exit ${code}`);
    }
    if (event.is_error) {
      throw clientFailure(this.client, String(event.result ?? "error"));
    }
    return {
      text: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? ""),
      sessionId: event.session_id,
      meta: { durationMs: event.duration_ms ?? 0 },
    };
  }
}

export const cursor: Client = {
  ...spec,
  id: "cursor",
  name: "Cursor Agent",
  bin: CURSOR_BIN,
  version: (env) =>
    probeVersion(CURSOR_BIN, env, (stdout) => stdout.trim().split("\n").pop()?.trim() || null),
  login: { args: ["login"], interactive: false },
  model: (alias, options) => new CursorModel(cursor, alias || "auto", options),
  // The workspace (call.dir) holds the instructions as AGENTS.md, the MCP server and the
  // permissions in .cursor/: see cursorWorkspace().
  args: (call) => [
    "-p",
    "--output-format",
    "stream-json",
    "--workspace",
    call.dir,
    ...(call.mcp ? ["--approve-mcps"] : []),
    ...(call.model && call.model !== "auto" ? ["--model", call.model] : []),
    ...(call.session ? ["--resume", call.session] : []),
  ],
  stdin: (call) => call.message,
  events(line) {
    const event = parseLine(line);
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
    } else if (event.type === "tool_call" && event.subtype === "completed") {
      const call = record(record(event.tool_call).mcpToolCall);
      const mcp = record(call.args);
      if (mcp.toolName || mcp.name) {
        const content = record(record(call.result).success).content;
        const first = Array.isArray(content) ? record(content[0]) : {};
        out.push({ kind: "toolDone", issues: issuesIn(record(first.text).text ?? first.text) });
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

/**
 * Cursor Agent's workspace files for a chat: the instructions, the host's MCP server, and the
 * permissions. The CLI also loads the servers of ~/.cursor/mcp.json and `--approve-mcps`
 * approves them all, so each of those is denied by name; a deny wins over an allow.
 */
export function cursorWorkspace(input: {
  system: string;
  /** The host's MCP server, by the name the client knows it by. */
  mcp: { name: string; url: string };
  key: string;
  /** The server names in the person's own ~/.cursor/mcp.json. */
  ownServers: string[];
}): Record<string, string> {
  const { name, url } = input.mcp;
  return {
    "AGENTS.md": input.system,
    ".cursor/mcp.json": JSON.stringify({
      mcpServers: {
        [name]: { url, headers: { Authorization: `Bearer ${input.key}` } },
      },
    }),
    ".cursor/cli.json": JSON.stringify({
      permissions: {
        allow: [`Mcp(${name}:*)`],
        deny: [
          "Shell(*)",
          "Read(**)",
          "Write(**)",
          ...input.ownServers.filter((s) => s !== name).map((s) => `Mcp(${s}:*)`),
        ],
      },
    }),
  };
}

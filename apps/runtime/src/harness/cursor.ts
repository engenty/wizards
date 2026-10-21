import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Effort, TextClass } from "@engenty/wizards-shared/definition";
import { probeVersion, resolveEnv, run } from "./env.js";
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
 * Cursor Agent: `cursor-agent -p` answers on the Cursor sign-in. The call's folder is its
 * workspace: the instructions as AGENTS.md, the tools as an MCP server in .cursor/mcp.json.
 * The answer is asked for as JSON where a schema is wanted.
 */

export const CURSOR_BIN = process.env.CURSOR_AGENT_BIN?.trim() || "cursor-agent";

/** "auto" = the model the client picks itself; a binding `cursor/<model>` names one. */
const CLASSES: Record<TextClass, string> = {
  classifier: "auto",
  standard: "auto",
  high: "auto",
  highest: "auto",
};

/** The escape sequences a terminal app draws with. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

const spec: EnvSpec = {
  id: "cursor",
  passThrough: /^CURSOR_API_KEY$/,
  keyVars: ["CURSOR_API_KEY"],
  async auth(env): Promise<HarnessAuth> {
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

class CursorModel extends HarnessModel {
  readonly provider = "cursor-agent";

  protected async invoke(call: HarnessCall): Promise<HarnessAnswer> {
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
      throw failureOf(this.harness, stderr.trim() || `exit ${code}`);
    }
    if (event.is_error) {
      throw failureOf(this.harness, String(event.result ?? "error"));
    }
    return {
      text: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? ""),
      sessionId: event.session_id,
      meta: { durationMs: event.duration_ms ?? 0 },
    };
  }
}

export const cursor: Harness = {
  ...spec,
  name: "Cursor Agent",
  bin: CURSOR_BIN,
  classes: CLASSES,
  version: (env) =>
    probeVersion(CURSOR_BIN, env, (stdout) => stdout.trim().split("\n").pop()?.trim() || null),
  login: { args: ["login"], interactive: false },
  model: (alias: string, effort?: Effort) => new CursorModel(cursor, alias || "auto", effort),
};

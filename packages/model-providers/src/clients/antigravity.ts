import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChatEvent, parseLine } from "./chat.js";
import type { Client } from "./client.js";
import { type ClientAuth, type EnvSpec, probeVersion, resolveEnv, run } from "./env.js";
import { clientFailure } from "./failure.js";
import { type ClientAnswer, type ClientCall, ClientModel, type Effort } from "./model.js";
import { runClient } from "./run.js";

/**
 * Antigravity CLI: `agy` answers on the Google sign-in it cached — the Google AI subscription,
 * which Gemini CLI no longer serves. The prompt goes on stdin as one stream-json message, the
 * instructions in front of it: the client reads no system prompt and no rules of a folder it
 * does not trust. It searches the web and reads the call's files with its own tools; the step's
 * tools it cannot take, as it reads MCP servers only from the person's own config. The answer
 * is checked against the schema by the client itself.
 */

export const AGY_BIN = process.env.AGY_BIN?.trim() || "agy";

/**
 * The model of that name at the effort a call asks for: the models carry their effort in the
 * name, `gemini-3.8-flash-<low|medium|high>`.
 */
export function withEffort(model: string, effort?: Effort): string {
  return effort ? model.replace(/-(low|medium|high)$/, `-${effort}`) : model;
}

const spec: EnvSpec = {
  id: "antigravity",
  passThrough: /^(AGY_ADC_AUTH|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT)$/,
  keyVars: [],
  // No status command, and a call without a sign-in waits a minute for one in the browser:
  // listing the models is quick, and refuses at once when nobody is signed in.
  async auth(env): Promise<ClientAuth> {
    try {
      await run(AGY_BIN, ["models"], { timeout: 20_000, env });
      return "subscription";
    } catch {
      return "none";
    }
  },
};

/** The `result` event of `agy --output-format stream-json`. */
export interface AntigravityResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  structured_output?: unknown;
  num_turns?: number;
  duration_seconds?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
  };
}

/** The client's result among the events it prints; null when it printed none. */
export function antigravityAnswer(stdout: string): AntigravityResult | null {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const event = JSON.parse(line) as { event?: string; result?: AntigravityResult };
      if (event?.event === "result" && event.result) {
        return event.result;
      }
    } catch {
      // a line it logs
    }
  }
  return null;
}

/** The instructions in front of the prompt: the client takes one message and nothing besides. */
export function antigravityMessage(system: string, request: string): string {
  const content = system ? `<instructions>\n${system}\n</instructions>\n\n${request}` : request;
  return `${JSON.stringify({ event: "user", message: { content } })}\n`;
}

class AntigravityModel extends ClientModel {
  readonly provider = "antigravity";
  protected override readonly nativeSchema = true;
  protected override readonly usesTools = false;

  protected async invoke(call: ClientCall): Promise<ClientAnswer> {
    const { env, auth } = await resolveEnv(spec);
    if (auth === "none") {
      throw clientFailure(this.client, "not logged in");
    }
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      ...(this.modelId === "default" ? [] : ["--model", withEffort(this.modelId, call.effort)]),
      "--disable-slash-commands",
    ];
    if (call.schema) {
      const schemaFile = join(call.dir, "schema.json");
      writeFileSync(schemaFile, JSON.stringify(call.schema));
      args.push("--json-schema", schemaFile);
    }
    const { stdout, stderr, code } = await runClient(AGY_BIN, args, {
      cwd: call.dir,
      env: { ...env, NO_COLOR: "1" },
      signal: call.signal,
      stdin: antigravityMessage(call.system, call.prompt),
    });
    const result = antigravityAnswer(stdout);
    if (!result) {
      throw clientFailure(this.client, stderr.trim() || `exit ${code}`);
    }
    if (result.status !== "SUCCESS") {
      throw clientFailure(this.client, result.error || stderr.trim() || result.status || "error");
    }
    const u = result.usage ?? {};
    return {
      text:
        result.structured_output !== undefined
          ? JSON.stringify(result.structured_output)
          : (result.response ?? ""),
      usage: {
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_tokens ?? 0,
        output: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0),
      },
      sessionId: result.conversation_id,
      meta: { turns: result.num_turns ?? 0, seconds: result.duration_seconds ?? 0 },
    };
  }
}

/** In a chat it only writes: no command, no file, no page, none of the person's own MCP servers. */
const CHAT_SETTINGS = JSON.stringify({
  permissions: {
    deny: [
      "command(*)",
      "read_file(*)",
      "write_file(*)",
      "read_url(*)",
      "execute_url(*)",
      "download_url(*)",
      "mcp(*)",
    ],
  },
});

/** What one line of `agy --output-format stream-json` says. */
interface AntigravityEvent {
  event?: string;
  conversation_id?: string;
  step_update?: { conversation_id?: string; step_type?: string; text_delta?: string };
  result?: AntigravityResult;
}

export const antigravity: Client = {
  ...spec,
  id: "antigravity",
  name: "Antigravity",
  bin: AGY_BIN,
  tools: false,
  version: (env) =>
    probeVersion(AGY_BIN, env, (stdout) => stdout.trim().split("\n").pop()?.trim() || null),
  // No login command: the client asks for the Google sign-in when it starts without one.
  login: { args: [], interactive: true },
  model: (alias, options) => new AntigravityModel(antigravity, alias || "default", options),
  args: (call) => [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--mode",
    "plan",
    "--settings",
    CHAT_SETTINGS,
    ...(call.model ? ["--model", call.model] : []),
    ...(call.session ? ["--conversation", call.session] : []),
  ],
  // A conversation it continues has read the instructions.
  stdin: (call) => antigravityMessage(call.session ? "" : call.system, call.message),
  events(line) {
    const event = parseLine(line) as AntigravityEvent | null;
    const out: ChatEvent[] = [];
    if (event?.event === "init" && event.conversation_id) {
      out.push({ kind: "session", id: event.conversation_id });
    } else if (event?.event === "step_update") {
      const { step_type, text_delta } = event.step_update ?? {};
      if (step_type === "agent_response" && text_delta) {
        out.push({ kind: "writing", text: text_delta });
      }
    } else if (event?.event === "result" && event.result) {
      const { conversation_id, status, error, response } = event.result;
      if (conversation_id) {
        out.push({ kind: "session", id: conversation_id });
      }
      if (status !== "SUCCESS") {
        out.push({ kind: "failure", detail: error || status || "error" });
      } else if (response) {
        out.push({ kind: "result", text: response });
      }
    }
    return out;
  },
  signedOut: (detail) =>
    /authenticat|log ?in|logged in|sign in|unauthori[sz]ed|\b401\b/i.test(detail),
};

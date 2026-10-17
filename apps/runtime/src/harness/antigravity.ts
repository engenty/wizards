import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Effort, TextClass } from "@engenty-wizards/shared/definition";
import { resolveEnv, run } from "./env.js";
import {
  failureOf,
  type HarnessAnswer,
  type HarnessCall,
  HarnessModel,
  runClient,
} from "./model.js";
import type { EnvSpec, Harness, HarnessAuth } from "./types.js";

/**
 * Antigravity CLI: `agy` answers on the Google sign-in it cached — the Google AI subscription,
 * which Gemini CLI no longer serves. The prompt goes on stdin as one stream-json message, the
 * instructions in front of it: the client reads no system prompt and no rules of a folder it
 * does not trust. It searches the web and reads the call's files with its own tools; the step's
 * tools it cannot take, as it reads MCP servers only from the person's own config. The answer
 * is checked against the schema by the client itself.
 */

export const AGY_BIN = process.env.AGY_BIN?.trim() || "agy";

/** The models carry their effort in the name: `gemini-3.8-flash-<low|medium|high>`. */
const CLASSES: Record<TextClass, string> = {
  classifier: "gemini-3.8-flash-low",
  standard: "gemini-3.8-flash-medium",
  high: "gemini-3.8-flash-high",
  highest: "gemini-3.8-flash-high",
};

/** The model of that name at the effort a step asks for, where the name carries one. */
export function withEffort(model: string, effort?: Effort): string {
  return effort ? model.replace(/-(low|medium|high)$/, `-${effort}`) : model;
}

const spec: EnvSpec = {
  id: "antigravity",
  passThrough: /^(AGY_ADC_AUTH|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT)$/,
  keyVars: [],
  // No status command, and a call without a sign-in waits a minute for one in the browser:
  // listing the models is quick, and refuses at once when nobody is signed in.
  async auth(env): Promise<HarnessAuth> {
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
export function antigravityMessage(system: string, prompt: string): string {
  const content = system ? `<instructions>\n${system}\n</instructions>\n\n${prompt}` : prompt;
  return `${JSON.stringify({ event: "user", message: { content } })}\n`;
}

class AntigravityModel extends HarnessModel {
  readonly provider = "antigravity";
  protected override readonly nativeSchema = true;
  protected override readonly usesTools = false;

  protected async invoke(call: HarnessCall): Promise<HarnessAnswer> {
    const { env, auth } = await resolveEnv(spec);
    if (auth === "none") {
      throw failureOf(this.harness, "not logged in");
    }
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      withEffort(this.modelId, call.effort),
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
      throw failureOf(this.harness, stderr.trim() || `exit ${code}`);
    }
    if (result.status !== "SUCCESS") {
      throw failureOf(this.harness, result.error || stderr.trim() || result.status || "error");
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

export const antigravity: Harness = {
  ...spec,
  name: "Antigravity",
  bin: AGY_BIN,
  classes: CLASSES,
  async version(env) {
    try {
      const { stdout } = await run(AGY_BIN, ["--version"], { timeout: 10_000, env });
      return stdout.trim().split("\n").pop()?.trim() || null;
    } catch {
      return null;
    }
  },
  // No login command: the client asks for the Google sign-in when it starts without one.
  login: { args: [], interactive: true },
  model: (alias: string, effort?: Effort) =>
    new AntigravityModel(antigravity, alias || CLASSES.standard, effort),
};

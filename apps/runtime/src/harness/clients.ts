import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLIENTS,
  type Client,
  type ClientImageCall,
  ClientImageModel,
  CODEX_BIN,
  clientFailure,
  codexAnswer,
  codexExecArgs,
  resolveEnv,
  runClient,
} from "@engenty/local-models/clients";
import type { Effort, TextClass } from "@engenty/wizards-shared/definition";
import { note } from "@engenty/wizards-shared/run";
import { prompt } from "../prompts.js";
import { modelOptions } from "./model.js";
import type { Harness } from "./types.js";

/**
 * Claude Code, Codex and Cursor Agent as the runtime runs them: the clients of
 * @engenty/local-models/clients with the model each text class runs on, what the person reads
 * when the account cannot pay, and Codex's images.
 */

/** A client of the package as a harness of the runtime. */
function harnessOf(
  client: Client,
  extra: Pick<Harness, "classes" | "exhausted" | "image">,
): Harness {
  const h: Harness = {
    id: client.id,
    name: client.name,
    bin: client.bin,
    passThrough: client.passThrough,
    keyVars: client.keyVars,
    auth: (env) => client.auth(env),
    version: (env) => client.version(env),
    login: client.login,
    model: (alias: string, effort?: Effort) => client.model(alias, { ...modelOptions(h), effort }),
    ...extra,
  };
  return h;
}

export const claude = harnessOf(CLIENTS.claude, {
  classes: { classifier: "haiku", low: "sonnet", standard: "opus", high: "opus" },
  exhausted: note("anthropicAccountClaudeCode"),
});

/**
 * Models a ChatGPT sign-in runs (checked 2026-10-04): Luna for small calls, Sol as the
 * workhorse, Astra for the hardest work. A binding `codex/<model>` names another;
 * `codex/default` = the model the client picks itself.
 */
const CODEX_CLASSES: Record<TextClass, string> = {
  classifier: "gpt-6-luna",
  low: "gpt-6.1-sol",
  standard: "gpt-6.1-sol",
  high: "gpt-6-astra",
};

/**
 * Images: `codex exec` with the built-in image tool, the reference photos attached with `-i`.
 * Codex keeps what it made under CODEX_HOME/generated_images/<thread>; the file is read from
 * there and that folder removed. `codex/image` runs the tool on the low class's model.
 */
class CodexImageModel extends ClientImageModel {
  readonly provider = "codex";

  protected async invoke(call: ClientImageCall): Promise<Uint8Array> {
    const request = [
      call.prompt,
      call.files.length ? prompt("services", "harness.codex_image.edit") : "",
      call.aspectRatio ? `Aspect ratio: ${call.aspectRatio}.` : "",
      prompt("services", "harness.codex_image.once"),
    ]
      .filter(Boolean)
      .join("\n\n");
    const args = [
      ...codexExecArgs(call.dir, false),
      "-m",
      this.modelId === "image" ? CODEX_CLASSES.low : this.modelId,
    ];
    for (const file of call.files) {
      args.push("-i", file);
    }
    const { env } = await resolveEnv(CLIENTS.codex);
    const { stdout, stderr, code } = await runClient(CODEX_BIN, args, {
      cwd: call.dir,
      env,
      signal: call.signal,
      stdin: request,
    });
    const { answer, failure } = codexAnswer(stdout);
    if (failure || !answer?.sessionId) {
      throw clientFailure(this.client, failure ?? stderr.trim() ?? `exit ${code}`);
    }
    const folder = join(
      env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
      "generated_images",
      answer.sessionId,
    );
    try {
      const made = existsSync(folder)
        ? readdirSync(folder)
            .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
            .map((f) => join(folder, f))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
        : [];
      if (!made[0]) {
        throw new Error(`Codex made no image: ${answer.text.slice(0, 300)}`);
      }
      return new Uint8Array(readFileSync(made[0]));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

export const codex: Harness = harnessOf(CLIENTS.codex, {
  classes: CODEX_CLASSES,
  exhausted: note("chatgptAccountCodexSigned"),
  image: {
    alias: "image",
    model: (alias: string) => new CodexImageModel(codex, alias || "image", modelOptions(codex)),
  },
});

/** "auto" = the model the client picks itself; a binding `cursor/<model>` names one. */
export const cursor = harnessOf(CLIENTS.cursor, {
  classes: { classifier: "auto", low: "auto", standard: "auto", high: "auto" },
});

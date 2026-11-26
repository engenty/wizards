import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { generateText, type LanguageModel } from "ai";
import spawn from "cross-spawn";
import { accountGateway } from "./account.js";
import type { ChatCall } from "./clients/chat.js";
import { resolveEnv } from "./clients/env.js";
import { CLIENTS, type Client, type ClientId } from "./clients/index.js";
import { providerModel } from "./providers/model.js";
import { PROVIDERS, type ProviderId } from "./providers/provider.js";
import {
  fits,
  type InstalledModel,
  SERVERS,
  type ServerId,
  type ServerTrouble,
} from "./servers/index.js";

/**
 * One short, real call per source of models: a tiny prompt, a timeout, and what came of it. A
 * call costs a few tokens, so a host makes it when the person asks or once at setup, never on a
 * timer. The result is a state and the source's own words; each host words it for the person.
 */

/**
 * - `ok`: it answered.
 * - `absent`: the client is not installed, or the server does not answer at the address.
 *   A provider or an account is never absent: without an answer it is `failed`.
 * - `signed_out`: the client is installed but not signed in.
 * - `no_model`: the server runs but holds no model to talk with (or not the one named); the
 *   provider has no models that write text.
 * - `too_big`: the model takes more of the computer's memory than the share allows.
 * - `failed`: it was asked and did not answer; `detail` says what it said.
 */
export type ProbeState = "ok" | "absent" | "signed_out" | "no_model" | "too_big" | "failed";

export interface ProbeResult {
  state: ProbeState;
  /** What the client or the server said, as it said it. */
  detail?: string;
  /** Why a server that runs was not asked. */
  trouble?: ServerTrouble;
  /** The model that was asked, or that would have been. */
  model?: string;
  /** It did not answer within the timeout. */
  timedOut?: boolean;
  /** The HTTP status a provider or an account refused the call with: 401 for a key it does not know. */
  status?: number;
}

export type ProbeSource =
  | {
      kind: "client";
      /** A client by id, or one of the host's own. */
      client: ClientId | Client;
      /** The model by the client's own name; left out, the client picks. */
      model?: string;
      timeoutMs?: number;
    }
  | {
      kind: "server";
      server: ServerId;
      /** The server's address: its root or `…/v1`. */
      url: string;
      /** The model to ask; left out, the one a host would pick first (see `preferredModel`). */
      model?: string;
      /** The computer's memory and the share of it a model may take, in the model sizes' unit (bytes). */
      memory?: number;
      share?: number;
      timeoutMs?: number;
      fetch?: typeof fetch;
    }
  | {
      kind: "provider";
      provider: ProviderId;
      /** The key the person brought. */
      key: string;
      /** The model by the provider's own name; left out, the provider's first (`PROVIDERS`). */
      model?: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    }
  | {
      kind: "account";
      /** The Manage-App's gateway, without `/v4/ai`. */
      url: string;
      key: string;
      /** A class of the account (`wizards/standard`) or a model as the gateway lists it. */
      model: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    };

export const PROMPT = "Answer with the single word ok.";
const SYSTEM = "You check whether you can answer. Answer with one word.";

export const CLIENT_TIMEOUT = 90_000;
export const SERVER_TIMEOUT = 120_000;
export const CLOUD_TIMEOUT = 30_000;

/** Whether the source answers a short call now. */
export function probe(source: ProbeSource): Promise<ProbeResult> {
  switch (source.kind) {
    case "client":
      return probeClient(source);
    case "server":
      return probeServer(source);
    case "provider":
      return probeProvider(source);
    case "account":
      return probeModel(
        accountGateway({ url: source.url, key: source.key, fetch: source.fetch })(source.model),
        source.model,
        source.timeoutMs,
      );
  }
}

function probeProvider(source: Extract<ProbeSource, { kind: "provider" }>): Promise<ProbeResult> {
  const model = source.model ?? PROVIDERS[source.provider].model;
  if (!model) {
    return Promise.resolve({ state: "no_model" });
  }
  const options = source.fetch ? { fetch: source.fetch } : {};
  return probeModel(
    providerModel(source.provider, source.key, model, options),
    model,
    source.timeoutMs,
  );
}

/** One short call to a model that is asked over the network, without a second try. */
async function probeModel(
  model: LanguageModel,
  name: string,
  timeoutMs = CLOUD_TIMEOUT,
): Promise<ProbeResult> {
  try {
    const { text } = await generateText({
      model,
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    return { state: "ok", model: name, detail: text.trim() };
  } catch (error) {
    const failure = error as Error & { statusCode?: number; responseBody?: string };
    if (failure.name === "TimeoutError" || failure.name === "AbortError") {
      return { state: "failed", model: name, timedOut: true };
    }
    const detail = [failure.message, failure.responseBody].filter(Boolean).join(" ").slice(0, 600);
    return {
      state: "failed",
      model: name,
      detail,
      ...(failure.statusCode ? { status: failure.statusCode } : {}),
    };
  }
}

async function probeClient(source: Extract<ProbeSource, { kind: "client" }>): Promise<ProbeResult> {
  const client = typeof source.client === "string" ? CLIENTS[source.client] : source.client;
  const timeout = source.timeoutMs ?? CLIENT_TIMEOUT;
  let env: NodeJS.ProcessEnv;
  try {
    const resolved = await resolveEnv(client);
    if (!(await client.version(resolved.env))) {
      return { state: "absent" };
    }
    if (resolved.auth === "none") {
      return { state: "signed_out" };
    }
    env = resolved.env;
  } catch (error) {
    return { state: "failed", detail: (error as Error).message };
  }
  const dir = mkdtempSync(join(tmpdir(), "model-sources-probe-"));
  const call: ChatCall = {
    system: SYSTEM,
    message: PROMPT,
    session: null,
    dir,
    model: source.model,
    images: [],
  };
  // Cursor Agent reads its instructions from the workspace.
  writeFileSync(join(dir, "AGENTS.md"), SYSTEM);
  try {
    const run = await new Promise<
      { answer: string } | { failure: string; timedOut?: boolean; missing?: boolean }
    >((resolve) => {
      const child = spawn(client.bin, client.args(call), {
        cwd: dir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Claude Code streams the text and then gives it whole; the whole message counts.
      let answer = "";
      let streamed = "";
      let result = "";
      let failed: string | undefined;
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);
      child.stdin?.on("error", () => {
        // The client went away before reading the prompt; `close` reports it.
      });
      child.stdin?.end(client.stdin(call));
      if (child.stdout) {
        createInterface({ input: child.stdout }).on("line", (line) => {
          for (const event of client.events(line)) {
            if (event.kind === "failure") {
              failed = event.detail;
            } else if (event.kind === "text") {
              answer += event.text;
            } else if (event.kind === "writing" && event.text) {
              streamed += event.text;
            } else if (event.kind === "result") {
              result = event.text;
            }
          }
        });
      }
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ failure: error.message, missing: error.code === "ENOENT" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ failure: "", timedOut: true });
        } else if (failed !== undefined) {
          resolve({ failure: failed });
        } else if ((answer || streamed || result).trim()) {
          resolve({ answer: (answer || streamed || result).trim() });
        } else {
          // Some failures reach only the error output, with a code or without.
          resolve({ failure: stderr.trim() || `exit ${code}` });
        }
      });
    });
    if ("answer" in run) {
      return { state: "ok", model: source.model, detail: run.answer };
    }
    if (run.missing) {
      return { state: "absent", detail: run.failure };
    }
    if (run.timedOut) {
      return { state: "failed", timedOut: true, model: source.model };
    }
    return {
      state: client.signedOut(run.failure) ? "signed_out" : "failed",
      detail: run.failure,
      model: source.model,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The model a host asks first among a server's models that write text: one that takes tools, then
 * the largest that fits the computer, then the smallest of those that do not.
 */
export function preferredModel(
  models: InstalledModel[],
  memory = Number.POSITIVE_INFINITY,
  share = 1,
): InstalledModel | undefined {
  const leavesRoom = (model: InstalledModel) => fits(model, memory, share);
  return models
    .filter((m) => m.completion)
    .sort(
      (a, b) =>
        Number(b.tools) - Number(a.tools) ||
        Number(leavesRoom(b)) - Number(leavesRoom(a)) ||
        (leavesRoom(a) ? b.size - a.size : a.size - b.size),
    )[0];
}

async function probeServer(source: Extract<ProbeSource, { kind: "server" }>): Promise<ProbeResult> {
  const server = SERVERS[source.server];
  const options = source.fetch ? { fetch: source.fetch } : {};
  const { running, trouble } = await server.state(source.url, options);
  if (!running) {
    return { state: "absent" };
  }
  if (trouble) {
    return { state: "failed", trouble };
  }
  const models = await server.models(source.url, options);
  const sized = source.memory !== undefined && source.share !== undefined;
  const model = source.model
    ? models.find((m) => m.name === source.model || m.name === `${source.model}:latest`)
    : preferredModel(models, source.memory, source.share);
  if (!model) {
    return { state: "no_model", model: source.model };
  }
  if (sized && !fits(model, source.memory as number, source.share as number)) {
    return { state: "too_big", model: model.name };
  }
  try {
    const signal = AbortSignal.timeout(source.timeoutMs ?? SERVER_TIMEOUT);
    const detail = await server.ask(source.url, model, PROMPT, { ...options, signal });
    return { state: "ok", model: model.name, detail };
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    return {
      state: "failed",
      model: model.name,
      ...(timedOut ? { timedOut } : { detail: (error as Error).message }),
    };
  }
}

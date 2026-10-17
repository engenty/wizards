import { join } from "node:path";
import { createInterface } from "node:readline";
import { LOCAL_CLIENT_HEADER, LOCAL_MCP_HEADER, mintLocalTicket } from "../auth/local-ticket.js";
import type { Running } from "../running.js";
import type { Layout } from "./home.js";
import { readSecret, runningRuntime, settings, startInBackground } from "./start.js";
import { tilde } from "./ui.js";

/**
 * `wizards mcp`: this install's MCP server over stdio, for AI clients that start their
 * servers as a command — Claude Desktop, Cursor, Codex and the ChatGPT app, VS Code, Windsurf,
 * Antigravity, Goose, OpenClaw, LM Studio. Each message goes on to the running runtime's
 * `/api/mcp`, signed with the data folder's secret, so no client's config holds a key and a new
 * port after a restart changes nothing. When nothing runs, the runtime is started.
 *
 * stdout carries only MCP messages; everything else goes to stderr.
 */

type Message = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

/** The JSON-RPC messages of a response: a JSON body (one or a batch) or a server-sent stream. */
export function messagesOf(contentType: string, body: string): Message[] {
  if (!body.trim()) {
    return [];
  }
  if (contentType.includes("text/event-stream")) {
    const out: Message[] = [];
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data.trim()) {
        out.push(JSON.parse(data) as Message);
      }
    }
    return out;
  }
  const parsed = JSON.parse(body) as Message | Message[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function mcp(paths: Layout): Promise<number> {
  const { dataDir } = settings(paths);
  let running: Promise<Running> | null = null;
  let clientName = "";
  let protocolVersion = "";

  const runtime = (): Promise<Running> => {
    running ??= (async () => {
      const found = await runningRuntime(dataDir);
      if (found) {
        return found;
      }
      process.stderr.write("engenty wizards isn’t running. Starting it…\n");
      const started = await startInBackground(paths);
      if (started) {
        return started;
      }
      throw new Error(
        `engenty wizards didn’t start. Its log is in ${tilde(join(paths.logs, "runtime.log"))}.`,
      );
    })();
    running.catch(() => {
      running = null;
    });
    return running;
  };

  const post = async (message: Message): Promise<Message[]> => {
    const at = await runtime();
    const secret = readSecret(paths);
    if (!secret) {
      throw new Error("No secret in the data folder yet. Start engenty wizards once first.");
    }
    const response = await fetch(`http://127.0.0.1:${at.port}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [LOCAL_MCP_HEADER]: mintLocalTicket(secret, Date.now(), "local-mcp"),
        ...(clientName ? { [LOCAL_CLIENT_HEADER]: clientName } : {}),
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(message),
    });
    const body = await response.text();
    if (!response.ok && response.status !== 202) {
      throw new Error(`engenty wizards responded with ${response.status}: ${body.slice(0, 300)}`);
    }
    return messagesOf(response.headers.get("content-type") ?? "", body);
  };

  const write = (message: Message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const handle = async (message: Message) => {
    if (message.method === "initialize") {
      const info = message.params?.clientInfo as { name?: string; title?: string } | undefined;
      clientName = info?.title || info?.name || "";
    }
    let answers: Message[];
    try {
      answers = await post(message);
    } catch (error) {
      // The runtime went away (stopped, restarted on another port): once more, with a fresh look.
      running = null;
      try {
        answers = await post(message);
      } catch {
        if (message.id !== undefined && message.method) {
          write({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: (error as Error).message },
          } as Message);
        }
        process.stderr.write(`${(error as Error).message}\n`);
        return;
      }
    }
    for (const answer of answers) {
      const version = answer.result?.protocolVersion;
      if (message.method === "initialize" && typeof version === "string") {
        protocolVersion = version;
      }
      write(answer);
    }
  };

  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      } as Message);
      continue;
    }
    // Requests are answered as they finish: a long get_run never holds up the next call.
    const job = handle(message).finally(() => pending.delete(job));
    pending.add(job);
  }
  await Promise.all(pending);
  return 0;
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Lang } from "@engenty/wizards-shared/definition";
import { internalKey } from "../auth/keys.js";
import { env } from "../env.js";
import { resolveEnv } from "../harness/env.js";
import { detectHarness, harness, signedOut } from "../harness/index.js";
import { CHAT_WAYS, type ChatWay, chatWayReady, localModelSettings } from "../models.js";
import { prompt } from "../prompts.js";
import { contentPolicy } from "../safety.js";
import { ServiceError } from "../services/errors.js";
import { deleteSetting, readSetting, writeSetting } from "../settings.js";
import { type ServerKey, serverText } from "../texts.js";
import type { ChatImage } from "./architect.js";
import {
  CHAT_CLIENTS,
  type ChatCall,
  CODEX_KEY_VAR,
  cursorWorkspace,
  SUBSCRIPTION_CLIENTS,
  type SubscriptionClient,
} from "./chat-clients.js";
import { thoughtLine } from "./thought.js";

/**
 * The studio chat on the admin's own subscription: an installed client (Claude Code, Codex or
 * Cursor Agent) runs headless and builds the wizard through this server's MCP tools — the same
 * tools any MCP client uses. It gets none of its own tools (no shell, no files), and its sign-in
 * stays with it: this server never sees a subscription token. Runs of wizards go through it as
 * a model (../harness/) when the settings name it as the source.
 */
export type { SubscriptionClient } from "./chat-clients.js";

/** The AI clients installed and signed in on this machine whose subscription can answer the studio chat. */
export async function subscriptionClients(): Promise<SubscriptionClient[]> {
  const found = await Promise.all(
    SUBSCRIPTION_CLIENTS.map(async (id) => {
      const h = await detectHarness(id);
      return h?.version && h.auth !== "none" ? id : null;
    }),
  );
  return found.filter((id): id is SubscriptionClient => id !== null);
}

const workDir = join(env.dataDir, "subscription");

const mcpUrl = () => `http://127.0.0.1:${env.port}/api/mcp`;

/** Claude's MCP config: this server only, signed in with a key made for this process. */
function mcpConfig(): string {
  mkdirSync(workDir, { recursive: true });
  const file = join(workDir, "mcp.json");
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        wizards: {
          type: "http",
          url: mcpUrl(),
          headers: { Authorization: `Bearer ${internalKey("Claude")}` },
        },
      },
    }),
    { mode: 0o600 },
  );
  return file;
}

/** The server names in the person's own Cursor config, which the chat's workspace denies. */
function ownCursorServers(): string[] {
  const file = join(homedir(), ".cursor", "mcp.json");
  try {
    return existsSync(file)
      ? Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {})
      : [];
  } catch {
    return [];
  }
}

const SYSTEM = (wizardId: string) =>
  `${prompt("architect", "subscription.system", { wizard_id: wizardId })}\n${prompt("architect", "hello").slice(2)}\n${contentPolicy()}`;

const BUILDING = /edit_wizard|write_wizard|write_file|delete_file|create_wizard/;

const ACTIVITY: [RegExp, ServerKey][] = [
  [/get_authoring_guide/, "doingGuide"],
  [/get_starter|list_starters/, "doingTemplate"],
  [/get_wizard|list_files|read_file/, "doingReadWizard"],
  [/write_file|delete_file/, "doingWriteFiles"],
  [/edit_wizard|write_wizard/, "doingRebuild"],
  [/check_widget|preview/, "doingCheckWidget"],
  [/start_test_run|get_test_run/, "doingTestWizard"],
  [/find_connectors|import_connector/, "doingFindService"],
];

export interface SubscriptionTurn {
  /** The client that answers. */
  client: SubscriptionClient;
  wizardId: string;
  message: string;
  signal: AbortSignal;
  onText: (delta: string) => void;
  onActivity: (label: string) => void;
  onThought?: (line: string) => void;
  onBuilding: () => void;
  images?: ChatImage[];
  /** The language the admin reads the lines about its work in. */
  lang?: Lang;
}

/** The activity for one tool call, naming the file or service it is about when it says. */
function activity(name: string, args: Record<string, unknown>, lang: Lang = "en"): string {
  const label = serverText(lang, ACTIVITY.find(([re]) => re.test(name))?.[1] ?? "doingWork");
  const about = [args.path, args.query].find((v) => typeof v === "string" && v.trim());
  return about ? `${label}: ${String(about)} …` : `${label} …`;
}

/** One conversation per wizard and client: another client cannot continue it. */
const sessionKey = (client: SubscriptionClient, wizardId: string) =>
  client === "claude" ? `chat-session:${wizardId}` : `chat-session:${client}:${wizardId}`;

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** One chat turn on a subscription. The client keeps the conversation; we keep its id. */
export async function subscriptionTurn(
  input: SubscriptionTurn,
): Promise<{ reply: string; changed: boolean }> {
  const client = CHAT_CLIENTS[input.client];
  const key = sessionKey(input.client, input.wizardId);
  // Cursor Agent keeps its chats per workspace: one folder per wizard.
  const dir = input.client === "cursor" ? join(workDir, "cursor", input.wizardId) : workDir;
  mkdirSync(dir, { recursive: true });
  const system = SYSTEM(input.wizardId);
  if (input.client === "cursor") {
    for (const [path, text] of Object.entries(
      cursorWorkspace({
        system,
        mcpUrl: mcpUrl(),
        key: internalKey("Cursor"),
        ownServers: ownCursorServers(),
      }),
    )) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text, { mode: 0o600 });
    }
  }
  // Codex attaches pictures as files; they go once the turn ends.
  const images = (input.images ?? []).map((i) => ({
    mime: i.mime,
    base64: Buffer.from(i.data).toString("base64"),
    file: join(workDir, "images", `${randomUUID()}.${EXT[i.mime] ?? "png"}`),
  }));
  if (input.client === "codex") {
    for (const [n, image] of images.entries()) {
      mkdirSync(dirname(image.file), { recursive: true });
      writeFileSync(image.file, input.images?.[n]?.data ?? new Uint8Array());
    }
  }
  const call: ChatCall = {
    system,
    message: input.message,
    session: await readSetting<string>(key),
    mcpUrl: mcpUrl(),
    dir,
    mcpConfigFile: input.client === "claude" ? mcpConfig() : undefined,
    images,
  };
  const h = harness(input.client);
  // The client's own sign-in, as the person's terminal has it; no key of ours reaches it.
  const childEnv = h ? (await resolveEnv(h)).env : process.env;
  try {
    const child = spawn(client.bin, client.args(call), {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      signal: input.signal,
      env:
        input.client === "codex"
          ? { ...childEnv, [CODEX_KEY_VAR]: internalKey("Codex") }
          : childEnv,
    });
    child.stdin.on("error", () => {
      // A client that is gone already says so on stdout and in its exit code.
    });
    child.stdin.end(client.stdin(call));
    let reply = "";
    let changed = false;
    let failure = "";
    let thinking = "";
    let thought: string | null = null;
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    for await (const line of createInterface({ input: child.stdout })) {
      for (const event of client.events(line)) {
        if (event.kind === "text") {
          const text = reply ? `\n\n${event.text}` : event.text;
          reply += text;
          input.onText(text);
        } else if (event.kind === "tool") {
          if (event.started && BUILDING.test(event.name)) {
            changed = true;
            input.onBuilding();
          }
          input.onActivity(activity(event.name, event.args, input.lang));
        } else if (event.kind === "thinkingStart") {
          thinking = "";
        } else if (event.kind === "thinking") {
          thinking += event.text;
          const next = thoughtLine(thinking);
          if (next && next !== thought) {
            thought = next;
            input.onThought?.(next);
          }
        } else if (event.kind === "session") {
          await writeSetting(key, event.id);
        } else if (event.kind === "failure") {
          failure = event.detail;
        } else if (event.kind === "result" && !reply && event.text) {
          reply = event.text;
          input.onText(reply);
        }
      }
    }
    const code: number | null = await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(child.exitCode);
      } else {
        child.once("close", resolve);
      }
    });
    if (failure || (code !== 0 && !reply)) {
      // A conversation the client no longer has starts afresh next time.
      await deleteSetting(key);
      const detail = failure || stderr.trim() || `exit ${code}`;
      if (client.signedOut(detail)) {
        throw new ServiceError("refused", signedOut({ id: client.id, name: client.name }));
      }
      throw new Error(`${client.name}: ${detail}`.slice(0, 500));
    }
    return { reply: reply.trim(), changed };
  } finally {
    for (const image of images) {
      rmSync(image.file, { force: true });
    }
  }
}

/** The ways that can answer the studio's chats now, in the order the settings offer them. */
export async function chatWays(textModelReady: boolean): Promise<ChatWay[]> {
  const ready = await Promise.all(CHAT_WAYS.map((w) => chatWayReady(w, textModelReady)));
  return CHAT_WAYS.filter((_, i) => ready[i]);
}

/**
 * What answers the studio's chats, Goose and the editor's chat, on a runtime that runs alone: the
 * way chosen while it can answer, else the text classes, or Claude Code where it is the source.
 */
export async function chatEngine(textModelReady: boolean): Promise<ChatWay> {
  const chosen = await readSetting<ChatWay>("chat-engine");
  if (chosen && CHAT_WAYS.includes(chosen) && (await chatWayReady(chosen, textModelReady))) {
    return chosen;
  }
  const claude = await chatWayReady("claude", textModelReady);
  // Nothing chosen: where Claude Code is the source of models, it answers the chat too.
  if (claude && localModelSettings().source === "claude") {
    return "claude";
  }
  // Else a configured model answers; without one, the Claude subscription does.
  return textModelReady || !claude ? "models" : "claude";
}

export function setChatEngine(way: ChatWay) {
  return writeSetting("chat-engine", way);
}

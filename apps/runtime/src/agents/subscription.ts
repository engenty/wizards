import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Lang } from "@engenty-wizards/shared/definition";
import { internalKey } from "../auth/keys.js";
import { env } from "../env.js";
import { CLAUDE_BIN as CLAUDE, claudeEnv } from "../harness/claude.js";
import { detectHarness, signedOut } from "../harness/index.js";
import { localModelSettings } from "../models.js";
import { ServiceError } from "../services/errors.js";
import { deleteSetting, readSetting, writeSetting } from "../settings.js";
import { type ServerKey, serverText } from "../texts.js";
import type { ChatImage } from "./architect.js";
import { thoughtLine } from "./thought.js";

/**
 * The studio chat on the admin's own subscription: the installed Claude Code runs headless and
 * builds the wizard through this server's MCP tools — the same tools any MCP client uses. It
 * gets none of its own tools (no shell, no files), and its sign-in stays with it: this server
 * never sees a subscription token. Runs of wizards go through it as a model (../harness/) when
 * the settings name it as the source.
 */
export type SubscriptionClient = "claude";

/** The AI clients installed on this machine whose subscription can answer the studio chat. */
export async function subscriptionClients(): Promise<SubscriptionClient[]> {
  return (await detectHarness("claude"))?.version ? ["claude"] : [];
}

const workDir = join(env.dataDir, "subscription");

/** The MCP config handed to the client: this server only, signed in with a key made for this process. */
function mcpConfig(): string {
  mkdirSync(workDir, { recursive: true });
  const file = join(workDir, "mcp.json");
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        wizards: {
          type: "http",
          url: `http://127.0.0.1:${env.port}/api/mcp`,
          headers: { Authorization: `Bearer ${internalKey()}` },
        },
      },
    }),
    { mode: 0o600 },
  );
  return file;
}

const SYSTEM = (wizardId: string) =>
  [
    "You are the architect in the engenty wizards studio. The admin talks to you in the studio's chat panel, next to a diagram of the wizard.",
    `You work on exactly one wizard: id "${wizardId}". Read it with get_wizard before you change it; change it with edit_wizard and the file tools; never create another wizard and never publish unless the admin asks.`,
    "Call get_authoring_guide once before your first change. Fix every issue a write reports before you answer.",
    "Answer in the admin's language, in two or three plain sentences: what you changed and what to try next. No JSON, no tool names.",
  ].join("\n");

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

const sessionKey = (wizardId: string) => `chat-session:${wizardId}`;

/** One chat turn on the Claude subscription. The client keeps the conversation; we keep its id. */
export async function subscriptionTurn(
  input: SubscriptionTurn,
): Promise<{ reply: string; changed: boolean }> {
  const session = await readSetting<string>(sessionKey(input.wizardId));
  const args = [
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
    mcpConfig(),
    "--allowedTools",
    "mcp__wizards",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--append-system-prompt",
    SYSTEM(input.wizardId),
    ...(session ? ["--resume", session] : []),
  ];
  const child = spawn(CLAUDE, args, {
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
    signal: input.signal,
    // The client's own sign-in, as the person's terminal has it; no key of ours reaches it.
    env: await claudeEnv(),
  });
  child.stdin.on("error", () => {
    // A client that is gone already says so on stdout and in its exit code.
  });
  child.stdin.end(
    `${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: input.message },
          ...(input.images ?? []).map((i) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: i.mime,
              data: Buffer.from(i.data).toString("base64"),
            },
          })),
        ],
      },
    })}\n`,
  );
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
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "stream_event") {
      const e = event.event ?? {};
      if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
        input.onActivity(activity(String(e.content_block.name ?? ""), {}, input.lang));
      } else if (e.type === "content_block_start" && e.content_block?.type === "thinking") {
        thinking = "";
      } else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta") {
        thinking += e.delta.thinking ?? "";
        const next = thoughtLine(thinking);
        if (next && next !== thought) {
          thought = next;
          input.onThought?.(next);
        }
      }
    } else if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          const text = reply ? `\n\n${block.text}` : block.text;
          reply += text;
          input.onText(text);
        } else if (block.type === "tool_use") {
          const name = String(block.name ?? "");
          if (BUILDING.test(name)) {
            changed = true;
            input.onBuilding();
          }
          input.onActivity(activity(name, block.input ?? {}, input.lang));
        }
      }
    } else if (event.type === "result") {
      if (event.session_id) {
        await writeSetting(sessionKey(input.wizardId), event.session_id);
      }
      if (event.is_error) {
        failure = String(event.result ?? "error");
      } else if (!reply && typeof event.result === "string") {
        reply = event.result;
        input.onText(reply);
      }
    }
  }
  const code: number | null = await new Promise((resolve) => child.once("close", resolve));
  if (failure || (code !== 0 && !reply)) {
    // A conversation the client no longer has starts afresh next time.
    await deleteSetting(sessionKey(input.wizardId));
    const detail = failure || stderr || `exit ${code}`;
    if (/authenticat|log ?in|oauth|credential/i.test(detail)) {
      throw new ServiceError("refused", signedOut({ id: "claude", name: "Claude Code" }));
    }
    throw new Error(`Claude Code: ${detail}`.slice(0, 500));
  }
  return { reply: reply.trim(), changed };
}

/** Which engine answers the studio chat on a runtime that runs alone. */
export type ChatEngine = "models" | "claude";

export async function chatEngine(textModelReady: boolean): Promise<ChatEngine> {
  const clients = await subscriptionClients();
  const chosen = await readSetting<ChatEngine>("chat-engine");
  if (chosen === "claude" && clients.includes("claude")) {
    return "claude";
  }
  if (chosen === "models" && textModelReady) {
    return "models";
  }
  // Nothing chosen: where the client is the source of models, it answers the chat too.
  if (clients.includes("claude") && localModelSettings().source === "claude") {
    return "claude";
  }
  // Else a configured model answers; without one, the subscription does.
  return textModelReady || !clients.includes("claude") ? "models" : "claude";
}

export function setChatEngine(engine: ChatEngine) {
  return writeSetting("chat-engine", engine);
}

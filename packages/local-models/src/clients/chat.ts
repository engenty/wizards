/**
 * How an installed client answers one turn of a chat: the command line, what goes on stdin, and
 * what its output lines mean. The client reaches only the host's MCP server, under the name the
 * host gives it, and keeps the conversation itself; the host keeps the id it reports.
 */

/** The host's MCP server for a turn. */
export interface ChatMcp {
  /** The name the client knows the server by: its tools are `mcp__<name>__…` to Claude Code. */
  name: string;
  url: string;
  /** Codex: the environment variable it reads the bearer key from; the host sets it for the turn. */
  keyVar: string;
  /** Claude Code: the MCP config file with the server and its key. */
  configFile?: string;
}

/** What one turn hands the client. */
export interface ChatCall {
  /** The instructions the client works by. */
  system: string;
  message: string;
  /** The conversation to continue, as the client named it last time. */
  session: string | null;
  /** The folder the client runs in: Claude's MCP config, Cursor's workspace. */
  dir: string;
  /** The model the client runs, by its own name: left out, the client picks. */
  model?: string;
  /** The host's MCP server. Left out, the turn has no tools at all: a call that only writes text. */
  mcp?: ChatMcp;
  /** The pictures pasted with the message: base64 for Claude, files for Codex. */
  images: { mime: string; base64: string; file: string }[];
}

/** What one line of the client's output says. */
export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; started: boolean }
  /** A tool has answered; `issues` is how many it found, if its answer speaks of them. */
  | { kind: "toolDone"; issues?: number }
  /**
   * The model is writing text this client hands over whole later on: for the turn's clock, and
   * the piece itself where the client streams it.
   */
  | { kind: "writing"; text?: string }
  | { kind: "thinkingStart" }
  /** `whole`: the client gives its reasoning once that is done, not as it streams. */
  | { kind: "thinking"; text: string; whole?: boolean }
  | { kind: "session"; id: string }
  | { kind: "failure"; detail: string }
  /** The client's own summary of the answer, used where no text came before it. */
  | { kind: "result"; text: string };

/** A client as a chat: its command line and how to read it. */
export interface ChatClient {
  args(call: ChatCall): string[];
  stdin(call: ChatCall): string;
  events(line: string): ChatEvent[];
  /** Whether a failure the client reports means its sign-in is missing or expired. */
  signedOut(detail: string): boolean;
}

export function parseLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** How many issues a tool's answer names; nothing where the answer does not speak of them. */
export function issuesIn(text: unknown): number | undefined {
  if (typeof text !== "string" || !text.includes('"issues"')) {
    return undefined;
  }
  const issues = parseLine(text)?.issues;
  return Array.isArray(issues) ? issues.length : undefined;
}

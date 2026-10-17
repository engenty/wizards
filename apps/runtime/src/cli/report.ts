import { join } from "node:path";
import { LOCAL_MCP_HEADER, mintLocalTicket } from "../auth/local-ticket.js";
import type { LogLine } from "../log.js";
import type { Layout } from "./home.js";
import { readSecret, runningRuntime, settings } from "./start.js";
import { bad, cmd, dim, ok, tilde } from "./ui.js";

/**
 * `wizards logs` shows the last lines the running runtime printed; `wizards report` sends its
 * status, model settings and those lines to the linked account, where an operator reads them
 * (docs/plans/remote-debug.md). Both talk to the running process, signed with the data folder's
 * secret as `wizards mcp` does; neither sends anything by itself.
 */

async function ask(
  paths: Layout,
  method: "GET" | "POST",
  path: string,
): Promise<{ status: number; body: Record<string, unknown> } | string> {
  const { dataDir } = settings(paths);
  const running = await runningRuntime(dataDir);
  if (!running) {
    return `engenty wizards isn’t running. To start it: ${cmd("start")}`;
  }
  const secret = readSecret(paths);
  if (!secret) {
    return `Couldn’t read the data folder’s secret (${tilde(join(dataDir, "secret"))}).`;
  }
  const res = await fetch(`http://127.0.0.1:${running.port}/api/local/debug${path}`, {
    method,
    headers: { [LOCAL_MCP_HEADER]: mintLocalTicket(secret, Date.now(), "local-debug") },
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** The last lines of the running runtime; `value` may name how many (default 100). */
export async function logsCommand(paths: Layout, value: string): Promise<number> {
  const limit = Math.min(Math.max(1, Number(value) || 100), 2000);
  const answer = await ask(paths, "GET", `/logs?limit=${limit}`);
  if (typeof answer === "string") {
    console.error(answer);
    return 1;
  }
  const lines = (answer.body.lines as LogLine[] | undefined) ?? [];
  for (const line of lines) {
    const at = new Date(line.at).toISOString().slice(11, 19);
    const level = line.level === "info" ? "     " : line.level.padEnd(5);
    console.log(`${dim(at)} ${level} ${line.text}`);
  }
  if (!lines.length) {
    console.log(dim("No log lines yet."));
  }
  return 0;
}

export async function reportCommand(paths: Layout): Promise<number> {
  const answer = await ask(paths, "POST", "/report");
  if (typeof answer === "string") {
    console.error(answer);
    return 1;
  }
  if (answer.status === 409) {
    console.error(
      `${bad} This computer isn’t connected to an account. Sign in under Settings → Account in the studio, or with ${cmd("account sign-in")}. Then try again.`,
    );
    return 1;
  }
  if (answer.status !== 200) {
    console.error(
      `${bad} ${answer.body.error ?? `engenty wizards responded with an error (${answer.status}).`}`,
    );
    return 1;
  }
  console.log(
    `${ok} Sent report ${answer.body.id} to ${answer.body.to}. Quote this ID when you ask for help.`,
  );
  return 0;
}

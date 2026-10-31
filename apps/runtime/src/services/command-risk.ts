/**
 * Whether a shell command on the space's computer may run without asking (docs/plans/work-chats.md,
 * "The space's computer and browser"): what stays in the container runs; what sends data out,
 * deletes or moves the space's files, or can't be read asks; what is unclear goes to a classifier
 * that fails closed (asks). The space's computer (piece 5) calls it before each command.
 */

export type CommandRisk =
  | { verdict: "runs" }
  | { verdict: "asks"; why: string }
  | { verdict: "unclear"; why: string };

/** Where the space's own files are mounted in the computer. */
const SPACE_PATHS = ["/space", "/files"];

const rules: { why: string; test: RegExp }[] = [
  // Can't be read before it runs: what it does is decided while it runs.
  {
    why: "runs code it builds while it runs",
    test: /\beval\b|`|\$\(|\|\s*(ba|z|da)?sh\b|\bsource\s+<\(/,
  },
  // Sends data out of the computer.
  {
    why: "pushes to a remote",
    test: /\bgit\s+push\b|\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b/,
  },
  { why: "connects to another computer", test: /\b(ssh|scp|sftp|rsync|ftp|telnet|nc|ncat)\b/ },
  { why: "sends mail", test: /\b(mail|mailx|sendmail|mutt)\b/ },
  {
    why: "sends data to a web address",
    test: /\bcurl\b[^|;&]*(\s-(d|F|T)\b|\s--(data|data-\w+|form|upload-file|json)\b|\s-X\s*(POST|PUT|PATCH|DELETE)\b)|\bwget\b[^|;&]*--(post|body|method)/i,
  },
];

const touchesSpace = (command: string) =>
  SPACE_PATHS.some((path) =>
    new RegExp(`(^|[\\s='"])${path.replace("/", "\\/")}(\\/|\\s|$|['"])`).test(command),
  );

export function classifyCommand(command: string): CommandRisk {
  const line = command.trim();
  if (!line) {
    return { verdict: "runs" };
  }
  for (const rule of rules) {
    if (rule.test.test(line)) {
      return { verdict: "asks", why: rule.why };
    }
  }
  if (touchesSpace(line)) {
    if (
      /(^|[;&|]\s*)(rm|rmdir|mv|truncate|shred|unlink)\b/.test(line) ||
      /\bfind\b.*\s-delete\b/.test(line)
    ) {
      return { verdict: "asks", why: "deletes or moves the space's files" };
    }
    // Writing into the space's files by redirect or copy: not plainly harmless, not plainly not.
    if (/>\s*['"]?\/(space|files)\b|\b(cp|tee|sed\s+-i|dd)\b/.test(line)) {
      return { verdict: "unclear", why: "writes into the space's files" };
    }
  }
  return { verdict: "runs" };
}

/** What happens with a command: an unclear one is asked about until a classifier says otherwise. */
export const asksBeforeRunning = (risk: CommandRisk) => risk.verdict !== "runs";

/** How the setup installs an AI client: with npm into the host's own prefix, or by the vendor's script. */
export type ClientInstall =
  | { kind: "npm"; pkg: string }
  /** `url` for `curl | bash`; `windows` for PowerShell's `irm | iex`. */
  | { kind: "script"; url: string; windows: string };

export const CLIENT_IDS = ["codex", "claude", "antigravity", "cursor"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

/** An AI client the setup offers. */
export interface ClientEntry {
  id: ClientId;
  name: string;
  /** The name with its provider, where a list shows it: "Anthropic Claude Code". */
  label: string;
  bin: string;
  /** The subscription it answers on. */
  account: string;
  install: ClientInstall;
  /** The vendor's desktop app: on this computer, the person most likely has the subscription. */
  app?: string;
}

/** The AI clients an app can think with, in the order the setup offers them. */
export const CLIENTS: readonly ClientEntry[] = [
  {
    id: "codex",
    name: "Codex",
    label: "OpenAI Codex",
    bin: "codex",
    account: "ChatGPT",
    install: { kind: "npm", pkg: "@openai/codex" },
    app: "ChatGPT",
  },
  {
    id: "claude",
    name: "Claude Code",
    label: "Anthropic Claude Code",
    bin: "claude",
    account: "Claude",
    install: {
      kind: "script",
      url: "https://claude.ai/install.sh",
      windows: "https://claude.ai/install.ps1",
    },
    app: "Claude",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    label: "Google Antigravity",
    bin: "agy",
    account: "Google AI",
    install: {
      kind: "script",
      url: "https://antigravity.google/cli/install.sh",
      windows: "https://antigravity.google/cli/install.ps1",
    },
    app: "Antigravity",
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    label: "Cursor Agent",
    bin: "cursor-agent",
    account: "Cursor",
    install: {
      kind: "script",
      url: "https://cursor.com/install",
      windows: "https://cursor.com/install?win32=true",
    },
    app: "Cursor",
  },
];

export function clientEntry(id: string): ClientEntry | null {
  return CLIENTS.find((client) => client.id === id) ?? null;
}

/** A word for the shell: quoted when it holds anything but plain characters. */
const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** A word for PowerShell: in single quotes, which take everything but a single quote as it is. */
const powershellWord = (word: string) =>
  /^[\w@%+=:,./\\-]+$/.test(word) ? word : `'${word.replaceAll("'", "''")}'`;

/**
 * The command the setup runs for a client, as the person would type it (PowerShell on Windows).
 * `folder`: npm's prefix, where the host keeps the clients it installs.
 */
export function installCommand(client: ClientEntry, folder: string, platform: string): string {
  const windows = platform === "win32";
  if (client.install.kind === "npm") {
    const prefix = windows ? powershellWord(folder) : shellWord(folder);
    return `npm install --global --prefix ${prefix} ${client.install.pkg}`;
  }
  return windows
    ? `irm ${powershellWord(client.install.windows)} | iex`
    : `curl -fsSL ${client.install.url} | bash`;
}

/** PowerShell, for a command written for it: without the person's profile, scripts allowed. */
export const POWERSHELL = [
  "powershell.exe",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
];

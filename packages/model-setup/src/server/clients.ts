import { mkdirSync } from "node:fs";
import {
  type ClientStatus,
  type Detectable,
  detectClient,
  freshAuth,
  loginEnv,
  loginShellEnv,
} from "@engenty/model-providers/clients";
import { type ClientId, clientEntry, installCommand, POWERSHELL } from "../catalog.js";
import type { ClientSetupStatus } from "../types.js";
import { vendorApp } from "./apps.js";

/** A client as the host runs it. */
export interface SetupClient extends Detectable {
  id: ClientId;
  name: string;
  bin: string;
  /**
   * What the terminal runs to sign the client in. `interactive`: the client's own app opens and
   * the person ends it; the terminal closes by itself once the sign-in is there.
   */
  login: { args: string[]; env?: Record<string, string>; interactive: boolean };
  /** Set where the host makes images with it. */
  image?: unknown;
}

/** A command for a terminal. */
export interface TerminalCommand {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface ClientSetupOptions {
  /** The host's clients, in the order the setup offers them. */
  clients: readonly SetupClient[];
  /** Where the host keeps the clients it installs: npm's prefix. Asked at each use. */
  folder: () => string;
  /** The environment an install starts with; `shellPath` is the login shell's PATH, if it has one. */
  env: (shellPath: string | undefined) => NodeJS.ProcessEnv;
}

/** The AI clients on this computer: how each stands, how it is installed and signed in. */
export class ClientSetup {
  /** The status last made of each client's detection, kept while the detection holds. */
  private readonly statuses = new Map<
    ClientId,
    { of: ClientStatus; value: ClientSetupStatus<ClientId> }
  >();

  constructor(private readonly options: ClientSetupOptions) {}

  client(id: string): SetupClient | null {
    return this.options.clients.find((client) => client.id === id) ?? null;
  }

  /** One client, as it is now; asked again after a minute, as it may get installed or signed in meanwhile. */
  async detect(id: string, force = false): Promise<ClientSetupStatus<ClientId> | null> {
    const client = this.client(id);
    if (!client) {
      return null;
    }
    const status = await detectClient(client, force);
    const kept = this.statuses.get(client.id);
    if (kept?.of === status) {
      return kept.value;
    }
    const entry = clientEntry(client.id);
    const value: ClientSetupStatus<ClientId> = {
      id: client.id,
      name: client.name,
      label: entry?.label ?? client.name,
      install: entry ? installCommand(entry, this.options.folder(), process.platform) : "",
      app: entry ? vendorApp(entry) : null,
      version: status.version,
      auth: status.auth,
      interactiveLogin: client.login.interactive,
      images: Boolean(client.image),
    };
    this.statuses.set(client.id, { of: status, value });
    return value;
  }

  /** Every client of the host, installed or not. */
  detectAll(force = false): Promise<ClientSetupStatus<ClientId>[]> {
    return Promise.all(
      this.options.clients.map(
        (client) => this.detect(client.id, force) as Promise<ClientSetupStatus<ClientId>>,
      ),
    );
  }

  /**
   * What the terminal runs to install a client: the command of the catalog, shown first. A
   * client from npm goes into the host's own prefix.
   */
  async install(id: string): Promise<TerminalCommand | null> {
    const entry = this.client(id) ? clientEntry(id) : null;
    if (!entry) {
      return null;
    }
    const folder = this.options.folder();
    mkdirSync(folder, { recursive: true });
    const command = installCommand(entry, folder, process.platform);
    if (process.platform === "win32") {
      const [bin = "", ...args] = POWERSHELL;
      return {
        bin,
        args: [...args, `Write-Host "$ ${command.replaceAll('"', '`"')}\`n"; ${command}`],
        env: this.options.env(undefined),
      };
    }
    const shell = await loginShellEnv();
    return {
      bin: "bash",
      args: [
        "-c",
        'printf "\\033[2m$ %s\\033[0m\\n\\n" "$1"; set -o pipefail; eval "$1"',
        "install",
        command,
      ],
      env: {
        ...this.options.env(shell.PATH),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    };
  }

  /** What the terminal runs to sign a client in. */
  async login(id: string): Promise<TerminalCommand | null> {
    const client = this.client(id);
    return (
      client && {
        bin: client.bin,
        args: client.login.args,
        env: { ...(await loginEnv(client)), ...client.login.env },
      }
    );
  }

  /** Whether the client is signed in, asked of the client itself. */
  async signedIn(id: string): Promise<boolean> {
    const client = this.client(id);
    return client ? (await freshAuth(client)) !== "none" : false;
  }
}

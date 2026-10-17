import { env } from "../env.js";
import { agentOsEngine } from "./agentos.js";
import { DOCKER_CAPABILITIES, dockerEngine } from "./docker.js";
import type { Sandbox, SandboxCapabilities, SandboxEngine } from "./types.js";

export type {
  ExecOptions,
  ExecResult,
  Sandbox,
  SandboxCapabilities,
  SandboxEngine,
} from "./types.js";

/**
 * The engines, in the order one is picked when `SANDBOX` names none. Another engine joins
 * here: one of Mastra's sandboxes through MastraRunSandbox (mastra.ts), its package installed
 * with `wizards sandbox add <name>` when it isn't a dependency of the runtime (install.ts).
 */
export const ENGINES: readonly SandboxEngine[] = [dockerEngine, agentOsEngine];

/**
 * `off`: none. An engine's name: that one, ready or not; it says what is missing when a run
 * uses it. Empty: the first engine that is ready here.
 */
export function pickEngine(
  engines: readonly SandboxEngine[],
  requested: string,
): SandboxEngine | null {
  if (requested === "off") {
    return null;
  }
  if (requested) {
    const engine = engines.find((e) => e.name === requested);
    if (!engine) {
      console.warn(
        `SANDBOX=${requested} is no engine (${engines.map((e) => e.name).join(", ")} or off): the sandbox is off.`,
      );
    }
    return engine ?? null;
  }
  return engines.find((e) => e.ready()) ?? null;
}

let picked: { engine: SandboxEngine | null } | null = null;

/** The engine of this server, picked once at the first question. */
export function sandboxEngine(): SandboxEngine | null {
  picked ??= { engine: pickEngine(ENGINES, env.sandbox) };
  return picked.engine;
}

/** What this server's sandbox runs, or null when it is switched off. */
export function sandboxCapabilities(): SandboxCapabilities | null {
  return sandboxEngine()?.capabilities() ?? null;
}

export function createSandbox(runId: string): Sandbox {
  const engine = sandboxEngine();
  if (!engine) {
    throw new Error("The sandbox is switched off on this server.");
  }
  return engine.create(runId);
}

export function shellToolDescription(caps: SandboxCapabilities): string {
  const notes = caps.notes ? ` ${caps.notes}` : "";
  return `Run a shell command in a private Linux sandbox (${caps.commands.join(", ")}). Working directory ${caps.workdir}. Network: ${caps.network}.${notes}`;
}

/** The authoring guide's line about the sandbox tool. */
export function sandboxGuideLine(): string {
  const uses = (sandboxCapabilities() ?? DOCKER_CAPABILITIES).uses;
  return `- The sandbox runs code (python/node) for ${uses}; export_file hands files to the person.`;
}

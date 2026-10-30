import { env } from "../env.js";
import { prompt } from "../prompts.js";
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

/**
 * The engine for a guest's run, from `SANDBOX_GUESTS`: `off` (the default): none. `agentos`: that
 * engine when it is ready here, else none. Never Docker: a guest's step there could install and
 * send anything (docs/plans/capabilities.md, A1). Anything else is said once and means off.
 */
export function pickGuestEngine(
  engines: readonly SandboxEngine[],
  requested: string,
): SandboxEngine | null {
  if (!requested || requested === "off") {
    return null;
  }
  if (requested !== "agentos") {
    console.warn(`SANDBOX_GUESTS=${requested} is no engine for guests (agentos or off): off.`);
    return null;
  }
  const engine = engines.find((e) => e.name === requested) ?? null;
  if (!engine?.ready()) {
    console.warn(
      "SANDBOX_GUESTS=agentos, but agentOS is not installed here: guests get no sandbox.",
    );
    return null;
  }
  return engine;
}

let picked: { engine: SandboxEngine | null } | null = null;
let pickedForGuests: { engine: SandboxEngine | null } | null = null;

/** The engine of this server, picked once at the first question. */
export function sandboxEngine(): SandboxEngine | null {
  picked ??= { engine: pickEngine(ENGINES, env.sandbox) };
  return picked.engine;
}

/** The engine of a guest's runs on this server, picked once at the first question. */
export function guestSandboxEngine(): SandboxEngine | null {
  pickedForGuests ??= { engine: pickGuestEngine(ENGINES, env.sandboxGuests) };
  return pickedForGuests.engine;
}

/** What this server's sandbox runs, or null when it is switched off. */
export function sandboxCapabilities(): SandboxCapabilities | null {
  return sandboxEngine()?.capabilities() ?? null;
}

/** A Work chat's sandbox, on the server's engine. A run's goes through its RunResources. */
export function createSandbox(runId: string): Sandbox {
  const engine = sandboxEngine();
  if (!engine) {
    throw new Error("The sandbox is switched off on this server.");
  }
  return engine.create(runId);
}

export function shellToolDescription(caps: SandboxCapabilities): string {
  const description = prompt("tools", "tool.run_command", {
    commands: caps.commands.join(", "),
    workdir: caps.workdir,
    network: caps.network,
  });
  return caps.notes ? `${description} ${caps.notes}` : description;
}

/** The authoring guide's line about the sandbox tool. */
export function sandboxGuideLine(): string {
  const uses = (sandboxCapabilities() ?? DOCKER_CAPABILITIES).uses;
  return prompt("tools", "tool.run_command.guide_line", { uses });
}

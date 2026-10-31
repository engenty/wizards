import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { currentFeatures } from "../features.js";
import type { Role } from "../manage.js";
import { type ExecResult, sandboxCapabilities, shellToolDescription } from "../sandbox/index.js";
import { activeSkills } from "../services/skills.js";
import { defaultSpace, ownedSpace } from "../services/spaces.js";
import { chatSandbox } from "../services/work-sandbox.js";
import { clip } from "../tools/shared.js";
import type { SkillSandbox } from "../tools/skills.js";
import { personCaller } from "./caller.js";
import { elementTools } from "./catalogue.js";
import { elementCall } from "./gate.js";
import { ELEMENT_SPECS, type ElementScope, type ElementToolName } from "./specs.js";

/**
 * The catalogue for clients outside the runtime: an MCP client (mcp/elements.ts) or a program on
 * the API (routes/elements.ts), signed in as a person (docs/plans/modular.md, phase 2). The space
 * a call names is checked against the token: a space of the token's organization, else refused
 * (I2); the rules then decide every item as that person. Skills' scripts run in a sandbox kept
 * per person, space and client while it is used, as a Work chat's is.
 */

/** Who an outside call acts for, as the token says: never from the call's arguments (I1). */
export interface OutsideWho {
  userId: string;
  role: Role;
  /** The client, as it names itself: the MCP client, the `x-wizards-client` header. */
  client: string;
  tenantId: string;
  scopes: readonly string[];
}

/** `run_command` in the outside client's sandbox: only for clients that may run elements. */
export const RUN_COMMAND = {
  scope: "elements:run" as ElementScope,
  input: z.object({ command: z.string(), timeoutSeconds: z.number().int().optional() }),
};

/** The space a call names, checked against the token; the person's first one when none. */
export async function outsideSpace(who: OutsideWho, spaceId?: string) {
  return spaceId ? ownedSpace(who.userId, spaceId) : defaultSpace(who.userId);
}

/** The sandbox an outside client's skills run in: one per person, space and client. */
function outsideSandbox(who: OutsideWho, spaceId: string): SkillSandbox | null {
  const caps = sandboxCapabilities();
  if (!caps) {
    return null;
  }
  const key = `outside-${who.tenantId}-${who.userId}-${spaceId}-${who.client}`.replace(
    /[^A-Za-z0-9_-]/g,
    "_",
  );
  return { handle: () => chatSandbox(key), workdir: caps.workdir };
}

/** The catalogue's tools for an outside caller in a space, by the token's scopes. */
export async function outsideTools(
  who: OutsideWho,
  spaceId: string | undefined,
  signal: AbortSignal,
): Promise<Record<string, any>> {
  const space = await outsideSpace(who, spaceId);
  const sandbox = who.scopes.includes("elements:run") ? outsideSandbox(who, space.id) : null;
  const caller = personCaller({
    space: { id: space.id, name: space.name },
    userId: who.userId,
    role: who.role,
    signal,
    client: who.client,
    sandbox,
  });
  const skills = (await currentFeatures()).skills === true ? await activeSkills(space.id) : null;
  const tools = await elementTools(caller, {
    knowledge: true,
    skills,
    wizards: true,
    connections: true,
  });
  if (sandbox) {
    const report = (result: ExecResult) => ({
      exitCode: result.exitCode,
      stdout: clip(result.stdout, 8000),
      stderr: clip(result.stderr, 4000),
    });
    tools.run_command = createTool({
      id: "run_command",
      description: shellToolDescription(sandboxCapabilities()!),
      inputSchema: RUN_COMMAND.input,
      execute: (input) =>
        elementCall(
          caller,
          { action: "run_command", about: "sandbox", perm: "x", input },
          async () =>
            report(
              await sandbox.handle().exec(input.command, {
                timeoutMs: Math.min((input.timeoutSeconds ?? 120) * 1000, 600_000),
              }),
            ),
        ),
    });
  }
  // What the token's scopes allow, nothing more.
  for (const name of Object.keys(tools)) {
    const scope =
      name === "run_command" ? RUN_COMMAND.scope : ELEMENT_SPECS[name as ElementToolName]?.scope;
    if (!(scope && who.scopes.includes(scope))) {
      delete tools[name];
    }
  }
  return tools;
}

/** What a call came back with: its result, or why it did not run. */
export type OutsideResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; data?: unknown };

/** One element call of an outside client. */
export async function callOutside(
  who: OutsideWho,
  spaceId: string | undefined,
  name: string,
  input: unknown,
  signal: AbortSignal,
): Promise<OutsideResult> {
  const tools = await outsideTools(who, spaceId, signal);
  const tool = tools[name] as
    | { inputSchema?: z.ZodType; execute?: (input: unknown) => Promise<unknown> }
    | undefined;
  if (!tool?.execute) {
    return {
      ok: false,
      error: `${name} is not open to this client in this space: the token's scopes, or nothing of the kind in the space.`,
    };
  }
  let data: unknown = input ?? {};
  if (tool.inputSchema) {
    const parsed = tool.inputSchema.safeParse(data);
    if (!parsed.success) {
      return { ok: false, error: "Invalid input", data: parsed.error.issues };
    }
    data = parsed.data;
  }
  try {
    const result = await tool.execute(data);
    if (result && typeof result === "object" && "error" in result) {
      const { error, ...data } = result as { error: string };
      return { ok: false, error, data };
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 400) };
  }
}

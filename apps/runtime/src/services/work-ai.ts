import { anthropic } from "@ai-sdk/anthropic";
import { surfaceComponentsSchema, validateSurface } from "@engenty/wizards-shared/surface";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sortedTools } from "../agents/space-agent.js";
import { chatTurnWay } from "../agents/subscription.js";
import { personCaller } from "../elements/caller.js";
import { elementTools } from "../elements/catalogue.js";
import { currentFeatures } from "../features.js";
import { HarnessModel } from "../harness/index.js";
import { managed, type Role } from "../manage.js";
import { attachTools, chatModel, gatewayTools, type ResolvedModel } from "../models.js";
import { pluginsOf } from "../plugins/registry.js";
import { prompt } from "../prompts.js";
import { type ExecResult, sandboxCapabilities, shellToolDescription } from "../sandbox/index.js";
import { currentTenant } from "../tenants/tenant.js";
import { assistantToolPlugin, assistantToolRisk, assistantToolsOf } from "../tools/plugin.js";
import { clip } from "../tools/shared.js";
import { skillsBlock } from "../tools/skills.js";
import { roleOf } from "./access.js";
import { ClientSteps } from "./client-steps.js";
import { activeSkills } from "./skills.js";
import { holdCall } from "./work-approvals.js";
import { workConnectionTools } from "./work-connections.js";
import { chatSandbox } from "./work-sandbox.js";

/**
 * What the space's AI gets for one turn of a Work chat (docs/plans/work-chats.md): the model of
 * the way the settings chose, the space's tools, and instructions that stay the same for the
 * space, so the prompt's start is cached. The agent itself is the tenant's (work-mastra.ts); it
 * reads this from the request context.
 */

export const TURN_KEY = "workTurn";
/** A turn stops after this long. */
export const TURN_MS = 20 * 60_000;
/** Steps one turn may take. */
export const MAX_STEPS = 16;

/**
 * What the person chose in the composer for the turns they ask for: `extra`, the way's more
 * capable model; `web: false`, no web search; `pluginsOff`, plugins whose tools stay out.
 */
export interface TurnChoice {
  extra?: boolean;
  web?: boolean;
  pluginsOff?: string[];
}

export interface WorkTurn {
  resolved: ResolvedModel<unknown>;
  tools: Record<string, unknown>;
  instructions: string;
}

const instructionsFor = (space: string, skills: string, knowledge: boolean, client: boolean) =>
  [
    client
      ? `You are the AI of the firm that runs the client space "${space}" in engenty wizards, and you answer one of the firm's clients there. The firm's people read this chat too. Answer from the client space and what the firm opened to its clients; where you can't know, say so and suggest asking the firm. When one of the firm's wizards fits the request, run it with wizard_run. In German, say du, as the client portal does.`
      : `You are the AI of the space "${space}" in engenty wizards. The team of the space talks with you and with each other in this chat.`,
    'Each message of a person comes as <user name="…">; answer the person who asked you, in their language, and call them by their name only when it helps.',
    knowledge
      ? "Before you answer about the space (its clients, matters, files, data), look it up with space_search; say where you found it. When you can't find it, say so."
      : "The space has no knowledge yet: say so when you're asked about its clients, matters, files or data.",
    "Write short, plain answers. Use lists or a table where they help. Rows, figures, a comparison or a few questions to the team can be a view instead: show_view.",
    skills,
  ]
    .filter(Boolean)
    .join("\n\n");

/** The space's skills that count, while the `skills` switch is on. */
async function spaceSkills(spaceId: string) {
  return (await currentFeatures()).skills === true ? activeSkills(spaceId) : null;
}

/**
 * The chat's sandbox (work-sandbox.ts) as the tools see it: `run_command`, and the skills whose
 * scripts may run written into it. None without a chat (an approved call runs alone) or where
 * this server has no sandbox.
 */
function sandboxTools(chatId: string | null): {
  tools: Record<string, unknown>;
  skill: { handle: () => ReturnType<typeof chatSandbox>; workdir: string } | null;
} {
  const caps = chatId ? sandboxCapabilities() : null;
  if (!(caps && chatId)) {
    return { tools: {}, skill: null };
  }
  const handle = () => chatSandbox(chatId);
  const report = (result: ExecResult) => ({
    exitCode: result.exitCode,
    stdout: clip(result.stdout, 8000),
    stderr: clip(result.stderr, 4000),
  });
  return {
    skill: { handle, workdir: caps.workdir },
    tools: {
      run_command: createTool({
        id: "run_command",
        description: shellToolDescription(caps),
        inputSchema: z.object({ command: z.string(), timeoutSeconds: z.number().optional() }),
        execute: async ({ command, timeoutSeconds }) =>
          report(
            await handle().exec(command, {
              timeoutMs: Math.min((timeoutSeconds ?? 120) * 1000, 600_000),
            }),
          ),
      }),
    },
  };
}

/** A view stays this small: what a chat shows at a glance, not a data dump. */
export const VIEW_MAX_BYTES = 64_000;

/**
 * The view a turn draws in the chat (docs/plans/work-chats.md, generative UI): components of the
 * surface catalog, the chat's own (Form, Ref, ask) among them, and the data they bind. It is
 * checked here, so the model gets the issues and tries again; the chat draws the call's input
 * once its result says ok. A client as the model calls it like any tool of the space.
 */
export const showView = () =>
  createTool({
    id: "show_view",
    description: [
      "Shows a view in the chat: key figures, a table, a chart, a list of files, a form that asks the team. Everyone in the chat sees it.",
      prompt("authoring", "surfaces"),
      prompt("authoring", "surfaces.chat"),
    ].join("\n\n"),
    inputSchema: z.object({
      title: z.string().max(120).optional().describe("What the view shows, in a few words"),
      components: surfaceComponentsSchema,
      data: z
        .record(z.string(), z.unknown())
        .default({})
        .describe('What the components bind by {"path": "/key/…"}: the rows and figures you found'),
    }),
    execute: async ({ components, data }) => {
      const bytes = Buffer.byteLength(JSON.stringify({ components, data }));
      const issues =
        bytes > VIEW_MAX_BYTES
          ? [
              `The view is ${bytes} bytes, more than ${VIEW_MAX_BYTES}: show fewer rows or less text.`,
            ]
          : validateSurface(components, Object.keys(data ?? {}), { chat: true }).map(
              (i) => i.message,
            );
      return issues.length
        ? { ok: false, issues, note: "Nothing was shown. Fix these and call show_view again." }
        : { ok: true, note: "Shown in the chat. Don't repeat what it shows." };
    },
  });

/** Whether the model can search the web itself: on Anthropic's API, or through the gateway. */
const searches = (resolved: ResolvedModel<unknown>) =>
  resolved.vendor === "anthropic" || resolved.gateway;

/** An approved call runs for its chat, and knows whether an admin approved it („Mit Freigabe“ met). */
export interface ApprovedRun {
  chatId: string;
  byAdmin: boolean;
}

/**
 * A client's turn (docs/plans/client-portal.md, phase 1): the client space's Knowledge with what
 * the firm opened to clients, the wizards opened to them (a run lands in the client space) and
 * views. No skills, sandbox, connections, plugins or web: nothing that reaches past the client
 * space or spends on the firm's sign-ins.
 */
async function clientTools(
  space: { id: string; name: string },
  userId: string,
  signal: AbortSignal,
  chatId: string | null,
): Promise<Record<string, unknown>> {
  const caller = personCaller({ space, userId, role: "client", signal, chatId });
  return sortedTools({
    ...(await elementTools(caller, { knowledge: true, wizards: true })),
    show_view: showView(),
  });
}

/**
 * The space's tools for a turn: its knowledge, its skills, the chat's sandbox, the space's
 * connections open to the person (work-connections.ts), the plugins' tools, the web; the plugins
 * and the web the person turned off (`choice`) left out. A client gets `clientTools` alone.
 * `role`: the person's, where the session knows it; else the organization's list says.
 */
async function toolsFor(
  resolved: ResolvedModel<unknown> | null,
  space: { id: string; name: string },
  userId: string,
  signal: AbortSignal,
  choice: TurnChoice = {},
  chatId: string | null = null,
  approved: ApprovedRun | null = null,
  known: Role | null = null,
): Promise<Record<string, unknown>> {
  const role = known ?? (await roleOf(userId));
  if (role === "client") {
    return clientTools(space, userId, signal, chatId ?? approved?.chatId ?? null);
  }
  const sandbox = sandboxTools(chatId);
  const connections = await workConnectionTools({
    space,
    userId,
    chatId: chatId ?? approved?.chatId ?? null,
    byAdmin: approved?.byAdmin,
  });
  // The turn reads as the person who asked: what they may not read, the AI does not find. Its
  // Knowledge and skills come from the tool catalogue (elements/), as a step's and Goose's do.
  const caller = personCaller({
    space,
    userId,
    role,
    signal,
    chatId: chatId ?? approved?.chatId ?? null,
    sandbox: sandbox.skill,
  });
  const tools: Record<string, unknown> = {
    ...(await elementTools(caller, {
      knowledge: true,
      skills: await spaceSkills(space.id),
      wizards: true,
    })),
    show_view: showView(),
    ...sandbox.tools,
    ...connections.tools,
    ...(await assistantToolsOf({
      tenantId: currentTenant(),
      space,
      userId,
      signal,
      emit: () => {},
      changed: () => {},
      card: () => {},
    })),
  };
  for (const [name, tool] of Object.entries(tools)) {
    const plugin = tool && typeof tool === "object" ? assistantToolPlugin.get(tool) : undefined;
    if (plugin && choice.pluginsOff?.includes(plugin)) {
      delete tools[name];
    }
  }
  if (choice.web !== false && resolved?.vendor === "anthropic") {
    tools.web_search = anthropic.tools.webSearch_20250305({ maxUses: 5 });
  } else if (choice.web !== false && resolved?.gateway) {
    tools.web_search = gatewayTools.perplexitySearch({ maxResults: 6 });
  }
  return sortedTools(tools);
}

/**
 * What the composer offers for a turn: web search where the model can search, and the plugins
 * whose tools the AI has. A way that isn't ready yet searches nothing.
 */
export async function composerTools(): Promise<{
  web: boolean;
  plugins: { id: string; name: string }[];
}> {
  const resolved = await chatModel(await chatTurnWay(managed), "standard").catch(() => null);
  const plugins = (await pluginsOf(currentTenant()))
    .filter((p) => p.assistantTools.size > 0)
    .map((p) => ({ id: p.source.id, name: p.source.manifest.name }));
  return { web: Boolean(resolved && searches(resolved)), plugins };
}

/**
 * Whether a call of the tool waits for a person's approval: a plugin's tool marked `outside`
 * does, and so does one without a mark (decided: "risk per tool", the safe side); a connection's
 * write, send or delete is marked so too (a confirmed action). The space's own tools only read.
 */
const UNMARKED_ASKS = true;

export function asksFirst(tool: unknown): boolean {
  if (!tool || typeof tool !== "object" || !assistantToolRisk.has(tool)) {
    return false;
  }
  const risk = assistantToolRisk.get(tool);
  return risk === "outside" || (risk === null && UNMARKED_ASKS);
}

/** Who a turn is for and where: what a held call is stored with. */
export interface TurnFor {
  space: { id: string; name: string };
  chatId: string;
  userId: string;
  /** The person's role, as their session has it: a client's turn is narrower (`clientTools`). */
  role?: Role;
}

/**
 * The gate on the tool: a call that waits for approval doesn't run. It is stored, and the AI is
 * told it waits; Approve runs it later (work-chats.ts). On a client too, since the gate is the
 * tool's own and the client calls the tool.
 */
export function gated(tools: Record<string, unknown>, turn: TurnFor): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      if (!asksFirst(tool)) {
        return [name, tool];
      }
      return [
        name,
        Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
          execute: async (input: unknown) => {
            const id = await holdCall(turn, name, input);
            return {
              approval: id,
              status: "waiting",
              note: "Held for a person's approval. Don't call it again: the chat tells you once it is decided.",
            };
          },
        }),
      ];
    }),
  );
}

/** One tool of the space as it runs once approved, for the person the turn was for. */
export async function toolToRun(
  space: { id: string; name: string },
  userId: string,
  name: string,
  signal: AbortSignal,
  approved: ApprovedRun,
): Promise<ToolToRun | null> {
  const tools = await toolsFor(null, space, userId, signal, {}, null, approved);
  return (tools[name] as ToolToRun) ?? null;
}

/** A tool as an approved call runs it: its schema checks the held arguments first. */
export interface ToolToRun {
  inputSchema?: {
    safeParse?: (input: unknown) => {
      success: boolean;
      data?: unknown;
      error?: { message: string };
    };
  };
  execute?: (input: unknown) => Promise<unknown>;
}

/**
 * Everything a turn of the space's AI needs, made for the person who asked. Calls that reach past
 * the space are held (`gated`); on a client the tools are recorded as they run
 * (client-steps.ts): the client runs them itself. `choice`: what the person chose in the
 * composer.
 */
export async function workTurn(
  turn: TurnFor,
  signal: AbortSignal,
  steps: ClientSteps,
  choice: TurnChoice = {},
): Promise<WorkTurn> {
  const resolved = await chatModel(await chatTurnWay(managed), choice.extra ? "high" : "standard");
  const client = turn.role === "client";
  const made = gated(
    await toolsFor(
      resolved,
      turn.space,
      turn.userId,
      signal,
      choice,
      turn.chatId,
      null,
      turn.role ?? null,
    ),
    turn,
  );
  const tools = resolved.model instanceof HarnessModel ? steps.wrap(made) : made;
  attachTools(resolved, tools);
  const skills = client ? null : await spaceSkills(turn.space.id);
  const block = skills
    ? skillsBlock(skills, { tools: true, sandbox: sandboxCapabilities() !== null })
    : "";
  return {
    resolved,
    tools,
    instructions: instructionsFor(turn.space.name, block, "space_search" in tools, client),
  };
}

/** A turn made on its first use, and the signal that ends it TURN_MS after that. */
export interface LazyTurn {
  get(): Promise<WorkTurn>;
  signal: AbortSignal;
  /** The tool steps of a client as the model; empty on an API model, whose stream has them. */
  steps: ClientSteps;
}

export function lazyTurn(turn: TurnFor, choice: TurnChoice = {}): LazyTurn {
  const controller = new AbortController();
  const steps = new ClientSteps();
  let made: Promise<WorkTurn> | null = null;
  return {
    signal: controller.signal,
    steps,
    get() {
      if (!made) {
        setTimeout(() => controller.abort(new Error("The turn took too long.")), TURN_MS).unref();
        made = workTurn(turn, controller.signal, steps, choice);
      }
      return made;
    },
  };
}

import type { AgentStep } from "@engenty/wizards-shared/definition";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  type BrokerConnection,
  brokerCall,
  decide,
  kindOf,
  type Refusal,
  reachesOutside,
  whereOf,
  whoOf,
} from "../broker/index.js";
import { refreshConnector, resolveConnector } from "../connectors/external.js";
import type { ConnectorAction } from "../engenty/connections-sdk/types.js";
import type { StepContext } from "../engine/types.js";
import { prompt } from "../prompts.js";
import { inProgram } from "./code.js";
import { attempt, clip, type FileKeeper } from "./shared.js";
import { resolveFile } from "./store.js";

/** Above this many actions a connector is offered as "find an action, then call it". */
const DIRECT_TOOLS = 24;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * The actions of imported connectors a step may use, as tools. Reading is free; anything that
 * changes the person's account waits for their yes — engenty's default policy for connectors
 * (read: allow, write and destructive: ask), asked of the person who is running the wizard.
 */
export async function connectorTools(step: AgentStep, ctx: StepContext, files: FileKeeper) {
  const tools: Record<string, any> = {};
  const connections = (ctx.def.connections ?? []).filter(
    (c) => c.connector && step.connections?.includes(c.id),
  );
  for (const connection of connections) {
    Object.assign(tools, await toolsOf(connection, ctx, files));
  }
  return tools;
}

const MAGIC: [string, string, string][] = [
  ["%PDF", "application/pdf", "pdf"],
  ["\x89PNG", "image/png", "png"],
  ["\xff\xd8\xff", "image/jpeg", "jpg"],
  ["GIF8", "image/gif", "gif"],
  ["PK\x03\x04", "application/zip", "zip"],
];

/** What a file is, by its first bytes — connectors often hand over content without a name. */
function sniff(data: Buffer): { mime: string; ext: string } | null {
  const head = data.subarray(0, 8).toString("latin1");
  const hit = MAGIC.find(([magic]) => head.startsWith(magic));
  return hit ? { mime: hit[1], ext: hit[2] } : null;
}

/**
 * A model cannot carry a file: content an action returns as base64 is kept in the wizard's
 * files and the result names the path instead.
 */
async function keepContent(
  result: unknown,
  action: ConnectorAction,
  service: string,
  files: FileKeeper,
): Promise<unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    if (!key.endsWith("_base64") || typeof value !== "string" || !value) {
      continue;
    }
    const data = Buffer.from(value, "base64");
    const kind = sniff(data);
    const given = [out.name, out.filename, out.file_name].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    const name = given ?? `${action.id}-${Date.now().toString(36)}.${kind?.ext ?? "bin"}`;
    const declared = [out.mime_type, out.mimeType, out.content_type].find(
      (v): v is string => typeof v === "string",
    );
    const kept = await files.keep(`${service}/${name}`, data, {
      mime: declared ?? kind?.mime,
      source: `${service}: ${action.summary || action.id}`,
    });
    delete out[key];
    out.saved = kept.path;
    out.note = prompt("tools", "note.connector_kept");
  }
  return out;
}

/** The other way round: `file:<path>` in a `*_base64` input sends a kept file or an upload. */
async function sendContent(input: unknown, ctx: StepContext): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    if (key.endsWith("_base64") && typeof value === "string" && value.startsWith("file:")) {
      const file = await resolveFile(ctx, value.slice("file:".length));
      out[key] = Buffer.from(file.data).toString("base64");
    }
  }
  return out;
}

/** A text that ends as a sentence, so the notes after it read as their own. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * Whether the person is asked before an action runs: the broker's decision for this step, with
 * no side effect. The wizard's author can settle it per action (`connection.policy`); deleting is
 * never taken off the person.
 */
function asks(connection: ConnectionDef, action: ConnectorAction, ctx: StepContext): boolean {
  return (
    decide({
      who: whoOf(ctx.store.holder),
      where: whereOf(ctx),
      connection: {
        kind: "store_secret",
        def: connection,
        scope: ctx.store,
        spaceId: ctx.space.id,
      },
      actionId: action.id,
      kind: kindOf(action.group),
    }).outcome === "ask"
  );
}

/** What the model reads when the broker refuses a call. */
function refusalNote(refused: Refusal, service: string): string {
  switch (refused) {
    case "not_connected":
      return prompt("tools", "note.connector_not_connected", { service });
    case "nobody":
      return inProgram()
        ? prompt("tools", "note.connector_in_program")
        : prompt("tools", "note.connector_nobody");
    case "declined":
      return prompt("tools", "note.connector_declined");
    default:
      return prompt("tools", "note.connector_refused", { service });
  }
}

/** One connection's actions as tools — for a step that lists it, or a share job that sends through it. */
export async function toolsOf(connection: ConnectionDef, ctx: StepContext, files: FileKeeper) {
  const spaceId = ctx.space.id;
  const id = connection.connector ?? "";
  let resolved = await resolveConnector(spaceId, id);
  if (!resolved) {
    return {};
  }
  const held: BrokerConnection = {
    kind: "store_secret",
    def: connection,
    scope: ctx.store,
    spaceId,
  };
  const who = whoOf(ctx.store.holder);
  const where = whereOf(ctx);
  // An MCP server that lists its tools only to a signed-in account: ask it now that there is one.
  if (resolved.imported && !resolved.connector.actions.length) {
    const refreshed = await brokerCall({
      who,
      where,
      connection: held,
      action: { id: "list_tools", kind: "read" },
      input: {},
      handler: (account) => refreshConnector(spaceId, id, account.ctx.accessToken),
    }).catch(() => null);
    if (refreshed?.ok) {
      resolved = (await resolveConnector(spaceId, id)) ?? resolved;
    }
  }
  const { connector, inputSchema } = resolved;
  const usable = connection.actions
    ? connector.actions.filter((a) => connection.actions?.includes(a.id))
    : connector.actions.filter((a) => a.group === "read");
  const service = connection.title ?? connector.name;
  const prefix = connector.toolPrefix;
  for (const action of usable) {
    reachesOutside(`${prefix}_${action.id}`, {
      connection: connection.id,
      action: action.id,
      kind: kindOf(action.group),
    });
  }

  const call = (action: ConnectorAction, input: unknown) =>
    attempt(async () => {
      const out = await brokerCall({
        who,
        where,
        connection: held,
        action: { id: action.id, kind: kindOf(action.group) },
        input: input ?? {},
        ctx: { ask: ctx.ask, allowed: ctx.resources.allowed },
        handler: async (account) => {
          await ctx.emit("tool", `${service}: ${action.summary || action.id}`.slice(0, 120));
          return keepContent(
            await action.handler(await sendContent(input ?? {}, ctx), account.ctx),
            action,
            service,
            files,
          );
        },
      });
      if (!out.ok) {
        return { error: refusalNote(out.refused, service) };
      }
      const result = out.result;
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return { result: clip(text ?? "", 8000) };
    });

  const fileNote = prompt("tools", "connector.file_note");
  const direct =
    usable.length <= DIRECT_TOOLS && usable.every((a) => TOOL_NAME.test(`${prefix}_${a.id}`));
  if (direct) {
    return Object.fromEntries(
      usable.map((action) => [
        `${prefix}_${action.id}`,
        createTool({
          id: `${prefix}_${action.id}`,
          description: [
            sentence(`${service}: ${action.description || action.summary}`),
            asks(connection, action, ctx) ? prompt("tools", "connector.asks") : "",
            fileNote,
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 1100),
          inputSchema: action.inputSchema as z.ZodType<any>,
          execute: (input) => call(action, input),
        }),
      ]),
    );
  }

  return {
    [`${prefix}_actions`]: createTool({
      id: `${prefix}_actions`,
      description: prompt("tools", "connector.actions", {
        service,
        count: usable.length,
        prefix,
      }),
      inputSchema: z.object({
        query: z.string().describe("Words to look for, e.g. 'search pages' or 'invoice list'."),
      }),
      execute: ({ query }) =>
        attempt(async () => {
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          const scored = usable
            .map((a) => {
              const text = `${a.id} ${a.summary} ${a.description}`.toLowerCase();
              return { a, score: words.filter((w) => text.includes(w)).length };
            })
            .filter((x) => x.score > 0)
            .sort((x, y) => y.score - x.score)
            .slice(0, 12);
          return {
            actions: scored.map(({ a }) => ({
              id: a.id,
              does: a.summary || a.description.slice(0, 200),
              asks_person_first: asks(connection, a, ctx),
              input: inputSchema(a.id),
            })),
          };
        }),
    }),
    [`${prefix}_call`]: createTool({
      id: `${prefix}_call`,
      description: `${prompt("tools", "connector.call", { service, prefix })} ${fileNote}`,
      inputSchema: z.object({
        action: z.string(),
        input: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: ({ action: id, input }) => {
        const action = usable.find((a) => a.id === id);
        return action
          ? call(action, input)
          : Promise.resolve({ error: `No action "${id}". Use ${prefix}_actions to find one.` });
      },
    }),
  };
}

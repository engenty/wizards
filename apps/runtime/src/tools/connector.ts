import type { AgentStep } from "@engenty-wizards/shared/definition";
import type { ConnectionDef } from "@engenty-wizards/shared/store";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { refreshConnector, resolveConnector } from "../connectors/external.js";
import { connectionContext } from "../connectors/index.js";
import type { ConnectorAction } from "../engenty/connections-sdk/types.js";
import type { StepContext } from "../engine/types.js";
import { inProgram } from "./code.js";
import { attempt, clip, type FileKeeper } from "./shared.js";
import { resolveFile } from "./store.js";

const FILE_NOTE =
  " File content never passes through you: returned content is kept as a file and you get its path; to send a kept file, give `file:<path>` where an input asks for `*_base64`.";

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
    out.note = "The content is kept as a file; read it with read_document.";
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

/**
 * Whether the person is asked before an action runs. The wizard's author can settle it per
 * action (a server may call a plain lookup a change); deleting is never taken off the person.
 */
function asks(connection: ConnectionDef, action: ConnectorAction): boolean {
  if (action.group === "destructive") {
    return true;
  }
  return (connection.policy?.[action.id] ?? (action.group === "read" ? "allow" : "ask")) === "ask";
}

async function toolsOf(connection: ConnectionDef, ctx: StepContext, files: FileKeeper) {
  const projectId = ctx.project.id;
  const id = connection.connector ?? "";
  let resolved = await resolveConnector(projectId, id);
  if (!resolved) {
    return {};
  }
  const account = () => connectionContext(ctx.store, connection, projectId);
  // An MCP server that lists its tools only to a signed-in account: ask it now that there is one.
  if (resolved.imported && !resolved.connector.actions.length) {
    const found = await account();
    if (found) {
      await refreshConnector(projectId, id, found.ctx.accessToken).catch(() => undefined);
      resolved = (await resolveConnector(projectId, id)) ?? resolved;
    }
  }
  const { connector, inputSchema } = resolved;
  const usable = connection.actions
    ? connector.actions.filter((a) => connection.actions?.includes(a.id))
    : connector.actions.filter((a) => a.group === "read");
  const service = connection.title ?? connector.name;

  const call = (action: ConnectorAction, input: unknown) =>
    attempt(async () => {
      const found = await account();
      if (!found) {
        return {
          error: `The person has not connected ${service}. Go on without it and say so in your result.`,
        };
      }
      const key = `${connection.id}:${action.id}`;
      if (asks(connection, action) && !ctx.resources.allowed.has(key)) {
        if (inProgram()) {
          return {
            error:
              "This change waits for the person's yes, which a program cannot ask for. Call the tool directly, outside the program.",
          };
        }
        const answer = await ctx.ask({
          kind: "confirm",
          reason: action.summary || action.id,
          service,
          action: {
            id: action.id,
            summary: action.summary,
            destructive: action.group === "destructive",
          },
          input: JSON.stringify(input ?? {}, null, 2).slice(0, 4000),
        });
        if (!answer) {
          return {
            error:
              "Nobody is there to allow this change, so it was not made. Report it as open in your result.",
          };
        }
        if (answer.type !== "done") {
          return {
            error:
              "The person did not allow this change. Do not try it again; say in your result that it was not made.",
          };
        }
        if (answer.remember) {
          ctx.resources.allowed.add(key);
        }
      }
      await ctx.emit("tool", `${service}: ${action.summary || action.id}`.slice(0, 120));
      const result = await keepContent(
        await action.handler(await sendContent(input ?? {}, ctx), found.ctx),
        action,
        service,
        files,
      );
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return { result: clip(text ?? "", 8000) };
    });

  const prefix = connector.toolPrefix;
  const direct =
    usable.length <= DIRECT_TOOLS && usable.every((a) => TOOL_NAME.test(`${prefix}_${a.id}`));
  if (direct) {
    return Object.fromEntries(
      usable.map((action) => [
        `${prefix}_${action.id}`,
        createTool({
          id: `${prefix}_${action.id}`,
          description: `${service}: ${action.description || action.summary}${
            asks(connection, action) ? " — the person is asked before this runs." : ""
          }${FILE_NOTE}`.slice(0, 1100),
          inputSchema: action.inputSchema as z.ZodType<any>,
          execute: (input) => call(action, input),
        }),
      ]),
    );
  }

  return {
    [`${prefix}_actions`]: createTool({
      id: `${prefix}_actions`,
      description: `${service} offers ${usable.length} actions. Find the ones you need by words from their name or purpose; you get each action's id, what it does and its input. Then call ${prefix}_call.`,
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
              asks_person_first: asks(connection, a),
              input: inputSchema(a.id),
            })),
          };
        }),
    }),
    [`${prefix}_call`]: createTool({
      id: `${prefix}_call`,
      description: `Run one ${service} action found with ${prefix}_actions. Some wait for the person's yes first.${FILE_NOTE}`,
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

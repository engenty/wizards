import type { CallToolResult, McpServer, ToolCallback } from "@modelcontextprotocol/server";
import { z } from "zod";
import { callOutside, RUN_COMMAND } from "../elements/outside.js";
import { ELEMENT_SPECS, ELEMENT_TOOL_NAMES } from "../elements/specs.js";
import { prompt } from "../prompts.js";
import { listSpaces } from "../services/spaces.js";
import type { Principal } from "./auth.js";

/**
 * The space's elements as MCP tools (docs/plans/modular.md, phase 2): what a Work chat uses,
 * for Claude Code, Codex or any MCP client signed in as a person. Made from the catalogue's specs
 * (elements/specs.ts), one tool each, behind the scope it needs. Each takes the space it works in
 * (`spaceId`, the person's first space when left out), checked against the token on every call
 * (I2); who calls is the token's person, never an argument (I1).
 */

const spaceId = z
  .string()
  .optional()
  .describe("The space to work in, as list_spaces names it; the first space when left out.");

const READ_ONLY = new Set<string>([
  "space_search",
  "space_list",
  "page_read",
  "table_read",
  "space_document",
  "skill_list",
  "skill_load",
  "skill_read",
  "connection_list",
  "wizard_list",
]);

function answer(result: Awaited<ReturnType<typeof callOutside>>): CallToolResult {
  const body = result.ok
    ? result.result
    : { error: result.error, ...(result.data ? { data: result.data } : {}) };
  return {
    ...(result.ok ? {} : { isError: true }),
    content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
  };
}

export function registerElementTools(server: McpServer, who: Principal) {
  const outside = {
    userId: who.userId,
    role: who.role,
    client: who.client,
    tenantId: who.tenantId,
    scopes: who.scopes,
  };
  const register = (name: string, scope: string, description: string, input: z.ZodObject) => {
    if (!who.scopes.includes(scope as never)) {
      return;
    }
    const withSpace = input.extend({ spaceId });
    server.registerTool(
      name,
      {
        title: name.replace(/_/g, " "),
        description,
        inputSchema: withSpace,
        annotations: {
          readOnlyHint: READ_ONLY.has(name),
          // A connection's action may write, send or delete in a connected account.
          destructiveHint: name === "connection_call",
          // Running a wizard or a command reaches past the person's own data.
          openWorldHint: !READ_ONLY.has(name),
        },
      },
      (async (args: Record<string, unknown>) => {
        const { spaceId: space, ...rest } = args;
        return answer(
          await callOutside(
            outside,
            typeof space === "string" ? space : undefined,
            name,
            rest,
            AbortSignal.timeout(10 * 60_000),
          ),
        );
      }) as ToolCallback<typeof withSpace>,
    );
  };
  for (const name of ELEMENT_TOOL_NAMES) {
    const spec = ELEMENT_SPECS[name];
    register(name, spec.scope, spec.description(), spec.input);
  }
  register(
    "run_command",
    RUN_COMMAND.scope,
    "Runs a shell command in your sandbox for this space, where the skills you loaded put their scripts (skills/<name>/). It keeps its files while you use it.",
    RUN_COMMAND.input,
  );
  // A client that only uses a space still needs to know which spaces there are.
  if (who.scopes.includes("elements:read") && !who.scopes.includes("wizards:read")) {
    server.registerTool(
      "list_spaces",
      {
        title: "List spaces",
        description: prompt("mcp", "tool.list_spaces"),
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      (async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              (await listSpaces(who.userId)).map((p) => ({ id: p.id, name: p.name })),
            ),
          },
        ],
      })) as ToolCallback<z.ZodObject>,
    );
  }
}

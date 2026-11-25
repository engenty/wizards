import { createTool } from "@mastra/core/tools";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

process.env.DATA_DIR ??= "/tmp/wizards-tool-harness";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";

type Harness = typeof import("../src/tools/harness.js");
type Connections = typeof import("../src/tools/connections.js");
let harness: Harness;
let connections: Connections;
beforeAll(async () => {
  harness = await import("../src/tools/harness.js");
  connections = await import("../src/tools/connections.js");
});
vi.mock("../src/tenants/tenant.js", async (real) => ({ ...(await real<object>()), currentTenant: () => "t" }));

const ran: unknown[] = [];
const action = (name: string, description: string) => {
  const tool = createTool({
    id: name,
    description: `${description} ${"More about it. ".repeat(60)}`,
    inputSchema: z.object({ to: z.string().describe("Who") }),
    execute: async (input) => {
      ran.push([name, input]);
      return { sent: true };
    },
  });
  connections.connectionTools.add(tool);
  return tool;
};
const resolved = (vendor = "anthropic") =>
  ({ model: {}, ref: "anthropic/claude-sonnet-5-5", vendor, gateway: true, metered: false }) as never;
const all = () => ({
  space_search: createTool({ id: "space_search", description: "Search the space.", inputSchema: z.object({}), execute: async () => ({}) }),
  web_search: { type: "provider", id: "anthropic.web_search" },
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, n) => [`mail_${n}`, action(`mail_${n}`, n === 3 ? "Send a letter by mail." : "Something else.")]),
  ),
});
const run = (tool: unknown, input: unknown) => (tool as { execute(i: unknown, c?: unknown): Promise<any> }).execute(input);

describe("the harness around a chat's tools", () => {
  it("keeps what every turn needs and puts a space's many actions behind two tools", async () => {
    const { tools } = harness.harnessed(all(), resolved(), (_n, tool) => harness.oneOfMany(tool));
    expect(Object.keys(tools).sort()).toEqual(["space_search", "tool_call", "tool_search", "web_search"]);
    const { found } = await run(tools.tool_search, { query: "send a letter" });
    expect(found).toMatch(/mail_3[\s\S]*"to"/);
  });

  it("runs the chat's own tool with a checked input, and nothing else", async () => {
    const { tools } = harness.harnessed(all(), resolved(), (_n, tool) => harness.oneOfMany(tool));
    expect(await run(tools.tool_call, { name: "mail_3", input: { to: "Anna" } })).toEqual({ sent: true });
    expect(ran).toEqual([["mail_3", { to: "Anna" }]]);
    for (const raw of [
      { name: "mail_send", input: { to: "Anna" } },
      { name: "mail_3", input: {} },
      { name: "mail_3", input: { to: 3 } },
    ]) {
      expect((await run(tools.tool_call, raw)).error).toMatch(/[Nn]othing was done/);
    }
    expect(ran).toHaveLength(1);
  });

  it("leaves a client all its tools, and a few small ones in the prompt", () => {
    const tools = all();
    expect(harness.harnessed(tools, resolved("claude"), () => true).tools).toBe(tools);
    const few = { space_search: tools.space_search };
    expect(harness.harnessed(few, resolved(), () => true).tools).toBe(few);
  });
});

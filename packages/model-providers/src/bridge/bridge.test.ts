import { AsyncLocalStorage } from "node:async_hooks";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { ClientModel } from "../clients/model.js";
import { Bridges, type BridgeTool, contentOf } from "./index.js";

const BASE = "http://127.0.0.1:1/bridge";

const add: BridgeTool = {
  name: "add",
  description: "Adds two numbers.",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  execute: async (input) => {
    const { a, b } = input as { a: number; b: number };
    return { sum: a + b };
  },
};

const clients: Client[] = [];

/** An MCP client on one bridge, with no server listening: its fetch goes straight to `fetch`. */
async function connect(
  bridges: Bridges,
  how: { path: string } | { bearer: string },
): Promise<Client> {
  const url = "path" in how ? `${BASE}/${how.path}` : `${BASE}`;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => {
      const request = new Request(input, init);
      if ("path" in how) {
        return bridges.fetch(request, how.path);
      }
      request.headers.set("authorization", `Bearer ${how.bearer}`);
      return bridges.fetch(request);
    },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const textOf = (result: { content?: unknown }) =>
  (result.content as { type: string; text?: string }[])[0]?.text ?? "";

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("Bridges", () => {
  it("serves a call's tools over MCP and closes them with the call", async () => {
    const bridges = new Bridges();
    const bridge = bridges.open([add]);
    const client = await connect(bridges, { path: bridge.token });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["add"]);
    expect(tools.tools[0]?.description).toBe("Adds two numbers.");
    const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } });
    expect(JSON.parse(textOf(result))).toEqual({ sum: 5 });
    bridge.close();
    const gone = await bridges.fetch(
      new Request(`${BASE}/${bridge.token}`, { method: "POST" }),
      bridge.token,
    );
    expect(gone.status).toBe(404);
  });

  it("takes the token from the bearer header, and the host's own token", async () => {
    const bridges = new Bridges({ name: "home" });
    const bridge = bridges.open([add], { token: "turn-token" });
    expect(bridge.token).toBe("turn-token");
    const client = await connect(bridges, { bearer: "turn-token" });
    const result = await client.callTool({ name: "add", arguments: { a: 1, b: 1 } });
    expect(JSON.parse(textOf(result))).toEqual({ sum: 2 });
    const wrong = await bridges.fetch(
      new Request(BASE, { method: "POST", headers: { authorization: "Bearer nope" } }),
    );
    expect(wrong.status).toBe(404);
    const none = await bridges.fetch(new Request(BASE, { method: "POST" }));
    expect(none.status).toBe(404);
  });

  it("keeps two bridges apart", async () => {
    const bridges = new Bridges();
    const one = bridges.open([add]);
    const other = bridges.open([{ ...add, name: "other" }]);
    const client = await connect(bridges, { path: one.token });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["add"]);
    one.close();
    const still = await connect(bridges, { path: other.token });
    expect((await still.listTools()).tools.map((t) => t.name)).toEqual(["other"]);
    other.close();
  });

  it("runs a tool in the context of the code that opened the bridge", async () => {
    const tenant = new AsyncLocalStorage<string>();
    const bridges = new Bridges();
    const bridge = tenant.run("acme", () =>
      bridges.open([
        {
          name: "whoami",
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({ tenant: tenant.getStore() ?? null }),
        },
      ]),
    );
    // The client's request comes from outside that context.
    const client = await connect(bridges, { path: bridge.token });
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(JSON.parse(textOf(result))).toEqual({ tenant: "acme" });
    bridge.close();
  });

  it("answers a failing tool as an error the client reads", async () => {
    const bridges = new Bridges();
    const bridge = bridges.open([
      {
        name: "boom",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          throw new Error("The folder is gone.");
        },
      },
    ]);
    const client = await connect(bridges, { path: bridge.token });
    const result = await client.callTool({ name: "boom", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("The folder is gone.");
    bridge.close();
  });

  it("aborts a running tool's signal when the bridge closes", async () => {
    const bridges = new Bridges();
    let seen: AbortSignal | undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const bridge = bridges.open([
      {
        name: "wait",
        inputSchema: { type: "object", properties: {} },
        execute: (_input, options) =>
          new Promise((resolve) => {
            seen = options?.signal;
            started();
            options?.signal?.addEventListener("abort", () => resolve("stopped"), { once: true });
          }),
      },
    ]);
    const client = await connect(bridges, { path: bridge.token });
    const call = client.callTool({ name: "wait", arguments: {} });
    await running;
    expect(seen?.aborted).toBe(false);
    bridge.close();
    expect(seen?.aborted).toBe(true);
    expect(textOf(await call)).toBe("stopped");
  });

  it("is the bridge of a ClientModel at a base URL", async () => {
    const bridges = new Bridges();
    const urls: (string | null)[] = [];
    const listed: string[][] = [];
    class Probe extends ClientModel {
      readonly provider = "probe";
      protected async invoke(call: { bridgeUrl: string | null }) {
        urls.push(call.bridgeUrl);
        const token = call.bridgeUrl?.split("/").pop() ?? "";
        const client = await connect(bridges, { path: token });
        listed.push((await client.listTools()).tools.map((t) => t.name));
        return { text: "ok" };
      }
    }
    const model = new Probe({ id: "probe", name: "Probe" }, "default", {
      bridge: bridges.at(`${BASE}/`),
    });
    model.attach({ add: { id: "add", execute: add.execute } });
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      tools: [{ type: "function", name: "add", inputSchema: add.inputSchema as never }],
    });
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:1\/bridge\/[\w-]{32}$/);
    expect(listed).toEqual([["add"]]);
    // The call is over: its bridge is closed.
    const token = urls[0]?.split("/").pop() ?? "";
    const gone = await bridges.fetch(new Request(urls[0] ?? BASE, { method: "POST" }), token);
    expect(gone.status).toBe(404);
  });
});

describe("contentOf", () => {
  it("is a string as text and anything else as JSON", () => {
    expect(contentOf({}, "hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
    expect(contentOf({}, { a: 1 })).toEqual({ content: [{ type: "text", text: '{"a":1}' }] });
    expect(contentOf({}, undefined)).toEqual({ content: [{ type: "text", text: "null" }] });
  });

  it("follows what toModelOutput shapes: text, JSON, pictures and errors", () => {
    const shaped = (value: unknown) => ({ toModelOutput: () => value });
    expect(contentOf(shaped({ type: "text", value: "done" }), null)).toEqual({
      content: [{ type: "text", text: "done" }],
    });
    expect(contentOf(shaped({ type: "json", value: { n: 2 } }), null)).toEqual({
      content: [{ type: "text", text: '{"n":2}' }],
    });
    expect(
      contentOf(
        shaped({
          type: "content",
          value: [
            { type: "text", text: "Here:" },
            { type: "image-data", data: "AAA", mediaType: "image/jpeg" },
            { type: "file-data", data: "BBB", mediaType: "image/png" },
          ],
        }),
        null,
      ),
    ).toEqual({
      content: [
        { type: "text", text: "Here:" },
        { type: "image", data: "AAA", mimeType: "image/jpeg" },
        { type: "image", data: "BBB", mimeType: "image/png" },
      ],
    });
    expect(contentOf(shaped({ type: "error-text", value: "no" }), null)).toEqual({
      isError: true,
      content: [{ type: "text", text: "no" }],
    });
  });
});

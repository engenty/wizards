import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-sub-"));
// A stand-in for Claude Code: it records its arguments, signs in at the MCP endpoint with the
// config it was handed, and answers in the stream-json shape.
const fake = join(dir, "claude");
writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.0.0 (fake)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(args));
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.wizards;
(async () => {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  fs.writeFileSync(${JSON.stringify(join(dir, "stdin.json"))}, input);
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { ...cfg.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const text = await res.text();
  const tools = (text.match(/"name":"[a-z_]+"/g) || []).length;
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__wizards__edit_wizard" }] } }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mcp " + res.status + " tools " + (tools > 5) }] } }));
  console.log(JSON.stringify({ type: "result", is_error: false, session_id: "sess-1", result: "done" }));
})();
`,
);
chmodSync(fake, 0o755);
// A stand-in for Codex that is signed in by its own account but refused by the vendor.
const fakeCodex = join(dir, "codex");
writeFileSync(
  fakeCodex,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.0.0"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(join(dir, "codex-args.json"))}, JSON.stringify({ args, key: Boolean(process.env.WIZARDS_MCP_KEY) }));
console.log(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
console.log(JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } }));
`,
);
chmodSync(fakeCodex, 0o755);

process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.CLAUDE_BIN = fake;
process.env.CODEX_BIN = fakeCodex;
// Not installed: never offered.
process.env.CURSOR_AGENT_BIN = join(dir, "no-cursor-agent");

let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  const app = (await import("../src/app")).default;
  server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // The chat's MCP config points at the port this server listens on.
  const { env } = await import("../src/env");
  (env as { port: number }).port = (server.address() as AddressInfo).port;
}, 30_000);

afterAll(() => server?.close());

describe("studio chat on the Claude subscription", () => {
  it("runs Claude Code without its own tools and lets it reach only our MCP endpoint", async () => {
    const { subscriptionTurn, subscriptionClients } = await import("../src/agents/subscription");
    expect(await subscriptionClients()).toEqual(["claude", "codex"]);
    const seen: string[] = [];
    let building = 0;
    const png = new Uint8Array([137, 80, 78, 71]);
    const turn = () =>
      subscriptionTurn({
        client: "claude",
        wizardId: "w1",
        message: "Bau etwas",
        signal: new AbortController().signal,
        onText: (t) => seen.push(t),
        onActivity: (a) => seen.push(`[${a}]`),
        onBuilding: () => building++,
        images: [{ path: "paste.png", mime: "image/png", data: png }],
      });
    const first = await turn();
    expect(first).toEqual({ reply: "mcp 200 tools true", changed: true });
    expect(building).toBe(1);
    expect(seen).toContain("[Rebuilding the wizard …]");

    const args: string[] = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__wizards");
    expect(args).not.toContain("--resume");
    // The message and its pictures come on stdin, as one user message.
    const sent = JSON.parse(readFileSync(join(dir, "stdin.json"), "utf8"));
    expect(sent.message.content).toEqual([
      { type: "text", text: "Bau etwas" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: Buffer.from(png).toString("base64") },
      },
    ]);

    // The second turn continues the conversation the client keeps.
    await turn();
    const again: string[] = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
    expect(again[again.indexOf("--resume") + 1]).toBe("sess-1");
  }, 30_000);

  it("hands Codex our key in its environment and says when its sign-in is refused", async () => {
    const { subscriptionTurn } = await import("../src/agents/subscription");
    const { readSetting } = await import("../src/settings");
    const turn = subscriptionTurn({
      client: "codex",
      wizardId: "w1",
      message: "Bau etwas",
      signal: new AbortController().signal,
      onText: () => undefined,
      onActivity: () => undefined,
      onBuilding: () => undefined,
    });
    await expect(turn).rejects.toMatchObject({ code: "refused" });
    const seen = JSON.parse(readFileSync(join(dir, "codex-args.json"), "utf8"));
    expect(seen.key).toBe(true);
    expect(seen.args.slice(0, 2)).toEqual(["exec", "-"]);
    // A failed conversation starts afresh; Claude's stays.
    expect(await readSetting("chat-session:codex:w1")).toBeNull();
    expect(await readSetting("chat-session:w1")).toBe("sess-1");
  }, 30_000);

  it("answers on a chosen client only while it is there", async () => {
    const { chatEngine, setChatEngine } = await import("../src/agents/subscription");
    await setChatEngine("codex");
    expect(await chatEngine(true)).toBe("codex");
    await setChatEngine("cursor");
    expect(await chatEngine(true)).toBe("models");
    expect(await chatEngine(false)).toBe("claude");
    // A provider without its key, or credits without an account, cannot answer yet.
    await setChatEngine("openai");
    expect(await chatEngine(true)).toBe("models");
    await setChatEngine("account");
    expect(await chatEngine(true)).toBe("models");
  });

  it("gives Goose and the editor a client's own model of the class", async () => {
    const { chatModel } = await import("../src/models");
    const { HarnessModel } = await import("../src/harness/model");
    const goose = await chatModel("codex", "high");
    expect(goose.ref).toBe("codex/gpt-6.1-sol");
    expect(goose.model).toBeInstanceOf(HarnessModel);
    expect((await chatModel("claude", "highest")).ref).toBe("claude/opus");
    await expect(chatModel("openai", "high")).rejects.toThrow(/OpenAI/);
  });
});

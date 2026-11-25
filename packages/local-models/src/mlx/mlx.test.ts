import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probe } from "../probe.js";
import { serversHere } from "../servers/index.js";
import { downloadModel, Helper, helper, mlx, mlxFolder, mlxModel, mlxModels } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "mlx-"));
const root = join(dir, "models");
const MODEL = "mlx-community/Tiny-4bit";

const FILES: Record<string, string> = {
  "config.json": JSON.stringify({ quantization: { bits: 4 } }),
  "tokenizer_config.json": JSON.stringify({ chat_template: "{% if tools %}{{enable_thinking}}" }),
  "model.safetensors": "w".repeat(5000),
  "README.md": "no",
  "evil.py": "no",
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Hugging Face with one model, which remembers the ranges it was asked for. */
function hub(files = FILES, sha = hash(FILES["model.safetensors"] as string)) {
  const asked: [string, string | null][] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    if (pathname === `/api/models/${MODEL}`) {
      return Response.json({
        sha: "abc",
        siblings: Object.entries(files).map(([rfilename, text]) => ({
          rfilename,
          size: text.length,
          ...(rfilename.endsWith(".safetensors") ? { lfs: { sha256: sha } } : {}),
        })),
      });
    }
    const name = pathname.split("/resolve/abc/")[1];
    const text = name && files[name];
    if (!text) {
      return new Response("", { status: 404 });
    }
    const range = new Headers(init?.headers).get("range");
    asked.push([name, range]);
    const from = Number(range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    return new Response(text.slice(from), { status: range ? 206 : 200 });
  }) as typeof fetch;
  return { doFetch, asked };
}

/** A helper that answers by what it is asked, as `wizards-mlx` does on stdin and stdout. */
const bin = join(dir, "wizards-mlx");
writeFileSync(
  bin,
  `#!${process.execPath}
const rl = require("node:readline").createInterface({ input: process.stdin });
const say = (o) => console.log(JSON.stringify(o));
rl.on("line", (line) => {
  const { id, chat, cancel } = JSON.parse(line);
  if (cancel) return say({ id, done: true, done_reason: "cancel" });
  const text = chat.messages.at(-1).content;
  if (text === "die") { console.error("out of memory"); process.exit(3); }
  if (text === "wait") return;
  if (chat.tools) say({ id, message: { tool_calls: [{ function: { name: "add", arguments: { a: 1 } } }] } });
  else if (chat.schema) say({ id, message: { content: chat.schema } });
  else { say({ id, message: { thinking: "hm" } }); say({ id, message: { content: "o" } }); say({ id, message: { content: "k" } }); }
  say({ id, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 });
});
rl.on("close", () => process.exit(0));
`,
);
chmodSync(bin, 0o755);

beforeAll(() => {
  vi.stubEnv("WIZARDS_MLX_BIN", bin);
});
afterAll(() => {
  helper.stop();
  vi.unstubAllEnvs();
});

describe("MLX's models", () => {
  it("are in a folder of engenty's, or where MLX_MODELS says", () => {
    expect(mlxFolder({})).toMatch(/\.engenty\/models\/mlx$/);
    expect(mlxFolder({ MLX_MODELS: "/m" })).toBe("/m");
  });

  it("take weights and configuration, never code, and go on where a download stopped", async () => {
    const weights = FILES["model.safetensors"] as string;
    const folder = join(root, ...MODEL.split("/"));
    const broken = hub();
    const stop = new AbortController();
    const breaking = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("model.safetensors")) {
        stop.abort(new Error("broke off"));
      }
      return broken.doFetch(input, init);
    }) as typeof fetch;
    await expect(
      downloadModel(root, MODEL, () => undefined, { fetch: breaking, signal: stop.signal }),
    ).rejects.toThrow();
    expect(await mlxModels(root)).toEqual([]);
    writeFileSync(join(folder, "model.safetensors.part"), weights.slice(0, 2000));

    const { doFetch, asked } = hub();
    const seen: [number, number][] = [];
    await downloadModel(root, MODEL, (a, b) => seen.push([a, b]), { fetch: doFetch });
    expect(asked).toContainEqual(["model.safetensors", "bytes=2000-"]);
    expect(asked.map(([name]) => name)).not.toContain("evil.py");
    expect(existsSync(join(folder, "evil.py"))).toBe(false);
    expect(readFileSync(join(folder, "model.safetensors"), "utf8")).toBe(weights);
    const [done, total] = seen.at(-1) ?? [];
    expect(done).toBe(total);
    expect(await mlxModels(root)).toEqual([
      {
        name: MODEL,
        size: total,
        digest: "abc",
        capabilities: ["completion", "tools", "thinking"],
        completion: true,
        tools: true,
        vision: false,
        thinking: true,
        runner: "mlx",
        quantization: "4bit",
        running: false,
      },
    ]);
  });

  it("refuse weights that arrived damaged, a name that leaves the folder, and no weights", async () => {
    const other = join(dir, "other");
    const damaged = hub(FILES, hash("else"));
    await expect(
      downloadModel(other, MODEL, () => undefined, { fetch: damaged.doFetch }),
    ).rejects.toThrow(/damaged/);
    expect(await mlxModels(other)).toEqual([]);
    for (const name of ["../x", "a/../../b", "a", "a/b/c", "/etc/passwd"]) {
      await expect(downloadModel(other, name, () => undefined)).rejects.toThrow(/Hugging Face/);
    }
    const none = hub({ "config.json": "{}" });
    await expect(
      downloadModel(other, MODEL, () => undefined, { fetch: none.doFetch }),
    ).rejects.toThrow(/no weights/);
  });

  it("are removed with their folder", async () => {
    const other = join(dir, "gone");
    await downloadModel(other, MODEL, () => undefined, { fetch: hub().doFetch });
    await mlx.remove?.(other, MODEL);
    expect(existsSync(join(other, "mlx-community"))).toBe(false);
    await expect(mlx.remove?.(other, MODEL)).rejects.toThrow(/no model/);
  });
});

describe.runIf(process.platform === "darwin" && process.arch === "arm64")("a model of MLX", () => {
  const user = (text: string) => [
    { role: "user" as const, content: [{ type: "text" as const, text }] },
  ];
  const model = (tools = true) => mlxModel({ folder: root, model: MODEL, tools });

  it("is offered where the helper is", () => {
    expect(serversHere()).toContain("mlx");
    vi.stubEnv("WIZARDS_MLX_BIN", join(dir, "nothing"));
    expect(serversHere()).not.toContain("mlx");
    vi.stubEnv("WIZARDS_MLX_BIN", bin);
  });

  it("answers, calls tools and gets its schema as text, in the schema's order", async () => {
    const said = await model().doGenerate({ prompt: user("hi") });
    expect(said.content).toEqual([{ type: "text", text: "ok" }]);
    expect(said.usage.outputTokens.total).toBe(2);
    const called = await model().doGenerate({
      prompt: user("add"),
      tools: [{ type: "function", name: "add", inputSchema: { type: "object" } }],
    });
    expect(called.content[0]).toMatchObject({ type: "tool-call", toolName: "add" });
    const schema = { type: "object", properties: { z: {}, a: {} } } as const;
    const json = await model().doGenerate({
      prompt: user("json"),
      responseFormat: { type: "json", schema },
    });
    expect(json.content).toEqual([{ type: "text", text: JSON.stringify(schema) }]);
  });

  it("is in memory after a call, and the test call needs no more than one", async () => {
    expect((await mlx.models(root))[0]?.running).toBe(true);
    expect(await probe({ kind: "server", server: "mlx", url: root })).toEqual({
      state: "ok",
      model: MODEL,
      detail: "ok",
    });
  });

  it("is given up when its caller gives up", async () => {
    const stop = new AbortController();
    const call = model().doGenerate({ prompt: user("wait"), abortSignal: stop.signal });
    setTimeout(() => stop.abort(new Error("stopped")), 100);
    await expect(call).rejects.toThrow("stopped");
  });

  it("says why the helper ended, and starts anew for the next call", async () => {
    await expect(model().doGenerate({ prompt: user("die") })).rejects.toThrow("out of memory");
    expect((await model().doGenerate({ prompt: user("hi") })).content).toHaveLength(1);
  });

  it("leaves the memory once nobody asked for a while", async () => {
    const own = new Helper(() => bin, 50);
    for await (const _ of own.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }));
    expect(own.model).toBe("m");
    await vi.waitFor(() => expect(own.model).toBeUndefined());
  });
});

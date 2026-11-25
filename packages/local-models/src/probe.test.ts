import { describe, expect, it, vi } from "vitest";

vi.mock("./clients/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clients/env.js")>()),
  resolveEnv: async (spec: { id: string }) => ({
    env: { PATH: process.env.PATH },
    auth: spec.id === "signed-out" ? "none" : "subscription",
  }),
}));

const { probe } = await import("./probe.js");
const { CLIENTS } = await import("./clients/index.js");

/** A stand-in for a client: Node prints what `script` writes, as the client's output. */
const fakeClient = (id: string, script: string, version: string | null = "1.0.0") => ({
  ...CLIENTS.claude,
  id: id as "claude",
  bin: process.execPath,
  version: async () => version,
  args: () => ["-e", script],
});

const said = (text: string) =>
  `console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: ${JSON.stringify(text)} }] } }))`;

describe("a short real call to a client", () => {
  it("is ok when the client answers", async () => {
    expect(await probe({ kind: "client", client: fakeClient("a", said("ok")) })).toEqual({
      state: "ok",
      detail: "ok",
    });
  });

  it("tells a missing client and a missing sign-in from a failure", async () => {
    expect(await probe({ kind: "client", client: fakeClient("a", "", null) })).toEqual({
      state: "absent",
    });
    expect(
      (await probe({ kind: "client", client: fakeClient("signed-out", said("ok")) })).state,
    ).toBe("signed_out");
    const expired = `console.log(JSON.stringify({ type: "result", is_error: true, result: "OAuth token has expired" }))`;
    expect(await probe({ kind: "client", client: fakeClient("a", expired) })).toEqual({
      state: "signed_out",
      detail: "OAuth token has expired",
    });
    expect(
      await probe({
        kind: "client",
        client: fakeClient("a", "process.stderr.write('boom'); process.exit(2)"),
      }),
    ).toEqual({ state: "failed", detail: "boom" });
  });

  it("gives up after the timeout", async () => {
    expect(
      await probe({
        kind: "client",
        client: fakeClient("a", "setTimeout(() => {}, 5000)"),
        timeoutMs: 200,
      }),
    ).toEqual({ state: "failed", timedOut: true });
  });
});

describe("a short real call to Ollama", () => {
  const ollama = (
    models: { name: string; size: number; capabilities: string[] }[],
    chat: () => Response,
  ) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/version")) {
        return Response.json({ version: "0.40.12" });
      }
      if (url.endsWith("/api/tags")) {
        return Response.json({ models: models.map((m) => ({ ...m, digest: `d-${m.name}` })) });
      }
      if (url.endsWith("/api/ps")) {
        return Response.json({ models: [] });
      }
      if (url.endsWith("/api/show")) {
        const name = JSON.parse(String(init?.body)).model;
        return Response.json({ capabilities: models.find((m) => m.name === name)?.capabilities });
      }
      return chat();
    }) as typeof fetch;

  it("asks the model a host would pick first and says it answered", async () => {
    const asked: string[] = [];
    const doFetch = ollama(
      [
        { name: "talks:1b", size: 1e9, capabilities: ["completion"] },
        { name: "tools:8b", size: 5e9, capabilities: ["completion", "tools"] },
      ],
      () => Response.json({ message: { content: "ok" } }),
    );
    const result = await probe({
      kind: "server",
      server: "ollama",
      url: "http://ollama.test/v1",
      fetch: async (input, init) => {
        asked.push(String(input));
        return doFetch(input, init);
      },
    });
    expect(result).toEqual({ state: "ok", model: "tools:8b", detail: "ok" });
    expect(asked.at(-1)).toBe("http://ollama.test/api/chat");
  });

  it("says when Ollama does not answer, holds no model, or the model is too big", async () => {
    expect(
      await probe({
        kind: "server",
        server: "ollama",
        url: "http://ollama.test",
        fetch: async () => new Response("", { status: 502 }),
      }),
    ).toEqual({ state: "absent" });
    expect(
      await probe({
        kind: "server",
        server: "ollama",
        url: "http://ollama.test",
        fetch: ollama([], () => Response.json({})),
      }),
    ).toEqual({ state: "no_model" });
    const big = ollama(
      [{ name: "big:70b", size: 40e9, capabilities: ["completion", "tools"] }],
      () => Response.json({ message: { content: "ok" } }),
    );
    expect(
      await probe({
        kind: "server",
        server: "ollama",
        url: "http://ollama.test",
        memory: 32e9,
        share: 0.55,
        fetch: big,
      }),
    ).toEqual({ state: "too_big", model: "big:70b" });
    expect(
      await probe({
        kind: "server",
        server: "ollama",
        url: "http://ollama.test",
        model: "other",
        fetch: big,
      }),
    ).toEqual({ state: "no_model", model: "other" });
  });

  it("passes on what Ollama said when the call fails", async () => {
    const broken = ollama([{ name: "m:1b", size: 1e9, capabilities: ["completion"] }], () =>
      Response.json({ error: "model requires more system memory" }, { status: 500 }),
    );
    expect(
      await probe({ kind: "server", server: "ollama", url: "http://ollama.test", fetch: broken }),
    ).toEqual({
      state: "failed",
      model: "m:1b",
      detail: "model requires more system memory",
    });
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ClientSetup, setupRoutes, Terminals, Tested } from "./index.js";

const signIn = { signedIn: false };
const dir = mkdtempSync(join(tmpdir(), "model-setup-"));

/** A host with one client, which is not installed, and models that count their calls. */
function host() {
  const tested: string[] = [];
  const test = vi.fn(async () => ({ ref: "codex/default", text: " OK " }));
  const client = {
    id: "codex" as const,
    name: "Codex",
    bin: "/bin/sh",
    passThrough: /^$/,
    keyVars: [],
    auth: async () => (signIn.signedIn ? ("subscription" as const) : ("none" as const)),
    version: async () => null,
    login: { args: ["-c", "echo signed in"], interactive: false },
  };
  const routes = setupRoutes({
    clients: new ClientSetup({
      clients: [client],
      folder: () => join(dir, "clients"),
      env: () => ({ PATH: "/usr/bin:/bin" }),
    }),
    terminals: new Terminals(),
    workDir: () => join(dir, "work"),
    tested: new Tested({
      read: async () => tested,
      write: async (sources) => {
        tested.splice(0, tested.length, ...sources);
      },
    }),
    models: {
      source: () => "codex",
      settings: () => ({ source: "codex" }),
      save: async () => {},
      classes: ["classifier", "low"],
      test,
      providers: ["openai"],
      key: async (_c, _provider, key) => ({ ok: key === "good", message: null, text: "openai:m" }),
      ollama: async () => ({ ok: true, message: null, text: null }),
    },
  });
  const app = new Hono().route("/local", routes);
  app.onError((err, c) => c.json({ error: err.message }, 400));
  const post = async (path: string, body: unknown = {}) => {
    const res = await app.request(`/local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as never };
  };
  return { app, post, tested, test };
}

describe("the setup's routes", () => {
  it("find a client without asking a model", async () => {
    const { post, test } = host();
    const { body } = await post("/harness/codex/detect");
    expect(body).toMatchObject({
      harness: { id: "codex", version: null, auth: "none", images: false },
    });
    expect(test).not.toHaveBeenCalled();
  });

  it("list the host's clients without asking a model", async () => {
    const { app, test } = host();
    const res = await app.request("/local/clients");
    expect(await res.json()).toMatchObject({ clients: [{ id: "codex", version: null }] });
    expect(test).not.toHaveBeenCalled();
  });

  it("know no client the host does not have, and run nothing for it", async () => {
    const { post } = host();
    for (const job of ["detect", "install", "login"]) {
      expect((await post(`/harness/claude/${job}`)).status).toBe(404);
    }
  });

  it("end the setup for the source a test call worked on", async () => {
    const { post, tested, test } = host();
    expect((await post("/models/test")).body).toMatchObject({ ok: true, reply: "OK" });
    expect(test).toHaveBeenCalledWith("classifier");
    expect(tested).toEqual(["codex"]);
  });

  it("say what a failed call said and end nothing", async () => {
    const { post, tested, test } = host();
    test.mockRejectedValueOnce(new Error("no credit"));
    expect((await post("/models/test")).body).toMatchObject({ ok: false, error: "no credit" });
    expect(tested).toEqual([]);
  });

  it("take a key that works, and refuse a provider they do not know", async () => {
    const { post, tested } = host();
    await post("/keys/openai", { key: "bad" });
    expect(tested).toEqual([]);
    await post("/keys/openai", { key: "good" });
    expect(tested).toEqual(["own"]);
    expect((await post("/keys/else", { key: "good" })).status).toBe(400);
  });

  it.skipIf(process.platform === "win32")(
    "run the sign-in in a terminal the page follows",
    async () => {
      const { app, post } = host();
      const { body } = await post("/harness/codex/login", { cols: 80, rows: 24 });
      const { terminal } = body as { terminal: string };
      const res = await app.request(`/local/terminal/${terminal}/stream`);
      const said = await res.text();
      expect(said).toContain("signed in");
      expect(said).toContain('{"type":"exit","code":0}');
      expect((await post(`/terminal/${terminal}/resize`, { cols: 100, rows: 30 })).status).toBe(
        200,
      );
      expect((await post(`/terminal/${terminal}/resize`, { cols: 100 })).status).toBe(400);
      expect((await app.request(`/local/terminal/${terminal}`, { method: "DELETE" })).status).toBe(
        200,
      );
      expect((await post(`/terminal/${terminal}/input`, { data: "x" })).status).toBe(400);
    },
  );
});

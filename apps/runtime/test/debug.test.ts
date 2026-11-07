import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-debug-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let log: typeof import("../src/log");
let secret: string;
let ticket: () => string;

beforeAll(async () => {
  log = await import("../src/log");
  log.hookConsole();
  const { migrateControlDb } = await import("../src/db/client");
  await migrateControlDb();
  const { env } = await import("../src/env");
  secret = env.authSecret;
  const { mintLocalTicket } = await import("../src/auth/local-ticket");
  ticket = () => mintLocalTicket(secret, Date.now(), "local-debug");
  app = (await import("../src/app")).default;
}, 60_000);

const get = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost:5181${path}`, { headers }));

describe("the log ring", () => {
  it("takes secrets out of a line", () => {
    const line = log.redact(
      'Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl key wz_abcdef0123 sk-abcdefgh12345678 "apiKey":"topsecret-1" http://x/api/local/enter?k=deadbeef&other=1',
    );
    expect(line).not.toMatch(/eyJ|wz_abc|sk-abc|topsecret|deadbeef/);
    expect(line).toContain("other=1");
    expect(line).toContain("wz_[redacted]");
  });

  it("keeps what the console printed, with its level, and answers a tail", () => {
    const before = log.logState().newest;
    console.error("[run r1]", new Error("boom"));
    console.warn("[codex] usage limit reached for gpt-6.1-sol");
    console.log("plain line");
    const all = log.tail({ since: before });
    expect(all.map((l) => l.level)).toEqual(["error", "warn", "info"]);
    expect(all[0].text).toContain("boom");
    expect(log.tail({ since: before, level: "warn" })).toHaveLength(2);
    expect(log.tail({ since: before, q: "GPT-6.1" })).toHaveLength(1);
    expect(log.tail({ since: before, limit: 1 })[0].text).toBe("plain line");
  });
});

describe("a page reports an error", () => {
  it("lands in the log as a browser line", async () => {
    const res = await app.fetch(
      new Request("http://localhost:5181/api/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "TypeError: x is not a function",
          stack: "at studio.js:1",
          url: "http://localhost:5181/studio/edit/abc",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const [line] = log.tail({ q: "x is not a function", limit: 1 });
    expect(line.level).toBe("error");
    expect(line.text).toMatch(/^\[browser visitor\] at http:\/\/localhost:5181\/studio\/edit\/abc/);
  });

  it("refuses what is no report", async () => {
    const res = await app.fetch(
      new Request("http://localhost:5181/api/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("a look from afar", () => {
  it("merges the lines of the runners that report, and names one that does not answer", async () => {
    const { allLogs } = await import("../src/debug");
    const { controlDb, control } = await import("../src/db/client");
    const now = new Date();
    await controlDb.insert(control.runner).values([
      { id: "r-up", url: "http://r-up:8891", seen: now },
      { id: "r-down", url: "http://r-down:8891", seen: now },
      { id: "r-silent", url: "http://r-silent:8891", seen: new Date(now.getTime() - 3_600_000) },
      { id: "r-no-address", url: null, seen: now },
    ]);
    const asked: { url: string; auth: string | null }[] = [];
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      asked.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      if (String(url).includes("r-down")) {
        throw new Error("refused");
      }
      return Response.json({
        sources: [{ from: "r-up", ok: true }],
        lines: [{ id: 1, at: 5, level: "info", text: "[timing] page", from: "r-up" }],
      });
    });
    try {
      console.info("[timing] here");
      const answer = await allLogs({ q: "[timing]" }, "?q=%5Btiming%5D", "Bearer k");
      expect(asked).toEqual([
        { url: "http://r-up:8891/api/internal/debug/logs?q=%5Btiming%5D&own=1", auth: "Bearer k" },
        { url: "http://r-down:8891/api/internal/debug/logs?q=%5Btiming%5D&own=1", auth: "Bearer k" },
      ]);
      expect(answer.sources).toContainEqual({ from: "r-up", ok: true });
      expect(answer.sources).toContainEqual({ from: "r-down", ok: false, error: "refused" });
      // By time: the runner's older line comes first.
      expect(answer.lines[0]).toMatchObject({ from: "r-up", text: "[timing] page" });
      expect(answer.lines.at(-1)?.text).toBe("[timing] here");
    } finally {
      fetched.mockRestore();
    }
  });

  it("is not for the Manage-App on a runtime that runs alone", async () => {
    expect((await get("/api/internal/debug/status")).status).toBe(401);
    expect((await get("/api/internal/debug/logs")).status).toBe(401);
  });

  it("answers the command line with a signed ticket only", async () => {
    expect((await get("/api/local/debug/status")).status).toBe(401);
    expect((await get("/api/local/debug/status", { "x-engenty-local": "1.bad" })).status).toBe(401);
    const res = await get("/api/local/debug/status", { "x-engenty-local": ticket() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      app: "engenty-wizards-runtime",
      managed: false,
      process: { pid: process.pid },
    });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it("hands out the lines, filtered", async () => {
    console.error("[run r2 step s1] GatewayInternalServerError: no providers for model x");
    const res = await get("/api/local/debug/logs?q=r2%20step&level=error", {
      "x-engenty-local": ticket(),
    });
    const body = await res.json();
    expect(body.sources).toEqual([{ from: hostname(), ok: true }]);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ level: "error", from: body.sources[0].from });
  });

  it("sends no report without an account", async () => {
    const res = await app.fetch(
      new Request("http://localhost:5181/api/local/debug/report", {
        method: "POST",
        headers: { "x-engenty-local": ticket() },
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "no_account" });
  });
});

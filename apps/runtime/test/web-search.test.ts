import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayWebSearch } from "../src/tools/web-search";

// web_search through the gateway (tools/web-search.ts): what is sent, what the model gets.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web_search through the gateway", () => {
  it("asks the gateway with the key, tenant and run, and hands on its results", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        results: [{ title: "T", url: "https://example.at", published: null, highlights: ["H"] }],
      });
    });
    const tool = gatewayWebSearch(
      { baseUrl: "https://gateway.test", token: "svc", tenant: "t1" },
      { runId: "r1" },
    );
    const out = await tool.execute({ query: "Öffnungszeiten", num: 3 }, {} as any);
    expect(out).toEqual({
      results: [{ title: "T", url: "https://example.at", published: null, highlights: ["H"] }],
    });
    expect(calls[0].url).toBe("https://gateway.test/v1/web/search");
    expect(calls[0].init.headers).toMatchObject({
      authorization: "Bearer svc",
      "x-wizards-tenant": "t1",
      "x-wizards-run": "r1",
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: "Öffnungszeiten", num: 3 });
  });

  it("tells the model when the gateway refuses, rather than failing the turn", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { message: "No credits left." } }, { status: 402 }),
    );
    const tool = gatewayWebSearch({ baseUrl: "https://gateway.test", token: "k", tenant: null });
    expect(await tool.execute({ query: "x" }, {} as any)).toEqual({ error: "No credits left." });
  });
});

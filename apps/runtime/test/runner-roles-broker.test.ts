import { beforeAll, describe, expect, it, vi } from "vitest";
import { webRoleLeavesRunsToRunner } from "./runner-roles.shared";

// A broker serves a run's services alone: it drives no run, a runner's look takes it.
webRoleLeavesRunsToRunner("broker");

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let env: typeof import("../src/env").env;

const get = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost:5181${path}`, init));

beforeAll(async () => {
  env = (await import("../src/env")).env;
  app = (await import("../src/app")).default;
});

describe("RUNTIME_ROLE=broker", () => {
  it("serves a run's services and the health checks, no half and no runner", async () => {
    expect(env.role).toBe("broker");
    expect(env.serves).toEqual({
      studio: false,
      doors: false,
      runner: false,
      api: false,
      vectors: false,
      runServices: true,
    });
    expect((await get("/api/health")).status).toBe(200);
    expect((await get("/api/health/ready")).status).not.toBe(404);
  });

  it("answers a run's services above its catch-all: a call without the run's token is refused", async () => {
    const before = process.env.FEATURES;
    process.env.FEATURES = "runServices=on";
    try {
      const res = await get("/api/run-services/v1/data/counts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { failure: { class: "final" } } });
    } finally {
      process.env.FEATURES = before;
    }
  });

  it("serves nothing people open, not even what both halves need", async () => {
    for (const path of [
      "/api/config",
      "/api/studio/me",
      "/api/public/wizards/abc",
      "/api/shares/abc",
      "/api/v1/me",
      "/api/mcp",
      "/api/connect/callback",
      "/studio/",
      "/w/abc",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toMatchObject({ code: "not_found" });
    }
    const log = await get("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(log.status).toBe(404);
  });
});

describe("which roles serve a run's services", () => {
  it("the runner and a runtime alone serve them too, until the cloud runs a broker apart", async () => {
    const served: Record<string, boolean> = {};
    for (const role of ["studio", "doors", "api", "web", "runner", "broker", "all"]) {
      vi.resetModules();
      process.env.RUNTIME_ROLE = role;
      served[role] = (await import("../src/env")).env.serves.runServices;
    }
    process.env.RUNTIME_ROLE = "broker";
    expect(served).toEqual({
      studio: false,
      doors: false,
      api: false,
      web: false,
      runner: true,
      broker: true,
      all: true,
    });
  });
});

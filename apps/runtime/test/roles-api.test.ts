import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-api-role-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
// This process serves outside clients alone: MCP and the API (docs/plans/modular.md).
process.env.RUNTIME_ROLE = "api";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let env: typeof import("../src/env").env;

const get = (path: string) => app.fetch(new Request(`http://localhost:5181${path}`));

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  env = (await import("../src/env")).env;
  app = (await import("../src/app")).default;
});

describe("RUNTIME_ROLE=api", () => {
  it("serves MCP and the API, and what every process needs", async () => {
    expect(env.serves).toEqual({ studio: false, doors: false, runner: false, api: true });
    expect((await get("/api/health")).status).toBe(200);
    // Known, and closed without a key or token.
    expect((await get("/api/v1/me")).status).toBe(401);
    expect((await get("/api/v1/spaces/abc/elements")).status).toBe(401);
  });

  it("serves neither the studio nor the doors", async () => {
    for (const path of ["/api/studio/me", "/api/public/wizards/abc", "/api/shares/abc"]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });
});

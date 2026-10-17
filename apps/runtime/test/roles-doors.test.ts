import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-doors-role-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.MOBILE_IOS_APP_IDS = "TEAM.ai.engenty.wizards";
// This process is the customers' half alone.
process.env.RUNTIME_ROLE = "doors";

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

describe("RUNTIME_ROLE=doors", () => {
  it("serves the doors' half and what both halves need", async () => {
    expect(env.serves).toEqual({ studio: false, doors: true, runner: false });
    expect(env.publicUrl).toBe(env.appUrl);
    expect((await get("/api/health")).status).toBe(200);
    // The doors' routes answer: the app links for the wizards' pages, a code nobody has.
    const links = await get("/.well-known/apple-app-site-association");
    expect(links.status).toBe(200);
    expect(JSON.stringify(await links.json())).toContain("/w/*");
    expect((await get("/api/public/codes/000000")).status).toBe(404);
    expect(await (await get("/api/runs/nope")).json()).toEqual({ error: "This doesn’t exist or was deleted.", code: "not_found" });
  });

  it("serves the app's files, not the studio's pages", async () => {
    // Built: the files a wizard's page loads sit below /studio; the studio itself is not here.
    if (!existsSync(join(import.meta.dirname, "../../web/dist/index.html"))) {
      return;
    }
    expect((await get("/w/abcdefgh")).status).toBe(200);
    expect((await get("/studio/")).status).toBe(404);
    expect((await get("/studio/edit/x")).status).toBe(404);
    expect((await get("/")).status).toBe(404);
  });

  it("has no studio, no sign-in and no MCP", async () => {
    for (const path of [
      "/api/studio/me",
      "/api/auth/login",
      "/api/local/enter?k=test-key",
      "/api/mcp",
      "/api/v1/me",
      "/api/claude-plugin/marketplace.json",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });
});

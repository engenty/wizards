import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-studio-role-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.PUBLIC_URL = "https://doors.example/";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.MOBILE_IOS_APP_IDS = "TEAM.ai.engenty.wizards";
// This process is the makers' half alone.
process.env.RUNTIME_ROLE = "studio";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let env: typeof import("../src/env").env;
let wizards: typeof import("../src/services/wizards");
let shares: typeof import("../src/services/shares");

const get = (path: string) => app.fetch(new Request(`http://localhost:5181${path}`));

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  env = (await import("../src/env")).env;
  wizards = await import("../src/services/wizards");
  shares = await import("../src/services/shares");
  app = (await import("../src/app")).default;
});

describe("RUNTIME_ROLE=studio", () => {
  it("serves the studio's half and what both halves need", async () => {
    expect(env.serves).toEqual({ studio: true, doors: false, runner: false });
    expect((await get("/api/health")).status).toBe(200);
    expect((await get("/api/config")).status).toBe(200);
    // The studio's own routes answer (unauthorized, not unknown).
    expect((await get("/api/studio/me")).status).toBe(401);
    // The runs' API is on both halves: a run that does not exist, not an unknown route.
    expect(await (await get("/api/runs/nope")).json()).toEqual({ error: "This doesn’t exist or was deleted.", code: "not_found" });
  });

  it("does not serve the doors", async () => {
    for (const path of ["/api/public/wizards/abc", "/api/shares/abc", "/api/public/codes/123456"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "This doesn’t exist or was deleted.", code: "not_found" });
    }
    // The app links belong to the wizards' pages: not here.
    expect((await get("/.well-known/apple-app-site-association")).status).toBe(404);
  });

  it("serves the studio's pages, not the wizards'", async () => {
    if (!existsSync(join(import.meta.dirname, "../../web/dist/index.html"))) {
      return;
    }
    expect((await get("/studio/")).status).toBe(200);
    expect((await get("/")).status).toBe(302);
    expect((await get("/w/abcdefgh")).status).toBe(404);
    expect((await get("/s/abcdefgh")).status).toBe(404);
  });

  it("makes the wizards' links with PUBLIC_URL", async () => {
    expect((await (await get("/api/config")).json()).publicUrl).toBe("https://doors.example");
    expect(wizards.shareUrl("tok")).toBe("https://doors.example/w/tok");
    expect(shares.shareUrlFor("tok")).toBe("https://doors.example/s/tok");
  });
});

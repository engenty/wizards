import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The page a used one-time link answers with speaks the browser's language.

const dir = mkdtempSync(join(tmpdir(), "wizards-local-enter-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;

const enter = (lang: string) =>
  app.fetch(
    new Request("http://localhost:5181/api/local/enter?k=wrong-key", {
      headers: { "accept-language": lang },
    }),
  );

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  app = (await import("../src/app")).default;
}, 60_000);

describe("a link that no longer works", () => {
  it("says so in German to a German browser", async () => {
    const res = await enter("de-DE,de;q=0.9,en;q=0.8");
    expect(res.status).toBe(403);
    const page = await res.text();
    expect(page).toContain('lang="de"');
    expect(page).toContain("Dieser Link gilt nicht mehr.");
  });

  it("says so in English otherwise", async () => {
    const res = await enter("en-US,en;q=0.9");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("This link is no longer valid.");
  });
});

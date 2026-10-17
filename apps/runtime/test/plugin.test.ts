import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-plugin-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "https://wizards.example.com";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;

beforeAll(async () => {
  await (await import("../src/db/client")).migrateControlDb();
  app = (await import("../src/app")).default;
}, 60_000);

describe("Claude Code plugin of this deployment", () => {
  it("serves a marketplace whose archive carries this server's MCP URL", async () => {
    const base = "https://wizards.example.com/api/claude-plugin";
    const market = await (await app.fetch(new Request(`${base}/marketplace.json`))).json();
    expect(market.name).toBe("wizards-example-com");
    const [entry] = market.plugins;
    expect(entry.source).toMatchObject({ source: "archive", url: `${base}/wizards.zip` });

    const res = await app.fetch(new Request(entry.source.url));
    const zip = new Uint8Array(await res.arrayBuffer());
    expect(createHash("sha256").update(zip).digest("hex")).toBe(entry.source.sha256);

    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "README.md",
      "commands/wizard.md",
      "hooks/engenty.ts",
      "hooks/hooks.json",
      "hooks/pane.test.tsx",
      "hooks/register.tsx",
      "skills/build-wizard/SKILL.md",
      "skills/use-wizard/SKILL.md",
      "types/index.d.ts",
    ]);
    const mcp = JSON.parse(strFromU8(files[".mcp.json"]));
    expect(mcp.mcpServers["engenty-wizards"].url).toBe("https://wizards.example.com/api/mcp");
    const manifest = JSON.parse(strFromU8(files[".claude-plugin/plugin.json"]));
    expect(manifest.name).toBe("wizards");
    expect(manifest.homepage).toBe("https://wizards.example.com");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

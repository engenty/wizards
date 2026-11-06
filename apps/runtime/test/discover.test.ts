import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Fähigkeiten › Entdecken: one search over skills.sh and integrations.sh, both asked at once; one
// that fails leaves the other's results; what the space has is marked. Behind `capabilities`.

const dir = mkdtempSync(join(tmpdir(), "wizards-discover-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "capabilities=on,skills=on";
// A public address the host guard lets through without asking DNS; the fetch below answers it.
const INTEGRATIONS = "https://93.184.215.14";
process.env.ENGENTY_INTEGRATIONS_REGISTRY_URL = INTEGRATIONS;
// GitHub's raw files, where a repository says whether it is a plugin with a server.
const RAW = "https://93.184.215.15";
process.env.GITHUB_RAW_URL = RAW;

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let client: typeof import("../src/db/client");

const url = (path: string) => `http://localhost:5181${path}`;
const get = async (path: string, lang = "en") =>
  app.fetch(
    new Request(url(path), {
      headers: { cookie, origin: "http://localhost:5181", "accept-language": lang },
    }),
  );
const discover = async (q: string, lang = "en") =>
  (await get(`/api/studio/spaces/${spaceId}/discover?q=${encodeURIComponent(q)}`, lang)).json() as Promise<any>;
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);

/** Which directory answers in this test, and what each saw. */
const down = { skills: false, connectors: false };
/** The files GitHub has at a repository's root, by `owner/name/HEAD/<path>`. */
const raw: Record<string, string> = {};
const asked: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (address.startsWith("https://skills.sh/api/search")) {
      asked.push(address);
      if (down.skills) {
        return new Response("busy", { status: 503 });
      }
      return Response.json({
        skills: ["anthropics/skills/pdf", "someone/tools/pdf-forms"].map((id) => ({
          id,
          source: id.split("/").slice(0, 2).join("/"),
          skillId: id.split("/")[2],
          name: id.split("/")[2],
          installs: 500,
        })),
      });
    }
    if (address.startsWith(`${INTEGRATIONS}/api/search`)) {
      asked.push(address);
      if (down.connectors) {
        throw new TypeError("fetch failed");
      }
      return Response.json({
        results: [
          { domain: "notion.so", name: "Notion", description: "Pages and databases.", kinds: ["mcp"] },
          { domain: "hubspot.com", name: "HubSpot", description: "CRM.", kinds: ["openapi"] },
          { domain: "stripe.com", name: "Stripe", description: "Payments.", kinds: ["openapi", "cli"] },
        ],
      });
    }
    if (address.startsWith(`${RAW}/`)) {
      asked.push(address);
      const file = raw[address.slice(RAW.length + 1)];
      return file === undefined ? new Response("no", { status: 404 }) : new Response(file);
    }
    return realFetch(input, init);
  });
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;

  // The space has skills.sh's pdf, an imported Notion and a connection to the built-in HubSpot.
  await local(async () => {
    await client.db.insert(client.schema.spaceSkill).values({
      id: "sk-pdf",
      tenantId: "local",
      spaceId,
      name: "pdf",
      description: "PDF files.",
      body: "# PDF",
      source: "skills.sh",
      origin: "anthropics/skills/pdf",
    } as any);
    await client.db.insert(client.schema.spaceConnector).values({
      spaceId,
      id: "notion",
      record: { id: "notion", domain: "www.notion.so", name: "Notion" } as any,
    });
    await client.db.insert(client.schema.spaceConnection).values({
      id: "sc-crm",
      spaceId,
      connectorId: "hubspot",
      name: "Vertrieb",
      signIn: "space",
      audience: "all",
      rules: { read: "allow", write: "ask", destructive: "deny", send: "ask" },
    });
  });
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("Entdecken", () => {
  it("asks both directories and marks what the space has", async () => {
    asked.length = 0;
    const found = await discover("pdf");
    expect(asked.some((a) => a.startsWith("https://skills.sh/api/search"))).toBe(true);
    expect(asked.some((a) => a.startsWith(`${INTEGRATIONS}/api/search`))).toBe(true);
    expect(found.errors).toEqual({});
    expect(found.skills.map((s: any) => [s.ref, s.added, s.official])).toEqual([
      ["anthropics/skills/pdf", true, true],
      ["someone/tools/pdf-forms", false, false],
    ]);
    expect(found.connectors.map((c: any) => [c.domain, c.setUp])).toEqual([
      ["notion.so", true],
      ["hubspot.com", true],
      ["stripe.com", false],
    ]);
    // What the connector search hands the studio: kinds it can import only.
    expect(found.connectors[2]).toMatchObject({ name: "Stripe", kinds: ["openapi"] });
  });

  it("keeps one directory's results when the other fails, and says why in plain words", async () => {
    down.skills = true;
    const noSkills = await discover("pdf");
    expect(noSkills.skills).toEqual([]);
    expect(noSkills.connectors).toHaveLength(3);
    expect(noSkills.errors).toEqual({ skills: "skills.sh did not answer. Try again in a moment." });
    down.skills = false;

    down.connectors = true;
    const noConnectors = await discover("pdf", "de");
    expect(noConnectors.skills).toHaveLength(2);
    expect(noConnectors.connectors).toEqual([]);
    expect(noConnectors.errors).toEqual({
      connectors: "integrations.sh antwortet nicht. Versuch es gleich noch einmal.",
    });
    down.connectors = false;
  });

  it("asks nobody for fewer than two letters", async () => {
    asked.length = 0;
    expect(await discover("p")).toEqual({ skills: [], connectors: [], bundles: [], errors: {} });
    expect(asked).toEqual([]);
  });

  it("names a repository that holds a server and skills as one hit, with what it stands for", async () => {
    // Nothing at the repositories' roots says plugin: the lists stand alone.
    expect((await discover("pdf")).bundles).toEqual([]);
    // One of them is a plugin whose server is Notion's: its skill and that connector are one.
    raw["someone/tools/HEAD/.claude-plugin/plugin.json"] = JSON.stringify({
      name: "PDF tools",
      description: "PDF skills and a server.",
    });
    raw["someone/tools/HEAD/.mcp.json"] = JSON.stringify({
      mcpServers: {
        notion: { type: "http", url: "https://mcp.notion.so/mcp" },
        local: { command: "npx", args: ["x"] },
      },
    });
    // What a repository says is kept for an hour: another one is asked.
    raw["anthropics/skills/HEAD/.mcp.json"] = JSON.stringify({
      mcpServers: { files: { command: "npx", args: ["files"] } },
    });
    const bundles = await import("../src/bundles/discover");
    const found = await local(() =>
      bundles.discoverBundles(
        spaceId,
        [
          { ref: "someone/tools/pdf-forms", name: "pdf-forms", source: "someone/tools", installs: 1, official: false, added: false },
          { ref: "other/repo/pdf", name: "pdf", source: "other/repo", installs: 1, official: false, added: false },
        ],
        [
          { domain: "notion.so", name: "Notion", description: "", kinds: ["mcp"] },
          { domain: "stripe.com", name: "Stripe", description: "", kinds: ["openapi"] },
        ],
      ),
    );
    // Asked before, with nothing there: the answer is kept, so only the new repository is read.
    expect(found).toEqual([]);
    raw["fresh/plugin/HEAD/.claude-plugin/plugin.json"] = raw["someone/tools/HEAD/.claude-plugin/plugin.json"];
    raw["fresh/plugin/HEAD/.mcp.json"] = raw["someone/tools/HEAD/.mcp.json"];
    const fresh = await local(() =>
      bundles.discoverBundles(
        spaceId,
        [
          { ref: "fresh/plugin/pdf-forms", name: "pdf-forms", source: "fresh/plugin", installs: 1, official: false, added: false },
          { ref: "fresh/plugin/pdf-read", name: "pdf-read", source: "fresh/plugin", installs: 1, official: false, added: false },
          { ref: "anthropics/skills/pdf", name: "pdf", source: "anthropics/skills", installs: 1, official: true, added: true },
        ],
        [
          { domain: "notion.so", name: "Notion", description: "", kinds: ["mcp"] },
          { domain: "stripe.com", name: "Stripe", description: "", kinds: ["openapi"] },
        ],
      ),
    );
    expect(fresh).toEqual([
      {
        repo: "fresh/plugin",
        name: "PDF tools",
        description: "PDF skills and a server.",
        format: "claude",
        hosts: ["mcp.notion.so"],
        official: false,
        added: false,
        covers: {
          skills: ["fresh/plugin/pdf-forms", "fresh/plugin/pdf-read"],
          connectors: ["notion.so"],
        },
      },
    ]);
  });

  it("is not there while the capabilities switch is off", async () => {
    process.env.FEATURES = "capabilities=off,skills=on";
    try {
      const res = await get(`/api/studio/spaces/${spaceId}/discover?q=pdf`);
      expect(res.status).toBe(404);
    } finally {
      process.env.FEATURES = "capabilities=on,skills=on";
    }
  });
});

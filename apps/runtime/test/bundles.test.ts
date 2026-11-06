import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A Connector that brings skills (docs/plans/capabilities-next.md, piece 4): a plugin for Claude
 * Code or Cursor is read from a public repository on GitHub or an uploaded zip and taken into a
 * space. Its MCP servers over http become connectors through the path of a pasted address, its
 * skills become read-only skills that name them, and what a space does not take is named.
 * GitHub's download host and the MCP servers are played here by a stubbed fetch, with one real
 * server on this computer for the private address.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-bundles-"));
process.env.APP_URL = "http://localhost:5181";
process.env.FEATURES = "capabilities=on,skills=on";
// The knowledge store asks no model here.
process.env.OLLAMA_URL = "http://127.0.0.1:9/v1";

/** Whether the runtime is a managed one; a test changes it. */
const mode = vi.hoisted(() => ({ managed: false }));

vi.mock("../src/manage.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/manage.js")>();
  return {
    ...mod,
    get managed() {
      return mode.managed;
    },
    tenantInfo: async () => ({ limits: { build: true }, plan: { id: "pro", name: "Pro" } }),
    tenantMembers: async () => ({
      members: [
        { userId: "user-a", role: "owner", name: "Anna" },
        { userId: "user-m", role: "member", name: "Max" },
      ],
    }),
  };
});

// Names resolve here, not on the network.
const DNS: Record<string, string> = {
  "codeload.github.com": "140.82.121.9",
  "open.example.net": "93.184.215.17",
  "mcp.keys.example.org": "93.184.215.16",
  "more.example.net": "93.184.215.19",
};
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const address = DNS[host];
    if (!address) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    }
    return [{ address, family: 4 }];
  },
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TOOLS = [
  {
    name: "search_pages",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "create_page",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
];

/** The headers each played server was last asked with. */
const asked: Record<string, Headers> = {};

/** An MCP server over streamable HTTP, as far as listing its tools goes. */
function mcpServer(allowed: (req: Request) => boolean = () => true) {
  return async (req: Request): Promise<Response> => {
    asked[new URL(req.url).host] = req.headers;
    if (!allowed(req)) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }
    if (req.method === "GET") {
      return new Response(null, { status: 405 });
    }
    if (req.method === "DELETE") {
      return new Response(null, { status: 200 });
    }
    const message = (await req.json()) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string };
    };
    const result = (value: unknown) => json({ jsonrpc: "2.0", id: message.id, result: value });
    if (message.method === "initialize") {
      return result({
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "played", version: "1.0.0" },
      });
    }
    if (message.id === undefined) {
      return new Response(null, { status: 202 });
    }
    if (message.method === "tools/list") {
      return result({ tools: TOOLS });
    }
    return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
  };
}

const skillMd = (name: string, description: string, body = "Do it well.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

/** A repository as GitHub hands it out: a zip with one folder around everything. */
const repoZip = (folder: string, files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, text]) => [`${folder}/${path}`, strToU8(text)]),
    ),
  );

/** The repositories GitHub has, by `owner/name`: what each holds now. A test changes one. */
const repos: Record<string, Record<string, string>> = {
  // A server over http, one on the command line, two skills, a command, an agent and hooks.
  "acme/both": {
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "notes",
      displayName: "Notes",
      version: "1.2.0",
      description: "Notes for the team.",
    }),
    ".mcp.json": JSON.stringify({
      mcpServers: {
        notes: {
          type: "http",
          url: "https://open.example.net/mcp",
          headers: { "X-Plugin": "notes@1" },
        },
        files: { command: "npx", args: ["-y", "@acme/files-server"] },
        live: { type: "ws", url: "wss://open.example.net/socket" },
        later: { type: "http", url: "" },
        yours: { type: "http", url: "https://${NOTES_HOST}/mcp" },
      },
    }),
    "skills/write-notes/SKILL.md": skillMd("write-notes", "Use when writing a note for the team."),
    "skills/write-notes/reference/style.md": "# Style\n\nShort sentences.\n",
    "skills/write-notes/scripts/count.py": "print(1)\n",
    "skills/find-notes/SKILL.md": skillMd("find-notes", "Use when looking a note up."),
    "skills/broken/SKILL.md": "no front matter here\n",
    "commands/note.md": "Write a note.",
    "commands/tasks/plan.md": "Plan.",
    "agents/reviewer.md": "---\nname: reviewer\n---\nReview.",
    "hooks/hooks.json": JSON.stringify({ hooks: { PostToolUse: [], SessionStart: [] } }),
    "README.md": "# Notes\n",
  },
  "acme/skills-only": {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "writing", skills: "./guides/" }),
    "guides/team/tone/SKILL.md": skillMd("Tone Of Voice", "Use when writing for customers."),
  },
  "acme/server-only": {
    ".cursor-plugin/plugin.json": JSON.stringify({ name: "keys", version: "0.3.0" }),
    "mcp.json": JSON.stringify({
      mcpServers: {
        keys: {
          url: "https://mcp.keys.example.org/mcp",
          headers: { Authorization: "Bearer ${KEYS_TOKEN}" },
        },
      },
    }),
    "rules/style.mdc": "---\nalwaysApply: true\n---\nBe brief.",
  },
  "acme/nothing": {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "only-commands" }),
    "commands/hello.md": "Say hello.",
  },
  "acme/many": {
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "acme-plugins",
      owner: { name: "Acme" },
      plugins: [
        { name: "sales", source: "./sales", description: "For sales." },
        { name: "elsewhere", source: { source: "github", repo: "acme/both" } },
        {
          name: "part",
          source: { source: "git-subdir", url: "https://github.com/acme/mono.git", path: "p/x" },
        },
        { name: "from-npm", source: { source: "npm", package: "@acme/x" } },
      ],
    }),
    "sales/.claude-plugin/plugin.json": JSON.stringify({ name: "sales", version: "2.0.0" }),
    "sales/skills/call-prep/SKILL.md": skillMd("call-prep", "Use before a call."),
  },
  "acme/not-a-plugin": { "README.md": "# Nothing\n", "src/index.ts": "export {};\n" },
};

const servers: Record<string, (req: Request) => Promise<Response> | Response> = {
  "codeload.github.com": (req) => {
    const m = /^\/([^/]+\/[^/]+)\/zip\/(.+)$/.exec(new URL(req.url).pathname);
    const files = m ? repos[m[1]] : undefined;
    return files
      ? new Response(repoZip(`${m?.[1].split("/")[1]}-main`, files), {
          headers: { "content-type": "application/zip" },
        })
      : new Response("not found", { status: 404 });
  },
  // Answers anybody.
  "open.example.net": (req) =>
    new URL(req.url).pathname === "/mcp" ? mcpServer()(req) : new Response("no", { status: 404 }),
  "more.example.net": (req) =>
    new URL(req.url).pathname === "/mcp" ? mcpServer()(req) : new Response("no", { status: 404 }),
  // Asks for a key in a header and describes nothing.
  "mcp.keys.example.org": (req) =>
    new URL(req.url).pathname === "/mcp"
      ? mcpServer((r) => r.headers.get("authorization") === "Bearer k-1")(req)
      : new Response("not found", { status: 404 }),
};

let client: typeof import("../src/db/client");
let bundles: typeof import("../src/bundles/index");
let reading: typeof import("../src/bundles/read");
let fetching: typeof import("../src/bundles/fetch");
let external: typeof import("../src/connectors/external");
let connections: typeof import("../src/connectors/space-connections");
let skills: typeof import("../src/services/skills");
let access: typeof import("../src/services/access");
let space: string;
let local: Server;
let localUrl: string;

const TENANT = "tenant-bundles";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const asAdmin = <T>(fn: () => Promise<T>) => inTenant(() => access.asRole("owner", fn));
const asMember = <T>(fn: () => Promise<T>) => inTenant(() => access.asRole("member", fn));
const realFetch = globalThis.fetch;
const at = (repo: string) => ({ address: `https://github.com/${repo}` });

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    // This computer: the real server below answers.
    if (url.hostname === "127.0.0.1") {
      return realFetch(input, init);
    }
    const server = servers[url.hostname];
    if (!server) {
      throw new TypeError(`fetch failed: nothing plays ${url.hostname}`);
    }
    return server(new Request(url, init));
  });
  // A real MCP server on this computer, for the private address.
  const play = mcpServer();
  local = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const answer = await play(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }),
    );
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((done) => local.listen(0, "127.0.0.1", done));
  localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}/mcp`;
  repos["acme/private"] = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "intern" }),
    ".mcp.json": JSON.stringify({ mcpServers: { intern: { type: "http", url: localUrl } } }),
    "skills/intern-guide/SKILL.md": skillMd("intern-guide", "Use for the internal system."),
  };

  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  bundles = await import("../src/bundles/index");
  reading = await import("../src/bundles/read");
  fetching = await import("../src/bundles/fetch");
  external = await import("../src/connectors/external");
  connections = await import("../src/connectors/space-connections");
  skills = await import("../src/services/skills");
  access = await import("../src/services/access");
  const spaces = await import("../src/services/spaces");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise((done) => local.close(done));
});

describe("a repository's address", () => {
  it("is read as GitHub writes it, with a branch and a folder", () => {
    expect(fetching.parseRepoAddress("https://github.com/acme/both")).toEqual({
      repo: "acme/both",
      ref: null,
      path: "",
    });
    expect(fetching.parseRepoAddress("github.com/acme/both.git")).toMatchObject({
      repo: "acme/both",
    });
    expect(
      fetching.parseRepoAddress("https://github.com/acme/many/tree/main/plugins/sales"),
    ).toEqual({ repo: "acme/many", ref: "main", path: "plugins/sales" });
  });

  it("is no other address", () => {
    expect(fetching.parseRepoAddress("https://gitlab.com/acme/both")).toBeNull();
    expect(fetching.parseRepoAddress("https://github.com/acme")).toBeNull();
    expect(fetching.parseRepoAddress("https://mcp.example.com/mcp")).toBeNull();
  });
});

describe("reading a plugin out of a zip", () => {
  const read = (files: Record<string, string>, path?: string) =>
    reading.readPlugin(new reading.Archive(repoZip("x-main", files)), {
      path,
      fallbackName: "x",
      say: (err) => (err as Error).message,
    });

  it("reads Claude Code's manifest, its MCP file and its skills, and names what it leaves out", () => {
    const found = read(repos["acme/both"]);
    if (!("plugin" in found)) {
      throw new Error("no plugin");
    }
    const { plugin } = found;
    expect(plugin).toMatchObject({ format: "claude", name: "Notes", version: "1.2.0", root: "" });
    expect(plugin.servers).toEqual([
      {
        key: "notes",
        url: "https://open.example.net/mcp",
        transport: "http",
        headers: [{ name: "X-Plugin", value: "notes@1" }],
        keyHeader: null,
      },
    ]);
    expect(plugin.skills.map((s) => [s.path, s.intake.content.name])).toEqual([
      ["skills/find-notes", "find-notes"],
      ["skills/write-notes", "write-notes"],
    ]);
    expect(plugin.skills[1].intake.content.files.map((f) => f.path)).toEqual([
      "reference/style.md",
      "scripts/count.py",
    ]);
    const leftOut = plugin.leftOut.map((l) => [l.kind, l.name, l.reason ?? null]);
    expect(leftOut).toEqual([
      ["server", "files", "stdio"],
      ["server", "live", "socket"],
      ["server", "later", "noAddress"],
      ["server", "yours", "variable"],
      ["skill", "skills/broken", "invalid"],
      ["command", "note", null],
      ["command", "tasks/plan", null],
      ["agent", "reviewer", null],
      ["hook", "PostToolUse", null],
      ["hook", "SessionStart", null],
    ]);
    expect(plugin.leftOut[4].detail).toMatch(/no front matter/);
  });

  it("reads Cursor's manifest: its mcp.json, a key in a header, its rules left out", () => {
    const found = read(repos["acme/server-only"]);
    if (!("plugin" in found)) {
      throw new Error("no plugin");
    }
    expect(found.plugin).toMatchObject({ format: "cursor", name: "keys", version: "0.3.0" });
    expect(found.plugin.servers).toEqual([
      {
        key: "keys",
        url: "https://mcp.keys.example.org/mcp",
        transport: "http",
        headers: [],
        keyHeader: { name: "Authorization", scheme: "Bearer" },
      },
    ]);
    expect(found.plugin.leftOut).toEqual([{ kind: "rule", name: "style" }]);
  });

  it("takes the folders a manifest names for skills, and makes a name the format allows", () => {
    const found = read(repos["acme/skills-only"]);
    if (!("plugin" in found)) {
      throw new Error("no plugin");
    }
    expect(found.plugin.skills.map((s) => [s.path, s.intake.content.name])).toEqual([
      ["guides/team/tone", "tone-of-voice"],
    ]);
  });

  it("lists the plugins of a repository that holds several, and reads the one that is chosen", () => {
    const found = read(repos["acme/many"]);
    expect(found).toEqual({
      choices: [
        { name: "sales", description: "For sales.", path: "sales", address: null },
        {
          name: "elsewhere",
          description: null,
          path: null,
          address: "https://github.com/acme/both",
        },
        {
          name: "part",
          description: null,
          path: null,
          address: "https://github.com/acme/mono/tree/HEAD/p/x",
        },
      ],
    });
    const chosen = read(repos["acme/many"], "sales");
    expect("plugin" in chosen && chosen.plugin).toMatchObject({
      name: "sales",
      version: "2.0.0",
      root: "sales/",
    });
  });

  it("refuses what is no plugin, a folder that is not there, and a file that is no zip", () => {
    expect(() => read(repos["acme/not-a-plugin"])).toThrow(/Nothing here is a plugin/);
    expect(() => read(repos["acme/both"], "nowhere")).toThrow(/no folder “nowhere”/);
    expect(() => read(repos["acme/both"], "../x")).toThrow(/no folder/);
    expect(() => new reading.Archive(strToU8("not a zip"))).toThrow(/\.zip or a \.plugin/);
  });

  it("leaves a path that climbs out of the zip where it is", () => {
    const archive = new reading.Archive(
      zipSync({
        ".claude-plugin/plugin.json": strToU8(JSON.stringify({ name: "p" })),
        "skills/a/SKILL.md": strToU8(skillMd("a", "Use it.")),
        "skills/a/../../escape.md": strToU8("out"),
        "__MACOSX/skills/a/._SKILL.md": strToU8("fork"),
      }),
    );
    expect([...archive.files.keys()].sort()).toEqual([
      ".claude-plugin/plugin.json",
      "skills/a/SKILL.md",
    ]);
  });
});

describe("a repository with a server and skills", () => {
  let bundleId = "";
  let hash = "";

  it("shows the name and version, the server as an address is read, the skills, and what is left out", async () => {
    const { preview, plugins } = await asAdmin(() =>
      bundles.previewBundle("user-a", space, at("acme/both"), "en"),
    );
    expect(plugins).toEqual([]);
    expect(preview).toMatchObject({
      name: "Notes",
      version: "1.2.0",
      description: "Notes for the team.",
      format: "claude",
      origin: { kind: "github", repo: "acme/both", ref: null, path: "" },
      added: null,
      skillsFree: 100,
    });
    expect(preview?.servers).toHaveLength(1);
    expect(preview?.servers[0]).toMatchObject({
      key: "notes",
      url: "https://open.example.net/mcp",
      headers: ["X-Plugin"],
      keyHeader: null,
      source: {
        sourceKind: "mcp",
        suggestedId: "open-example",
        fromAddress: true,
        privateAddress: false,
        signIn: { described: "none" },
      },
    });
    // The plugin's own header went with the request that listed the tools.
    expect(asked["open.example.net"].get("x-plugin")).toBe("notes@1");
    expect(preview?.servers[0].source.actions.map((a) => [a.id, a.group])).toEqual([
      ["search_pages", "read"],
      ["create_page", "write"],
    ]);
    expect(preview?.skills).toEqual([
      {
        path: "skills/find-notes",
        name: "find-notes",
        description: "Use when looking a note up.",
        chars: expect.any(Number),
        files: 0,
        scripts: false,
        skipped: 0,
      },
      {
        path: "skills/write-notes",
        name: "write-notes",
        description: "Use when writing a note for the team.",
        chars: expect.any(Number),
        files: 2,
        scripts: true,
        skipped: 0,
      },
    ]);
    // The server started on the command line is left out, and named.
    expect(preview?.leftOut).toContainEqual({ kind: "server", name: "files", reason: "stdio" });
    expect(preview?.leftOut.filter((l) => l.kind === "command").map((l) => l.name)).toEqual([
      "note",
      "tasks/plan",
    ]);
    hash = preview?.hash ?? "";
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("takes it as it was shown: a connector „nicht geprüft“ and skills that name it", async () => {
    await expect(
      asAdmin(() => bundles.importBundle("user-a", space, at("acme/both"), { hash: "x" }, "en")),
    ).rejects.toThrow(/changed since you looked/);
    const made = await asAdmin(() =>
      bundles.importBundle(
        "user-a",
        space,
        at("acme/both"),
        { hash, servers: { notes: { actionKinds: { create_page: { kind: "send" } } } } },
        "en",
      ),
    );
    bundleId = made.bundle.id;
    expect(made.bundle).toMatchObject({
      name: "Notes",
      version: "1.2.0",
      format: "claude",
      hash,
      connectors: [{ id: "open-example", name: "Notes" }],
      connections: [],
    });
    expect(made.bundle.skills.map((k) => [k.name, k.mode])).toEqual([
      ["find-notes", "demand"],
      ["write-notes", "demand"],
    ]);
    // Kept without the words of a refusal.
    expect(made.bundle.leftOut).toContainEqual({ kind: "skill", name: "skills/broken", reason: "invalid" });
    expect(made.connectors[0]).toMatchObject({
      id: "open-example",
      fromAddress: true,
      bundle: { id: bundleId, name: "Notes" },
    });
    // What the admin said an action does is kept, as for a pasted address.
    expect(made.connectors[0].actions.map((a) => [a.id, a.group])).toEqual([
      ["search_pages", "read"],
      ["create_page", "send"],
    ]);
    const row = await inTenant(() =>
      client.db.query.spaceConnector.findFirst({ where: (t, { eq }) => eq(t.id, "open-example") }),
    );
    expect(row?.bundleId).toBe(bundleId);
    expect(row?.record.required_headers).toEqual([
      { name: "X-Plugin", value: "notes@1", description: null },
    ]);
    // The lists say what each came with.
    const listed = await asAdmin(() => external.listConnectors(space));
    expect(listed.find((c) => c.id === "open-example")?.bundle).toEqual({
      id: bundleId,
      name: "Notes",
    });
    const { skills: all } = await asAdmin(() => skills.listSkills("user-a", space));
    expect(all.map((k) => [k.name, k.source, k.origin, k.runScripts])).toEqual([
      ["find-notes", "plugin", "skills/find-notes", false],
      ["write-notes", "plugin", "skills/write-notes", false],
    ]);
    expect(all[0].bundle).toEqual({
      id: bundleId,
      name: "Notes",
      connectors: [{ id: "open-example", name: "Notes" }],
    });
  });

  it("says so where the space has it already", async () => {
    const { preview } = await asAdmin(() =>
      bundles.previewBundle("user-a", space, at("acme/both"), "en"),
    );
    expect(preview?.added).toBe(bundleId);
    await expect(
      asAdmin(() => bundles.importBundle("user-a", space, at("acme/both"), {}, "en")),
    ).rejects.toThrow(/has “Notes” from here already/);
  });

  it("keeps its skills as they came: a copy is the space's own", async () => {
    const { skills: all } = await asAdmin(() => skills.listSkills("user-a", space));
    const skill = all.find((k) => k.name === "write-notes");
    if (!skill) {
      throw new Error("no skill");
    }
    await expect(
      asAdmin(() => skills.updateSkill("user-a", skill.id, { body: "Mine now." })),
    ).rejects.toThrow(/came with a connector stays as it is/);
    await expect(asAdmin(() => skills.deleteSkill("user-a", skill.id))).rejects.toThrow(
      /Switch it off, or remove the connector/,
    );
    // When it counts is the space's to say.
    await asAdmin(() => skills.updateSkill("user-a", skill.id, { mode: "always" }));
    const copy = await asAdmin(() => skills.copySkill("user-a", skill.id));
    expect(copy.name).toBe("write-notes-2");
    const own = await asAdmin(() => skills.getSkill("user-a", copy.id));
    expect(own).toMatchObject({ source: "own", bundle: null, mode: "demand" });
    await asAdmin(() => skills.updateSkill("user-a", copy.id, { body: "Mine now." }));
    await asAdmin(() => skills.deleteSkill("user-a", copy.id));
  });

  it("tells a step that loads the skill which connector it came with", async () => {
    const row = await inTenant(() =>
      client.db.query.spaceSkill.findFirst({ where: (t, { eq }) => eq(t.name, "find-notes") }),
    );
    if (!row) {
      throw new Error("no skill");
    }
    expect(await inTenant(() => skills.skillConnectors(row))).toEqual([
      { name: "Notes", toolPrefix: "open_example" },
    ]);
  });

  it("starts a connection on its connector for the admins, and the connection goes with it", async () => {
    const row = await asAdmin(() =>
      connections.createSpaceConnection(
        "user-a",
        space,
        connections.newConnectionSchema.parse({
          connectorId: "open-example",
          name: "Team-Notizen",
          signIn: "space",
        }),
      ),
    );
    expect(row).toMatchObject({ audience: "admins", bundleId });
    const [bundle] = await asAdmin(() => bundles.listBundles("user-a", space));
    expect(bundle.connections).toEqual([
      { id: row.id, name: "Team-Notizen", connectorId: "open-example" },
    ]);
  });

  it("says nothing changed while the origin is as it was", async () => {
    expect(await asAdmin(() => bundles.bundleUpdate("user-a", bundleId, "en"))).toEqual({
      update: null,
      upload: false,
    });
  });

  it("says what the origin changed, and takes it; the connection and its sign-in stay", async () => {
    const connection = await inTenant(() =>
      client.db.query.spaceConnection.findFirst({ where: (t, { eq }) => eq(t.bundleId, bundleId) }),
    );
    if (!connection) {
      throw new Error("no connection");
    }
    await inTenant(() =>
      connections.keepSpaceSignIn(connection, "notes@acme", {
        accessToken: "t-1",
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      }),
    );
    const before = { ...repos["acme/both"] };
    const next = { ...before };
    next[".claude-plugin/plugin.json"] = JSON.stringify({ name: "notes", displayName: "Notes", version: "1.3.0" });
    next["skills/write-notes/SKILL.md"] = skillMd(
      "write-notes",
      "Use when writing a note for the team or a customer.",
      "Do it better.",
    );
    delete next["skills/find-notes/SKILL.md"];
    next["skills/share-notes/SKILL.md"] = skillMd("share-notes", "Use when sharing a note.");
    next[".mcp.json"] = JSON.stringify({
      mcpServers: {
        notes: { type: "http", url: "https://open.example.net/mcp", headers: { "X-Plugin": "notes@1" } },
        more: { type: "http", url: "https://more.example.net/mcp" },
      },
    });
    repos["acme/both"] = next;
    const { update } = await asAdmin(() => bundles.bundleUpdate("user-a", bundleId, "en"));
    expect(update).toMatchObject({
      version: "1.3.0",
      skills: { added: ["share-notes"], changed: ["write-notes"], removed: ["find-notes"] },
      servers: { added: [{ key: "more", url: "https://more.example.net/mcp" }], removed: [] },
    });
    await expect(
      asAdmin(() => bundles.applyBundleUpdate("user-a", bundleId, { hash: "old" }, "en")),
    ).rejects.toThrow(/changed since you looked/);
    const taken = await asAdmin(() =>
      bundles.applyBundleUpdate("user-a", bundleId, { hash: update?.hash }, "en"),
    );
    expect(taken.notTaken).toEqual([]);
    expect(taken.bundle).toMatchObject({ version: "1.3.0", hash: update?.hash });
    expect(taken.bundle.connectors).toEqual([
      { id: "more-example", name: "More" },
      { id: "open-example", name: "Notes" },
    ]);
    // The changed skill keeps its name and when it counts; the new one comes on demand.
    expect(taken.bundle.skills.map((k) => [k.name, k.mode, k.description])).toEqual([
      ["share-notes", "demand", "Use when sharing a note."],
      ["write-notes", "always", "Use when writing a note for the team or a customer."],
    ]);
    const kept = await inTenant(() =>
      client.db.query.spaceConnection.findFirst({ where: (t, { eq }) => eq(t.id, connection.id) }),
    );
    expect(kept).toMatchObject({ label: "notes@acme", bundleId, connectorId: "open-example" });
    expect(kept?.secret).toBeTruthy();
    expect(await asAdmin(() => bundles.bundleUpdate("user-a", bundleId, "en"))).toEqual({
      update: null,
      upload: false,
    });
  });

  it("lets a connector go its own way where the origin no longer names its server", async () => {
    const next = { ...repos["acme/both"] };
    next[".mcp.json"] = JSON.stringify({
      mcpServers: {
        notes: { type: "http", url: "https://open.example.net/mcp", headers: { "X-Plugin": "notes@1" } },
      },
    });
    repos["acme/both"] = next;
    const { update } = await asAdmin(() => bundles.bundleUpdate("user-a", bundleId, "en"));
    expect(update?.servers).toEqual({
      added: [],
      removed: [{ connectorId: "more-example", name: "More" }],
    });
    const taken = await asAdmin(() => bundles.applyBundleUpdate("user-a", bundleId, {}, "en"));
    expect(taken.bundle.connectors).toEqual([{ id: "open-example", name: "Notes" }]);
    // It stays a connector of the space, by itself.
    const listed = await asAdmin(() => external.listConnectors(space));
    expect(listed.find((c) => c.id === "more-example")).toMatchObject({
      bundle: null,
      fromAddress: true,
    });
    await asAdmin(() => external.removeConnector(space, "more-example"));
  });

  it("names the wizards that use its connection before it is removed, and removes all at once", async () => {
    const connection = await inTenant(() =>
      client.db.query.spaceConnection.findFirst({ where: (t, { eq }) => eq(t.bundleId, bundleId) }),
    );
    const wizard = (title: string, id: string, spaceConnection?: string) =>
      inTenant(() =>
        client.db.insert(client.schema.wizard).values({
          id,
          spaceId: space,
          tenantId: TENANT,
          title,
          shareToken: `share-${id}`,
          draft: {
            version: 1,
            title,
            steps: [],
            ...(spaceConnection ? { connections: [{ id: "notes", spaceConnection }] } : {}),
          } as never,
        }),
      );
    await wizard("Notiz an das Team", "wz-uses", connection?.id);
    await wizard("Etwas anderes", "wz-other");
    const removal = await asAdmin(() => bundles.bundleRemoval("user-a", bundleId));
    expect(removal).toEqual({
      connectors: [{ id: "open-example", name: "Notes" }],
      connections: [{ id: connection?.id, name: "Team-Notizen" }],
      skills: [
        { id: expect.any(String), name: "share-notes" },
        { id: expect.any(String), name: "write-notes" },
      ],
      wizards: [{ id: "wz-uses", title: "Notiz an das Team", connections: ["Team-Notizen"] }],
    });
    await asAdmin(() => bundles.removeBundle("user-a", bundleId));
    expect(await asAdmin(() => bundles.listBundles("user-a", space))).toEqual([]);
    const listed = await asAdmin(() => external.listConnectors(space));
    expect(listed.some((c) => c.id === "open-example")).toBe(false);
    expect((await asAdmin(() => skills.listSkills("user-a", space))).skills).toEqual([]);
    expect(await inTenant(() => connections.listSpaceConnections(space))).toEqual([]);
    // The wizard stays; its draft says what it misses when it is checked.
    const left = await inTenant(() =>
      client.db.query.wizard.findFirst({ where: (t, { eq }) => eq(t.id, "wz-uses") }),
    );
    expect(left?.title).toBe("Notiz an das Team");
  });
});

describe("a plugin with skills and no server over http", () => {
  it("brings its skills alone", async () => {
    const { preview } = await asAdmin(() =>
      bundles.previewBundle("user-a", space, at("acme/skills-only"), "en"),
    );
    expect(preview).toMatchObject({ name: "writing", version: null, servers: [], leftOut: [] });
    const made = await asAdmin(() =>
      bundles.importBundle("user-a", space, at("acme/skills-only"), {}, "en"),
    );
    expect(made.connectors).toEqual([]);
    expect(made.bundle.connectors).toEqual([]);
    expect(made.bundle.skills.map((k) => k.name)).toEqual(["tone-of-voice"]);
    const { skills: all } = await asAdmin(() => skills.listSkills("user-a", space));
    expect(all[0].bundle).toEqual({ id: made.bundle.id, name: "writing", connectors: [] });
    await asAdmin(() => bundles.removeBundle("user-a", made.bundle.id));
  });
});

describe("a plugin with a server and no skills", () => {
  it("brings its connector alone, with the header its plugin names for the key", async () => {
    const { preview } = await asAdmin(() =>
      bundles.previewBundle("user-a", space, at("acme/server-only"), "en"),
    );
    expect(preview).toMatchObject({ name: "keys", format: "cursor", skills: [] });
    expect(preview?.servers[0]).toMatchObject({
      key: "keys",
      keyHeader: { name: "Authorization", scheme: "Bearer" },
      source: { toolsPending: true, signIn: { described: null } },
    });
    expect(preview?.leftOut).toEqual([{ kind: "rule", name: "style" }]);
    // With the key the admin types, the preview lists the actions.
    const withKey = await asAdmin(() =>
      bundles.previewBundle("user-a", space, at("acme/server-only"), "en", {
        keys: { signIn: { kind: "header", name: "Authorization", scheme: "Bearer", value: "k-1" } },
      }),
    );
    expect(withKey.preview?.servers[0].source.actions).toHaveLength(2);
    const made = await asAdmin(() =>
      bundles.importBundle("user-a", space, at("acme/server-only"), {}, "en"),
    );
    expect(made.bundle.skills).toEqual([]);
    expect(made.connectors).toHaveLength(1);
    expect(made.connectors[0]).toMatchObject({
      id: "keys-example",
      name: "Keys",
      auth: "api_key",
      fromAddress: true,
    });
    const row = await inTenant(() =>
      client.db.query.spaceConnector.findFirst({ where: (t, { eq }) => eq(t.id, "keys-example") }),
    );
    expect(row?.record.auth_config).toMatchObject({
      kind: "api_key",
      placement: { in: "header", name: "Authorization", value_template: "Bearer {{api_key}}" },
    });
    await asAdmin(() => bundles.removeBundle("user-a", made.bundle.id));
  });

  it("leaves a server out where the admin says so, and refuses what brings nothing", async () => {
    await expect(
      asAdmin(() =>
        bundles.importBundle(
          "user-a",
          space,
          at("acme/server-only"),
          { servers: { keys: { take: false } } },
          "en",
        ),
      ),
    ).rejects.toThrow(/brings nothing a space takes/);
    await expect(
      asAdmin(() => bundles.importBundle("user-a", space, at("acme/nothing"), {}, "en")),
    ).rejects.toThrow(/brings nothing a space takes/);
    await expect(
      asAdmin(() =>
        bundles.importBundle("user-a", space, at("acme/both"), { servers: { nope: {} } }, "en"),
      ),
    ).rejects.toThrow(/names no server “nope”/);
    expect(await asAdmin(() => bundles.listBundles("user-a", space))).toEqual([]);
  });

  it("leaves nothing behind where a server fails", async () => {
    await expect(
      asAdmin(() =>
        bundles.importBundle(
          "user-a",
          space,
          at("acme/both"),
          { servers: { notes: { id: "Not An Id" } } },
          "en",
        ),
      ),
    ).rejects.toThrow(/The server “notes” could not be imported/);
    expect(await asAdmin(() => bundles.listBundles("user-a", space))).toEqual([]);
    expect((await asAdmin(() => skills.listSkills("user-a", space))).skills).toEqual([]);
  });
});

describe("what GitHub and a zip can hold", () => {
  it("lists the plugins of a repository of several, and takes the one in its folder", async () => {
    const found = await asAdmin(() =>
      bundles.previewBundle("user-a", space, at("acme/many"), "en"),
    );
    expect(found.preview).toBeNull();
    expect(found.plugins.map((p) => p.name)).toEqual(["sales", "elsewhere", "part"]);
    await expect(
      asAdmin(() => bundles.importBundle("user-a", space, at("acme/many"), {}, "en")),
    ).rejects.toThrow(/holds several plugins/);
    const { preview } = await asAdmin(() =>
      bundles.previewBundle(
        "user-a",
        space,
        { address: "https://github.com/acme/many/tree/main/sales" },
        "en",
      ),
    );
    expect(preview).toMatchObject({
      name: "sales",
      origin: { kind: "github", repo: "acme/many", ref: "main", path: "sales" },
    });
  });

  it("says what is no repository, none GitHub has, and no plugin", async () => {
    const preview = (address: string) =>
      asAdmin(() => bundles.previewBundle("user-a", space, { address }, "en"));
    await expect(preview("https://example.com/acme/both")).rejects.toThrow(
      /no address of a repository on GitHub/,
    );
    await expect(preview("https://github.com/acme/gone")).rejects.toThrow(
      /no public repository acme\/gone/,
    );
    await expect(preview("https://github.com/acme/not-a-plugin")).rejects.toThrow(
      /Nothing here is a plugin/,
    );
    // In the asker's language.
    await expect(
      asAdmin(() =>
        bundles.previewBundle("user-a", space, at("acme/not-a-plugin"), "de"),
      ).catch((err) => {
        throw new Error(JSON.stringify((err as { toJSON(lang: string): unknown }).toJSON("de")));
      }),
    ).rejects.toThrow(/Hier liegt kein Plugin/);
  });

  it("takes an uploaded zip, and a new file to update it", async () => {
    const zip = (files: Record<string, string>) =>
      zipSync(Object.fromEntries(Object.entries(files).map(([p, t]) => [p, strToU8(t)])));
    const files = {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "from-a-file", version: "1" }),
      "skills/a/SKILL.md": skillMd("a-skill", "Use it."),
    };
    const file = { name: "from-a-file.zip", data: zip(files) };
    await expect(
      asAdmin(() =>
        bundles.previewBundle("user-a", space, { file: { name: "x.txt", data: file.data } }, "en"),
      ),
    ).rejects.toThrow(/\.zip or a \.plugin/);
    const { preview } = await asAdmin(() => bundles.previewBundle("user-a", space, { file }, "en"));
    expect(preview).toMatchObject({
      name: "from-a-file",
      origin: { kind: "upload", file: "from-a-file.zip", path: "" },
    });
    const made = await asAdmin(() =>
      bundles.importBundle("user-a", space, { file }, { hash: preview?.hash }, "en"),
    );
    expect(made.bundle.skills.map((k) => k.name)).toEqual(["a-skill"]);
    // Its origin cannot be asked: a new file is the update.
    expect(await asAdmin(() => bundles.bundleUpdate("user-a", made.bundle.id, "en"))).toEqual({
      update: null,
      upload: true,
    });
    await expect(
      asAdmin(() => bundles.applyBundleUpdate("user-a", made.bundle.id, {}, "en")),
    ).rejects.toThrow(/Upload the new file/);
    const newer = {
      name: "from-a-file-2.zip",
      data: zip({
        ...files,
        ".claude-plugin/plugin.json": JSON.stringify({ name: "from-a-file", version: "2" }),
        "skills/b/SKILL.md": skillMd("b-skill", "Use it too."),
      }),
    };
    const taken = await asAdmin(() =>
      bundles.applyBundleUpdate("user-a", made.bundle.id, { file: newer }, "en"),
    );
    expect(taken.bundle).toMatchObject({
      version: "2",
      origin: { kind: "upload", file: "from-a-file-2.zip" },
    });
    expect(taken.bundle.skills.map((k) => k.name)).toEqual(["a-skill", "b-skill"]);
    await asAdmin(() => bundles.removeBundle("user-a", made.bundle.id));
  });
});

describe("a plugin's server at a private address", () => {
  it("is taken on a computer of one's own", async () => {
    const { preview } = await asAdmin(() =>
      bundles.previewBundle("user-a", space, at("acme/private"), "en"),
    );
    expect(preview?.servers).toHaveLength(1);
    expect(preview?.servers[0].source).toMatchObject({ privateAddress: true, fromAddress: true });
    expect(preview?.leftOut).toEqual([]);
    const made = await asAdmin(() =>
      bundles.importBundle("user-a", space, at("acme/private"), {}, "en"),
    );
    expect(made.connectors).toHaveLength(1);
    expect(made.bundle.skills.map((k) => k.name)).toEqual(["intern-guide"]);
    await asAdmin(() => bundles.removeBundle("user-a", made.bundle.id));
  });

  it("is left out in words on a managed runtime, and its skills still come", async () => {
    mode.managed = true;
    try {
      const { preview } = await asAdmin(() =>
        bundles.previewBundle("user-a", space, at("acme/private"), "en"),
      );
      expect(preview?.servers).toEqual([]);
      expect(preview?.leftOut).toEqual([
        {
          kind: "server",
          name: "intern",
          reason: "refused",
          detail: expect.stringMatching(/is in a private network/),
        },
      ]);
      expect(preview?.skills.map((k) => k.name)).toEqual(["intern-guide"]);
      // Taken as it stands, the server stops the import, and nothing stays.
      await expect(
        asAdmin(() => bundles.importBundle("user-a", space, at("acme/private"), {}, "en")),
      ).rejects.toThrow(/The server “intern” could not be imported.*private network/);
      const made = await asAdmin(() =>
        bundles.importBundle(
          "user-a",
          space,
          at("acme/private"),
          { servers: { intern: { take: false } } },
          "en",
        ),
      );
      expect(made.connectors).toEqual([]);
      expect(made.bundle.leftOut).toEqual([{ kind: "server", name: "intern" }]);
      // The server the admin left out does not come back as new with an update.
      repos["acme/private"] = {
        ...repos["acme/private"],
        "skills/intern-guide/SKILL.md": skillMd("intern-guide", "Use for the internal system.", "New."),
      };
      const { update } = await asAdmin(() => bundles.bundleUpdate("user-a", made.bundle.id, "en"));
      expect(update).toMatchObject({
        skills: { added: [], changed: ["intern-guide"], removed: [] },
        servers: { added: [], removed: [] },
      });
      await asAdmin(() => bundles.removeBundle("user-a", made.bundle.id));
    } finally {
      mode.managed = false;
    }
  });
});

describe("who may", () => {
  it("refuses a member every call, in an organization", async () => {
    const made = await asAdmin(() =>
      bundles.importBundle("user-a", space, at("acme/skills-only"), {}, "en"),
    );
    mode.managed = true;
    try {
      const calls: (() => Promise<unknown>)[] = [
        () => bundles.previewBundle("user-m", space, at("acme/both"), "en"),
        () => bundles.importBundle("user-m", space, at("acme/both"), {}, "en"),
        () => bundles.listBundles("user-m", space),
        () => bundles.bundleUpdate("user-m", made.bundle.id, "en"),
        () => bundles.applyBundleUpdate("user-m", made.bundle.id, {}, "en"),
        () => bundles.bundleRemoval("user-m", made.bundle.id),
        () => bundles.removeBundle("user-m", made.bundle.id),
      ];
      for (const call of calls) {
        await expect(asMember(call)).rejects.toMatchObject({ code: "forbidden" });
      }
      // An admin of the organization may.
      expect(await asAdmin(() => bundles.listBundles("user-a", space))).toHaveLength(1);
    } finally {
      mode.managed = false;
    }
    await asAdmin(() => bundles.removeBundle("user-a", made.bundle.id));
  });
});

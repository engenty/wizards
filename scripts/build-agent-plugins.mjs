// Builds the plugin for the AI apps' marketplaces from `plugin/`: the contents of the public
// repository engenty/wizards-plugins, which Claude Code, Codex, ChatGPT, Cursor, VS Code and
// Gemini CLI install from, and the MCP Registry's server.json.
//
//   node scripts/build-agent-plugins.mjs [--url https://engenty.ai] [--out dist/agent-plugins]
//
// --url  the wizards server the plugin bundles: its MCP server is `<url>/api/mcp`
// --out  the folder to write; it is emptied first. Beside it, `<out>-openai.zip` is the upload
//        for OpenAI's plugin portal: the portable manifest, the MCP server and the skills, no
//        Claude Code pane (the portal refuses hooks).
//
// One folder serves every app, each reading its own files:
//   .claude-plugin/plugin.json + .mcp.json    Claude Code, VS Code
//   plugin.json + mcp.json                    ChatGPT, Codex, Cursor, VS Code (Agent Plugins 1.0)
//   gemini-extension.json                     Gemini CLI
//   .claude-plugin/marketplace.json           `claude plugin marketplace add engenty/wizards-plugins`
//   .agents/plugins/marketplace.json          `codex plugin marketplace add engenty/wizards-plugins`
//   server.json                               the MCP Registry (`mcp-publisher publish`)
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { zipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    url: { type: "string", default: "https://engenty.ai" },
    out: { type: "string", default: "dist/agent-plugins" },
  },
});
const url = values.url.replace(/\/+$/, "");
const out = resolve(values.out);
const mcpUrl = `${url}/api/mcp`;
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The server's name in every app's settings; the skills name its tools by it. */
const SERVER = "engenty-wizards";
const DESCRIPTION =
  "Build page-by-page AI wizards that people open on a shared link, test and publish them from the chat, and run your published ones here.";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  writeFileSync(
    join(out, path),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
};

rmSync(out, { recursive: true, force: true });
cpSync(join(root, "plugin"), out, {
  recursive: true,
  filter: (src) => !src.endsWith(".DS_Store"),
});

// The manifests carry the release's version and this server's address.
const claude = readJson(join(out, ".claude-plugin/plugin.json"));
write(".claude-plugin/plugin.json", { ...claude, version, homepage: url });
const portable = readJson(join(out, "plugin.json"));
write("plugin.json", { ...portable, version, homepage: url });

// The app's icon, as the directories show it.
mkdirSync(join(out, "assets"), { recursive: true });
cpSync(join(root, "apps/web/public/icons/icon-512.png"), join(out, "assets/logo.png"));
cpSync(join(root, "apps/web/public/icons/icon-192.png"), join(out, "assets/icon.png"));

// Claude Code and VS Code: `type` is required, a `url` without it reads as a local command.
write(".mcp.json", { mcpServers: { [SERVER]: { type: "http", url: mcpUrl } } });
// Agent Plugins 1.0. The person signs in with their engenty account; engenty.ai's sign-in
// takes a client that names itself by its metadata document (CIMD).
write("mcp.json", {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    [SERVER]: {
      type: "streamable-http",
      url: mcpUrl,
      extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "cimd" } } } },
    },
  },
});
// Gemini CLI: `httpUrl` is streamable HTTP (`url` would be SSE). It reads the skills from skills/.
write("gemini-extension.json", {
  name: SERVER,
  version,
  description: DESCRIPTION,
  mcpServers: { [SERVER]: { httpUrl: mcpUrl } },
});

const marketplace = {
  name: "engenty",
  owner: { name: "engenty", url },
  description: "engenty wizards for your AI apps.",
  plugins: [
    {
      name: claude.name,
      source: "./",
      description: claude.description,
      category: "productivity",
      keywords: claude.keywords,
    },
  ],
};
write(".claude-plugin/marketplace.json", marketplace);
write(".agents/plugins/marketplace.json", {
  name: "engenty",
  interface: { displayName: "engenty" },
  plugins: [
    {
      name: portable.name,
      source: { source: "local", path: "./" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  ],
});

// The MCP Registry: a remote server under the namespace engenty.ai proves by DNS.
write("server.json", {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "ai.engenty/wizards",
  title: "engenty wizards",
  description: "Build, test, publish and run page-by-page AI wizards that people open on a link.",
  version,
  websiteUrl: url,
  repository: { url: "https://github.com/engenty/wizards-plugins", source: "github" },
  remotes: [{ type: "streamable-http", url: mcpUrl }],
});

write("LICENSE", readFileSync(join(root, "plugin/LICENSE"), "utf8"));

// OpenAI's portal: one MCP server, skills and the listing, nothing it refuses.
const OPENAI = ["plugin.json", "mcp.json", "skills", "assets", "LICENSE"];
const files = {};
const add = (path) => {
  const full = join(out, path);
  if (statSync(full).isDirectory()) {
    for (const entry of readdirSync(full)) {
      add(`${path}/${entry}`);
    }
  } else {
    files[path] = readFileSync(full);
  }
};
for (const path of OPENAI) {
  add(path);
}
writeFileSync(
  `${out}-openai.zip`,
  zipSync(files, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") }),
);

console.log(`agent plugins ${version} for ${mcpUrl}:`);
console.log(`  ${relative(root, out)}/`);
console.log(`  ${relative(root, `${out}-openai.zip`)} (${Object.keys(files).length} files)`);

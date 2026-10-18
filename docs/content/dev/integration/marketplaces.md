---
title: Marketplaces
description: How the plugin for the AI apps is built, released and listed in each app’s directory.
version: 0.9.0
---

The plugin “engenty wizards” is `plugin/` in this repository. One build makes it for every AI
app, with engenty.ai’s MCP server bundled:

```bash
node scripts/build-agent-plugins.mjs --url https://engenty.ai
```

It writes `dist/agent-plugins/`, the contents of the public repository
[engenty/wizards-plugins](https://github.com/engenty/wizards-plugins), and
`dist/agent-plugins-openai.zip`, the upload for OpenAI’s plugin portal.

## What each app reads

| Files | Apps |
|---|---|
| `.claude-plugin/plugin.json`, `.mcp.json`, `claude-code/` | Claude Code, VS Code |
| `plugin.json`, `mcp.json` (Agent Plugins 1.0) | ChatGPT, Codex, Cursor, VS Code |
| `gemini-extension.json` | Gemini CLI |
| `skills/` | all of them |
| `.claude-plugin/marketplace.json` | `claude plugin marketplace add engenty/wizards-plugins` |
| `.agents/plugins/marketplace.json` | `codex plugin marketplace add engenty/wizards-plugins` |
| `server.json` | the MCP Registry, which GitHub’s registry and Goose read |

- The Claude Code pane is a mod in `claude-code/`, outside the `hooks/` folder that other apps
  read as their own hooks. OpenAI’s portal refuses hooks, so the zip leaves it out.
- Every app names the server `engenty-wizards`. The skills name its tools by it.
- The Claude Code plugin is named `wizards`, the others `engenty-wizards`.

## Release

A release tag runs the job `agent-plugins` in `release.yml`. It builds the plugin, replaces the
contents of engenty/wizards-plugins with it, tags it with the same version and attaches the zip
to the GitHub release. The deploy key in the secret `PLUGINS_DEPLOY_KEY` may write to
engenty/wizards-plugins.

Claude Code, Codex and Gemini CLI install the repository’s newest commit. Anthropic’s and
Cursor’s directories pick up the new version from the repository. OpenAI’s portal needs the new
zip uploaded by hand.

## Before a listing

The directories check the MCP server as well as the plugin:

- Every tool has a title and all three hints: `readOnlyHint`, `destructiveHint`,
  `openWorldHint` (`apps/runtime/src/mcp/tools.ts`).
- engenty.ai’s sign-in takes clients by metadata document (CIMD) and by registration (DCR), and
  public clients without a secret. Its redirect check must take
  `https://claude.ai/api/mcp/auth_callback`, `https://chatgpt.com/connector/oauth/…`,
  `https://www.cursor.com/agents/mcp/oauth/callback` and loopback addresses on any port.
- The privacy policy (`https://engenty.ai/privacy`) names what a run stores.
- A test account with credits, without a second factor or an e-mail code.

## The listings

| Directory | Where | What it needs |
|---|---|---|
| Claude (plugins) | claude.ai/directory/manage → Plugin bundle | the public repository engenty/wizards-plugins |
| OpenAI (ChatGPT and Codex) | platform.openai.com/plugins | the zip, the token for `OPENAI_APPS_CHALLENGE`, a test account, 5 prompts it should answer and 3 it should turn down, a demo video |
| Cursor | cursor.com/marketplace/publish | the public repository |
| MCP Registry | `mcp-publisher publish` with `server.json` | a TXT record on engenty.ai for the namespace `ai.engenty` |
| Gemini CLI | the GitHub topic `gemini-cli-extension` on engenty/wizards-plugins | nothing else: its gallery reads the repository each day |

- **Claude.** Anthropic’s connector directory doesn’t take servers that make images or videos
  with AI, so engenty wizards is listed as a plugin only. People on claude.ai add the server
  as a custom connector.
- **OpenAI.** The portal checks the domain at `https://engenty.ai/.well-known/openai-apps-challenge`:
  set the token it shows as `OPENAI_APPS_CHALLENGE` in engenty.ai’s environment. A plugin
  inside ChatGPT may not sell credits or point to a plan or checkout. Runs use the credits a
  person already has.
- **MCP Registry.** `mcp-publisher login dns --domain engenty.ai --private-key <key>` signs in
  with the key whose public half is in the TXT record
  `v=MCPv1; k=ed25519; p=<public key>`.

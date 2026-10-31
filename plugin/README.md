# engenty wizards for your AI apps

An engenty wizard is a page-by-page AI flow that people open on a shared link: a few questions
per page, AI steps that research, write and make images, videos and documents, a review, and
files at the end. This plugin brings your wizards into your AI app:

- **Build and change** a wizard from the chat: the `build-wizard` skill reads the authoring guide,
  starts from the closest starter, fixes every issue, runs one test and gives you the studio link.
- **Run** one of your published wizards in the chat with the `use-wizard` skill, page by page,
  with its review and its downloads. Apps that show MCP Apps show the wizard itself.
- **Work in your space** with the `work-in-space` skill: search its knowledge, follow its skills
  (their scripts run in a sandbox of the space), use its connections and run its wizards, under
  the space's rules, as you.
- **Publish** a wizard and change who may open its link, when you ask for it.

The plugin connects your app to engenty.ai (`https://engenty.ai/api/mcp`). The first time you use
it, the app asks you to sign in with your engenty account. Runs and test runs use your account's
credits.

## Install

| App | How |
|---|---|
| Claude Code | `claude plugin marketplace add engenty/wizards-plugins`, then `claude plugin install wizards@engenty` |
| Codex | `codex plugin marketplace add engenty/wizards-plugins`, then `/plugins` in Codex and install “engenty wizards” |
| ChatGPT | Plugins → search “engenty wizards”. Not listed yet: + → Add custom MCP server → `https://engenty.ai/api/mcp` |
| Cursor | Customize → Plugins → search “engenty wizards”. Not listed yet: Settings → MCP → add `https://engenty.ai/api/mcp` |
| VS Code (Copilot) | Command palette → “Chat: Install Plugin From Source” → `https://github.com/engenty/wizards-plugins` |
| Gemini CLI | `gemini extensions install https://github.com/engenty/wizards-plugins --auto-update` |
| claude.ai, Claude Desktop | Settings → Connectors → Add custom connector → `https://engenty.ai/api/mcp` |

Then ask: “Which wizards do I have in engenty?”

Updates: `claude plugin update wizards`, `codex plugin marketplace upgrade engenty`,
`gemini extensions update engenty-wizards`. The other apps update by themselves.

## Claude Code: the wizards pane

In Claude Code the plugin also adds **`/wizard <what it should do>`**, which builds a wizard from a
description, and **`/wizards`**, a pane beside the chat with your wizards. **Run** opens the
wizard's own page in the app's browser pane, where you fill it as any person would. **Edit** puts
a change request into the chat for you to finish. The pane opens by itself when the plugin loads;
`/wizards close` closes it. A run the model drives opens its page beside the chat once it waits
for you.

The pane calls the server itself, from a button press, not from a model request. In auto mode
such a call is refused unless an allow rule names the tool. Put these in `permissions.allow` of
`.claude/settings.local.json` or your user settings:

```json
["mcp__plugin_wizards_engenty-wizards", "mcp__Claude_Browser__navigate"]
```

The browser pane's `navigate` may still ask you. The pane then shows a plain link to the same
page.

| Option    | Default           | What it names                                         |
| --------- | ----------------- | ----------------------------------------------------- |
| `server`  | `engenty-wizards` | the wizards server's MCP server, as `/mcp` lists it   |
| `browser` | `Claude_Browser`  | the app's browser pane, whose `navigate` opens a page |

The pane is a mod: `claude-code/register.tsx`, its state declared in `claude-code/types/`.
`claude plugin validate .` checks it, `claude plugin test .` runs `claude-code/pane.test.tsx`.

## engenty wizards on your computer

engenty wizards also runs on your computer, without an account. `wizards connect` adds it to the
AI apps it finds there. Its Claude Code plugin comes from the product's repository and uses that
server:

```bash
claude plugin marketplace add engenty/wizards
claude plugin install wizards@engenty-local
```

## This repository

The plugin is built from `plugin/` in [engenty/wizards](https://github.com/engenty/wizards) and
lands here with each release. Change it there.

The plugin is under the MIT licence ([LICENSE](LICENSE)). The engenty figures in it
(`claude-code/engenty.ts`, `assets/`) are under CC BY 4.0, and “engenty” and the figures are
trademarks of Thru The Heart Creative GmbH.

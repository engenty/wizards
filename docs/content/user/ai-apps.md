---
title: AI apps
description: Run and build your wizards inside Claude Desktop, Cursor, Codex and other AI apps.
version: 0.5.0
---

Settings → Integrate brings your wizards to where you work. engenty wizards is an MCP server: an
AI app that adds it gets the tools to find, run and build wizards. Under “Share”, the same page
has the WordPress plugin: see [WordPress](./wordpress.md).

## What an app can do

| In the chat | How |
|---|---|
| Run a wizard | “Start one of my engenty wizards.” The app asks the wizard’s questions, shows the review and hands over the downloads. Only published wizards run |
| See the wizard itself | Apps that support MCP Apps show the wizard as a widget, page by page, and you answer there |
| Build a wizard | “Use engenty wizards to build a wizard that reads amount, date and sender from an invoice PDF.” |
| Change one | The app can create, change and publish wizards, find templates and connectors, and read and write a wizard’s files |

- A run in a chat spends what any run of the wizard spends, and so does a test run.
- What a chat can’t fill in (files, recordings, signatures, line items) you fill in on the run’s
  page in the browser. The app gives you the link.
- What an app writes shows up live in an open editor, marked with the app’s name (“Via …”).

## Apps

| App | Shows the wizard as a widget | Name for the command |
|---|---|---|
| Claude Desktop | yes | `claude-desktop` |
| Claude Code | no, a run comes as text | `claude-code` |
| Codex · ChatGPT app | no | `codex` |
| Cursor | yes | `cursor` |
| VS Code (Copilot) | yes | `vscode` |
| Windsurf | no | `windsurf` |
| Antigravity | no | `antigravity` |
| Goose | yes | `goose` |
| OpenClaw | no | `openclaw` |
| LM Studio | no | `lm-studio` |
| claude.ai, ChatGPT | yes | not on your computer, see below |

## Add an app

Settings → Integrate opens on the apps found on this computer. Each one has a button and says
where it stands: “Works”, “Added, not tested yet” or “Not set up yet”. The dots in the menu say
the same.

Choose an app and follow its numbered steps:

1. **Add to …** writes engenty wizards into the app’s settings. You need no key and no port: the
   app starts engenty wizards itself.
2. **Restart …**, or reload the app’s MCP servers. The page notices by itself when the app
   checks in.
3. **Try it in the chat**: “Which wizards do I have in engenty?”

Once the app has used a tool, the page says “Works” and offers first sentences to try, with your
own wizards’ names.

From a terminal, this command does the same as step 1:

```bash
wizards connect
```

It adds every AI app found on this computer. To add only some apps, name them. To take an app
out again, use `disconnect`:

```bash
wizards connect cursor codex
wizards disconnect cursor
```

- The app’s settings file as it was before is kept beside it as `<file>.before-engenty`.
- If Claude Desktop is running, the command asks you to quit it first: it writes its settings
  from memory while it runs and would overwrite the change.
- A settings file that isn’t plain JSON is left alone. The command prints the entry for you to
  paste in yourself.

## An app on another computer

Under the steps, “Connect with the address and an API key” is for an app that runs elsewhere.
The API key is shown once and goes straight into the command or settings entry the page shows.

- Each API key signs in one app and has full rights. Treat it like a password.
- The page lists the API keys with their last use. When you delete one, that app is signed out.

## Apps on the web

claude.ai and ChatGPT connect from their makers’ servers, and so do Claude Desktop’s
connectors. They can’t reach your computer, so for them your wizards run on engenty.ai.

- **In the studio on engenty.ai**, the page walks you through it: open the app’s connector
  settings, enter the name and the address `https://engenty.ai/api/mcp`, click “Connect”, sign
  in to engenty and choose “Allow”. You need no key.
- **On your computer**, connect your engenty account first (“Connect to engenty.ai”). The wizards
  you publish then go to engenty.ai, and claude.ai connects there. If you’d rather not use an
  account, use Claude Desktop on this computer.

The consent page names the team the access is for and the address it goes back to. An app that
only named itself is marked “Name given by the app itself”.

You disconnect an app at engenty.ai under Account → Connected apps. Its access ends within half
a minute, even with a token it already holds.

## The Claude Code plugin

If engenty wizards has a public https address, Claude Code can also install a plugin. It adds
the `/wizard` command and the skills to build and use wizards:

```bash
claude plugin marketplace add <your address>/api/claude-plugin/marketplace.json
claude plugin install engenty-wizards@engenty
```

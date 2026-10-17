---
title: Command line
description: The wizards command – start, setup, status, update – and the settings file on your computer.
version: 0.5.0
---

## Commands

| Command | What it does |
|---|---|
| `wizards` | Shows what is running, and a menu. While it runs, you can open the studio, restart or stop it; while it doesn’t, “Start in the background” or “Start in this terminal”. Then “Update”, which restarts it into the new version, “Start at login”, “Connect AI apps”, “Account”, “Status”, “Setup”, “Uninstall” and “Help”. The first time, the setup runs first. It needs a terminal |
| `wizards start` | Starts it and opens the studio. It runs in that terminal, and Ctrl-C stops it. The first time, the setup runs first |
| `wizards studio` | Opens the studio in your browser. If it isn’t running, it starts in the background first |
| `wizards setup` | Runs the guided setup again: your account, an AI client, the browser and ffmpeg, start at login, your AI apps. `--local` leaves the account out ([Local only](./local-only.md)) |
| `wizards account` | Shows the account this computer is signed in to: who, which team, the credits. `sign-in` shows a link and a code and opens your browser; `sign-out` disconnects this computer |
| `wizards open` | Signs this browser in to the running studio. `--print` only prints the link; it works once, within a minute |
| `wizards status` | Shows what is installed and running, with the browser it uses for PDF, PNG and websites |
| `wizards doctor` | Shows the status and checks for problems |
| `wizards logs [n]` | Prints the last lines engenty wizards printed while running (100, or `n` up to 2000). Keys and tokens are taken out |
| `wizards report` | Sends the status, the model settings (never a key) and the last 500 log lines to your [account](./models.md#account), so support can see what went wrong. Nothing is sent unless you run it. The command names the report’s ID. If this computer isn’t signed in, it tells you to sign in under Settings → Account or with `wizards account sign-in` |
| `wizards stop` | Stops it, with any other copy of it still running in the background. Your data is kept. AI apps that use your wizards start it again when you use one there |
| `wizards restart` | Stops it and starts it again; after an update, that is the new version. If it isn’t running, it starts in the background |
| `wizards update` | Installs the latest version |
| `wizards sandbox add` / `remove` | Adds the sandbox where AI steps run code, or removes it. It is agentOS, about 340 MB, and needs no Docker. Without a sandbox, steps can’t run code. `wizards sandbox` alone shows whether it is there. Name an engine to add another one: `wizards sandbox add agentos` |
| `wizards autostart on` / `off` | Starts it when you log in, or stops doing so. It is a LaunchAgent on macOS and a systemd user service on Linux |
| `wizards connect [app …]` | Adds your wizards to your [AI apps](./ai-apps.md): every app found, or the ones you name |
| `wizards disconnect [app …]` | Takes them out again |
| `wizards mcp` | Runs the MCP server over stdio. AI apps start it; you don’t |
| `wizards uninstall` | Takes engenty wizards off this computer. It shows what it will remove first and asks about your data on its own; your data is kept unless you choose to delete it. `--dry-run` only shows the plan, `--yes` asks nothing and keeps your data, `--yes --delete-data` deletes it too. See [Remove](./install.md#remove) |
| `wizards validate <path …>` | Checks wizards without the studio: `.wizard` files, unpacked wizard files, or a wizard’s JSON. `--json` prints the problems as JSON. A space’s connectors and plugins are checked when you import it |

| Option | What it does |
|---|---|
| `--yes`, `-y` | Asks nothing and installs nothing optional |
| `--local` | Sets up without an account, so nothing leaves this computer ([Local only](./local-only.md)) |
| `--client <name>` | Installs this AI client without asking: `codex`, `claude`, `antigravity`, `cursor` |
| `--no-open` | Starts without opening the browser |
| `--background`, `-s` | Starts it in the background (`--service` still works): detached from the terminal, and the command returns. `wizards stop` stops it, and its output goes to `logs/runtime.log` |
| `--version`, `-v` | Prints the version |
| `--help`, `-h` | Lists every command |

When you start it in a terminal, it runs while that terminal is open, and Ctrl-C stops it. With
`wizards start --background` it keeps running after the terminal closes. If it is already
running, `wizards start` opens the running one instead of starting a second.

## Where things are

| Path | What it holds |
|---|---|
| `~/.engenty/wizards` | Everything engenty wizards installed. `ENGENTY_HOME` moves `~/.engenty` |
| `~/.engenty/wizards/data` | Your wizards, results and files. See [Your data](./data.md) |
| `~/.engenty/wizards/.env` | The settings file |
| `~/.engenty/wizards/plugins` | [Plugins](./plugins.md) on this computer |
| `~/.engenty/wizards/logs` | Logs: `install.log`, `update.log`, `runtime.log` when it runs in the background, `autostart.log` when a Mac starts it at login |
| `~/.engenty/wizards/engines` | The sandbox, once `wizards sandbox add` put it there: one folder per engine |
| `~/.engenty/wizards/tools`, `runtime` | Its own Node.js, and engenty wizards itself |
| `~/.engenty/wizards/bin/wizards` | The command; `~/.local/bin/wizards` links to it |

## Settings

You change most settings in the studio. The settings file `~/.engenty/wizards/.env` holds what
the studio doesn’t: one `NAME=value` per line. Restart engenty wizards after a change.

| Setting | What it does | Default |
|---|---|---|
| `APP_URL` | The address you open. Links and sign-ins use it | `http://localhost:24368` |
| `API_PORT` | The port | `24368`; if it is taken, the next free one up to `24387` |
| `CHROME_PATH` | The browser for PDF and PNG exports and steps on websites: Chrome, Edge, Chromium or Brave | The first one found: on a Mac Google Chrome, Microsoft Edge, Chromium or Brave in `/Applications` or `~/Applications`; on Linux `google-chrome`, `chromium`, `chromium-browser` or `microsoft-edge` on the PATH. `wizards status` names it |
| `FFMPEG_PATH` | ffmpeg for MP4 videos | `ffmpeg` |
| `SANDBOX_ALLOW_HOSTS` | Addresses the sandbox reaches besides the npm and PyPI registries, comma-separated: `api.example.com`. It reaches nothing else | not set |
| `OLLAMA_URL` | Where Ollama answers | `http://127.0.0.1:11434/v1` |
| `PLUGINS_DIR` | Folders with plugins, comma-separated. If you set it, it replaces the default | `~/.engenty/wizards/plugins` |
| `PLUGINS_WATCH` | With `0`, plugins no longer load again when their files change | `1` |
| `GEOCODER_URL` | Finds the place of a location (street, town). If it is not set, a location is only coordinates, and no position leaves your computer | not set |
| `LIMIT_DEFAULT_DAILY_RUNS` | How many runs a day a shared link allows, unless the wizard sets its own limit | `50` |
| `LIMIT_VISITOR_RUNS_PER_HOUR` | How many runs one visitor can start in an hour | `6` |
| `RESULT_TTL_DAYS` | How many days the result of a run over a wizard’s link is kept | `7` |
| `STORE_TTL_DAYS` | How many days what a wizard keeps for a person stays when nobody uses it | `400` |

The OAuth clients of the built-in connectors go here too: see [Connectors](./connectors.md).
Every setting, with what it is for, is in
[.env.example](https://github.com/engenty/wizards/blob/main/.env.example).

The command passes engenty wizards only a short list of your terminal’s variables. A key your
shell exports for another project doesn’t reach it: put it into the settings file, or enter it
in the studio.

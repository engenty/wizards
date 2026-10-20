---
title: Install
description: One command on macOS, Linux or Windows. It brings its own Node.js and asks for no password.
version: 0.9.3
---

## Install

In a terminal, on macOS or Linux (arm64 or x64):

```bash
curl -fsSL https://engenty.ai/install.sh | bash
```

On Windows 10 or 11, in PowerShell:

```powershell
irm https://engenty.ai/install.ps1 | iex
```

Or, with Node.js 20 or newer on the machine:

```bash
npx wizards
```

All three do the same. On Windows, if PowerShell refuses `npx` (“running scripts is disabled on
this system”), type `npx.cmd wizards`. `npx wizards` runs the same installer and setup, then the
`wizards` menu. Run again, it opens the installed one and updates it first if needed.

The installer needs nothing but `curl` and `tar`. On Windows it may add Microsoft’s Visual C++
runtime; Windows asks once. It brings its own Node.js (a Node you already have is left alone),
installs engenty wizards into `~/.engenty/wizards` (about 650 MB), links the `wizards` command into
`~/.local/bin` (on Windows it puts `~\.engenty\wizards\bin` on your PATH) and then walks you
through the rest:

| Step | What it does |
|---|---|
| Your engenty account | Asks “Sign in or create your account now?”. If you say yes, it shows a link and a code and opens your browser for the sign-in at account.engenty.ai; check that the page shows the same code (if you have no account yet, the page creates one with your invitation code, or puts you on the waitlist). While it waits, Enter opens the page again and Esc goes on without an account. Once you are signed in, what you publish on this computer runs in the cloud too. If you say no, `wizards account sign-in` does it any time. Setting it up again with `--local` signs an account out. `--local` leaves the account out altogether: see [Local only](./local-only.md) |
| An AI client | Looks for Codex, Claude Code, Antigravity and Cursor Agent and, if none is installed, offers to install one. `wizards setup --client <name>` adds another later. It puts first the one whose app (ChatGPT, Claude, Antigravity, Cursor) is on your Mac, as you most likely have that subscription already. You can also use your account’s credits, an API key, [Ollama](https://ollama.com) or, on a Mac with Apple silicon and macOS 26, Apple Intelligence: the studio’s [first page](./first-start.md) offers them |
| A browser and ffmpeg | Names the browser for PDF and PNG exports and steps on websites: the first of Chrome, Edge and Chromium it finds (on a Mac and on Windows also Brave). engenty wizards uses that one; [`CHROME_PATH`](./command-line.md#settings) picks another. It also says whether ffmpeg is there for MP4 videos of animated widgets, and with Homebrew it offers to install it |
| A decision model (optional) | On macOS and Linux, with 16 GB of memory, offers to install [Ollama](https://ollama.com) if it isn’t there and to download Cloudflare’s Clef-flash into it (about 11 GB). The wizards then make their decisions, such as which branch to take, on your computer, without a key or credits. Ollama may ask for your password once |
| Start at login (optional) | engenty wizards starts in the background when you log in, so links and AI apps can always reach it. It is a LaunchAgent on a Mac, a systemd user service on Linux and a scheduled task on Windows (a shortcut in the Startup folder where Windows allows no task) |
| Your AI apps (optional) | Offers to add your wizards to the [AI apps](./ai-apps.md) it finds, such as Claude Desktop, Cursor or Codex |
| The command | If `~/.local/bin` is not on your PATH, it offers to add it in your shell’s settings file |

The installer starts nothing. At the end it says whether engenty wizards is running and how to
start, stop and check it. You install once; from then on you use the `wizards` command.

## Start, stop, check

| Command | What it does |
|---|---|
| `wizards start` | Starts it and opens the studio. It runs while that terminal is open; Ctrl-C stops it |
| `wizards start -s` | Starts it in the background, so the terminal stays free |
| `wizards studio` | Opens the studio. If engenty wizards isn’t running, it starts it in the background first |
| `wizards stop` | Stops it. Your data is kept |
| `wizards status` | Shows whether it is running, and where |
| `wizards restart` | Stops it and starts it again |
| `wizards account` | Shows the account this computer is signed in to; `sign-in` and `sign-out` change it |
| `wizards` | Opens a menu with all of it |

The studio is at `http://localhost:24368/studio/`. The link the command opens signs this browser
in, and it works once. For another browser, see [`wizards open`](./command-line.md).

If the command is not found, open a new terminal or run `~/.local/bin/wizards`.

## Install it as an app

In Chrome or Edge you can install the studio as an app, with its own window and its own icon in
the Dock or taskbar. The studio offers it in a banner at the top, or you click the install icon at
the right of the address bar. In Safari on a Mac, File → Add to Dock does the same.

## Other ways to get it

| Way | For |
|---|---|
| [From source](https://github.com/engenty/wizards#from-source) | Working on the code |
| [Docker](./server.md) | A server others can reach |

## Update

engenty wizards updates itself: it looks for a new version when it starts and once a day,
downloads it in the background and checks it, and switches to it at the next start (a restart or
the next login), never while a wizard runs. The version before stays beside it. `wizards status`
and the studio then say “Updated to …” with what changed. To turn it off:

```bash
wizards autoupdate off
```

or set `WIZARDS_DISABLE_AUTOUPDATE=1` (in the terminal or in `~/.engenty/wizards/.env`). `npx wizards` never updates itself. To update now:

```bash
wizards update
```

This runs the installer again without its questions. If engenty wizards is running, `wizards
restart` then starts the new version; the command tells you so. "Update" in the `wizards` menu
restarts it into the new version by itself.

The studio also tells you in a banner at the top when a new version is out (“Version … of
engenty wizards is out.”). “Update” there installs it and starts the new version. The menu
behind the engenty mark in the app bar shows it too (“Check for updates”, “About engenty
wizards”), and so does the line at the top of Settings → Account: its version number opens the
About dialog with what is new. Your data is
brought up to date at the next start.

## Remove

```bash
wizards uninstall
```

First it shows what it will remove: your wizards in your AI apps, starting at login, everything of
engenty wizards that is running, the program in `~/.engenty/wizards` and the command
`~/.local/bin/wizards`. Your data in `~/.engenty/wizards/data` is kept unless you say to delete
it, and installing again picks it up. [Back it up](./data.md) first if you delete it. At the end
it lists anything it couldn’t remove.

If the `wizards` command is no longer on your path, `npx wizards uninstall` hands over to the
installed one.

| Option | What it does |
|---|---|
| `--dry-run` | Only shows what it would remove |
| `--yes` | Removes everything without asking and keeps your data |
| `--yes --delete-data` | Deletes your data as well |

Without a terminal, it asks for `--yes`.

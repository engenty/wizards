<p align="center">
  <img src="docs/assets/engenty.svg" width="96" alt="">
</p>

<h1 align="center">engenty wizards</h1>

<p align="center">
  Make a wish. Get your wizard.<br>
  It guides you step by step.<br>
  Let AI do the work.
</p>

## What it does

- **Describe it, get a wizard.** Say in plain words what you do again and again – a post with
  an image, a research briefing, an invoice, a quote, a damage report – and engenty builds a
  wizard for it: pages that ask what it needs, AI steps that do the work.
- **AI steps do the work.** They research the web, write, draw images, render video, read PDFs,
  scans and emails, build documents and dashboards, and write into other services over MCP, HTTP
  or a browser. Anything that changes an account asks first.
- **Share it with a link.** Anyone can run a wizard in the browser, on a phone too: camera,
  code scan, voice notes, location and a drawn signature included. Results download as PDF,
  Word, HTML, Markdown, PNG, MP4, MP3, CSV, Excel or JSON, or go out as a link.
- **Runs on your machine, on your subscription.** It uses Codex, Claude Code, Antigravity
  or Cursor Agent when one is installed and signed in, so no API key is needed. Or bring a key
  (Vercel AI Gateway, OpenAI, Anthropic), or a local model through Ollama. Your wizards and
  results stay in a folder on your machine.

## How it looks

The studio: a wizard’s steps as a flow with its branches, next to the conversation that changes them.

<p align="center">
  <img src="docs/assets/studio.png" alt="The studio of engenty wizards: the flow of a wizard that collects a month's receipts for bookkeeping – two pages of questions, AI steps that branch to the inbox and to customer portals, a review and the result – with the conversation beside it">
</p>

A wizard in use: it asks on one page, then on the next, and ends with the result to download or share.

<p align="center">
  <img src="docs/assets/wizard.png" alt="A wizard in use on a phone, three pictures: which week and how many children, what is on the table, and the finished weekly plan with PDF, PNG and sharing">
</p>

## Get started

Create an account at [engenty.ai](https://engenty.ai): it is in a closed beta, so “Get started”
takes your email for an invitation, or your invitation code. Signed in, the studio asks who
your team is, reads your website into your space, takes first documents, and you build your
first wizard in the browser. Links run day and night on the team’s credits.

## Install it on your computer

The same account on your own machine: it runs on your Claude, ChatGPT, Google AI or Cursor
subscription, reads your local files and browses for you, and what you publish keeps running in
the cloud behind the same links. On macOS or Linux, in a terminal:

```bash
curl -fsSL https://engenty.ai/install.sh | bash
```

With Node.js 20 or newer on the machine, `npx wizards` does the same.

It needs nothing but `curl` and `tar` and asks for no password. It brings its own Node.js (a
Node you already have is left alone), installs engenty wizards into `~/.engenty/wizards` and
then walks you through the rest:

- **Your engenty account.** “Sign in or create your account now?”: a link and a code, and
  the browser for the sign-in, which also creates a new account (with your invitation code); what
  you publish on this computer then runs in the cloud too. Esc while it waits, or say no, and
  `wizards account sign-in` does it any time.
  `--local` leaves the account out: nothing leaves the computer, links answer on it only
  ([local only](https://engenty.ai/docs/user/local-only)).
- **An AI client.** It looks for Codex, Claude Code, Antigravity and Cursor Agent and
  offers to install the missing ones – first the one whose app (Claude, ChatGPT, Cursor) is
  on your Mac, as its subscription is most likely yours already. The first page of the studio
  installs them too. Or use your account’s credits, an API key, [Ollama](https://ollama.com) or,
  on a Mac with Apple silicon and macOS 26, Apple Intelligence.
- **A browser and ffmpeg** (optional): Chrome, Edge or Chromium (on a Mac also Brave) for PDF
  and PNG exports and for steps that use a browser, ffmpeg for MP4 videos of animated widgets.
- **Start at login** (optional): engenty wizards starts in the background when you log in (a
  LaunchAgent on a Mac, a systemd user service on Linux). Links and AI clients then always
  reach it. `wizards autostart on` or `off` switches it later.
- **Your AI apps** (optional): adds your wizards to the AI apps it finds, such as Claude
  Desktop, Cursor or Codex. `wizards connect` and `wizards disconnect` do it later.

It starts nothing. Afterwards:

```bash
wizards start
```

starts it and opens the studio; it runs while that terminal is open, Ctrl-C stops it.
`wizards start -s` starts it in the background instead.
`wizards` opens a menu with all of it, `wizards status` says what is installed and what runs,
`wizards setup` runs the guided setup again, and `wizards --help` lists the rest.

**Install it as an app.** In Chrome or Edge the studio installs as an app: its own window, its
own icon in the Dock or taskbar. The studio offers it in a banner at the top; or click the install
icon at the right of the address bar.

### From source

You need Node.js 24.11 or newer and pnpm 10 (`corepack enable`).

```bash
git clone https://github.com/engenty/wizards.git
cd wizards
pnpm install
pnpm build
pnpm wizards
```

pnpm may list “Ignored build scripts” – that’s expected, nothing to do.

Code steps (shell, Node, Python) run in a sandbox when Docker and the sandbox image are on the
machine; a checkout brings its own sandbox, the installed version has none yet.

## First start

The setup shows your account at the top and asks how the AI should run. Pick an AI
client that is installed on your computer – engenty uses your existing subscription and signs
it in for you in a terminal right on the page – your account’s credits, Apple Intelligence on a
Mac that has it, or your own keys.
It stays until a test call works, then the studio opens.

Change it later under Settings → Models.

## Using it

- **Make a wizard:** describe it in the studio’s chat, or start from one of the templates.
  You see the steps as a diagram and can change any of them.
- **Run and share:** try it yourself, then share the link. Shared results are kept for 7 days
  for people without an account.
- **Connect services:** Gmail, Google Drive, Calendar, Contacts, Outlook, OneDrive, Slack,
  GitHub, HubSpot and S3 are built in; any other service can be added from its API description
  or MCP server through the [integrations.sh](https://integrations.sh) registry. Services that
  sign in with OAuth need a few settings first: [Connectors](docs/development.md#connectors).
- **Build from Claude Code or Codex:** Settings → Integrate adds engenty wizards to your AI
  apps (Claude Desktop, Claude Code, Codex, Cursor and others), or `wizards connect` from a
  terminal.

Your machine only answers on `localhost`. To let others open shared wizards, run it on a server.

## Your data

Everything lives in `~/.engenty/wizards/data`: the databases and the files of your wizards and
results. Keys you enter are kept in the Keychain on a Mac, elsewhere encrypted in that folder.
Back up the folder; delete it to start over. Settings go into `~/.engenty/wizards/.env` (see [.env.example](.env.example));
`ENGENTY_HOME` moves the whole install.

`pnpm start` in a checkout keeps its data in the `data` folder next to the code instead.

## Update

```bash
wizards update
```

This runs the installer again without its questions. The studio says in a banner at the top
when a newer release is out and can run the same update from there or from its About dialog.
From source: `git pull`, `pnpm install`, `pnpm build`. Your data is brought up to date at the
next start.

To remove engenty wizards, run `wizards uninstall` (or `npx wizards uninstall` if the command no
longer runs). It shows what it will remove first: your AI apps' entries, the login item, every
running process, `~/.engenty/wizards` and `~/.local/bin/wizards`. Your data in
`~/.engenty/wizards/data` is kept unless you choose to delete it, and a reinstall picks it up
again. `--dry-run` only shows the plan, `--yes` runs it without questions and keeps your data,
and `--yes --delete-data` deletes your data too.

## Run it on a server

With Docker, behind an https proxy (Caddy, Traefik, Coolify):

```bash
git clone https://github.com/engenty/wizards.git
cd wizards
cp .env.example .env    # set APP_URL to your https address and add a model key
docker compose up -d --build
docker compose logs     # shows the link to open once
```

Point the proxy at port 8891. On a server, engenty uses your keys or Ollama; the
AI clients’ subscriptions live on your own computer. The code sandbox is off in this image.

## Troubleshooting

| | |
|---|---|
| “This link is no longer valid” | The link works once. `wizards open` gives this browser a new one. |
| `wizards`: command not found | Open a new terminal, or run `~/.local/bin/wizards`. |
| You open it under another address | Set `APP_URL` in `~/.engenty/wizards/.env` to the address you open. |
| An AI client shows as not signed in | Sign it in on the setup page, or in your own terminal (e.g. `claude`, `codex login`), then “Check again”. |
| PDF or PNG export fails | Install Chrome, Edge or Chromium (on a Mac also Brave), or set `CHROME_PATH` to one. |
| Port 24368 is taken | The next free port is used. To fix one, set `API_PORT` in `~/.engenty/wizards/.env`. |
| Something else | `wizards doctor` checks the install. |

More settings: [.env.example](.env.example).

## For developers

Development server, checks, how it is built, the managed mode:
[docs/development.md](docs/development.md).

Plugins add tools for steps, routes with their own tables and pages in the studio, without
changing the runtime: [docs/content/dev/plugins](docs/content/dev/plugins/index.md).

The documentation – a user guide and the developer docs – is in [docs/content](docs/content)
and is a site of its own: `pnpm dev:docs`.

## License

[FSL-1.1-MIT](LICENSE): use it for yourself and your company, run it, change it – just don’t
offer it to others as a competing product or service. Each release becomes MIT two years
after it is published. [COPYRIGHTS.md](COPYRIGHTS.md) names the owner, the marks, what is not ours and the
third-party software with its licences.

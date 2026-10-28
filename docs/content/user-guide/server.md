---
title: Run it on a server
description: One Docker container behind an https proxy, so others can open your wizards' links.
version: 0.11.13
---

engenty wizards on your computer answers on `localhost` only. On a server with a public address,
anyone with a link can run your wizards.

## Start it

You need Docker and an https proxy in front, such as Caddy or Traefik.

```bash
git clone https://github.com/engenty/wizards.git
cd wizards
cp .env.example .env
```

In `.env`, set `APP_URL` to your https address (the container doesn’t start without it) and add
a model key. Then:

```bash
docker compose up -d --build
docker compose logs
```

The logs show a link (“Open the studio: …”). Open it once: it signs your browser in.

## What to know

| | |
|---|---|
| Port | Point the proxy at port 8891 |
| Data | Databases and files are on the `/data` volume. Back that volume up |
| Models | Your own API keys or Ollama (see below). The subscriptions of AI clients live on your own computer, not on a server |
| PDF, PNG, browser steps, MP4 | Chromium and ffmpeg are in the image |
| Code & shell | The sandbox is off in this image, so steps can’t use that tool. `compose.yaml` shows how to switch it on: with Docker, or with agentOS built into the image |
| Plugins | Put them in a folder that you mount into the container and name in `PLUGINS_DIR` |

## Models on the server

`compose.yaml` holds an Ollama service that is off by default. It comes without models. To use it,
add a line to `.env`:

```bash
COMPOSE_PROFILES=ollama
```

Then run `docker compose up -d --build` again. In the studio, Settings › Models › Search offers to
download EmbeddingGemma 2 (about 1.3 GB). The model goes to the `ollama-models` volume, so it stays
when you update. Only engenty wizards reaches this Ollama; it has no port of its own.

## Update

```bash
git pull
docker compose up -d --build
```

Your data is brought up to date when the container starts.

## Sign in again

The link works once. For a new one, restart the container and read the logs again.

---
title: Local only
description: engenty wizards on your computer without an account. Nothing leaves your computer, and links work only there. The flag, what it means, and how to connect an account later.
version: 0.5.0
---

During the setup, engenty wizards on your computer normally signs in to your account. What you
publish then runs in the cloud too. You can also keep it on your computer alone.

## The flag

```bash
curl -fsSL https://engenty.ai/install.sh | bash -s -- --local
```

`--local` skips the account step of the setup and switches the account off on this computer.
If engenty wizards is already installed, run `wizards setup --local`.

## What it means

- There is no account, and nothing leaves this computer. Your wizards, your space and results
  stay in `~/.engenty/wizards/data` ([Your data](./data.md)).
- Links work on this computer only: `http://localhost:24368/w/…`. If others should open them,
  run engenty wizards [on a server](./server.md) of your own.
- It runs on your AI clients, your own API keys, Ollama or Apple Intelligence
  ([First start](./first-start.md)). Without an account, video and voice need your own API key.
- The studio shows nothing about an account: no sign-in, no credits, no copy in the cloud. The
  feature switch `account` is off in the `.features` file in `~/.engenty/wizards`, and
  `wizards features` lists it.
- `wizards status` and the `wizards` menu say “only on this computer, no account”.

## Connect an account later

```bash
wizards account sign-in
```

The command shows a link and a code and opens your browser for the sign-in. After that,
engenty wizards is connected to the account and the switch is on again. `wizards account` shows
where it stands, and `wizards account sign-out` disconnects it. As long as the account is
switched off, the studio offers no sign-in, so you use the command. Once you are connected,
Settings → Account in the studio shows the account and can sign you out too.

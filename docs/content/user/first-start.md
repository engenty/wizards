---
title: First start
description: Choose how the AI runs on your computer. The studio opens once a test call works.
version: 0.5.0
---

The first page of the studio on your computer is the setup, “Choose how the AI runs”. It asks
one thing: what should engenty wizards run on?

## Your account

Your account stands above the choices. If you signed in during the [install](./install.md), it
shows your name, your team and your credits. If you aren’t signed in yet, “Your engenty account”
has a “Sign in” button that opens your browser for it. If you set engenty wizards up
[only for this computer](./local-only.md), the page shows nothing here.

## Choose how the AI runs

| Choice | Runs on | Needs |
|---|---|---|
| engenty credits | Your account’s credits, as in the cloud | An account signed in. Shown only then |
| Claude Code | Your Claude subscription | The client installed and signed in |
| Codex | Your ChatGPT subscription | The client installed and signed in |
| Antigravity | Your Google AI subscription | The client (`agy`) installed and signed in |
| Cursor Agent | Your Cursor subscription | The client installed and signed in |
| Apple Intelligence | The model on this Mac, without an account or the internet | A Mac with Apple silicon on macOS 26 or later, with Apple Intelligence switched on. Shown only on such a Mac |
| Your own keys | OpenAI, Anthropic, Google or Vercel AI Gateway, or a model on your computer | One API key, or [Ollama](https://ollama.com) running |

- **An AI client that is not installed** installs right on the page, in a terminal shown there.
  It takes about a minute.
- **Signing in** happens in the same terminal, with the client’s own sign-in. Your browser opens
  for it, and the terminal closes once you are signed in.
- **A client signed in with an API key from your shell** does not run on your subscription.
  Click “Sign in here” on the page to change that.
- **Apple Intelligence** has nothing to connect: the test runs once it is switched on (System
  Settings → Apple Intelligence & Siri). It handles short texts and decisions on this Mac.
  Research, long documents and code stay with a client you chose before it, or you add another
  option for them later under Settings → Models. See [Apple Intelligence](./models.md#apple-intelligence).

## The test

After you connect, one short call checks that the model can be reached. The setup stays until
that call works. Then “Open the studio” takes you in.

With your own keys, each key has its own Test. It checks the key with the provider, stores it in
this computer’s keychain and sets that provider’s models for what no other key covers yet. One
key that works is enough. Which model does which job you change later under
[Settings → Models](./models.md).

## What an AI client does not cover

An installed AI client writes and reasons. Codex also makes images on your sign-in; with the
other clients, images need a key. Video and audio need a key with every client, or the credits
of an engenty account. A Mac with Apple silicon on macOS 26 can write down voice notes by itself.
One Vercel AI Gateway key covers text, images, video and web search. You can add it later under
[Models and account](./models.md).

## Change it later

You change it under Settings → Models. See [Models and account](./models.md).

---
title: Troubleshooting
description: What to do when a link no longer works, a client shows as not signed in, or an export fails.
version: 0.5.0
---

`wizards doctor` checks engenty wizards on your computer and says what is wrong. Start there.

## Starting and signing in

| What you see | What to do |
|---|---|
| “This link is no longer valid. Run wizards open to get a new one.” | The link works once. `wizards open` gives this browser a new one |
| “engenty wizards isn’t answering” | It has stopped or is restarting. `wizards status` says whether it is running; `wizards start` starts it |
| `wizards`: command not found | Open a new terminal, or run `~/.local/bin/wizards` |
| “This browser isn’t signed in” | The browser has no sign-in for engenty wizards on this computer, for example after you cleared cookies. Run `wizards open` |
| “The studio runs at another address” | Open the address the page names, or set `APP_URL` in `~/.engenty/wizards/.env` to the address you open |
| Port 24368 is taken | engenty wizards uses the next free port. To fix the port, set `API_PORT` in `~/.engenty/wizards/.env` |

## Models

| What you see | What to do |
|---|---|
| An AI client shows as not signed in | Sign it in on the setup page or under Settings → Models, or in your own terminal (`claude`, `codex login`). Then click “Check again” |
| “Signed in with an API key from your shell, not the subscription.” | The client runs on that key, not on your subscription. “Sign in here” switches it |
| “The test didn’t work” | The message names the reason. Check the key, or sign the client in again |
| “Models are missing” in the editor | A step needs a model that isn’t set up here, often for video or audio. Add a key under Settings → Models |
| A template says “Not set up here” | It is the same: the template needs a model that isn’t set up |
| No Apple Intelligence in the setup or under Models | It needs a Mac with Apple silicon on macOS 26 or later. It is offered on your computer only, not on engenty.ai |
| Apple Intelligence “switched off” or “Apple is still loading the model” | Switch it on under System Settings → Apple Intelligence & Siri, or wait until the Mac has the model. The studio checks again after a minute |
| A step on Apple Intelligence fails because the text is too long | The model takes 4,096 tokens for prompt and answer together. Give the step the class High, or choose another model for its class under Settings → Models. See [Apple Intelligence](./models.md#apple-intelligence) |
| A voice note the Mac writes down fails in Chrome or Firefox | Their recordings need ffmpeg on the Mac: install it, or set `FFMPEG_PATH` |

## Running wizards

| What you see | What to do |
|---|---|
| PDF or PNG export, or a step on a website, fails | `wizards doctor` names the browser engenty wizards uses. Install Chrome, Edge or Chromium (on a Mac also Brave), or set `CHROME_PATH` to one; see [Settings](./command-line.md#settings) |
| A widget offers no video | Install ffmpeg, or set `FFMPEG_PATH` |
| “This wizard isn’t available right now.” | The link is switched off, or the account the wizard runs on has no credits left. See [Test and share](./test-and-share.md) |
| “This wizard has reached its limit for today. Try again tomorrow.” | The link’s runs for the day are used up; the day starts at midnight UTC. Raise “Limit per day” under Settings (the gear) in the share dialog |
| “You’ve started a lot of runs just now. Try again in an hour.” | One visitor started more runs in an hour than the link allows (`LIMIT_VISITOR_RUNS_PER_HOUR`, see [Settings](./command-line.md#settings)) |
| “This wizard doesn’t exist or was deleted.” | It is not published, or its link was replaced by a new one |
| Others can’t open the link | engenty wizards on your computer answers on `localhost` only. See [who can open the link](./test-and-share.md#who-can-open-the-link) |
| The chat has no phone button, or “Join” stays grey | A live conversation needs “Live voice” or “Video call” switched on for the wizard (see [Channels](./test-and-share.md#channels); your own test run always has it) and an OpenAI API key under Settings → Models |
| The camera, microphone or location doesn’t work | Allow it in the browser’s site settings (the lock icon in the address bar) |
| A connector says “not set up” | engenty wizards needs an OAuth client for it. See [Connectors](./connectors.md) |
| A step stops at a plugin’s tool | That plugin is not installed here. See [Plugins](./plugins.md) |

## Updating

| What you see | What to do |
|---|---|
| “The update failed. Details are in logs/update.log.” | The reason is in `~/.engenty/wizards/logs/update.log`. Run `wizards update` in a terminal to see it as it happens |
| A template says “Needs a newer version” | Update with `wizards update` |

## Still stuck

`wizards logs` shows the last lines engenty wizards printed, with keys and tokens taken out. Open
an issue at [github.com/engenty/wizards](https://github.com/engenty/wizards/issues) with what
`wizards doctor` prints and the lines that matter.

If this computer is signed in to an [account](./models.md#account), `wizards report` sends the
status, the model settings (never a key) and the last 500 log lines to engenty. It names the
report’s ID: give that ID when you ask for help. Nothing is sent unless you run the command. If
this computer isn’t signed in, the command tells you so: sign in under Settings → Account or with
`wizards account sign-in`.

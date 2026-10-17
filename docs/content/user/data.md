---
title: Your data
description: Where wizards, results, files and keys are kept, how to back them up and how to start over.
version: 0.5.0
---

## Where it is

Everything engenty wizards keeps on your computer is in one folder:

```bash
~/.engenty/wizards/data
```

| In it | What |
|---|---|
| Databases | Your wizards, their versions, runs and results (a run from a website tag also keeps the page it was started on); what wizards keep for people |
| Files | Uploads, generated media, documents, the files of each wizard |
| A secret | Signs the studio’s sign-in and its links, and encrypts what is stored encrypted |

On a Mac, the API keys you enter in the studio and the sign-in of your account are kept in the
Keychain (as `engenty-wizards`). On other systems they are stored encrypted in the data folder.

## Back up, move, start over

| To | Do |
|---|---|
| Back up | Stop engenty wizards (`wizards stop`) and copy the folder |
| Move to another computer | Install engenty wizards there, stop it and put the folder in place. On a Mac, enter your API keys and sign in to your account again: the Keychain doesn’t move |
| Start over | Run `wizards uninstall`, choose to delete your data, then install again. On a Mac, the keys in the Keychain stay and are used again. To remove them, delete the `engenty-wizards` entries in Keychain Access |
| Keep it elsewhere | Set `ENGENTY_HOME` to another folder. engenty wizards then keeps everything in its `wizards` folder there |

After an update, engenty wizards brings your data up to date the next time it starts.

## What leaves your computer

- **Model calls** go to whatever the models run on: your AI client’s provider, the provider of
  your API key, or your engenty account. With Ollama, or Apple Intelligence on a Mac, they stay
  on your computer.
- **Steps that use the web** send what they search for, open or call.
- **Connected services** get what a wizard’s actions send them.
- **Published wizards**, with an account signed in: when you publish, engenty.ai receives the
  published version and its files, the space’s name, title, “About”, colours, facts and main
  logo, and the space’s own tables and pages ([Test and share](./test-and-share.md#in-the-cloud)).
  Documents, drafts, runs and connected accounts stay on your computer.
- **Templates** come from the marketplace at engenty.ai. `MARKETPLACE_URL=off` in the settings
  file turns that off.
- **The update check** asks GitHub for the newest release.
- **The studio’s typefaces** are loaded by your browser from Google Fonts.
- **A location** is sent to a geocoder only if you set one up (`GEOCODER_URL`). Without one, it
  stays coordinates.
- **`wizards report`** sends the status, the model settings (never a key) and log lines to your
  account, and only when you run it.

Without an account, your wizards, the space and its files stay on your computer.

## How long things are kept

| What | How long |
|---|---|
| Your wizards and your test runs | Until you delete them |
| A real run of a published wizard (over its link or from an AI app), its result and the result’s shared link | 7 days |
| What a wizard keeps for a person: lists, files, connected accounts, sign-ins | Until they delete it, or 400 days after its last use |
| The space’s tables and pages, and what wizards keep for every run: shared lists, pages | Until you delete them, or the wizard they belong to |

Connected accounts and remembered sign-ins are stored encrypted.

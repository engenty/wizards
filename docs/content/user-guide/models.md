---
title: Models and account
description: What runs the AI in your wizards – an AI client on your computer, your own API keys, a local model or credits.
version: 0.12.2
---

Settings → Models decides what runs the AI in your wizards. On your computer you set it up
yourself. On engenty.ai the organization’s admins set it in the studio there, for everyone in it.

## Overview

The page opens on “Overview”. Its card says what everything “Runs with” – your subscription, your
own API key, a model on this computer or your engenty credits – and what it is “Helped by”. In the
cloud it names the organization’s plan and, on a plan with tiers, the [tier](#which-models).

Below that, “Which model for what” lists each job with a dot for its state: green when it is
ready, amber when something is missing, hollow when the tier doesn’t offer it. The menu beside
the page has the same jobs in two groups:

| Group | Job | Used for | Classes |
|---|---|---|---|
| In the studio | Studio chat (Goose) | Goose and the chat in the editor that builds your wizards | Its own, see [Studio chat](#studio-chat-goose) |
| Agents & wizards | Text & reasoning | Writing, research, decisions and knowledge search in the steps | Classifier, Low, Standard, High |
| Agents & wizards | Images & video | Logos, product shots, illustrations, short clips | Image, Video |
| Agents & wizards | Voice | Reading text aloud, turning voice notes into text | Speech, Audio |

“Access” lists what engenty can use: Credits, AI apps, Local models and API keys, and in the cloud
Masking for the admins. On engenty.ai a member sees Credits and API keys; AI apps and local models
are the admins’ choice there.

A job’s page asks “Who does it?”:

| Choice | What it is | Cost |
|---|---|---|
| Your subscription | Claude Code, Codex, Antigravity or Cursor Agent on this computer, using your sign-in there (text; Codex also makes images; Antigravity runs steps without their tools) | Your subscription |
| Your own API key | OpenAI, Anthropic, Google Gemini, fal.ai, ElevenLabs, Replicate or Vercel AI Gateway | The provider bills your key |
| Apple Intelligence | The model on this Mac: short texts and decisions (Classifier, Standard) and voice notes. See [Apple Intelligence](#apple-intelligence) | Nothing |
| Local model | [Ollama](https://ollama.com) on this computer: text, search and decisions. See [Local models](#local-models) | Nothing |
| engenty credits | Your account’s credits. Auto picks the model, or you choose one it offers (FLUX on fal, ElevenLabs voices, Veo …) | Credits |

Below that you choose the provider’s model, and “Try it” makes one real call: a short answer, a
test image, a voice to hear, a 4-second clip or a transcript. A try costs the same as a real call.

With an account, credits step in where you have nothing of your own set up – for example,
videos without your own API key. The switch “Credits step in” on the page “Credits” turns that
off. A job with nothing of its own set up then doesn’t run.

## Local models

Text & reasoning, Search and Decisions each have a part “Local model”. It lists:

- **On this computer:** the models Ollama holds that can do this job, with their size and what
  else they read (images, sound) or can do (tools). “Use” picks one; the bin removes it from
  Ollama.
- **To download:** the models engenty suggests for the job, with their size. The first one that
  fits your computer’s memory is marked “suggested”. “Download and use” loads it into Ollama
  and picks it.
- **Another model from Ollama:** any name from [Ollama’s library](https://ollama.com/library),
  such as `llama3.2:3b`. It is downloaded if Ollama doesn’t have it yet.

On a Mac with Apple silicon, Ollama 0.40 and later runs the models that come as MLX on Apple’s
MLX. Where Ollama isn’t running, the part offers to start it, and on a Mac to install it.

“Ollama” under “Access” shows Ollama on its own: whether it runs, every model it holds with the
jobs it serves, the models to download for all jobs, and Ollama’s address. A model a job uses
can’t be removed there; pick another one on that job’s page first.

## Apple Intelligence

On a Mac with Apple silicon and macOS 26 or later, the [setup](./first-start.md) and “Text &
reasoning” offer Apple Intelligence: the model Apple keeps on the Mac. It is there on your
computer only, not on engenty.ai. Nothing leaves the Mac, you don’t sign in and you pay nothing.
It needs Apple Intelligence switched on (System Settings → Apple Intelligence & Siri). Until
then, the choice says why it can’t be used yet: “switched off” or “Apple is still loading the
model”.

The model is small. It reads at most 4,096 tokens for a prompt and its answer together, and it
uses no tools. So it takes only the classes Classifier and Low: decisions, picking values
out of text and short copy. A step of these classes runs there without its tools (no API calls,
no web, no lists or documents). A step whose text is too long fails with a note that says so.
Give such a step the class Standard, or choose something else for the class.

Standard and High keep what they ran on before. The page names it under the choice. If you later
choose something else for text, Classifier and Low leave Apple Intelligence again.

“Voice notes” offers Apple Intelligence on the same Macs, even with Apple Intelligence switched
off. The Mac writes a recording down itself, in the language of the run, and it costs nothing. The
first note in a language waits while Apple downloads that language. A recording from Chrome or
Firefox (WebM, Ogg) needs ffmpeg on the Mac, which turns it into WAV first. Recordings from Safari
need nothing. Without ffmpeg, the page “Voice notes” says so.

## Keys

engenty wizards checks a key with its provider before it stores it. On your computer, keys stay
in the Keychain on a Mac and in an encrypted file in the data folder elsewhere. On engenty.ai
they are kept encrypted for the organization. They are never in the database, and nobody sees them again.

“API keys” under “Access” lists each key there is, masked to its prefix and last four characters (`sk-…a1b2`), with
where it comes from: kept in the studio, or an environment variable on this computer. The other
providers are under “More providers”. A provider’s page holds its key, what it is used for, and
which of its models run on credits without your own API key. What runs on a key costs no credits.

On engenty.ai, own API keys need a plan that has them: from Pro. The tier doesn’t forbid them.
The admins choose whether the organization uses them, and then the provider handles the data
under your contract with it, not under the tier’s promises. Without own keys, runs use the
organization’s credits.

Vercel refuses many models for an AI Gateway key on its free tier. The Models page and the check
before a run say so, with a link to top up at Vercel.

| Provider | Serves |
|---|---|
| OpenAI | Text, images, voice, transcripts |
| Anthropic | Text |
| Google Gemini | Text, images, video (Veo), voice, voice notes |
| fal.ai | Images (FLUX, Recraft, Imagen), video (Veo, Luma, MiniMax), voice, transcripts |
| ElevenLabs | Voices, transcripts (Scribe) |
| Replicate | Images, video |
| Vercel AI Gateway | Many providers’ models with one key, web search |

## Model per class

A step names a class, never a model. In the editor you choose a step’s model by name: “Auto” (the
right one for each task) or a model of the list, with a hint such as “fast · low cost” or
“thorough”. The step keeps the class, with the model’s maker where you chose one, so it follows
when a newer model takes the class. For text, “Adjust per class” sets the model of each class.
Under each class the page shows what its model needs at least, and warns when the chosen model
lacks some of it:

| Class | Used for | Needs at least |
|---|---|---|
| Classifier | Decisions, picking values out of text | JSON output, 32k tokens of context |
| Low | Short copy, API calls | Tool calls, JSON output, image input, 64k tokens of context |
| Standard | Research, long documents; Goose | Tool calls, JSON output, image input, 128k tokens of context |
| High | Hard reasoning, code; the assistant in the editor | Tool calls, JSON output, image input, reasoning, 200k tokens of context |

What a model can do comes from the AI Gateway’s model list; a model that list doesn’t know isn’t
checked. Goose and the assistant in the editor can’t work without tool calls: the page doesn’t
save a model without them for Standard or High.

With an AI Gateway key, the classes start on low-cost models: DeepSeek V4.1 Flash for Classifier,
Low and Standard, Kimi K3 for High.

You write a model as `vendor/model` for the AI Gateway, with the provider in front for the others
(`openai:gpt-5.4-mini`, `fal:fal-ai/flux/schnell`, `ollama:qwen3`), or as `credits` /
`credits:<model>` for the credits.

Some decisions go to a decision model, Jev, wherever one can be reached: decisions in a wizard (a
branch with a statement, a field shown when the AI finds a statement true) and the check of what
a Knowledge search found. Jev is reached through an AI Gateway key, a TypeSafe key
(`TYPESAFE_API_KEY` in the settings file), the Clef-flash model in Ollama on this computer, or
your account. Without any of them, the Classifier class decides.

## Studio chat (Goose)

“In the studio” holds **Studio chat (Goose)**: what answers Goose and the editor’s chat that builds
your wizards. “Agents & wizards” holds what your wizards’ steps use.

| Choice | Means |
|---|---|
| Your subscription: Claude Code, Codex, Cursor Agent | The program on this computer answers, using your sign-in there. It works only through the tools of engenty wizards: it runs no commands and changes no files of its own |
| Your own API key: OpenAI, Anthropic, Google Gemini, Vercel AI Gateway | A model of that provider answers, on your key |
| engenty credits | The credits pay, through your account. Auto picks the models |

The list shows each program that is installed and signed in. Without a choice, Claude Code answers
where it is the source of your models, else the first way that is ready. With none ready, the chat
says what to set up. The chat has its own models, apart from Text & reasoning.

Under the choice, **Model** is what answers everyday questions and **Extra effort** is the more
capable one. Both default to the newest model of the way, which the runtime asks the server for
every day, so a new model needs no update. Pick another from the list, or **Another model …** to
type any name.

In a message box’s **+** menu, **Extra effort** switches the chat to the more capable model for the
conversation. The editor chat starts with it on, Goose with it off. When Goose sees demanding work,
it offers a button under its answer.

In the cloud, the organization’s credits pay and Auto picks the models from the tier. Where the
admins allow it, members can answer the chat with their own subscription (“AI apps”: Claude Code,
Codex, Cursor) or a model on their computer (“Local models”: Ollama, Apple). These serve the
studio chat only; agents and wizards never run on them. What the chat reads then goes to the
subscription’s provider under its terms; a local model keeps it on the computer.

## Which models

On engenty.ai, an organization on Pro or Team has a model tier. Its admins choose it under
“Which models”, and it applies to everyone in the organization, in the studio and in every agent
and wizard.

| Tier | What it promises | Plans |
|---|---|---|
| All models | The best models worldwide. Providers process data on their own terms | Pro, Team |
| EU data protection | Models in EU data centres. Providers store nothing and don’t train on what they get | Pro, Team |
| EU sovereign | EU companies and EU servers only, open models. Less choice | Team |

An organization that hasn’t picked a tier, and one on Free, runs on All models. A tier set by
contract shows “Your organization’s contract sets this.” The tier’s page lists what it promises
(“Runs in the EU”, “Providers keep no data”, “Never used for training”) and what each class runs
on. A class the tier doesn’t offer shows “Not offered”, and a step that needs it counts as missing
a model. Web search can be off on a tier; steps that search the
web then run without it.

Own API keys and members’ subscriptions are allowed on every tier, as the admins’ choice. The
page says where the data then goes: to that provider, under its own terms or your contract, not
under the tier’s promises. Apps that read a space over MCP stay off on a tier whose providers
keep no data.

The account’s billing pages show which models and providers the organization’s calls went to
and the sub-processors of each tier.

## Model choice

“Model choice” sets how the admins share out the tier, for wizards, Goose and work chats. Running
work finishes as it started.

| Way | Means |
|---|---|
| Preselection | People choose from the tier’s preselection: Auto and a few models that fit best. New models join on their own |
| You set defaults | A default per task. People switch to any model in the tier, up to the effort you allow |
| Expert mode | The admins decide which models people choose from, separately for wizards, Goose and work chats, with the efforts they allow. New models join only when they approve them |

The model menus in the editor and in Goose’s message box offer what the way allows.

## Masking

In an organization with a tier, the admins can switch on “Mask personal data”. Then names, email addresses, phone numbers, IBANs and IDs become
placeholders before a call leaves engenty, and come back in the answer. A placeholder stays the
same within a run, so the model can still tell people apart. Each call that had something to
mask costs credits on top.

Under “What else to mask” the admins say in a sentence what else to look for, such as “Mask our
clients’ names, internal code names and anything about employees’ health.” engenty turns it into
things to look for (“Looks for”), in every call of the organization. They can remove one or add
their own: in English, as a plain word for what the thing is (“company” finds more than “customer
name”). “Try a sentence” shows what the model would see.

Not masked yet: decisions answered by the decision model, knowledge search, voice (what is read
aloud and voice notes) and files sent as they are, such as images and PDFs.

## Account

engenty wizards on your computer normally signs in to your account during the setup
([Install](./install.md)). If you set it up without an account, it stays
[on your computer only](./local-only.md). With an account you can

- use credits instead of your own API keys (where text, image or video models are missing, the
  editor’s note about them says so),
- publish wizards to the cloud, where their links work while your computer is off
  ([Test and share](./test-and-share.md#in-the-cloud)),
- connect Gmail, Drive, Calendar and Contacts without a Google client of your own
  ([Connectors](./connectors.md)).

You sign in under Settings → Account, which opens your browser. In a terminal,
`wizards account sign-in` does the same. A new account needs an invitation code: enter it under
“No account yet?”, and “Create account” opens the sign-up with the code filled in
([Create an account](./create-account.md)). An account starts with credits. Some of them expire
on a set date, which the settings show. Runs in the cloud are paid from the account’s credits.
They stop when the credits are used up, until you top up.

While you are signed in, the studio uses the name and email of your account. Settings → Account
shows them under “Profile”, and you can’t change them there. The avatar carries a small cloud.
Its menu says “Connected to engenty.ai” and shows your credits, or says “Sign-in expired” when
you need to sign in again. In the studio on engenty.ai, Settings → General shows the
organization’s credits with its plan, and Settings → Credits their entries.

Without an account, engenty wizards isn’t connected to anything. Your wizards, the space and its
files stay on your computer.

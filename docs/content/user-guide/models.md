---
title: Models and account
description: What runs the AI in your wizards – an AI client on your computer, your own API keys, a local model or credits.
version: 0.11.13
---

Settings → Models decides what runs the AI in your wizards. On your computer you set it up
yourself. On engenty.ai you set it in the studio there.

## What the wizards can do

The menu lists five capabilities under “Capabilities”. A dot beside each one shows how it runs:
green on something of your own, amber on credits, hollow when nothing is set up.

| Capability | Used for | Classes |
|---|---|---|
| Text & reasoning | Writing, research and decisions in the steps | Classifier, Low, Standard, High |
| Images | Logos, product shots, illustrations | Image |
| Videos | Short clips from text or an image | Video |
| Voice | Reading text aloud | Speech |
| Voice notes | Turning speech into text | Audio |

A capability’s page asks “Who does it?”:

| Choice | What it is | Cost |
|---|---|---|
| Your subscription | Claude Code, Codex, Antigravity or Cursor Agent on this computer, using your sign-in there (text; Codex also makes images; Antigravity runs steps without their tools) | Your subscription |
| Your own API key | OpenAI, Anthropic, Google Gemini, fal.ai, ElevenLabs, Replicate or Vercel AI Gateway | The provider bills your key |
| Apple Intelligence | The model on this Mac: short texts and decisions (Classifier, Standard) and voice notes. See [Apple Intelligence](#apple-intelligence) | Nothing |
| Local model | [Ollama](https://ollama.com) on this computer: text, search and decisions. See [Local models](#local-models) | Nothing |
| engenty credits | Your account’s credits. engenty chooses the model, or you choose one it offers (FLUX on fal, ElevenLabs voices, Veo …) | Credits |

Below that you choose the provider’s model, and “Try it” makes one real call: a short answer, a
test image, a voice to hear, a 4-second clip or a transcript. A try costs the same as a real call.

With an account, credits step in where you have nothing of your own set up – for example,
videos without your own API key. The switch “Credits step in” on the page “engenty credits” turns
that off. A capability with nothing of its own set up then doesn’t run.

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

Under “Access” you find the credits, the AI clients on this computer and each provider you gave
a key. The other providers are under “More providers”. A provider’s page holds its key, what it
is used for, and which of its models run on credits without your own API key.

On engenty.ai, your own API keys come with the Pro plan. Without them, runs use the organization’s
credits.

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

A step names a class, never a model. For text, “Adjust per class” sets the model of each class.
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

## Agent chat

Settings → Models has two groups. “In the studio” holds **Agent chat**: what answers Goose and the
editor’s chat that builds your wizards. “In runs” holds what your wizards’ steps use: text,
images, video, voice and voice notes.

| Choice | Means |
|---|---|
| Your subscription: Claude Code, Codex, Cursor Agent | The program on this computer answers, using your sign-in there. It works only through the tools of engenty wizards: it runs no commands and changes no files of its own |
| Your own API key: OpenAI, Anthropic, Google Gemini, Vercel AI Gateway | A model of that provider answers, on your key |
| engenty credits | The credits pay, through your account. engenty picks the models |

The list shows each program that is installed and signed in. Without a choice, Claude Code answers
where it is the source of your models, else the first way that is ready. With none ready, the chat
says what to set up. The chat has its own models, apart from Text & reasoning.

Under the choice, **Model** is what answers everyday questions and **Extra effort** is the more
capable one. Both default to the newest model of the way, which the runtime asks the server for
every day, so a new model needs no update. Pick another from the list, or **Another model …** to
type any name.

In a message box’s **+** menu, **Extra effort** switches the chat to the more capable model for the
conversation. The editor chat starts with it on, Goose with it off. When Goose sees demanding work,
it offers a button under its answer. In the cloud, the organization’s credits pay and engenty picks
the models.

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
you need to sign in again.

Without an account, engenty wizards isn’t connected to anything. Your wizards, the space and its
files stay on your computer.

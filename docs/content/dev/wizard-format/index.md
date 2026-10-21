---
title: The wizard format
description: A wizard as one JSON document, what its keys mean, and where each part is described.
version: 0.9.6
---

A wizard is one JSON document, its **definition**. The studio exports it as a `.wizard` file
and imports one back. You can write either by hand or with a tool, check it in your editor
against its [JSON Schema](#json-schema), and check it completely with `wizards validate`.

The code that defines the format and checks it is also under the
[MIT licence](https://github.com/engenty/wizards/blob/main/packages/shared/LICENSE-MIT), so any
tool may read and write wizards.

## The definition

```json
{
  "$schema": "https://engenty.ai/schema/v2/wizard.json",
  "version": 2,
  "title": "Create an invoice",
  "description": "A finished invoice from a few details.",
  "avatar": "round",
  "lang": "en",
  "steps": [ … ]
}
```

| Key | What it holds |
|---|---|
| `version` | The version of the format, `2`. See [Version](#version) |
| `title` | What people get, short. See [Title, description and intro](#title-description-and-intro) |
| `description` | One sentence about the wizard |
| `avatar` | The engenty shown to people. See [The avatar](#the-avatar) |
| `costume` | A Halloween costume the avatar wears. See [The avatar](#the-avatar) |
| `intro` | One sentence in the wizard’s voice, in the chat |
| `lang` | The language the wizard speaks, as a two-letter code. See [Languages](#languages) |
| `lists` | Tables the wizard keeps between runs. See [Lists and connections](./lists-and-connections.md) |
| `connections` | Accounts the person connects during a run. See [Lists and connections](./lists-and-connections.md) |
| `themes` | The space’s themes the wizard offers, in order. See [Themes](./themes.md) |
| `steps` | What the run does, from top to bottom |

## JSON Schema

| For | Schema |
|---|---|
| A definition | [`https://engenty.ai/schema/v1/wizard.json`](https://engenty.ai/schema/v1/wizard.json) |
| `wizard.json` in a `.wizard` file | [`https://engenty.ai/schema/v1/wizard-package.json`](https://engenty.ai/schema/v1/wizard-package.json) |

Put the address under `"$schema"`, as in the example above. Editors such as VS Code then
complete keys and mark mistakes as you type. [JSON Schema and validation](./validate.md) says
what the schema checks and what only `wizards validate` can.

## Title, description and intro

| Key | Where people read it | How to write it |
|---|---|---|
| `title` | On the wizard’s page, in its chat, in the link preview, in the studio and the marketplace, and in AI apps over MCP | What people get, in a few words: “Create an invoice” |
| `description` | Under the title, as the chat’s first line and in the link preview. AI apps read it to pick the wizard | One sentence on what comes out |
| `intro` | In the chat, after the description | One sentence in the wizard’s own voice: “Show me your fridge.” |

`title` is required. `description` may be empty and `intro` left out. All three are written in
the wizard’s language and translated with it. See [Languages](#languages).

## The avatar

`avatar` names the engenty that stands for the wizard: the one-eyed figure on its pages, in its
chat and calls, and in the studio’s and marketplace’s lists. It is one of ten shapes:

`round` (the default), `drop`, `dome`, `flame`, `oval`, `bean`, `pebble`, `sprout`, `tower` and
`wedge`.

The list is fixed. Any other value is an error in the JSON Schema and in `wizards validate`, and
a wizard cannot bring a picture of its own. Each shape has its own colour.

`costume` dresses the avatar up for Halloween: `witch`, `devil`, `bat` or `pumpkin`. Leave it out
and the avatar wears none.

Every shape is in [`assets/engenty/`](https://github.com/engenty/wizards/tree/main/assets/engenty)
as a 512 × 512 PNG on a transparent ground. Seven of them also come wearing Goose’s flight
helmet. The figures are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): you
may use, change and share them, commercially too, with credit:

```text
engenty figures © Thru The Heart Creative GmbH - Matthias Platzer, CC BY 4.0, engenty.ai
```

Using a figure or the name engenty as your own brand, logo or mascot needs permission. See
[TRADEMARKS.md](https://github.com/engenty/wizards/blob/main/TRADEMARKS.md).

## Themes

`themes` names the looks the wizard offers, in order: ids of the space’s themes, or the built-in
`brand`, `host` and `default`. Without it the wizard wears its space’s brand. A theme holds
colours, fonts, shape and effects, values only. See [Themes](./themes.md).

## Languages

A definition is written in one language, and `lang` names it. Any real language works: `en`,
`de`, `it`, `fr` and so on. It sets the runner’s own words and how numbers and dates are written.
The schema checks the shape of the code. `wizards validate` and the studio check that it names a
real language. Without `lang`, the language is read from the wizard’s own words, and English is
the default where they are not clearly German.

People who read another language can read the wizard in theirs. The runner offers their
language, from the browser or the time zone, and translates the wizard on request. AI steps then
write in that language too. The translation is kept with the wizard in the space, not in the
definition. These are never translated:

- ids, branches and their `ask` statements
- the instructions of AI steps and `{{…}}` placeholders
- the values of choices: a choice shows a translated label and keeps its value

In the studio, Share → Settings has “Offer a translation”. It turns translation on or off for the
wizard, and each language can be edited line by line there.

## Version

`version` is the version of the format the definition is written in, not of the wizard. It is
`2` today. Write it: a definition without it is read as version 1.

It changes only with a breaking change to the format. The schemas of each version stay online in
their own folder (`/schema/v1/`, `/schema/v2/`, …). An app reads only the versions it knows: it
refuses a wizard of a newer version instead of running it the wrong way. An older version it
reads and saves in its own.

| Version | What changed |
|---|---|
| 2 | The text model classes are `classifier`, `low`, `standard`, `high`. Version 1’s `standard`, `high` and `highest` are read as `low`, `standard` and `high`. See [Agent steps](./agent-steps.md#model-class-and-effort) |
| 1 | The first version |

The versions of a wizard itself, its drafts and what is published, are kept in the studio, not
in the definition.

## Steps

Every step has an `id`, a `title`, an optional `description` and an optional `next`. Ids are
letters, digits and `_`, start with a letter and are unique in the wizard. The last step is
always a `result` step.

| Type | What it does | Page |
|---|---|---|
| `page` | Asks the person, one to five fields | [Pages and fields](./pages-and-fields.md) |
| `agent` | An AI step: researches, writes, decides, calls tools | [Agent steps](./agent-steps.md) |
| `generate` | Makes an image, a video, a voice-over, a document or a dashboard | [Images, video and documents](./generate-steps.md) |
| `surface` | Shows a view built from the surface catalog | [Views and widgets](./views-and-widgets.md) |
| `widget` | Shows an HTML app from the wizard’s workspace | [Views and widgets](./views-and-widgets.md) |
| `film` | Has the AI client on your computer make a film | [Films](./film-steps.md) |
| `review` | Shows earlier results to check, change or make again | [Review and result](./review-and-result.md) |
| `result` | The last page: the message and the downloads | [Review and result](./review-and-result.md) |

Steps run from top to bottom unless a step’s `next` sends the run elsewhere. See
[Branches and loops](./branches.md). Steps read what came before through templates such as
`{{topic}}` and `{{steps.post}}`. See [Templates](./templates.md).

## A complete wizard

```json
{
  "version": 2,
  "title": "X post with an image",
  "description": "Turns a topic into a finished post with an image.",
  "avatar": "flame",
  "lang": "en",
  "steps": [
    {
      "id": "about", "type": "page", "title": "What is it about?",
      "fields": [
        { "id": "topic", "label": "Topic or occasion", "kind": "textarea", "required": true },
        { "id": "tone", "label": "Tone", "kind": "select",
          "options": ["Casual", "Professional", "Funny"], "default": "Casual" }
      ]
    },
    {
      "id": "post", "type": "agent", "title": "Write the post", "model": "low",
      "instructions": "Write a post for X on {{topic}}. Tone: {{tone}}. At most 270 characters.",
      "tools": [], "output": { "format": "text" }
    },
    {
      "id": "visual", "type": "generate", "title": "Draw the image", "asset": "image",
      "prompt": "A striking image for this post: {{steps.post}}. No text in the image.",
      "options": { "aspectRatio": "16:9" }
    },
    {
      "id": "check", "type": "review", "title": "Does this work?",
      "show": ["post", "visual"], "edit": true, "regenerate": true
    },
    {
      "id": "done", "type": "result", "title": "Ready to post",
      "deliverables": [
        { "from": "post", "label": "Post", "formats": ["txt", "md"] },
        { "from": "visual", "label": "Image", "formats": ["png"] }
      ]
    }
  ]
}
```

The studio’s MCP tool `get_authoring_guide` gives an AI client the same format with its rules
for good wizards.

## Files and checks

- [The .wizard file](./wizard-file.md): what the zip holds and what the import takes.
- [JSON Schema and validation](./validate.md): the JSON Schema for your editor and `wizards validate`.

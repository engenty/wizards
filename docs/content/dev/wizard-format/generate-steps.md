---
title: Images, video and documents
description: A generate step makes an image, a video, a voice-over, a document or a dashboard.
version: 0.7.10
---

A `generate` step makes one thing, named by `asset`. Its `prompt` is a template. See
[Templates](./templates.md).

```json
{
  "id": "visual", "type": "generate", "title": "Draw the image", "asset": "image",
  "working": "Drawing the image…",
  "prompt": "A striking image for this post: {{steps.post}}. No text in the image.",
  "options": { "aspectRatio": "16:9", "style": "modern editorial, high contrast" }
}
```

| `asset` | What `prompt` is | `options` |
|---|---|---|
| `image` | What the picture shows | `aspectRatio`, `style` |
| `video` | What the clip shows | `aspectRatio`, `duration` (4 to 10 seconds), `resolution` (`720p`, the default, or `480p`), `style` |
| `voice` | The exact text that is read aloud | `style`: how to speak, for example “calm, warm” |
| `document` | The brief | `template`: `invoice`, `offer`, `briefing`, `letter`, `report` or `free` |
| `dashboard` | The brief | |

`aspectRatio` is `1:1`, `16:9`, `9:16`, `4:5`, `3:2` or `2:3`. A `document` or `dashboard` step
takes `model` and `effort` like an [agent step](./agent-steps.md#model-class-and-effort). Images
and video use the image and video class.

## Starting from a picture

`referenceImage` is the image an image or video starts from. It names an earlier `image` field,
or an earlier step that made images.

## One result per entry

`each` makes one image or video per entry, at most eight. It names an `image` field with several
uploads, an earlier step that made several images, or a table of an agent step
(`steps.<id>.<key>`). The prompt reads the entry as `{{item.<column>}}`, `{{index}}` and
`{{count}}`. With `each` the prompt goes to the model as written, so let the agent step that makes
the table write complete descriptions.

With `referenceImage` naming as many images, entry 3 starts from the third image. In a review the
person can make single results again.

## Photos and signatures in documents

A document step can place the photos of an earlier `image` field and a `signature`. Say in its
prompt where they go. Pictures from the web in a document (`<img src="https://…">`) are fetched
once when the step runs and kept with the run.

## AI labels

Images, clips and voice-overs carry the marking of AI media (EU AI Act, Art. 50) in their file
metadata. The runner lays the EU’s “AI” label over them. Never ask an image step to draw a label
into the picture.

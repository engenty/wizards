---
title: Films
description: A film step has the AI client on your computer write a film as code, and the runtime renders it.
version: 0.7.10
---

A `film` step makes a motion-graphics film. The AI client on your computer (Claude Code) writes
the film as HTML, CSS and JavaScript in a folder of its own. It looks at its frames and fixes
them, and engenty wizards renders the MP4.

A film step runs only where Claude Code is set up as your AI subscription. It never runs on
credits or in the cloud, and it takes 5 to 40 minutes.

```json
{
  "id": "film", "type": "film", "title": "Make the film",
  "brief": "A 30-second explainer of {{product}}, calm and bright. Use the voice-over.",
  "kit": "kits/explainer.zip",
  "inputs": { "voice": "steps.voice", "script": "steps.script" },
  "format": "16:9", "seconds": 30
}
```

| Key | What it does |
|---|---|
| `brief` | What the film is: story, look, what to use. A template |
| `skills` | Skill packages the client reads. The default is `["hyperframes"]`. A workspace package is `skills/<name>`, a folder with a `SKILL.md` |
| `kit` | A style kit in the workspace, as a `.zip`: a showreel made once with its rules, helpers and stills. Every film of the wizard is made to it |
| `inputs` | What the film is made from: a name (lowercase letters, digits, `-`) → a field id or `steps.<id>` |
| `format` | `16:9` (the default), `9:16` or `1:1` |
| `from` | `steps.<id>` of an earlier film step. This film starts from that one’s code and lays it out for its own format |
| `seconds` | About how long the film runs, 3 to 600 |
| `model`, `effort` | The model class, `standard` by default. The kit carries the craft |

Files among the inputs (uploads, voice lines, pictures) are copied into `input/<name>/`. Text is
written to `input/<name>.md`, JSON to `input/<name>.json`.

## A film in steps

A film that convinces is made in stages, each with its own review:

1. An agent step writes the research and the script.
2. A `generate` step with `asset` `voice` reads the whole script.
3. The film step makes the film from the voice, the pictures and the script.

The film step finds the word timings in the voice-over itself. Sounds come from a fixed catalog.
A film leaves the page as a video file, so it shows the EU’s “AI” label in the picture.

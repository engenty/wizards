---
title: Embed
description: Put a published wizard on your website with one script tag, in the look you choose.
version: 0.9.0
---

[Embed in a website](../../user-guide/test-and-share.md#embed-in-a-website) in the user guide shows the
script tag and its options. This page adds what the tag does with the wizard’s look.

## The look on your website

A wizard wears a chain of themes: its own, in the order its author set under “Look”, then the
space’s brand. `data-theme` chooses which one your website shows:

```html
<script async src="https://example.com/embed.js" data-wizard="TOKEN" data-theme="halloween-calm"></script>
```

| `data-theme` | Shows |
|---|---|
| Left out | The wizard’s first theme, as on its own page |
| The id of one of the wizard’s themes | That theme |
| `brand` | The space’s brand |
| `default` | engenty wizards’ neutral look, without a brand |
| `host` | Your website’s look. Today the tag passes nothing of it, so this is the space’s brand |

A wizard cannot insist on its theme, but your website can choose only among the themes the
wizard wears. An id the wizard does not wear shows its first theme. The ids are on the wizard’s
“Look” section in the studio, and in its definition as `themes`.

The wizard runs in a frame, so its theme applies in full: colours, fonts, shape and effects.
Nothing of it reaches your page outside the frame.

## How it works

`embed.js` adds the choice to the frame’s address: `/w/<token>?theme=<id>`. A link to the
wizard’s page can carry the same `?theme=`. The page sends it along when it reads the wizard
(`GET /api/public/wizards/:token?theme=<id>`), and the runtime answers with the theme’s values
in `brand.theme`. The runtime takes `brand`, `host`, `default` and the ids in the wizard’s chain.
Anything else gets the wizard’s first theme.

---
title: Themes
description: How a wizard looks, from colours and fonts to shape and effects, kept as a theme in the space and carried in its wizard file.
version: 0.9.1
---

A theme is how a wizard’s pages look: the colours of light and dark pages, two fonts, the shape of
corners, cards and headings, and effects such as spider webs, embers or snow. A theme is a
document of its own. It lives in the space, several wizards can wear it, and a wizard file
carries the themes its wizard names.

A theme holds values only: no CSS, no files, no addresses. Everything a theme shows is drawn by
the runner’s own code. So a theme is checked completely by its schema, and it looks the same
wherever the wizard runs.

## The chain in the definition

`themes` in the definition names the looks the wizard offers, in order. Each entry is the id of
one of the space’s themes, or a built-in:

| Id | Look |
|---|---|
| `brand` | The space’s brand: its colours, fonts and logo |
| `host` | The look of the place the wizard runs in: the AI app, the website, your own page |
| `default` | engenty wizards’ own look |

```json
{
  "version": 1,
  "title": "Spukhaus-Exposé",
  "themes": ["halloween", "halloween-calm", "brand"],
  "steps": [ … ]
}
```

Without `themes` the wizard wears its space’s brand. `themes` holds at most 8 ids, each once.

## Which theme shows where

The wizard offers its chain. The place that shows it chooses from it.

| Place | Shows |
|---|---|
| The wizard’s own page and share pages | The first theme of the chain the space has |
| A website, with `embed.js` | `data-theme`: an id of the chain, `brand` or `default`. Left out, the first. See [Embed](../integration/embed.md) |
| A link | `?theme=<id>` on the wizard’s address, chosen the same way |
| ChatGPT, Claude and other MCP Apps hosts | `host`: the app’s own look. The model passes `theme` to `run_wizard` when the person asks for the wizard’s look. See [MCP Apps](../integration/mcp-apps.md) |
| Your own page, with OpenUI | `theme`, `mode` and `effects` on the component. Your page decides how much shows. See [OpenUI](../integration/openui.md#the-wizards-look) |

An id outside the chain shows the first theme. A wizard can’t insist on its theme, but a place can
only choose among the themes the wizard offers.

## The theme

Its JSON Schema is `https://engenty.ai/schema/theme/v1/theme.json`.

```json
{
  "id": "halloween",
  "name": "Halloween",
  "version": "1.0.0",
  "base": "brand",
  "colors": [
    { "scheme": "dark", "accent": "#ff7a1a", "background": "#140b1f", "text": "#f3eaff" },
    { "scheme": "light", "accent": "#d9480f", "background": "#fff4e6" }
  ],
  "fonts": { "heading": "Creepster", "text": "Nunito" },
  "shape": { "radius": "round", "cards": "glass", "headings": "normal" },
  "effects": [
    { "id": "glow" },
    { "id": "corners", "kind": "webs" },
    { "id": "figures", "costume": "bat", "motion": "fly" },
    { "id": "particles", "kind": "embers" }
  ]
}
```

| Key | What it holds |
|---|---|
| `id` | Lowercase letters, digits and dashes, up to 48: `halloween`. A theme from the catalog has a scope: `@owner/halloween`. See [Ids and scopes](#ids-and-scopes) |
| `name` | Shown in the studio |
| `version` | The theme’s own version, `1.0.0` unless given |
| `base` | `brand` (the default), `host` or `default`: what the theme builds on. Whatever the theme leaves out comes from there |
| `colors` | Light and dark pages, in order. See [Colours](#colours) |
| `fonts` | `heading` and `text`. See [Fonts](#fonts) |
| `shape` | `radius`: `sharp`, `soft`, `round`. `cards`: `solid`, `outline`, `glass`. `headings`: `normal`, `uppercase` |
| `effects` | Up to 8 effects of the runner’s library, each with its options. See [Effects](#effects) |

### Colours

`colors` holds one entry per scheme, `light` or `dark`, each once. Each entry has `accent`,
`background` and `text` as `#rrggbb`, and leaves out what comes from the base. Every other colour
of the page (buttons, fields, cards, borders) is worked out from these three.

| `colors` | The pages |
|---|---|
| Left out | As the base shows them, light or dark as the person chose |
| One entry | Always that scheme. The person can’t switch |
| Two entries | The first shows until the person switches |

### Fonts

`heading` and `text` each name a font that engenty wizards ships, or `brand` for the space’s own.

The shipped fonts load from engenty wizards itself, never from another site: `Inter`, `Figtree`,
`DM Sans`, `Nunito`, `Fredoka`, `Bricolage Grotesque`, `Fraunces`, `Playfair Display`, `Lora`,
`Young Serif`, `Caveat`, `Creepster` and `Nosifer`. Creepster and Nosifer are display fonts for
headings.

A space’s own font, for example the one its website uses, belongs to its brand, not to a theme:
uploaded as a file, or loaded from the website’s address after you confirm the licence (see
[Space](../../user/space.md#info--brand)). A theme only names it, with `brand`. A theme that goes
to another space shows that space’s brand font, or a shipped font of the same kind.

### Effects

| Effect | Options | Draws |
|---|---|---|
| `glow` | | Headings and the main button light up in the accent |
| `corners` | `kind`: `webs`, `frost` | Spider webs with a spider letting itself down, or frost in the top corners |
| `particles` | `kind`: `embers`, `snow`, `confetti`, `stars` | Rising embers, falling snow or confetti, twinkling stars |
| `figures` | `costume`: `witch`, `devil`, `bat`, `pumpkin`. `motion`: `fly`, `peek` | engenties in the costume fly past, or peek in from a bottom corner |
| `fog` | | Fog drifting along the bottom |
| `pattern` | `kind`: `dots`, `grid` | A quiet pattern on the ground |

- **One kind each.** `corners`, `particles` and `pattern` take one `kind`. In the studio, choosing
  one switches the other off.
- **Never in the way.** Effects sit over or behind the page and never take a tap or a click.
- **Reduced motion.** For people who ask their device for less motion, nothing moves: flying
  figures, particles and peeking figures go, the spider and the fog stand still.
- **New effects.** The library grows with runner releases. A runner that doesn’t know an effect
  or an option leaves it out, so a theme stays valid on older installs.

## Ids and scopes

| Id | Who |
|---|---|
| `halloween` | A theme of the space. The studio and agents make these |
| `@owner/halloween` | A theme from the catalog, published by `owner` |
| `@wizards/…` | Themes engenty publishes, for example with templates |
| `brand`, `host`, `default` | The built-ins above |

`engenty`, `wizard` and `wizards` are reserved as ids, and `@engenty` and `@wizard` as scopes.

The catalog for themes isn’t open yet. Until then a theme reaches another space in a wizard file.

## In a wizard file

`wizard.json` carries the themes its wizard names, in full, beside the definition:

```json
{
  "format": "engenty-wizard",
  "version": 1,
  "definition": { "themes": ["halloween"], … },
  "themes": [{ "id": "halloween", "name": "Halloween", … }]
}
```

The import puts them into the space you import into:

- **The same theme is there.** Same id, same content: the space keeps its own, nothing doubles.
- **Another theme has the id.** The imported one comes in under a free id, `halloween-2`, and the
  wizard’s `themes` names that one.
- **New.** It comes in as it is.

A space keeps at most 40 themes. A wizard sent from your computer to the cloud takes its themes
along, and they replace the cloud space’s themes with the same ids.

## From the studio and from agents

The studio’s “Look” section edits the theme a wizard wears (see
[Build a wizard](../../user/build-a-wizard.md)). The first change makes a theme named after the
wizard.

Agents and MCP clients use two operations of `edit_wizard`:

| Operation | Does |
|---|---|
| `set_theme` with `{ "theme": { … } }` | Saves the theme in the space, or replaces the one with its id, and puts it first in the wizard’s `themes` |
| `set_meta` with `{ "themes": [ … ] }` | Sets the chain, for example to offer a calmer theme second or the brand last |

A theme saved from the studio or an agent has no scope.

## Why no CSS

Free CSS and files would run in the run page itself, next to what people type. CSS can send
answers to another site, or hide and relabel what must stay as it is: the question before a
connector acts, a sign-in, the AI labels. A theme’s address for a font or a picture would send
every visitor’s IP address to that site. Values only avoid all of it, and a schema can check them.
The reasoning is in [docs/plans/themes.md](https://github.com/engenty/wizards/blob/main/docs/plans/themes.md).

## Styling around the runner

A page that shows the runner as a component (OpenUI) can style around it with these names. They
stay the same across releases. Anything else on the runner’s elements may change.

| Name | What it is |
|---|---|
| `.wizard-page` | The whole page |
| `.wizard-title` | A page’s title |
| `.wizard-heading` | Headings on a page |
| `.wizard-button` | The button that goes on |
| `.wizard-field` | Fields |
| `.wizard-card` | Cards on a page |
| `var(--wizard-accent)` | Accent colour |
| `var(--wizard-background)` | Background |
| `var(--wizard-text)` | Text colour |
| `var(--wizard-font-heading)` | Font for headings |
| `var(--wizard-font-text)` | Font for text |

The variables are for reading. The theme sets them.

```css
.wizard-title { letter-spacing: 0.04em; }
.wizard-button {
  border-radius: 0.5rem;
  outline: 2px solid var(--wizard-accent);
}
```

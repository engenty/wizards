# Themes

Decided 2026-10-19 over four rounds. Not built. Open: themes in the catalog (see the end).

## Why

#83 and #85 gave a wizard a look of its own: the `style` key in the definition, with colours,
fonts, four effects and CSS. It works, but it puts two things into one document:

- **The wizard** is pages, steps and a result. Its author decides it, and it is versioned with it.
- **The look** belongs to where the wizard is shown. A website that embeds it, ChatGPT or Claude,
  WordPress and a call each have a look of their own. The same Halloween look also fits many
  wizards and comes back every October.

Fonts and effects are also closed lists in the wizard’s schema today. Each new one changes the
published JSON Schema, and an older install then refuses a wizard that uses it.

So a theme becomes a document of its own. A wizard can still ship with its themes: a Halloween
wizard arrives with its Halloween look.

## The theme document

A theme is `theme.json` plus its files. It has a schema of its own, versioned apart from the
wizard’s (`engenty.ai/schema/theme/v1/theme.json`).

```json
{
  "id": "halloween",
  "name": "Halloween",
  "version": "1.0.0",
  "base": "brand",
  "light": { "accent": "#e8630a", "background": "#faf3ea" },
  "dark": { "accent": "#ff7a1a", "background": "#140b1f" },
  "prefer": "dark",
  "fonts": { "heading": "Creepster", "text": "Nunito" },
  "effects": [{ "id": "glow" }, { "id": "particles", "kind": "embers" }],
  "css": "css/theme.css"
}
```

- **`base`.** What the theme builds on: `brand`, `host` or `default`. What it leaves out comes
  from there, so a theme that only adds an accent and spider webs fits any space.
- **Dark and light live in one theme.** `light` and `dark` hold the colours of each. `prefer`
  says which one the theme shows when the person has not chosen. A theme with only one of them
  pins it, as `dark: true` does today.
- **Files** sit beside `theme.json`: CSS, SVG, images and font files.
- **Effects are open names with options.** The runner draws those it knows and skips the rest
  without an error. A new effect needs no schema change, and an older install still opens a theme
  that names it.

## In the wizard file

```
spukhaus.wizard
├─ wizard.json                  manifest and definition
├─ files/                       the workspace, as today
└─ themes/
   ├─ halloween/
   │  ├─ theme.json
   │  ├─ css/theme.css
   │  └─ files/web.svg
   └─ halloween-calm/…
```

The definition names its themes and nothing more:

```json
"themes": ["halloween", "halloween-calm"]
```

The order is the wizard’s chain of choices (see below). The `style` key goes away.

A wizard file always carries full copies of its themes. A wizard never breaks because a theme
somewhere else changed.

## The built-in themes

Three names exist everywhere and cannot be defined or published by anyone:

| Name | What it shows |
|---|---|
| `brand` | The space’s brand: today’s look. The default when nothing else applies |
| `host` | The look of the place the wizard runs in: what a website’s embed passes, the styles an AI app hands an MCP app, the WordPress theme. Where the host passes nothing, `brand` |
| `default` | engenty wizards’ own neutral look, without any brand |

A wizard that names no themes behaves as now.

## Choosing a theme

The wizard offers a chain of choices: its own themes in its order, then `brand`. The place that
shows the wizard picks from that chain:

| Place | Picks |
|---|---|
| The wizard’s own run page and share page | The first theme of the chain |
| A link or channel with a theme set | That theme, if the chain has it |
| A website embed | What the snippet asks for (`data-theme="host"`, a theme’s id, or the first in the chain) |
| An AI app (MCP) | `host` by default; the app can ask for a theme of the chain |
| A call | Nothing to show; the theme does not matter |

The host always wins. A wizard cannot insist on its theme.

## Names and scopes

- **Inside a space** a theme’s id is a free slug, like a file name. Anybody can invent one, as in
  WordPress.
- **On import** the files decide. Same id and same content: the space’s theme is used. Same id
  and different content: the theme comes in as `halloween-2`, and the wizard’s reference is
  rewritten. Nothing is overwritten without asking.
- **In the catalog** a theme has a scope, `@owner/id`. A scope belongs to an account.
- **Reserved:** the scope `@wizards` is ours (`@wizards/halloween`). The scopes `@engenty` and
  `@wizard` are reserved, and so are the ids `brand`, `host`, `default`, `engenty`, `wizard` and
  `wizards`.

## Fonts

- **Shipped:** the 13 fonts the runner carries today stay, named by family.
- **Embedded:** a theme may bring font files (`.woff2`) under its files, each with its licence
  in `theme.json`. The page serves them from its own address.
- **External:** the schema allows a font from another address. Such a font breaks the rule that a
  run page loads nothing from elsewhere, so it is the one exception: the studio says so where the
  theme is edited, and a theme in the catalog may not use one.

## Effects and CSS

A theme’s CSS follows the rules that hold today (no `@import`, no backslash escapes), with two
new kinds of address that stay on our own site:

- `url(theme:files/web.svg)`: a file of the same theme.
- `url(engenty:round-bat)`: one of the engenty figures in any costume, built into the runner.

Spider webs, bats and fog become CSS and SVG in the Halloween theme. The runner keeps a few
named effects that CSS cannot do well (`glow`, `particles`, figures flying or peeking in) and
skips names it does not know.

The stable names from #85 stay: `.wizard-page`, `.wizard-title`, `.wizard-heading`,
`.wizard-button`, `.wizard-field` and the `--wizard-…` variables.

## The studio

The studio stays as it is now. The “Look” section with its preview edits the wizard’s first
theme. Behind the scenes it is a theme of the space:

- A wizard without a theme gets one the first time its look is changed, named after the wizard.
- A theme two wizards use changes for both. The section says so (“Also used by …”) and offers to
  make a copy for this wizard only.
- Choosing another theme of the space, or adding one to the chain, is a select above the preview.
- The space gets a list of its themes beside the brand, for renaming, copying and deleting.

## Without migration

`style` is not in a release yet. It goes away, with no migration: wizards that use it are deleted
and made again. The Halloween look of #83 becomes the theme `@wizards/halloween`, shipped with the
Halloween templates.

## Build order

1. The theme schema and its checks (shared package), with the JSON Schema published.
2. Themes in the space: table, files, the import rules for ids.
3. `themes` in the definition; `style` removed; the `.wizard` file carries `themes/`.
4. The run page: resolving the chain, `light`/`dark`, fonts, the new `url()` addresses, the named
   effects. The share page as well.
5. The studio: the Look section on a theme, the select, “Also used by”, the space’s list.
6. Hosts: the embed snippet’s `data-theme`, the styles of an MCP host, WordPress.
7. `@wizards/halloween` and the Halloween templates.

## Open: themes in the catalog

Not decided yet:

- How a theme is published, and whether alone or only with a wizard.
- Updates: how a space learns that `@owner/id` has a newer version, and whether it takes it.
- Who may publish under which scope, and how a scope is claimed.
- What the catalog checks before it lists a theme (no external fonts, the CSS rules, licences).

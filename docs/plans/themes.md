# Themes

Decided 2026-10-19 over six rounds, the last two after a security review. Built 2026-10-19 except the hosts (step 7) and the catalog. Open: themes
in the catalog (see the end).

## Why

#83 and #85 gave a wizard a look of its own: the `style` key in the definition, with colours,
fonts, four effects and CSS. It works, but it puts two things into one document:

- **The wizard** is pages, steps and a result. Its author decides it, and it is versioned with it.
- **The look** belongs to where the wizard is shown. A website that embeds it, ChatGPT or Claude,
  OpenUI, WordPress and a call each have a look of their own. The same Halloween look also fits
  many wizards and comes back every October.

Fonts and effects are also closed lists in the wizard’s schema today. Each new one changes the
published JSON Schema, and an older install then refuses a wizard that uses it.

So a theme becomes a document of its own. A wizard can still ship with its themes: a Halloween
wizard arrives with its Halloween look.

## Values only

A theme holds values and nothing else: no CSS, no files, no fonts from elsewhere. Everything a
theme can show is drawn by the runner’s own code, which we review once and extend over time.

```json
{
  "id": "halloween",
  "name": "Halloween",
  "version": "1.0.0",
  "base": "brand",
  "colors": [
    { "scheme": "dark", "accent": "#ff7a1a", "background": "#140b1f" },
    { "scheme": "light", "accent": "#e8630a", "background": "#faf3ea" }
  ],
  "fonts": { "heading": "Creepster", "text": "Nunito" },
  "shape": { "radius": "soft", "cards": "glass", "headings": "uppercase" },
  "effects": [
    { "id": "glow" },
    { "id": "corners", "kind": "webs" },
    { "id": "particles", "kind": "embers" },
    { "id": "figures", "costume": "bat", "motion": "fly" },
    { "id": "fog" }
  ]
}
```

- **`base`.** What the theme builds on: `brand`, `host` or `default`. What it leaves out comes
  from there, so a theme that only adds an accent and spider webs fits any space.
- **Dark and light live in one theme.** `colors` lists the colours of each scheme, in order: the
  first shows until the person picks, as the order of a wizard’s `themes` is its preference. A
  theme with one entry pins that scheme.
- **Fonts** come from the list the runner ships (13 today, more over time), by family, or from
  the space’s brand by role: `"heading": "brand"` means the brand’s font for headings (see
  [Brand fonts](#brand-fonts)).
- **`shape`** sets a few choices of form: corner radius, how cards look, how headings are set.
- **Effects** come from the runner’s library (below), each with its options.

The theme schema is versioned apart from the wizard’s (`engenty.ai/schema/theme/v1/theme.json`).
Its effect names are open strings: the runner draws those it knows and skips the rest without an
error. A new effect is a runner release, but no schema change, and an older install still opens
a theme that names a newer effect.

## The effect library

All effects are our code. We extend the library regularly: seasons, occasions, business looks.

| Effect | Options | Examples |
|---|---|---|
| `glow` | strength | Headings and the main button light up in the accent |
| `corners` | `webs`, `frost`, `garland`, `leaves` | Spider webs in the top corners, with a spider |
| `particles` | `embers`, `snow`, `confetti`, `stars` | Embers rising, snow falling |
| `figures` | a costume, `fly` or `peek` | engenties with bat wings flying across, a witch peeking in |
| `fog` | strength | Fog drifting along the bottom |
| `pattern` | `dots`, `grid`, `paper` | A quiet pattern on the ground, for business looks |

Effects never take a click, stay behind or around the content, and stop moving where the
person asked for reduced motion.

We publish ready themes from it under `@wizards`: `@wizards/halloween`, `@wizards/christmas`,
`@wizards/party`, a few business looks. Hosts and clients with a renderer of their own (OpenUI,
an own UI, WordPress) get the same values and draw the effects they support in their own way.

## Why values only

Free CSS and files were in an earlier round of this plan. A security review took them out:

| Left out | What it would have risked |
|---|---|
| Free CSS | CSS runs in the run page itself, next to the person’s answers. With an address function the check misses, it can send typed answers to another site. It can hide or relabel what must stay as it is: the question before a connector acts, a sign-in, the EU “AI” labels, “Made with engenty wizards”. A check by pattern has to know every CSS function a browser will ever have |
| Theme files | An SVG or HTML file opened at our address runs scripts there. Every file type needs checking, cleaning and safe serving |
| Fonts from elsewhere in a theme | Every visitor’s address goes to a third party: a privacy question in the EU. A theme would carry the address to every space that imports it. Fonts of one’s own go into the brand instead (see [Brand fonts](#brand-fonts)) |
| Effects by anyone | Code we have not reviewed |

With values only, a theme is data that a schema checks completely. The catalog needs no review
of code, and a theme looks the same in every place a wizard runs.

The `css` of #83 does not move into themes. If an escape hatch is needed later, it is CSS of a
space’s own, behind a feature switch, and it never leaves the space: not in a wizard file, not in
the catalog.

A Content-Security-Policy on run and share pages is still worth adding, as protection against
our own mistakes (a script hole anywhere in the app). It is no longer a condition for themes.

## Brand fonts

A space can use a font of its own, for example the one its website already uses. The font
belongs to the space’s brand, not to a theme, so it never travels.

- **A brand font gets a source.** Today the brand holds only family names. New: each brand font
  has an uploaded `.woff2` file, served from our own address, or the address of the font on the
  space’s own website (the file or its stylesheet). The licence field the brand font has stays.
- **A theme names it by role.** `"heading": "brand"` and `"text": "brand"` mean the brand’s
  fonts for headings and text. A theme never holds a font’s address. On another space, `brand`
  means that space’s fonts.
- **The studio’s font select** lists the shipped fonts and the space’s brand fonts. Choosing a
  brand font in a theme stores the role.
- **On the run page** the runtime resolves the role and adds an `@font-face` for the font, from
  our copy or from the website.
- **It never leaves the space.** A wizard file carries no brand, and a theme in the catalog may
  name only shipped fonts and roles.

What the studio checks and says when an address is entered:

| Point | What happens |
|---|---|
| The website does not allow other sites to use the font | Browsers load a font from another site only with that site’s permission (`Access-Control-Allow-Origin`). The studio tries the address and says so, with two ways out: allow it on the website, or upload the file |
| Licence | Web font licences are often tied to one domain. The studio asks to confirm the licence |
| Privacy | Visitors’ browsers contact the website. The studio says so once |
| The website does not answer | The page shows the shipped font of the same kind (sans or serif) |

When run and share pages get a Content-Security-Policy, its `font-src` is built per page and
holds exactly the address of the space’s font.

## The places a wizard runs

A theme is values, so every place can apply it as far as it can draw it:

| Place | Who draws it | What of a theme applies |
|---|---|---|
| Own run page and share page | The runtime, a page of its own | Everything |
| Website embed (`embed.js`) | The runtime, in a frame on the website | Everything. The snippet picks the theme (`data-theme`) |
| ChatGPT, Claude (MCP Apps) | The runtime, in the host’s sandboxed frame | `host` by default: the styles the app hands over. A theme of the wizard if the app asks for it |
| OpenUI, an own UI | The host’s page; the runner is a component in it | Colours, fonts and shape as CSS variables on `.engenty-runner`; a brand font by family name only, the host loads it. Effects only inside the wizard’s card, and only those the host turns on |
| WordPress | The plugin | Like the embed when it shows a frame, like OpenUI when it draws inline |
| A call | Nothing to draw | The theme does not matter |

## In the wizard file

Themes are values only, so they travel inside `wizard.json`, beside the definition: a wizard file
that is plain JSON carries them as well.

```json
{
  "format": "engenty-wizard",
  "definition": { "title": "Spukhaus", "themes": ["halloween", "halloween-calm"], "steps": [] },
  "themes": [{ "id": "halloween", "name": "Halloween" }, { "id": "halloween-calm", "name": "Halloween, calm" }]
}
```

The definition names its themes and nothing more. The order is the wizard’s chain of choices
(see below). The `style` key is gone.

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
| OpenUI, an own UI | What the host passes to the component; else the first in the chain |

The host always wins. A wizard cannot insist on its theme.

## Names and scopes

- **Inside a space** a theme’s id is a free slug, like a file name. Anybody can invent one, as in
  WordPress.
- **On import** the content decides. Same id and same content: the space’s theme is used. Same
  id and different content: the theme comes in as `halloween-2`, and the wizard’s reference is
  rewritten. Nothing is overwritten without asking.
- **In the catalog** a theme has a scope, `@owner/id`. A scope belongs to an account.
- **Reserved:** the scope `@wizards` is ours (`@wizards/halloween`). The scopes `@engenty` and
  `@wizard` are reserved, and so are the ids `brand`, `host`, `default`, `engenty`, `wizard` and
  `wizards`.

## The studio

The studio stays as it is now. The “Look” section with its preview edits the wizard’s first
theme. Behind the scenes it is a theme of the space:

- A wizard without a theme gets one the first time its look is changed, named after the wizard.
- A theme two wizards use changes for both. The section says so (“Also used by …”) and offers to
  make a copy for this wizard only.
- Choosing another theme of the space, or adding one to the chain, is a select above the preview.
- The font selects list the shipped fonts and the space’s brand fonts.
- The fields become the theme’s values: colours for light and dark, the two fonts, shape, and
  the effects with their options. The field “Your own CSS” and its help go away.
- The space gets a list of its themes beside the brand, for renaming, copying and deleting.

The stable class names of #85 (`.wizard-page`, `.wizard-title`, …) stay on the run page, for
hosts that style the runner around it.

## Without migration

`style` is not in a release yet. It goes away, with no migration: wizards that use it are deleted
and made again. The Halloween look of #83 becomes the theme `@wizards/halloween`, shipped with the
Halloween templates.

## Build order

1. The theme schema and its checks (shared package), with the JSON Schema published.
2. The effect library in the runner: `glow`, `corners`, `particles`, `figures`, `fog`,
   `pattern`, as values in and drawing out, with reduced motion.
3. Themes in the space: table, the import rules for ids. Brand fonts with a source: upload or
   website address, with the studio’s checks.
4. `themes` in the definition; `style` removed; `wizard.json` carries the themes.
5. The run page and the share page: resolving the chain, `light`/`dark`, fonts, shape, effects.
6. The studio: the Look section on a theme, the select, “Also used by”, the space’s list.
7. Hosts: the embed snippet’s `data-theme`, the styles of an MCP host, the values for OpenUI and
   WordPress.
8. `@wizards/halloween` with the Halloween templates, then `@wizards/christmas` and the business
   looks.

## Open: themes in the catalog

Not decided yet. With values only, the catalog checks a theme against the schema and nothing
more. Still to settle:

- Whether a theme is listed on its own, or only together with a wizard.
- What a scope is: the account’s handle, a team’s name.
- Updates: a notice and one click, or automatic.
- Whether the first theme of a new scope is reviewed by us.

---
title: Styles and components
description: The studio's components, Tailwind against the studio's theme, and why a plugin's styles never leak.
version: 0.5.0
---

A plugin’s page should look like the studio. Two things make that easy: the studio’s components
and its theme.

## Components

`@engenty-wizards/web/ui` is what the studio itself is drawn with:

| Component | For | Props beside the element’s own |
|---|---|---|
| `Button` | An action | `variant`: `primary` (default), `secondary`, `ghost`, `quiet`, `danger` · `size`: `sm`, `md`, `lg` · `busy` |
| `IconButton` | An action that is only an icon | `label`: its name for screen readers and the tooltip |
| `Input`, `Textarea` | Text. The textarea grows with its content | `minRows`, `maxRows` on the textarea |
| `Select` | One of a list | `value`, `onChange(value)`, `options: { value, label, disabled? }[]`, `placeholder` |
| `Segmented` | One or several of a few | `value`, `onChange`, `options: string[]`, `multi`, `disabled` (options shown but not to be picked) |
| `Tabs` | A row of tabs; the panels are yours | `value`, `onChange`, `options: { id, label }[]`, `label` (for screen readers) |
| `Switch` | On or off | `checked`, `onChange(checked)`, `label`, `disabled` |
| `Swatch` | A colour | The native colour input’s |
| `Label` | A field’s label | `hint`, `required` |
| `Card` | A surface | |
| `Chip` | A state in a word | `tone`: `neutral` (default), `live`, `warn`, `ember` · `icon` (in place of the live dot) · `title` (on hover) |
| `DatePicker` | A date from a month | `value` (“YYYY-MM-DD” or “”), `onChange`, `min`, `max`, `clearable` |
| `DateRangePicker` | A day or a period in one month: the first click is the start, the second the end | `from`, `to`, `onChange({ from, to })`, `min`, `max` |
| `TimePicker` | A time of day from an hour and a minute column; arrow keys on the field move it by `step` | `value` (“HH:MM” or “”), `onChange`, `step` (minutes, default 5), `compact` (narrow, no clock) |
| `PageMenu` | A page’s own menu: a list at the side with one level below that slides in, tabs on a phone | `title`, `entries` ({ id, label, icon?, to, entries? }), `current`, `footer` |
| `MenuPage` | A page with a menu of its own: the menu stands at the page’s left, or in the studio’s sidebar while that is open, so there is only ever one menu at the left | `menu` (a `PageMenu`, or any), `children` (the page) |
| `Composer` | The field a message is written in: text, dictation, files, send | `onSend(text, files)` (false keeps the draft), `placeholder`, `disabled`, `attach`, `floating` |
| `Dialog` | A modal; on a phone it fills the screen | `open`, `onClose`, `title`, `wide` (`true`, or `"page"` for a document), `height="tall"` (for tabs, folds or lists: its height does not jump), `bare` (the children are the panel) |
| `Spinner`, `Empty` | Loading, and nothing there yet | |
| `LinkedText` | A sentence with its web addresses as links, named by their host | `text` |
| `QrCode` | A QR code of a text, such as a link or a `tel:` number, as the share dialog draws it | `text`, `label` (for screen readers) |
| `cn(...)` | Joins class names, skipping what is false | |
| `dateText(date, withWeekday?)` | A “YYYY-MM-DD” date in the studio’s language: “Wed 14 Oct 2026” | |
| `Anchor`, `Section` | A section of the space page and the spot the menu jumps to: the heading and its hint above the card | `id` on the anchor · `title`, `hint`, `save` (how the last save went), `action` (beside the heading), `plain` (the content draws its own cards) |
| `InlineText` | Text edited where it stands, without a field’s frame | `value`, `onChange`, `placeholder`, `label`, `maxLength`, `fit` (as wide as its text) |
| `AddMenu` | The “Add” menu of a section’s heading | `entries: { label, icon, onPick }[]` |
| `AddRow` | A quiet “+ …” row at the end of a list | `label`, `onClick` |
| `RuleRows`, `useRuleRows(saved)` | Rules as rows, each with its sign (bullet, do, don’t, to check, important, numbered) | `rules` (what the hook gives), `placeholder`, `readOnly` |
| `useAutosave(value, save)` | Saves a value a moment after it last changed; gives the state for a section’s `save` | |
| `newId()` | A short id for something new | |

```tsx
import { Button, Card, Chip, Label, Input } from "@engenty-wizards/web/ui";

<Card className="flex flex-col gap-4 p-5">
  <Label hint="Where the message goes.">Address</Label>
  <Input value={url} onChange={(e) => setUrl(e.target.value)} />
  <div className="flex items-center gap-3">
    <Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button>
    <Chip tone="live">connected</Chip>
  </div>
</Card>
```

Icons are from `lucide-react`.

Most of these components live in the runner package (`@engenty-wizards/runner`), so a wizard’s
run page looks like the studio. Import them from `@engenty-wizards/web/ui` all the same: that is
the import the studio shares. `@engenty-wizards/runner` is not shared, so the build would bundle
it into `client.js`.

## Tailwind

A plugin writes Tailwind classes, as the studio does. The build collects the classes the
plugin’s files use into `dist/client.css`.

The theme’s names are the studio’s:

| | Names |
|---|---|
| Surfaces | `bg-paper`, `bg-paper-2`, `bg-paper-3`, `bg-card`, `bg-popover`, `bg-accent` |
| Text | `text-ink`, `text-ink-2`, `text-ink-3`, `text-ink-4` |
| Lines | `border-border`, `border-border-soft`, `ring-border-soft` |
| The accent | `ember`, `ember-strong`, `ember-tint`; `primary`, `primary-foreground` |
| States | `moss` and `moss-tint` (good), `amber` and `amber-tint` (attention), `rose` and `rose-tint` (danger), `cobalt` and `cobalt-tint` (information) |
| Type | `font-sans`, `font-display` (headings), `font-mono` |
| Corners | `rounded-sm` to `rounded-3xl`, from the theme’s radius |
| Shadows | `shadow-soft`, `shadow-elevated`, `shadow-overlay` |
| Variants | `dark:` and `coarse:` (a finger, not a mouse) beside Tailwind’s own |

The full list is
[packages/runner/src/theme.css](https://github.com/engenty/wizards/blob/main/packages/runner/src/theme.css):
the studio and a wizard’s run page share it.

## Rules

- **Colours come from the names.** The dark theme is derived from the theme’s values, not from a
  fixed palette. A literal colour (`#1a1a1a`, `text-gray-700`) breaks in the other theme.
- **Check both themes.** Dark is the studio’s default. The user menu and the app bar’s own menu
  switch between light, dark and the system’s.
- **Touch targets.** `coarse:min-h-11` gives a control the 44 px a finger needs. The studio’s
  components do that themselves.
- **Don’t style outside your own part.** It would not work anyway: see below.

## Why a plugin’s styles never leak

`client.css` is built so that it cannot change how the studio looks:

- Every rule applies only inside what the plugin draws. The studio wraps each page, section,
  part of the space page, app bar icon, part of the share dialog and assistant card of a plugin
  in an element with `data-plugin="<id>"`, and every rule of `client.css` is nested below that.
- The rules sit in a layer above the studio’s utilities, so inside the plugin’s part the
  plugin’s stylesheet decides.
- The theme is used by reference: `client.css` carries the names’ uses, none of the variables
  and no resets.

## Your own CSS

A stylesheet imported in `ui/plugin.tsx` lands in `client.css` as it is:

```tsx
import "./contacts.css";
```

The build doesn’t nest it for you. Begin its class names with the plugin’s id
(`.contacts-chart`) and use the theme’s variables for colours: `var(--ink-2)`, `var(--paper-2)`,
`var(--ember)`.

## The theme is a contract

A plugin is built against the names the theme has at the time of its build. If a later release
renames or removes a name, plugins built before break without an error: the class is simply not
there. That is why whoever changes `theme.css` treats its names as a contract. If you build
against a name a release added, say in your plugin’s description which release it needs.

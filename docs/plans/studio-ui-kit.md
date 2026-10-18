# Plan: the studio’s UI kit as `@engenty/wizards/plugin/ui`

Status: assessed on 2026-10-18 after the workspace packages took their new names (#74), not
done. This note says what blocks the move and what it would take.

## The rule, and the one exception

[docs/development.md](../development.md): a new thing for outside code goes into
`packages/wizards/` as a subpath, not into a package of its own. A plugin’s studio half breaks
that rule today: it imports the studio’s components as `@engenty/wizards-studio/ui`
(`apps/web/src/ui/index.tsx`), a workspace package that is never published.

At build time the name hardly matters: `scripts/build-plugin.mjs` leaves the import external
and the studio hands the plugin its live copy (`__WIZARDS_STUDIO__.ui`), so a `/plugin/ui` in
`@engenty/wizards` would give plugins the name the rule asks for, and the types.

## What the kit is made of

| Exports | Live in | Need from the studio |
|---|---|---|
| `Button`, `IconButton`, `Input`, `Textarea`, `Select`, `Segmented`, `Tabs`, `Switch`, `Swatch`, `Label`, `Card`, `Chip`, `Dialog`, `Spinner`, `Empty`, `LinkedText`, `cn` | `packages/runner/src/ui.tsx` | nothing: the runner’s own `t` |
| `QrCode` | `apps/web/src/studio/editor/WizardQr.tsx` | nothing: `uqr` |
| `DatePicker`, `DateRangePicker`, `dateText`, `TimePicker` | `apps/web/src/ui/` | `lib/i18n`: the studio’s strings and its language |
| `Composer`, `DictationButton`, … | `apps/web/src/ui/composer.tsx` | `lib/i18n`, `lib/speech`, which talks to the runtime through `lib/api` |
| `PageMenu`, `MenuPage` | `apps/web/src/ui/page-menu.tsx` | `studio/side-menu`: the sidebar slot the studio owns |
| `Section`, `Anchor`, `AddMenu`, `AddRow`, `InlineText`, `RuleRows`, `useRuleRows`, `newId` | `apps/web/src/studio/project/Section.tsx` | `lib/i18n`, `@engenty/wizards-shared/projects` |
| `useAutosave`, `SaveState` | `apps/web/src/studio/project/data.ts` | `lib/api`, react-query |

What the closed plugins import today, over 41 files: the runner’s components above, and of the
rest `QrCode` (2 files), `PageMenu` (2) and `TimePicker` (1).

## What blocks it

`apps/web` depends on `@engenty/wizards`, so `@engenty/wizards` must not depend on `apps/web`.
Everything below the first two rows reads the studio’s own state: its string table and language
(`apps/web/src/lib/i18n.ts`, 4300 lines), its signed-in API client, its sidebar slot. Moving
`apps/web/src/ui` as it is means moving those too, or a workspace cycle. Moving only the first
two rows gives a `/plugin/ui` smaller than the kit the docs describe and the plugins use: two
names for one kit, which is what the rule is against.

## What it would take

1. The date and time pickers, the composer and the section pieces take their strings and the
   language from an env the studio sets, as the runner’s `configureRunner` does; their strings
   leave the studio’s table.
2. The sidebar slot’s context moves into the package; the studio provides it.
3. `useAutosave` and the composer’s dictation take the API client from the same env, or stay in
   the studio and out of `/plugin/ui`.
4. `uqr` becomes a dependency of `@engenty/wizards`, and the package’s Vite build gets a
   `plugin/ui` entry that bundles the runner’s `ui`, as `/openui` bundles the runner, with one
   rolled-up `.d.ts`.
5. `scripts/build-plugin.mjs` maps `@engenty/wizards/plugin/ui` beside the two older names,
   `apps/web/src/ui/index.tsx` re-exports the package, and the plugin pages change their import.

Nothing in `apps/runtime` changes. It is a redesign of the kit’s edges, not a move, so it waits
for its own plan.

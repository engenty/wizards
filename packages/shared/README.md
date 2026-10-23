# @engenty/wizards-shared

Licence: two licences in one package. The wizard format, the sixteen files below, is under MIT
or FSL-1.1-MIT, your choice (`FSL-1.1-MIT OR MIT`, [LICENSE-MIT](LICENSE-MIT)). The rest of the
package is FSL-1.1-MIT ([LICENSE](../../LICENSE)), like most of the repository.

| File | Licence |
|---|---|
| `src/definition.ts` | `FSL-1.1-MIT OR MIT` |
| `src/fit.ts` | `FSL-1.1-MIT OR MIT` |
| `src/numbers.ts` | `FSL-1.1-MIT OR MIT` |
| `src/run.ts` | `FSL-1.1-MIT OR MIT` |
| `src/runner-texts.ts` | `FSL-1.1-MIT OR MIT` |
| `src/shape.ts` | `FSL-1.1-MIT OR MIT` |
| `src/sharing.ts` | `FSL-1.1-MIT OR MIT` |
| `src/store.ts` | `FSL-1.1-MIT OR MIT` |
| `src/surface.ts` | `FSL-1.1-MIT OR MIT` |
| `src/texts.ts` | `FSL-1.1-MIT OR MIT` |
| `src/theme.ts` | `FSL-1.1-MIT OR MIT` |
| `src/translation.ts` | `FSL-1.1-MIT OR MIT` |
| `src/wizard-package.ts` | `FSL-1.1-MIT OR MIT` |
| `src/engenty/data-tables/columns.ts` | `FSL-1.1-MIT OR MIT` |
| `src/engenty/data-tables/columns-format.ts` | `FSL-1.1-MIT OR MIT` |
| `src/engenty/data-tables/columns-value.ts` | `FSL-1.1-MIT OR MIT` |
| every other file | `FSL-1.1-MIT` |

Each of the sixteen says so in its first line (`SPDX-License-Identifier`). The `license` field of
`package.json` is `FSL-1.1-MIT`: one field names one licence for the whole package, and that is
the licence of most of its files. The line at the top of a file is what counts for that file.
[COPYRIGHTS.md](../../COPYRIGHTS.md) is the full list for the repository.

They import only each other and zod. The runner (`packages/runner`, MIT) bundles them under MIT.

## What it is

The modules the runtime, the studio, the runner and `@engenty/wizards` share: the wizard format
and what reads it, and the types and texts they pass between them. It is not published on its
own. Import a module by its path, such as `@engenty/wizards-shared/definition`.

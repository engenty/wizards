# Example wizards

The wizards behind the example pages of wizards.page (the Manage repository's
`apps/server/test/page-examples.ts`): the first two of each team, as `.wizard` files. Each one
carries its team's look as a theme (`themes` in the file), so a run page shows the colours and
fonts of the page it comes from.

| Team | Files |
|---|---|
| nimbus-labs | `purchase-request`, `travel-request` |
| vela-brand | `brand-check`, `logo-pack` |
| alderbrook | `report-a-problem`, `register-a-move` |
| maple-grove-school | `sick-note`, `timetable-and-info` |

## trick-or-treat

engenty's own Halloween page (`trick-or-treat.wizards.page`), nine wizards in German, all
wearing the same `halloween` theme: dark, a glowing orange accent, Creepster headings, spider
webs, flying bats and embers.

| File | What people get |
|---|---|
| `dein-monster-ich` | A selfie as a monster portrait and the poster of their own horror film |
| `halloween-mit-den-engenties` | A spooky story with their names, illustrated, read aloud, as a book |
| `spukhaus-expose` | Their home as a haunted house: photos, an estate agent's listing, a short film |
| `spukorte` | The real legends and haunted places nearby, with sources |
| `halloween-post` | A Halloween post with a picture that fits their company, from its website |
| `dein-fluch` | A curse or prophecy about what annoys them, spoken by a witch |
| `kuerbis-schablone` | A pumpkin carving stencil to print, with instructions |
| `party-einladung` | A party invitation card and a guest list |
| `monster-haustier` | Their pet as a Halloween monster, with a profile |

Import one in the studio with "Import" on the wizards page, or through the API:
`POST /api/studio/projects/:id/wizards/import` with the file as `file`. The theme lands in the
space's themes; the wizard names it in `themes`.

The AI, document and image steps need a model behind the runtime; the pages, uploads and
reviews work without one.

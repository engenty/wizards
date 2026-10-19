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

Import one in the studio with "Import" on the wizards page, or through the API:
`POST /api/studio/projects/:id/wizards/import` with the file as `file`. The theme lands in the
space's themes; the wizard names it in `themes`.

The AI, document and image steps need a model behind the runtime; the pages, uploads and
reviews work without one.

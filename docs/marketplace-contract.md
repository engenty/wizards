# Contract between the runtime and the marketplace

The marketplace is an app of its own: the wizards anyone can start from and their search (its
public pages are written by the site at engenty.ai, see [The pages](#the-pages)). The runtime
(this repo) is one of its clients. It searches the marketplace live, starts wizards from its
entries, and keeps a few of them for offline use: the ones the marketplace marks as starters,
and the ones a person starred. This file is what both sides implement; the types are
`packages/shared/src/marketplace.ts`.

`MARKETPLACE_URL` names the marketplace (default `https://engenty.ai/wizards`; `off` = none). Its
API is below that address, at `/api/v1`. Every call is public and needs no token; publishing,
verifying and voting will take a token of the Manage-App (scope `wizards:publish`).

## Calls

| Call | Answers |
|---|---|
| `GET /api/v1/entries?q=&lang=&useCase=&industry=&format=&capability=&plan=&limit=&offset=` | `MarketplacePage`: the published entries the words find, best first, narrowed by the filters; `total` of them, `all` published entries, and per filter option the entries it would leave (`facets`). Without `q` in the marketplace's own order. `limit` at most 100, default 60. |
| `GET /api/v1/entries?ids=a,b&lang=` | The same page, of exactly these entries (no words, no filters) |
| `GET /api/v1/entries/:id?lang=` | `MarketplaceItem`: the summary, the wizard in that language (else in its own) and its workspace files (base64). 404 for an entry that is not published. |
| `GET /api/v1/entries/:id/export` | `MarketplaceExport`: the entry in every language it has, with its files: what a client keeps offline |
| `GET /api/v1/sync?ids=a,b` | `{ items: MarketplaceSyncItem[] }`: `id`, `hash`, `updatedAt` of every starter and of the named entries that are published |
| `POST /api/v1/entries/:id/installs` | `204`: a wizard was made from the entry; counted |

- **Languages**: `lang` is `de` or `en` (default `de`). An entry is written in one language and
  may be translated; where it is not, it answers in its own and says so in `language`.
- **Hash**: over everything the entry is made of — its words and wizard in every language, its
  files, how it is sorted. A client that keeps an entry fetches the export again only when the
  hash in `sync` differs from the one it keeps. `revision` goes up with every change; a wizard
  made from an entry records it (`wizard.starter_revision`).
- **Versions**: `version` is the definition version the wizard is written in. A client whose
  `DEFINITION_VERSION` is lower shows the entry as needing a newer app. The schema drops what it
  does not know, so a client also reads the wizard before it starts one and refuses it when
  anything would be lost. A client says the version it reads in `x-wizards-definition`. Without
  it, the client is one from before version 2: entries come in version 1 (the text classes
  `low`, `standard` and `high` named `standard`, `high` and `highest`), so it can still start them.
- **Plugins and plans**: `plugins` names the plugins an entry's wizard uses (its tools named
  `<plugin>.<tool>`, `pluginsOf`), `plan` the plan that has them (`free`, or `pro` as soon as it
  uses a plugin: plugins come with Pro and Team), and `pluginStarter` the plugin's own starter
  the entry shows in the catalog (`<plugin>.<starter>`). `plan=free|pro` filters by it, with its
  counts in `facets.plan`. A runtime that has the plugin lists the plugin's starter and leaves
  out the entry that stands for it; one without it marks the entry with `needs` and refuses to
  start it. A marketplace older than these fields leaves them out: no plugins, free.
- **Errors**: `400` with `{ "error": "…" }` for a request that does not parse, `404` for an id
  that is not published.
- **Caching**: lists and sync `cache-control: public, max-age=60`; an item and an export carry
  `etag: "<hash>"`.
- **Changes**: a field may be added within `v1`; a client ignores what it does not know.
  Removing or changing a field takes `v2`.

## The client (runtime)

- **Search**: the studio's "new" page and the `list_starters` tool ask `entries` live. Without an
  answer within 5 s the runtime searches what it keeps, with the same scoring
  (`searchEntries` in `packages/shared/src/marketplace-search.ts`), and says so.
- **Offline**: at start and then hourly it asks `sync` with the starred ids, fetches the export
  of every entry whose hash changed, and forgets what is no longer listed
  (`marketplace_cache` in the control database). Stars are a person's own (tenant database).
- **Starting a wizard**: from the kept export when its hash is current, else from `entries/:id`.
  The wizard is a copy; later changes of the entry do not touch it.

## The pages

The marketplace's pages are not its own: the site at the root of `engenty.ai` (closed repo,
`apps/www`) writes them, with their words in the HTML for search engines, from the marketplace's
`api/pages/…`. English has no prefix, other languages sit below their code: the gallery
`/wizards/` and `/de/wizards/`, an entry's page `/wizards/<slug>` and `/de/wizards/<slug>` (a
slug per language; the entry's id answers 301 to it), `/sitemap.xml` and `/robots.txt`. An
entry's page offers the app as the landing page does, and opens the template in an installed app
with `engenty-wizards://new?starter=<id>` (`entryAppLink`) or in a runtime the visitor names at
`<runtime>/studio/new?starter=<id>`.

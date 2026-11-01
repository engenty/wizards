# Plan: the organization's page

Status: planned 2026-11-01, nothing built. Builds on the client portal (`docs/plans/client-portal.md`,
decision "The organization's page"), the public space page the Manage-App renders today
(`engenty-wizards-manage` `apps/server/src/pages/`), the `pages` switch and „Wer sieht“ for Wissen
folders and Dateien (#479, #482).

`<team>.wizards.page` becomes the organization's own page: its brand, who it is, what it offers
and the ways in, to everyone. What a visitor may do there the organization's owner switches on,
within what the plan allows. Signed in, a client of the firm finds their part behind it, the
client portal. One app, one look, one address.

## Decided

| | Decision |
|---|---|
| Who serves it | The portal app (`apps/portal`) serves the whole host: the public face before sign-in, the client part after. The Manage-App answers the page data by host (`GET /v1/pages/host/<host>`) and stops rendering pages. Today's server-rendered space page moves into the app |
| The home | An organization home: brand, about, contact, the public wizards and the public spaces. Each public space keeps its own page under it. The plan sets how many public spaces there are |
| What visitors may do | The owner switches each capability on or off in Studio; the plan sets which ones exist (below). Off by default, but the page itself |
| Own domains | Later. `<team>.wizards.page` now; the host lookup and the routes leave room for a team's own domain |
| Who a visitor is | The broker's `guest`: what a guest may read follows „Wer sieht“ (Wissen folders and Dateien with Gäste on), what they may start follows the wizards listed |
| Who pays | The firm's credits, as for a client (`client-portal.md`, "Who pays") |

## What a visitor may do

Each is a switch in Studio › Settings › Organisation › Öffentliche Seite, shown only where the
plan has it. The plans' column is a proposal; the tiers are not decided
(`subscription-tiers-outline`).

| Capability | What it is | Proposed plans |
|---|---|---|
| The page | Brand, about, contact facts, links (Info › Links), the public spaces | Pro, Team |
| Start public wizards | The wizards a space lists on its page; results by link or mail, as today | Pro, Team |
| Contact | A form that lands in the contacts plugin, with consent and privacy line (GDPR, see `gdpr-contact-data-in-wizards`) | Pro, Team |
| Book an appointment | The appointments plugin's booking, its free slots | Team |
| Ask the firm's AI | A public chat as a guest: Wissen and Dateien where Gäste see them, the listed wizards, no connections, no web search unless switched on; rate-limited per visitor | Team |
| Client sign-in | The client portal (`clientSpaces`) | Team |

A capability switched off leaves no trace on the page: no button, no route.

## Routes

| Address | What |
|---|---|
| `/` | The home |
| `/<space>` | A public space's page (today's page) |
| `/<space>/<wizard>` | A wizard's card and start; the run stays at `engenty.ai/w/<token>` |
| `/chat` | Ask the firm's AI (where on) |
| `/kontakt`, `/termin` | Contact and booking (where on); English names in English |
| `/portal/…` | The client part (`client-portal.md`, "Addresses") |

A space may not take the address of a route (as Manage #166 keeps it off `portal`).

## The parts

- **Studio** (open runtime): Settings › Organisation › Öffentliche Seite: the switches above,
  the home's words (headline, about, from Info and Marke by default), which space's brand the
  home wears, the public spaces in order. A preview opens the page.
- **The runtime** sends the home with the spaces it sends today (`PUT /v1/pages/:tenantId`):
  `pageTeam` gets `home` (words, brand space, capabilities) and `spaces` (a list where it has one
  `space` today).
- **The Manage-App** keeps the page data, checks it against the plan (a capability the plan
  lacks is dropped) and answers it by host. It stops rendering `pages/views.tsx`; the redirect of
  `/` to the one space goes.
- **The portal app** renders the home, the space pages and the visitor's capabilities; the
  client part stays as built. A visitor's calls (chat, contact, booking) go to the runtime's
  `doors` role as a guest, not through the client contract (no sign-in).
- **The proxy**: the whole `*.wizards.page` host goes to the portal's container; `/v1` stays the
  Manage-App's.

## Steps

1. **The app serves the host.** The portal app renders the public space page as the Manage-App
   does today (same data, same look), Coolify routes the host to it, the Manage-App's renderer goes.
   Done when every page of today looks the same from the portal app.
2. **The home and its settings.** `home` and `spaces` in the page data, Settings › Organisation ›
   Öffentliche Seite in Studio, the home in the app; plan checks in the Manage-App.
3. **Wizards and contact.** The two Pro capabilities: the wizards on the home and the contact
   form into the contacts plugin, with consent.
4. **Ask the firm's AI.** A public chat as a guest on the runtime's `doors`: the client AI's
   narrower tools (`clientTools`) for a guest, reading what Gäste see, a limit per visitor and a
   budget the owner sets.
5. **Booking.** The appointments plugin's slots and booking on the page.
6. **Later: own domains.** A team's domain, verified by DNS, TLS through the proxy.

Steps 1 and 2 go first; 3–5 may follow in any order, each behind its switch.

## Open

1. Which plan has how many public spaces (one on Pro, as decided in `client-portal.md` D12?).
2. The public chat's limits: messages per visitor and day, a monthly budget, what the owner sees
   of visitors' chats (none kept? kept like a client's?).
3. Whether the home is a page of Wissen the owner writes (blocks), or fields in settings.
4. SEO: server-side rendering of the public part in the portal app, or prerendered HTML from the
   page data.

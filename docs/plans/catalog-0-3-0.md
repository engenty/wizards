# Plan: the marketplace's templates in version 0.3.0

Status: converted 2026-11-16. Every entry the marketplace lists is in version 0.3.0, reworked by
hand and walked through with real models on the dev data. Eight entries were merged into others
and are unlisted. All of it is on the manage branch `feat/catalog-0-3-0`
(engenty/engenty-wizards-manage#213) and not live. The notes of each walk-through are in
[catalog-0-3-0/](catalog-0-3-0/).

Scope: the 31 entries in `engenty-wizards-manage/apps/marketplace/entries`, which templates stay,
which are merged, which become one-prompt wizards, and how each reaches the marketplace in version
0.3.0 ([kernel.md](kernel.md)).

Not in scope: new templates, prices, the English texts of entries in version 0.3.0 (the format has
no translations yet).

## How a template reaches the marketplace in 0.3.0

- An entry of version 0.3.0 is the folder it is today: `wizard.de.json` holds the definition with
  `kernel`, and `files/steps/<id>.ts` are its step files. `readEntry` takes it unchanged.
- `wizard.en.json` goes: version 0.3.0 has no translations. The entry is German only until it has.
- `entry.json` stays. A merged entry's use cases and search terms move to the one it is merged
  into.
- The branch `feat/catalog-0-3-0` stands on `feat/format-version` (#212, the entry's version as
  the format's), which stands on this repository's `feat/kernel`. It merges after both.
- A template is converted in the studio (`POST /wizards/:id/convert`), reworked, walked through
  in a test run with a real model, exported, and put in its folder.

## One-prompt wizards

A first page, one step file whose one ask is the agent, and the output. Decided 2026-11-16: no
change to the format. How the studio shows such a wizard, as its prompt rather than as code, is
open.

| Entry | Shape |
|---|---|
| web-advisor, web-appointment, web-dayplan, web-event, web-faq, web-funding, web-job-application, web-sitecheck | first page, one agent ask |
| web-complaint | first page, one step file: contact page, description, document |
| web-price | first page, one step file: read the rooms, confirm the quantities, write the document |

research-dashboard stays three step files: the data download and the review each need their own.

## Merged

| Into | From | How |
|---|---|---|
| claim (new) | expense-claim, medical-claim, insurance-claim, grant-application | The kind of claim is a choice on the first page; one table in `lib/claim.ts` holds what differs. |
| property-photo-tour | property-film | Camera moves and a voice are choices on the second page. |
| facebook-video-ad | photo-ad | One ad wizard: moving stills or clips, 2–4 scenes, an optional voice. |
| appointment-booking | booking-link | One service is booking-link's flow, several start with the choice. |
| quote | window-quote | "Was für ein Angebot?" on the first page; the price list is a file of the wizard. |

A merged entry is `unlisted`: its page stays reachable, the search no longer shows it.

## Step wizards

| Entry | State |
|---|---|
| quote, invoice, research-briefing, x-post, damage-report, menu-plan | walked to the end |
| property-photo-tour | walked to the end with a voice and with camera moves |
| facebook-video-ad | stills walked; clips, voice and a product photo not |
| receipts | the mail and portal steps not walked (no mail account, a person at the portal's login) |
| explainer-video | walked to the end, before the film got the voice (fixed since) |
| claim | Auslagen and Arztrechnungen walked, Schaden and Zuschuss not |
| appointment-booking, site-visit-booking | walked to a booked appointment with the appointments plugin |

Result: 24 entries from 31, 11 of them one-prompt wizards.

## What is left

1. Done: the appointments plugin's starters are the two booking entries, written into
   `src/starters.gen.ts` by `plugins/appointments/scripts/starters.mjs`. The starter `link` is
   gone; the booking wizard with one service is the booking link.
2. Rewrite the landing pages (`landing.json`) of every changed entry: most describe the old pages.
3. Walk what was not walked: receipts' mail and portal, claim's Schaden and Zuschuss, the ad's
   clips, explainer-video once more with its voice.
4. The studio shows a one-prompt wizard as its prompt.

## What the conversions found

Fixed on `feat/kernel`:

- A run's grant took hosts, tools and connections only from version 1's steps.
- A film got nothing of the steps before it; inputs written as values made it fail.
- A converted mailbox had no actions, and the first page's connection field kept the old name.
- A converted AI step was given every answer again, ids of files and voice notes as JSON included.
  Now only the answers its text does not name, by label, a voice note as what is said.
- Claude Code 2.1.317 refuses an output schema that names its dialect (`$schema`). Also on `main`.

Open:

- A document repeats its title (invoice, claim, web-complaint, quote).
- A step file cannot read the space's brand, the wizard's own files, or a list, and cannot write
  a list row without a model.
- A review ask has no place for a sentence on what to check.
- A download of a finished 0.3.0 run's step answers 404 (`serveDownload` looks in
  `run.definition.steps`).
- A change request for a film starts it over; a downloaded step value leaves out a review's edits.
- Events of a step are filed under the step before it.
- Removing a step file leaves its name in `start` and `edges`.
- A time page with no free times leaves the person stuck.
- The converter keeps a review loop limit of 21, writes `<data>` tags into headings, and in
  facebook-video-ad made clips twice.

## Open questions

1. Merged entries: `unlisted`, or removed with a redirect from their pages?
2. claim: one wizard for four kinds, or four small wizards that share one file of step code, as
   an organization offers mostly one kind?
3. English: wait for translations in 0.3.0, or keep `wizard.en.json` as version 0.2.0 beside a
   German 0.3.0?

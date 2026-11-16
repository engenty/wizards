# Plan: the marketplace's templates in version 0.3.0

Status: started 2026-11-16. Six templates are converted, walked through on the dev data and stored
as entries of version 0.3.0 on the manage branch `feat/catalog-0-3-0`. Nothing of it is live.

Scope: the 31 entries in `engenty-wizards-manage/apps/marketplace/entries`, which templates stay,
which are merged, which become simple wizards, and how each reaches the marketplace in version
0.3.0 ([kernel.md](kernel.md)).

Not in scope: new templates, prices, the English texts of entries in version 0.3.0 (the format has
no translations yet).

## Where it stands

- All 31 convert with `toKernel`, compile and run to their end with stand-ins
  (`packages/kernel/src/convert.test.ts`). That proves the converter, not the templates.
- Six were converted, reworked by hand and walked through with real models on the dev data:
  quote, invoice, research-briefing, x-post, damage-report, property-photo-tour.
- The live marketplace serves all 31 as version 1 (0.2.0).

## How a template reaches the marketplace in 0.3.0

- An entry of version 0.3.0 is the folder it is today: `wizard.de.json` holds the definition with
  `kernel`, and `files/steps/<id>.ts` are its step files. `readEntry` takes it unchanged.
- `wizard.en.json` goes: version 0.3.0 has no translations. The entry is German only until it has.
- `entry.json` and `landing.json` stay. A landing page that describes the old pages is rewritten
  with the template.
- The branch `feat/catalog-0-3-0` stands on `feat/format-version` (the entry's version as the
  format's), which stands on this repository's `feat/kernel`. It merges after both.
- A template is converted in the studio (`POST /wizards/:id/convert`), reworked, walked through
  in a test run with a real model, exported, and put in its folder.

## The sorting

### Simple wizards: one prompt

A form, one agent ask and its answer. A step file adds nothing to these; one prompt with skills
and knowledge does the work.

| Entry | Steps today |
|---|---|
| web-advisor, web-appointment, web-dayplan, web-event, web-faq, web-funding, web-job-application, web-sitecheck | form → agent → result |
| web-price | form → agent → form → generate |
| web-complaint | form → form → agent → generate |

In version 0.3.0 such a wizard is already possible without a change to the format: `input` and one
step file whose one ask is the agent. What is open is how the studio shows it: as the prompt to
edit, not as code. Decided together with the question whether a wizard folder becomes a package
([kernel.md](kernel.md)).

research-dashboard is the same shape plus one generated file, and so are research-briefing and
x-post, which are already converted. They stay step wizards for now.

### Merged

| Into | From | Why |
|---|---|---|
| claim | expense-claim, medical-claim, insurance-claim, grant-application | The same twelve steps: read the documents, check, check again, submit. The kind of claim is a choice on the first page. |
| property-photo-tour | property-film, facebook-video-ad, photo-ad | A film or an ad from photos. The format is a choice. |
| appointment-booking | booking-link | Booking and the booking link are one flow with the appointments plugin. |
| quote | window-quote | A quote with a template for window replacement. |

An entry merged into another is set to `unlisted`: its page stays reachable, the search no longer
shows it.

### Step wizards that stay

| Entry | State |
|---|---|
| quote | converted |
| invoice | converted |
| research-briefing | converted |
| x-post | converted |
| damage-report | converted |
| property-photo-tour | converted; the merge with the films is open |
| menu-plan | open |
| receipts | open |
| explainer-video | open |
| site-visit-booking | open; needs the appointments plugin on the dev stack |
| claim | open; the merge |
| appointment-booking | open; the merge, needs the appointments plugin |

Result: about 12 step wizards and 11 simple ones, from 31.

## Order

1. Store the six converted ones as entries. Done.
2. Convert menu-plan, receipts, explainer-video, and build claim from the four claims.
3. Merge the films into property-photo-tour, window-quote into quote.
4. The two booking wizards, once the appointments plugin runs on the dev stack.
5. The simple wizards, once the studio shows a one-prompt wizard as a prompt.
6. Rewrite the landing pages of every changed entry.

## What the conversions found

Each walk-through leaves notes: what the converter lost, bugs in the kernel and runtime, questions.
The ones that recur:

- The first page loses its title: `input` has no title.
- The converter writes its tables for a model in English and machine formats in a German wizard,
  and appends the raw answers to a prompt that already holds them computed.
- A step file cannot read the space's brand.
- A review ask has no place for a sentence on what to check.
- A download of a finished 0.3.0 run's step answers 404 (`serveDownload` looks in
  `run.definition.steps`).

## Open questions

1. A one-prompt wizard: a step file with one ask, shown in the studio as its prompt? Or its own
   shape in the file, without `steps/`?
2. Merged entries: `unlisted`, or removed with a redirect from their pages?
3. English: wait for translations in 0.3.0, or keep `wizard.en.json` as version 0.2.0 beside a
   German 0.3.0?

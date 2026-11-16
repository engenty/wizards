# receipts → "Belege für die Buchhaltung" (0.3.0)

- Wizard: `ObQZF2PStb-o`, http://localhost:5260/studio/edit/ObQZF2PStb-o (space "Mein Computer")
- Its 0.2.0 source in the same space: `jPCIT6oeMtm2`, left as it is.
- Draft: no issues, no warnings.
- Test run `Xwo22TYAPATZDRt-fQ` finished. Export: `belege-0.3.0.wizard` in this folder, written into the manage entry `receipts`, which loads as 0.3.0.
- Test data: `../../receipts-data/` (a bank CSV for October 2026 with entries from 30.09. and 02.11. around it, a salary, a tax payment, a bank fee; three receipt PDFs, one of them in USD).
- Downloads of the finished run: `belege.zip` (three PDFs and the xlsx) and `offene-punkte.pdf` in this folder.
- What a person stumbles over in the template, written before any change: `before.md`.
- Walked: first page, second page, payments, own receipts, matching, review, open points, result. Not walked: mail (no mail account on the dev stack) and portal (needs the browser and a person at a login). Both step files compile and are reached only by those ways.

## The test run, checked by hand

| Zahlung | Expected | Run |
|---|---|---|
| 30.09. Hetzner, 02.11. Hetzner | outside October, left out | left out (by the code) |
| 02.10. Gehalt +3.250,00 | income, left out | left out |
| 01.10. Hetzner 38,56 | receipt R0024602117 | proposed by code, kept, „passt“ after review |
| 03.10. Notion 89,12 (USD 96.00) | USD receipt, amount differs | no code proposal; model added it with note „Beleg in USD, Betrag weicht ab“ |
| 07.10. ÖBB 59,90 | no receipt | offen, „beim Anbieter anfordern“ |
| 12.10. Büro Schmid 142,30 | receipt 4471 | proposed by code, kept |
| 15.10. Finanzamt 1.204,00 | no receipt needed | kein_beleg |
| 20.10. A1 34,99 | no receipt | offen |
| 31.10. Bank Austria 9,50 | no receipt needed | kein_beleg |

Seven rows in the list, every figure as on the statement. The open points list ÖBB and A1 with German dates and amounts, and two request texts. Nothing invented.

## What changed, and why

1. **The month is code.** `payments` works out the month and its first and last day from "Letzter Monat" and `run.today`, and gives the model the exact dates to read. Other steps read `run.steps.payments.month`.
2. **The model only copies.** It returns date, shop, amount, currency and whether a receipt is needed. The code makes the ISO date, the number (German or English decimal), drops what is outside the month or not an expense, sorts, and builds each payment's id. Two alike get "(2)".
3. **Matching is code first.** `match` proposes a receipt per payment: same amount, receipt 35 days before to 5 days after, same shop name first, each receipt once. The model checks shop names, places foreign-currency receipts, writes the list in one call. It gets the counts from the code for its sentences.
4. **No model call without work.** `own` skips the model when nothing was uploaded. `mail` skips it when no payment needs a receipt. `portal` works out the payments still without a receipt and asks only for those, biggest first, or skips.
5. **Converter's answers block gone** from every AI step. The person's answers are only where a step needs them.
6. **Words.** First page "Welcher Monat, welche Zahlungen?" with a line on what the statement and the mailbox are for. Portal question as a question with Nein/Ja. Working lines with a subject ("Ich lese deine 3 Belege …"). Review "Stimmt jede Zuordnung?" says where to look first. "Offene Punkte" gets its month as a name ("Oktober 2026") and fixed formats.
7. **The file.** `classifier` dropped from `requires.models` (no step uses it). The mail connection names its actions (search, read, get_attachment) and the mail step names them as tools. The first page's connection field points at `mail`. "Offene Punkte" downloads as PDF and DOCX, no Markdown.

## What the conversion lost or left open

- The connection was renamed `mailbox` → `mail` in the file, but the first page's connection field still pointed at `mailbox`. The draft check said nothing.
- The connection got no actions, and the mail step's ask no tools. The converter's note says so, but the wizard would have run the mail step with no mail tools at all.
- `wizard.en.json` has no 0.3.0 counterpart.
- `landing.json` still describes the old pages.

## Bugs and gaps (described, not fixed)

Kernel and runtime
1. The run's events carry `stepId: "more"` for the tool calls of `payments`, `own` and `match` ("Reading kontoauszug…", "Filing 3 files", "Remembering Zahlungen & Belege"). The feed puts the AI steps' work under the second form.
2. A step file cannot read a list. `open` has to count rows with a model, and `match` cannot see which rows were confirmed last month, so the rule "leave confirmed rows" is the model's.
3. The step outline shows a `working` line with `${…}` as "…" ("Ich lese deine … Belege …"). Only while the step has not asked.
4. `input` is fixed: the month choices can't name the month ("Letzter Monat (Oktober)").

Converter
1. A renamed connection is not renamed in a `connection` field (see above).
2. A connection without actions gives the step no tools, with only a note.

## Questions for Matthias

1. Mail and portals were not walked. Is there a dev mailbox and browser seat to finish the walk?
2. Should confirming a row ("passt") happen in the review only, or also in the result's list?
3. The request texts address the vendor with "Sie". Fine for mail to a shop, or "du" as everywhere else?
4. Matching by amount is exact to the cent. Do you want a tolerance (say 1 %) for card fees, or only the foreign-currency rule?
5. A step could write the list itself through a `list_write` tool ask, with the model only judging shop names. Worth it, or keep the model writing the list?

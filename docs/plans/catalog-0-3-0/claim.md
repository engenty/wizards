# expense-claim + medical-claim + insurance-claim + grant-application → „Antrag einreichen“ (0.3.0)

- Wizard: `fbQG8j85Oz-L`, http://localhost:5260/studio/edit/fbQG8j85Oz-L (space „Mein Computer“). It was converted from expense-claim (imported as `ixgORLvN-O-B`, left as it is) and then rewritten.
- Draft: no issues, no warnings.
- Export: `antrag-einreichen-0.3.0.wizard` in this folder. The final files are in `final/`, the sources I wrote in `new/`.
- Entry: `engenty-wizards-manage-catalog/apps/marketplace/entries/claim/`, with slugs `antrag-einreichen` and `submit-a-claim`. The four old entries are set to `"status": "unlisted"`. `check-entries.mts`: all load.
- Test documents (made with PIL): `docs/`.

## Test runs (real models)

| Run | Kind | Path | State |
|---|---|---|---|
| `mX8FnfyTIRvNJL-XNF` | Auslagen | Two issues → findings → explanation → recheck → document → submit | done; list row `AA-20261116-LM` written exactly |
| `GcBlvqmVgAfgT-ert1` | Arztrechnungen, für mich | Amount not readable → findings → readable copy handed in → recheck → document → submit | done; row `KE-20261116-AB` |
| `c7NIlJyOVmiibyXXVg` | Arztrechnungen, Familienmitglied | Same path, after the fix for stale notes; checks the extra field `patient` | document checked, then cancelled before submit |

Schaden and Zuschuss were not walked. They compile, and their pages, prompts and rules are the old ones, but no run went through them. Location, audio and photo fields (Schaden) are untested in 0.3.0.

### Checked by hand

- Auslagen: three receipts. The model read all three exactly, including the Billa total of 47,81 € with cigarettes for 6,80 €. The person struck the cigarettes, leaving 41,01 €. Total: 36,89 + 128,40 + 41,01 = 206,30 €. Document and row both show 206,30 €.
- The code found both rule breaks itself: the Metro receipt from 01.07.2026 is 138 days old (limit 92), and the Druckerei invoice of 128,40 € has no approval (limit 100 €). The model added only reading-based notes, such as the cigarettes and that the invoice is made out to the club.
- Arzt: the model reported the Hautarzt amount as not readable instead of guessing. It really was cut off, because my test image was too narrow. After a readable copy was handed in, the recheck confirmed 95 + 25 = 120 €. Total: 450,00 €.
- Reference, date, kind, details, positions, total, check result and notes in the list row are set in code. The model only called `list_write` with the JSON it was given.

## What differs between the four, and how it is kept

| | Auslagen | Arzt | Schaden | Zuschuss |
|---|---|---|---|---|
| First page | receipts, occasion, area | bills, enclosures, for whom | what happened (kind, date, place, audio, text), then photos + documents | program, ID, proofs |
| Who | name, email, IBAN | insured person, insurance no., family member if chosen, email, IBAN | policy no., name, email, phone | email, IBAN |
| Read out | one row per receipt + recipients | one row per bill + patients, enclosures | account, items, seen on photos, documents | name, birth date, address, household, incomes, documents |
| Confirm | positions, approved by, signature | positions, paid, elsewhere, signature | account, items, IBAN, signature | personal data, incomes, signature |
| Counted in code | date ≤ 3 months, ≥ 100 € needs approval, doubles | date ≤ 3 years, doubles, elsewhere → note | day not in future, > 500 € needs a receipt, IBAN needed, > 14 days → model checks for a reason | household changed → note |
| Judged by the model | ≥ 250 € made out to the club, fits the occasion, nothing private | bill content, prescription, name matches | photos match, police report, cause of water, PIR, receipt dates | ID, registration, proofs per person, rent papers |
| List | abrechnungen | einreichungen | schadensfaelle | antraege |

- One table `KINDS` in `lib/claim.ts` holds each kind's words, columns, limits and rules. Every step file imports it, and the bundler inlines it.
- The first page asks only for the kind. Each step branches on it. Schaden asks its first step as two pages, as before.
- One list `einreichungen` replaces the four. It has the columns Art and Angaben (the kind's own details, one line each). The status is one set for all: eingegangen / in Bearbeitung / erledigt / abgelehnt. The four old status sets (offen/freigegeben/ausgezahlt, neu/erstattet, gemeldet/reguliert, eingelangt/bewilligt) are gone.
- The reference keeps one prefix per kind (AA, KE, SM, ZU) plus the date and initials. Zuschuss used to take the first three letters of the program; now it is ZU.

## What changed, and why

1. **Figures in code.** The tables are German (`1.234,50 €`, `TT.MM.JJJJ`, a Summe row). Total, age, thresholds, doubles and changed totals are computed in the step. The model is told what is already found and must not repeat it. The converter's English table and the raw-answers block are gone.
2. **The check decides the way by its issues, not by the model's `complete`.** Any issue, counted or judged, leads to findings. `why` is set on both ways.
3. **After a recheck, the first notes the model wrote no longer appear.** The recheck rewrites the notes as they now stand. Only the counted notes (`check.counted`) stay. Without this, the document said „Betrag nicht lesbar“ next to „nachgereicht, 120 €“.
4. **The document is assembled in code**, section by section. The model only lays it out. Empty lines are left out.
5. **The list row is assembled in code.** The submit agent writes it unchanged and answers with a fixed sentence.
6. **Arzt:** the family member's field appears only when chosen. It is not a hidden required field, which is known to fail in 0.3.0.
7. **Reviews:** „Diese Punkte fehlen noch“ and „Stimmen Angaben, Beträge und Unterschrift?“
8. **Words:** no „bitte“, no dashes as separators, and „Prüfe diese Einreichung“ instead of „Prüfe der Antrag“ (the case was wrong for masculine kinds).
9. **Models:** `standard` for reading and checking, `low` for the document and the submit; `audio` is optional (Schaden).

## What the converter lost or left open

- It appended `# The person's answers (data)` with every answer to every AI step, including the generate and submit steps, which already list them. This is the same as invoice bug 3.
- It wrote the positions table in English (`Amount`, `Net`, `Total`) in a German wizard. Same as invoice bug 2.
- It wrote `lists` twice, at the top of the definition and in `kernel`. Both must be kept in step by hand: I changed both.
- It kept `limits: null` and the shell's `steps`. Harmless.
- No notes about any of this: the only note was about `{{brand.…}}`.

## Bugs (described, not fixed)

1. **Event step ids are off by one.** In the run's events, a tool call of `extract` is listed under `who`, `check` under `confirm`, `recheck` under `fix` and `submit` under `send`. Each event carries the id of the step before.
2. **The recheck read two documents when nothing was handed in** (Auslagen run: „Reading 2 documents“ under the recheck while `moreFiles` was empty). It probably read the original receipts again. That is harmless but costs a call. Not looked into.
3. **The document's title appears twice.** The `report` template sets its own title above the `# …` the prompt gives. The other converted templates likely do the same.
4. **`outputs` of a run's page holds only what the current review shows.** The check's or recheck's value cannot be read from `/api/runs/:id` once the run has moved on. I read the document and the list row instead.
5. **A step file cannot write a row of a list.** It needs an agent ask with `list_write`. Code that has every cell ready still spends a model call and trusts the model to copy them.
6. **`{{brand.name}}` stays empty in the dev space**, so the document line reads „· erstellt am …“ with a leading separator. The step cannot read the brand to leave it out (invoice bug 2).

## Questions for Matthias

1. **Is one wizard for four kinds right?** An organization offers one kind: a club does not take damage claims. Today it would have to delete three options and leave the rest of the code in. The alternative is four small wizards that share `lib/claim.ts`, one kind each. That needs a way to share a file between templates.
2. **One list or four?** One list with Art and Angaben is simpler to read in one place, but the kind-specific columns (Polizzennummer, Schadenstag, Haushalt, Einkommen) are now text in Angaben, so they cannot be sorted or filtered.
3. **Status:** is one set (eingegangen / in Bearbeitung / erledigt / abgelehnt) good enough, or should each kind keep its own words?
4. **English:** the four had `wizard.en.json`. The merged entry is German only. The landing page has both languages.
5. **The rules are code** (`KINDS[kind].rules`, the thresholds in `check.ts`). An organization adapts them by editing the file. Should they be a settings page instead?

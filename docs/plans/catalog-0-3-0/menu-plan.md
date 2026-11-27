# menu-plan → "Wochen-Menüplan für den Kindergarten" (0.3.0)

- Wizard: `u-4MDwYWIziR`, http://localhost:5260/studio/edit/u-4MDwYWIziR (space "Mein Computer"). Its 0.2.0 source: `wUP4MJJmKU4Z`, left as it is.
- Draft: no issues, no warnings.
- Test run `NmpF1AZLRRPtWRu1qp`: done, week 15.–19. März 2027, Steiermark, 18 Kindergarten- + 6 Krippenkinder, ohne Schweinefleisch und Nüsse, Vormittagsjause + Mittagessen. One change through the review ("Freitag keine Palatschinken"), then accepted. Documents: `poster.html`, `shopping.html`; PDF download of the poster answers 200.
- First run `0hUMJ6gQh1ssAMQjF0` (week of 8 Dec 2026) stopped at the review; it showed the holiday bug below and the coarse rounding.
- Export: `menueplan-0.3.0.wizard`; in the entry on `feat/catalog-0-3-0` (manage), `readEntry` takes it. Final step files: `steps/`. Before: `before.md`.

## Checked by hand

- Amounts: Seelachs 70 g × (18 + 6 × ⅔ = 22 Portionen) = 1,54 kg → 2 kg; Hühnerbrust 50 g × 22 = 1,1 kg → 1,5 kg. Every line of both shopping lists (24 frisch, 11 Vorrat) stands in the document exactly as computed.
- The change through the review touched Friday only; the other four days stayed word for word.
- 1× Fleisch, 1× Fisch, Donnerstag Suppe, no pork, no nuts: kept.
- "Gerichte merken" wrote the five lunches into the list.
- The holiday logic, run offline with the step file and the real date.nager.at data: Josefstag counts in Steiermark and not in Wien, Mariä Empfängnis everywhere in AT, Heilige Drei Könige in Bayern and not in Berlin, a week over New Year fetches both years.

## What changed, and why

1. **Three pages, one theme each**: "Für welche Woche?" (week, country, Bundesland/Kanton), "Wer isst mit?" (children, what must not appear), "Was kommt auf den Tisch?" (Fleisch/Fisch, meals, wishes).
2. **Week**: "Für welche Woche?", any day of it. Monday to Friday are computed in code, not by a model.
3. **Bundesland/Kanton is a list per country** (`when` on the country), mapped to ISO codes in code. Free text gave the model "Stmk" or "Graz" to guess.
4. **Holidays**: the model only fetches and copies the holidays that fall on the five dates. Whether one counts (`global` or the region's code in `counties`) is decided in code. If the list cannot be fetched, the step says so and plans all five days, instead of guessing.
5. **Children by group** instead of "Alter" with "Gemischt": Kindergartenkinder and Krippenkinder as two numbers; a Krippenportion is ⅔. With 0 and 0 the same page comes again with a line why.
6. **Quantities in code**: the model names dishes and, per ingredient and day, the amount for one Kindergarten child (g, ml, Stück) and a group. Code multiplies by the portions, adds up equal products, rounds to what one buys (10 g / 50 g / 250 g, then ½ kg or ½ l), and sets the buying day: Fleisch & Fisch and Brot on the day of use, other fresh goods on Monday, Vorrat with no day; salt, oil, spices "nach Bedarf".
7. **Two snacks**: Vormittags- and Nachmittagsjause are two columns; a meal not chosen stays empty.
8. **Review**: title says what to check ("Passen die Gerichte, die Allergene und die Mengen?"), shows the holidays too. A change request gives the model the other days and says "ändere nur das". The way back has a `why`. Limits 6 instead of 21.
9. **Poster**: one finished line per day, holidays as their own line, the week as "15.–19. März 2027" computed (Jänner in Österreich). No capitals, "füg nichts dazu".
10. **Shopping list**: finished Markdown tables in German formats, the model only sets them.
11. **Gerichte merken**: the rows for the list are built in code; the model only writes them.
12. **No raw answers block**: the converter's "# The person's answers (data)" is gone from every prompt.
13. **Result**: "Plan und Mengen als Tabelle" as xlsx only (md dropped). `requires.models` without `classifier` (nothing used it).
14. **Words**: intro says what comes out; working lines with a subject ("Ich plane die Woche …").

## What the conversion lost or left open

- Nothing was lost; the converter's notes only said `{{lists.…}}` stays as written (it is filled, the model saw the list).
- Only the German definition was converted; `wizard.en.json` goes. `landing.json` still describes the old first page ("Alter").

## Bugs and gaps (described, not fixed)

Runtime
1. **A 0.3.0 file's hosts never reach the run's grant.** `grantOf` (`apps/runtime/src/broker/grant.ts`) reads `definition.steps`, which for a 0.3.0 run is the one result step of the shell. `kernel.requires.hosts` and an agent ask's `hosts` are ignored, so `http_request` to date.nager.at is refused (`host_not_in_grant`) whenever the space's broker switch is on. Both runs planned through the holiday. The same goes for an agent ask's tools and connections in the grant.
2. The v1 template never listed `hosts` either; in version 1 it is refused the same way once the switch is on.

Converter
3. Appends "# The person's answers (data)" to every prompt, also generate prompts that already hold all they need (as in invoice).
4. Keeps `regenerate: true` with no `why` and a limit of 21 (as in invoice).
5. Carries `classifier` into `requires.models` though no ask names it.

Model
6. Names the same thing two ways across days ("Käse" and "Bergkäse", "Vollkornbrot" and "Mischbrot"); they stay separate lines. The prompt asks for one name per product; it is not enforced.

## Questions for Matthias

1. Holidays: compute them in code (fixed dates + Easter, per country and region) and drop the model and the network? Exact for AT; DE and CH regions are a longer table.
2. The ⅔ portion for Krippenkinder and the per-portion amounts are rules of thumb from the template. Should they follow a source (e.g. DGE/ÖGE Qualitätsstandard)?
3. Buying day: is "Fleisch, Fisch, Brot am Tag, alles andere am Montag" right for a Kindergarten kitchen, or should fresh produce be split over the week?
4. Is the review wanted, or is "make it again" on the result page enough?
5. `landing.json` and the English text: rewrite now, or with the other entries?

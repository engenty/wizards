# quote → „Angebot (0.3.0)“

- Wizard: `UoednjjAjrXv` – http://localhost:5260/studio/edit/UoednjjAjrXv
- Source in 0.2.0 (kept, untouched after creation): `l-RTHR-mrIRX`
- Test run: `pAXOz9PYa4Sp2D24mG` – finished, status `done`
- Export: `angebot-0.3.0.wizard` in this folder; the step files as written are in `new/`, the converter's in `orig-*.ts`
- Outline: no `error` in any step. Draft saved with `issues: []`, `warnings: []`.
- What a person would stumble over, written before any change: `before.md`

## Converter notes (verbatim)

- "A review's edits are in its value. Steps later in the list read them. The file's output reads the step's own value."

## What I changed, and why

| What | Before | Now | Why |
|---|---|---|---|
| Description | „Schreibt ein überzeugendes Angebot mit korrekten Summen.“ | „Schreibt aus deinen Angaben ein Angebot mit Einleitung, Leistungsbeschreibung und Preistabelle.“ | no marketing adjective, says what comes out |
| Intro | „Erzähl mir vom Vorhaben – ich formuliere das Angebot.“ | „Sag mir, für wen das Angebot ist und was du anbietest. Ich schreibe den Text und rechne die Summen.“ | says what is asked and what the person gets |
| First page | 3 fields: Angebot an (Name und Anschrift), Ansprechperson, Worum geht es? | 2 fields: „An wen geht das Angebot?“, „Worum geht es?“, each with an example and one help line | the contact is part of the address (the example shows it); the salutation is read from there |
| Page 2 | „Leistungen und Preise“, „Positionen“, „Umsatzsteuer (%)“ 20/19/10/7/0 | „Was bietest du an?“, „Leistungen“, „Einzelpreis netto“, „Umsatzsteuer“ 20 %/19 %/… | title as a question; net said where it matters; the unit in the option, not in the label |
| AI step `pitch` | one sentence; got the price table and was told not to repeat it; plus the converter's appendix „# The person's answers (data)“ with every answer a second time | gets recipient, project and the services' names only; two parts named exactly; rules: only what is given, no dates, guarantees, discounts, prices, quantities | the model cannot repeat a price it never saw; no filler; no doubled input |
| Review `pitchCheck` | „Ändere direkt im Text oder fordere eine neue Fassung an.“ | adds what to check: Anrede, Vorhaben, Leistungen. The way back to `pitch` has a `why`. | says what to look at |
| Step `offer` | converter's table in English (`Amount`, `Net`, `VAT 20%`, `Total`) with `1200.00 EUR`; title „Angebot setzen“ | table and sums in German (`Betrag`, `Summe netto`, `Umsatzsteuer 20 %`, `Gesamtbetrag`), `1.200,00 €`, quantities with a comma; the last valid day is worked out in the step; title „Angebot als Dokument“, „Erstellt das Dokument …“ | the table goes into a German document as it is; no number or date is left to the model |
| Review `offerCheck` | review with regenerate only, no description, right before the result | removed (file deleted, edge `offer → end`) | the result page shows the same document; the guide: a result one can make again needs no review |
| Result | no message; „Angebot“ pdf/docx/html and „Text“ md/docx | message „Dein Angebot ist fertig. Lies Anschrift und Summen noch einmal, bevor du es verschickst.“; one download „Angebot“ pdf/docx | one job, one result |
| `limits` | 21 on four steps | 6 on `pitch` and `pitchCheck` | five new versions are enough; 21 came from the converter |
| `output` | `offer`, `pitch` | `offer` | the text is inside the offer |

## The test run

Answers: Tischlerei Huber GmbH, Frau Martina Berger, Linz; a new website; four services (1 × 1.200, 1 × 4.800, 0,5 Tag × 1.400, 3 Std. × 95), 20 %, 30 Tage. In the review I accepted with one edit in the text.

- Sums in the document: 6.985,00 € netto, 1.397,00 € Umsatzsteuer, 8.382,00 € gesamt. Checked by hand: right. Every row's amount right.
- Salutation „Sehr geehrte Frau Berger“ read from the address. Nothing invented.
- The edit from the review reached the document („ein halber Tag“). A marker I had put in brackets, „(GEPRÜFT)“, was left out by the document step, which wrote in an HTML comment that it looked like an internal note. So „wörtlich übernehmen“ is not literal.
- Found in the run and changed afterwards, **not run again**: the text said „Umfang: 1 pauschal“ and „0.5 Tag“ and „Kundinnen und Kunden“ (the services' list now has names only; a rule asks for „Kunden“); the document step worked out „bis 15. Dezember 2026“ itself (the step now computes it); the prompt now says to take over what is in brackets too. The outline parses after these writes; their effect on a run is not verified.

## What the conversion lost or left open

- The first page's title „Für wen und wofür?“. `input` has no title, the page shows the wizard's title – here „Angebot (0.3.0)“.
- The result step's title „Angebot fertig“. `result` has `message` and `downloads` only.
- A review's `description` does not reach the run: the run's step at `pitchCheck` is `{id, type, title, show, approve, edit, regenerate}`, without it, in the step preview too. The outline has it. So the sentence that says what to check is not shown.
- Money in the table for the model: 0.2.0 wrote it in the run's locale (`formatMoney`), the converted helper writes `1200.00 EUR`.
- The table's words (`Amount`, `Net`, `VAT`, `Total`) are English in both versions. In a German document step told to take them over exactly that is wrong either way.
- Languages: one definition per language in 0.2.0. This wizard is German only; the English one is not converted.

## Bugs and gaps (described, not fixed)

1. Converter: every model step gets „# The person's answers (data)“ appended with all answers, also where the prompt already names each of them. Here the items went in twice, once as a table and once as JSON.
2. Converter: each step file carries all helpers (`itemsOf`, `num`, `answersOf`, `edited`, `revision`, ~90 lines), used or not. `offer.ts` had `vat: 0` in `itemsField` beside the real rate from `taxRate`; right in effect, hard to read.
3. Converter: `limits` of 21 on every step in a regenerate loop, the two review steps too.
4. Converter: the form step `customer` became `input` (good), but its title is dropped without a note. The notes name the review's edits only.
5. Kernel page: a review's `description` is not shown (above).
6. Studio API: `POST /api/runs/<id>/pages/input` right after `POST …/test-runs` answered „The run has moved on and no longer waits“ while the run then showed `waiting_input` at `input`. The same call three seconds later was taken.
7. `wizard.json` has no place for a page title of the first page and none for the result's title.
8. A write of a step file does not raise the wizard's `revision` (stayed 1 after two more file writes). Whether the editor's „changed elsewhere“ check needs that, I did not test.
9. Deleting `steps/offerCheck.ts` while `edges` still named it was accepted without a word; I saved the edges right after.

## Questions for Matthias

1. Umsatzsteuer: 20 % (Austria) is the default, 19 % and 7 % (Germany) follow. Keep one list for both, or take the rate from the space's country?
2. Who sends the offer is nowhere asked; the document ends with „Mit freundlichen Grüßen“ and no name in a space without brand. Should the wizard ask once when the space has no brand, or is that the space's job?
3. I removed the second review. Without it the document can only be made again by running the wizard again. Right call, or should the result page get „neu erstellen“?
4. „Ansprechperson“ as its own field is gone, the address example carries it. Fine?
5. The text is written in the „wir“ form. A freelancer writes „ich“. Ask, or read from the space?
6. No offer number. 0.2.0 had none either. Wanted?
7. The wizard's title is the first page's heading. „Angebot (0.3.0)“ is for comparing; the real title would be „Angebot schreiben“?

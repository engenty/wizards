# invoice → "Rechnung (0.3.0)"

- Wizard: `VAX99XV-1O5G`, http://localhost:5260/studio/edit/VAX99XV-1O5G
- Its 0.2.0 source in the same space: `DqV2W4O0Pkj3` ("Rechnung erstellen"), left as it is.
- Outline: no errors. Draft: no issues, no warnings.
- Test run `4ew_9uF51z9fFcwkL7` finished. Export: `rechnung-0-3-0.wizard` in this folder. The document of the run: `invoice.html`. Final step files: `steps/`.
- A first run (`5RU10S9nP2kCIAzRO2`) was cancelled on its second page, before any model call (see kernel bug 1). No credits spent on it.
- What a person stumbles over in the template, written before any change: `before.md`.

## Sums of the test run, checked by hand

| | Mine | Document |
|---|---|---|
| 37,5 Std. × 96,40 € | 3.615,00 € | 3.615,00 € |
| 3 Stk. × 49,99 € | 149,97 € | 149,97 € |
| 12 Monate × 14,90 € | 178,80 € | 178,80 € |
| Netto | 3.943,77 € | 3.943,77 € |
| Umsatzsteuer 20 % | 788,75 € (788,754) | 788,75 € |
| Gesamtbetrag | 4.732,52 € | 4.732,52 € |
| Fällig (15.11.2026 + 14 Tage) | 29.11.2026 | 29.11.2026 |

Sender, UID, IBAN, recipient and note are in the document as typed. Nothing was added.

## What changed, and why

1. **First page** asks only who gets the invoice: recipient (the question is the field's label) and the customer's UID, with a line on when it is needed. Number, date and period moved to the pages they belong to. One theme per page.
2. **Positions page**: price column says "Einzelpreis netto". 13 % added (AT). "Wann hast du geleistet?" is required now, because an invoice must carry it (AT § 11, DE § 14 UStG).
3. **0 % tax**: a second page in the same step asks for the reason, in the person's own words, and that sentence goes on the invoice. Nothing about tax law is invented.
4. **Third page** "Nummer, Datum und Zahlung": the date starts with today (`default: run.today`). "Zahlbar: sofort / in 14 Tagen / in 30 Tagen" replaces "14 Tage netto". The sender moved up from an afterthought to its own field with a placeholder that lists what it must hold.
5. **Document step**: everything with a figure is worked out in the step's code: amounts per line, net, tax, total, the due date, German formats ("1.234,50 €", "15.11.2026"). The prompt is German, gives the table as it must stand, leaves out lines for empty answers, and forbids inventing a UID, bank details, a greeting or clauses. The converter's block of raw answers (ISO date, items as JSON) is gone: one source for every number.
6. **Review** kept, because a model sets the document. Its title says what to check: "Stimmen Empfänger, Positionen und Summen?". The way back has a `why`. A change request tells the model to change only that and keep all figures.
7. **Result**: a message, downloads PDF then DOCX. HTML dropped (nobody sends an invoice as HTML).
8. **Words**: intro in the wizard's own voice without counting pages, working line with a subject ("Ich setze deine Rechnung …"), "verrechnet" → "in Rechnung stellen".
9. **Limits**: 6 instead of 21 for the review loop.

## What the conversion lost or left open

- The first page's title ("An wen geht die Rechnung?") is gone: `input` has no title, the page shows the wizard's title. The converter said nothing (`notes: []`).
- Only the German definition was converted. `wizard.en.json` has no 0.3.0 counterpart (languages are "not designed" in the plan).
- `entry.json` and `landing.json` are untouched. They still describe the old three pages.
- Amounts are rounded per line, then summed, as the page does it.

## Bugs and gaps (described, not fixed)

Converter
1. A lost first-page title gets no note.
2. The table it builds for the model is English and in machine format in a German wizard ("Amount", "Net", "VAT 20%", "3615.00 EUR"). The model has to translate and reformat figures.
3. It appends "# The person's answers (data)" with the raw answers to a document prompt that already holds the computed table: a second, uncomputed source for the same numbers.
4. Empty optional answers stay as "UID Empfänger: " and "Hinweis: " in the prompt.
5. The regenerate way gets no `why`, and the loop's limit is 21.

Kernel and runtime
1. A required field that `when` hides is still demanded in a 0.3.0 run: `"taxReason" is missing` with tax at 20. The error names no field (`field: ""`) and is English in a German run. Worked around with a second ask in the step.
2. A step file cannot read the space's brand (`run` has input, today, steps, last, count). So the wizard cannot know whether the sender is on file, and must offer the field every time. The document step itself gets the brand.
3. While the document step runs, and in the review's `shown`, the step's title is its id ("invoice") and its type "agent". The ask's `title` ("Rechnung setzen") is not used.
4. `GET /api/runs/<run>/steps/invoice/download?format=pdf` answers 404 for the finished run. `serveDownload` looks the step up in `run.definition.steps`, which holds only `result` for a 0.3.0 run. The result page builds the same address (`packages/runner/src/outputs.tsx`). Not checked in a browser.
5. A review ask has a title and nothing else: no place for a sentence on what to check.
6. `input` has no title of its own.

Studio
1. The step preview shows `default: run.today` as no default.
2. The preview of `result` shows no downloads although `result.downloads` is set.
3. A test run keeps the step files it started with. A file changed while it waits has no effect on it, and nothing says so.

## Questions for Matthias

1. Sender: once a step can read the brand, should the field show only when the brand lacks name, address, UID or bank details?
2. Invoice number: should the wizard keep the last number in a list and propose the next one?
3. Tax rates: AT and DE rates stand in one list (20, 19, 13, 10, 7, 0). Should they follow the space's country?
4. The 0 % reason is typed by the person. Do you want fixed choices (Kleinunternehmer, Reverse Charge) with the legal sentence per country instead?
5. E-Rechnung (XRechnung, ZUGFeRD) for German B2B is not covered. In scope for this template?
6. Is the review wanted here, or should the result page with "make it again" be enough?
7. The first page is titled "Rechnung (0.3.0)". Should `input` get a title, or should a wizard like this start with a form step and leave `input` empty?

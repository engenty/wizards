# damage-report → "Schadensmeldung (0.3.0)"

- Wizard: `yuD5u7ClcO03`, http://localhost:5260/studio/edit/yuD5u7ClcO03 (space "Mein Computer")
- 0.2.0 source wizard made from `wizard.de.json`: `vkcs249wgFb0` ("Schaden melden", left as it is)
- Outline: no `error` in any step. Draft: no issues, no warnings.
- Test run: `6OKgPAGGlDCFVTGl-d`, finished (`done`). Report: `test-run-report.html` in this folder.
- Export: `schadensmeldung-0.3.0.wizard`. Step files as written: `steps/`. Stumbling points written before any change: `before.md`.
- Converter notes: `[]` (empty), see `convert-response.json`.

## What changed and why

Flow before: Fotos → Wo/wann → Was passiert → Wer + Unterschrift → KI-Beschreibung → PDF → Review des PDF → Ergebnis.
Flow now: Fotos → Wo/wann → Was passiert → KI-Beschreibung → **Review der Beschreibung** → Wer + Unterschrift → PDF → Ergebnis. Same number of steps.

1. The person signs after reading. The signature page came before the AI text existed; it now follows the review, and its help says „Damit bestätigst du, dass die Beschreibung stimmt.“
2. The review is on the text, not on the PDF. Title „Stimmt die Beschreibung?“. The person corrects the text in place (`edit`, no credits) or has it written again with a note (way back to `summary`, with a `why`). The document step takes the confirmed text word for word. The review of the finished PDF is gone: nothing is written elsewhere, and the text in it was already confirmed.
3. An empty account is caught. `what` asks once more for one written line when neither a voice note nor a text came („Schreib kurz auf, was passiert ist“).
4. First page: „Kennzeichen, Serien- oder Inventarnummer“ became „Was ist beschädigt?“ (still with scan, with an example). A damage without a number can be named.
5. Contact: „E-Mail für Rückfragen“ (email) became „Telefon oder E-Mail“ (text). On site a phone number is the usual answer.
6. Prompt of the description: every damage names its source („laut Schilderung“ / „auf Foto 2 zu sehen“); from a photo only what is visible; no cause, no hidden damage, no costs, no recommendation; missing answers arrive as „(nicht angegeben)“ and belong under „Offene Punkte“; open points are limited to a fixed list (after the test run the model had added guesses about third parties). The voice-note line is only in the prompt when there is a voice note.
7. Prompt of the document: head lines only where an answer exists (no empty brackets), photos named one by one as `asset://…`, German dates (14.11.2026), „nothing but what is here“. The dump „# The person's answers (data)“ the converter appended is gone from both prompts: every answer is already named, and the dump carried raw JSON of the place and the signature id.
8. Working lines have a subject: „Ich sehe mir die Fotos an und schreibe die Beschreibung …“, „Ich setze den Schadensbericht …“.
9. Result: one download, the PDF. DOCX, HTML and the second download „Beschreibung“ (MD, TXT) are gone: the report is signed, and a phone wants one file to send on. `output` is `report` only.
10. Texts: intro „Zeig mir den Schaden und erzähl kurz, was passiert ist. Den Bericht schreibe ich.“; description names the signed PDF; „Ort des Schadens“ → „Wo ist es passiert?“; date help „Lass es leer, wenn du den Tag nicht weißt.“
11. `limits`: 21 → 6 for `summary` and `check`.

## The test run

Answers: two drawn sample pictures (a van's rear with a dented bumper: drawings, not photos), „Transporter M-AB 1234“, a place in Munich, 14.11.2026, `what` sent empty once (the second ask came, as intended), then a written account, review accepted with a corrected text (`edits`), name, phone, a drawn signature.

Result: the report has the head table, the confirmed text word for word, both pictures and the signature. Nothing invented, no costs, no blame.

Changed after the run, not run again (executed once with stub answers under `node --experimental-strip-types`, outline clean): reading the description as `.text` (bug 2 below), German dates, the tighter „Offene Punkte“, the voice-note line.

## What the conversion lost or left open

- The first page's title „Was ist beschädigt?“. The first page of a 0.3.0 wizard takes the wizard's title; `input` has no `title`.
- The result page's title „Schadensbericht fertig“. `result` has `message` and `downloads` only; the page is titled like the wizard.
- `requires.optional.models: ["audio"]`. `kernelRequiresSchema` has no `optional`. Whether a voice note is transcribed in a 0.3.0 run is not tested (no audio through the API in this run).
- `limits` of 21 for the loop: generous for a review loop.
- The converter said nothing about any of this: `notes` was empty.

## Bugs and gaps (described, not fixed)

1. **An agent ask does not see the photos.** `apps/runtime/src/kernel/batteries.ts` runs the ask with `emptyState()` and the shell definition; `seenPhotos` (`engine/steps.ts`) finds photos through `{{field}}` references and the definition's image fields, and has neither. The model wrote „Foto 1 und Foto 2 konnten nicht ausgewertet werden“. The converter's `upload:<id>` names do not help: the ask has no tools. For this template that is the main gap: the description rests on the account alone. The document step does get the pictures (`asset://<id>` in its prompt).
2. **A markdown agent ask answers `{ text }`, and the converter reads it with `text(...)`.** `run.steps.summary` is `{ "text": "…" }`; the converted `report.ts` had `text(run.steps.summary)`, which puts `{"text": "…"}` as JSON into the document prompt. `format: "markdown"` on the ask is dropped by `stepOf` (output becomes `text`).
3. **Download of the result answers 404 over the API.** `GET /api/runs/<run>/steps/report/download?format=pdf` (and `html`) → 404. `serveDownload` looks the step up in the stored definition, which for 0.3.0 holds only `result`. Not checked in a browser.
4. **Result page names the step by its id.** `shown[0].step` is `{ id: "report", type: "agent", title: "report" }`; the ask's title „Bericht erstellen“ is not used. A running step shows the id too (`step.title` was „summary“ while the description was written).
5. **Preview shows a computed ask property as false.** `regenerate: run.count("summary") < 3` showed `regenerate: false` in `steps/check/view`; only a literal `true` counts. I use the literal.
6. **Only the first ask of a step has a preview.** The second ask of `what` shows nowhere in `steps/what/view`; the outline lists both.
7. **A form or review ask has no place for a line under the title.** `kernel/page.ts` passes title, fields, groups, cta, components, data; a `description` is dropped. A review can say what to check only in its title.
8. `POST /wizards/<id>/convert` copies title and description unchanged; the copy has the same name as its source in the list.

## Questions for Matthias

1. No review of the finished PDF any more. Is that right, or do you want a last look before the result (it would cost a second document on a change)?
2. PDF only. Do offices that process the report need DOCX?
3. „Was ist beschädigt?“ is optional. Required would give every report a named object, at the price of one more must on page one.
4. The description is written in the third person („Die Person meldet, dass sie …“) and then signed by that person. First person („Ich bin …“) would read more naturally above a signature. Which one?
5. Should the day of the damage also ask for the time? The model took „gegen 16:30 Uhr“ from the account.
6. The title „Schadensmeldung (0.3.0)“ is also the first page's and the result page's heading. For the marketplace it would go back to „Schaden melden“.

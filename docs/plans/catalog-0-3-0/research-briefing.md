# research-briefing → 0.3.0

- Wizard: `LQExFhaZro0u`, „Recherche-Briefing (0.3.0)“, http://localhost:5260/studio/edit/LQExFhaZro0u
- Source wizard (0.2.0, made from `wizard.de.json`): `ScpHPpEzLOHK`, left in the space
- Converter notes: `[]` (none)
- Outline: no errors. Draft: no issues, no warnings.
- Test run: `mQh9JFCQIvqXr8HxMS`, finished. Web search works in this studio.
- Files here: `recherche-briefing-0.3.0.wizard` (export), `steps/*.ts`, `before.md` (what a person stumbles over, written first), `run-research.md`, `run-briefing.html`, `run-rows.json`

## What I changed, and why

| Where | Before | Now | Why |
|---|---|---|---|
| Intro | „Nenne ein Thema – ich recherchiere …“ | „Stell mir eine Frage. Ich recherchiere im Web und schreibe dir ein Briefing, in dem jede Aussage ihre Quelle hat.“ | says what the person gets; a question gives a better briefing than a keyword |
| Description | „… fasst es als Briefing mit Quellen zusammen.“ | „… schreibt ein Briefing, in dem jede Aussage ihre Quelle hat.“ | same promise as the intro |
| First page | 4 fields: Thema, Schwerpunkt (optional), Für wen, Umfang | 3 fields: „Dein Thema oder deine Frage“, „Wer liest das Briefing?“, „Wie ausführlich?“; button „Recherche starten“ | „Schwerpunkt“ had no help and no example and belongs in the question itself; every field now has a one-line help |
| Audience options | „Kundschaft“ | „Kunden“ | German wording rule |
| Research prompt | one paragraph, „mindestens sechs Quellen“, empty focus left „Schwerpunkt: .“ | steps: split into sub-questions, open every page before using it, 6 sources (10 for „Ausführlich“), primary sources first, date per source; rules: every fact with its source number, nothing invented, both sides of a contradiction, „Offen geblieben“; fixed shape of the notes; today's date | the old prompt did not forbid inventing, had no date and no place for what was not found |
| Briefing prompt | one sentence + the template | structure (title, „Stand“, three sentences, key statements, meaning for the readers, „Offen geblieben“, sources), length per choice, only from the notes, `[n]` on every statement, figures unchanged, source list only of cited sources | „nothing without a source“ is the product's promise |
| Typed text in prompts | `text()` in the document prompt, `asData()` in the agent prompt, plus a block „The person's answers (data)“ repeating every field | every typed value once, marked `<data>` | the block doubled the topic and brought the unused fields along |
| Working lines | „Recherchiert im Web …“, „Schreibt das Briefing …“ | „Ich recherchiere im Web. Das dauert ein paar Minuten …“, „Ich schreibe dein Briefing …“ | subject, and the wait is named (the research took about 2 minutes) |
| Review `check` | „Dein Briefing“ / „Wünschst du Änderungen? …“ | „Passt das Briefing?“ / says what to check (figures against sources) and that a change is written from the same research; the way back has a `why` | kept: it is the only place for a change wish, and a new run costs a whole research |
| Limits | `briefing: 21, check: 21` | `5` each; the review stops offering „neu schreiben“ after the fifth version | 21 rewrites is no limit; the button goes before the limit ends the run |
| Result | no message; Briefing pdf/docx/md/html; „Recherche-Notizen“ md | message „Dein Briefing ist fertig. Die Recherche-Notizen zeigen zu jeder Aussage, woher sie stammt.“; Briefing pdf/docx/md; „Recherche-Notizen mit allen Quellen“ md | html dropped; the second download says what it is for |

Changed after the test run, not run again (one run only):
- `steps/briefing.ts` reads the notes as text (`run.steps.research.text`). In the run they arrived as JSON `{"text":"…\n…"}`; the briefing was still right.
- „Stand“ and „Heute ist der“ write `15.11.2026` instead of `2026-11-15`.
- A change wish no longer pastes „Das Briefing bisher“ (see bug 1).

## Test run

Topic: E-Rechnungspflicht für kleine Unternehmen in Deutschland, „Geschäftsführung“, „Kompakt“.
- Research: 7 sources (§ 14 UStG, three IHKs, VeR survey, DATEV, Markt und Mittelstand), each with date and address; quotes marked; says which BMF letters it could not open; names a contradiction between two IHK pages.
- Briefing: one page, every statement with `[n]`, „Offen geblieben“ filled, source list with full links. It flags commissioned surveys as such.
- Not exercised: the way back from the review (a change wish), and „Ausführlich“.

## What the conversion lost or left open

- First page's title „Welches Thema?“: `input` has no title; the page is titled with the wizard's title.
- Result step's title „Briefing fertig“: `result` has `message` and `downloads` only. The converter wrote no message, so it was gone without a note.
- The review's description is in the step file, but no page shows it (bug 2).
- The converter's notes were empty although the two titles above were dropped.

## Bugs and gaps (described, not fixed)

1. Converter, `revision()` helper: on a change wish it pastes `text(run.steps.briefing)` as „The result before“. A document step leaves `{"assets":[{"id":…,"kind":"html"}]}`, so the model gets asset ids, not the document. A step file has no way to read the document's text.
2. Kernel page (`apps/runtime/src/kernel/page.ts`): a review's `description` is not passed on; the run's step and the step preview have title, show, approve, edit, regenerate only. The sentence that says what to check is never shown. (quote and x-post found the same.)
3. Downloads: `GET /api/runs/<run>/steps/briefing/download?format=pdf` and `…/research/download?format=md` answer 404 on the finished run, though the result lists both. `serveDownload` looks the step up in `run.definition.steps`, which in a 0.3.0 run holds only `result`. Read from the code and seen through curl; not clicked in the browser.
4. An agent step's markdown value is `{ text }` in `run.steps.<id>`, and the converter's `text()` turns it into JSON inside the next prompt. Converted prompts carry escaped `\n` notes.
5. Step preview: an ask value that is code (`regenerate: run.count("briefing") < MOST`) previews as `false`, so the review's preview shows no „neu schreiben“. In the run it was `true`.
6. Step preview of `briefing` says type `agent`, format markdown; it is a `generate` document. The result's preview shows no downloads and no message.
7. Converter adds „# The person's answers (data)“ with every field to every AI step, also where the prompt already names the fields. English headings in a German prompt.
8. `limits` from the converter are 21 for a review loop.
9. `POST /api/studio/wizards` drops `definition` (the route's schema has spaceId, starterId, lang only), though `createWizard` takes one. A wizard from a definition needs create + `PUT draft`.

## Questions for Matthias

1. „Schwerpunkt“ is gone and belongs into the question. Keep it that way, or back as an optional field with an example?
2. Keep the review? It is the only place for a change wish; the guide says a result one can make again needs none. Without it the wizard is: ask → research → briefing → result.
3. A change wish rewrites from the same notes. Should a wish that needs new facts go back to the research (an edge `check → research`)? It costs a second research.
4. Four audiences: do „Kunden“ and „Öffentlichkeit“ earn their place, or is it Geschäftsführung / Fachteam only?
5. The briefing addresses its readers with „Sie“ („Was das für Sie bedeutet“). Fine for a document, or „du“ as in the app?
6. Should the English template get the same rewrite once this one is approved?

# explainer-video → 0.3.0

- Wizard: `is8puy9MEYnr`, „Erklärvideo“, http://localhost:5260/studio/edit/is8puy9MEYnr (space „Mein Computer“).
- Its 0.2.0 source, imported from the entry and left as it is: `8OwLTyt_ryFr`.
- Converter's notes: one, about review edits (`convert.json`). Draft revision 1: no issues, no warnings.
- Test run: `L6AeBB_MJRjePHYE5S`. **Done**, walked from the first page to the result: one change request on the script, one approval with an edit, the film made by Claude Code in about 8 minutes, the film approved. Film: `run/film.mp4`, frames every 3 s: `run/frames.png`, the downloaded script: `run/script.md`.
- Stumbling points written before the work: `before.md`. Converter's output: `converted/`. Final files: `final/`. Export: `erklaervideo-0.3.0.wizard`.
- **In 0.3.0 the film has no voice-over** (bug 1): the voice is recorded, but the film step never gets it. The step files are written so that they are right once the host passes it.

## What I changed, and why

| Where | Before | Now | Why |
|---|---|---|---|
| Intro | „… nehme die Sprecherstimme auf, und Claude Code zeichnet den Film …“ | „Nenn mir das Thema. Ich lese bei den Quellen nach, die du zulässt, und schreibe ein Drehbuch, das du freigibst. Danach nehme ich die Stimme auf und zeichne den Film in den Farben deiner Marke.“ | says what the person gets and that they approve the script; no tool names |
| First page | „Für wen?“, „Welche Quellen gelten?“ without a word on what they change | one help line each: wording and examples follow the audience; the film says only what the sources say | every field says why it is asked |
| Research | English points whatever the language; the raw answers appended a second time | written in the film's language (URLs stay); leaves out what the sources do not cover; no second block of answers | the review showed English tables to a German person |
| Script | length as `<data field="length">45 Sekunden</data>`; „2.2 words per second“ left to the model; the research as JSON | seconds and the word limit worked out in code (30 s → at most 66 words); points and steps as numbered lines; research edits from the review are read; „add no facts of your own“ | the model gets numbers, not arithmetic; one source for every point |
| Review of the script | „Passt das Drehbuch?“, description says voice and film come later | „Stimmt, was der Film sagen soll?“; ways back with a `why` | the title says what to check, because the description is not shown |
| Two film steps | `film` (9:16) and `film16` (16:9), picked by the exact text of the option, the 9:16 one routed on „format exists“ | one `film` step; the format and `seconds` come from the second page | one step, one place to change the brief |
| Film inputs | values (script, voice, research, material) | refs `steps.voice` and `material`; the approved script and the facts are in the brief | values make the step fail (bug 2); the brief is the only way the script reaches Claude Code today |
| Film brief | voice-over required | times to the voice-over when there is one, else to the say lines at 2.2 words per second | the film works with and without bug 1 |
| Film review | „Dein Erklärvideo“, „„Zurück“ führt zum Skript.“ | „Passt der Film so?“, change in one sentence | names no button the page may not have |
| Result | two video downloads, one always empty | one „Video“, „Drehbuch“, „Quellen“ | |
| Limits | 21 and 41 | research 4, script 6, scriptCheck 10, film 4, filmCheck 4 | every film costs 10–40 minutes of Claude Code |

## Test run, what it showed

Phishing for the staff of a small office, 30 seconds, 16:9, no screenshots.

- Both pages as written.
- Research: six points in German, each from a BSI page it opened. Scenario and four steps.
- Script: ten beats, 67 words (limit 66).
- Review → „Lass den Punkt mit den Dateiendungen weg“: the script came back without that beat, 60 words. The research did not run again.
- Approved with an edit of the recap („Erst nachfragen, dann klicken.“): the edit is in the voice prompt and three times in the film's brief.
- Voice: recorded, `voice.mp3` (asset `MMpnG4SqRmkNAKyX`).
- Film: made by Claude Code in about 8 minutes, 31 s, 1920×1080, with sound effects and **no voice** (bug 1). It follows the script beat by beat in the kit's look: Lena at her desk, the hook pulling the cursor, the fake bank page, the three senders, the stopped click, the four steps after a click, the edited recap at the end. The beat's speech bubble still says „Nicht klicken – nachfragen!“: my edit changed `say` and `recap`, not `visual`. No logo at the end: the space has no brand.
- Film review approved → result. Downloads `film.mp4`, `script.md`, `research.md` answer 200 (invoice's bug 4 is gone).
- `script.md` holds the script **without the person's edit** (bug 7).

## What the conversion lost or left open

- The second page's ways by format became two film steps with string compares (the converter keeps version 1's two steps).
- Review descriptions are carried into the step files and shown nowhere.
- `requires.optional.models: ["low"]` became required.
- The converter passed the motion step's `inputs` as values (bug 2).
- `wizard.en.json` is not converted.

## Bugs and gaps (described, not fixed)

1. **A motion-graphics ask gets none of the run's steps.** `kernel/batteries.ts` builds the step's state with the uploads only (`emptyState()` plus `givenFiles`). `project.ts` reads `inputs` of the form `steps.<id>` from `ctx.state.outputs`, which is empty: the voice-over, the script and the research never reach `input/`. Here `input/README.md` says „(none)“ while the voice was recorded.
2. **The converter writes a motion step's `inputs` as values.** `project.ts` calls `dataRef(raw)` on each, which is `raw.trim()`: an object throws, as the widget step does in property-photo-tour's notes.
3. **A change request for the film starts it over.** The motion step takes a review's note from `ctx.state.notes`, which the battery leaves empty. The note can only go into the brief; a different brief changes the step's stamp, so the folder is deleted and the film made from scratch. Version 1 changes the film's code instead.
4. While the film is made, the run shows the step as `type: "agent"` with empty instructions.
5. Events are filed under the step before: the research's „Reading www.bsi.bund.de“ under `style`, the film's under `scriptCheck` (property-photo-tour's bug 8).
6. `GET /runs/<id>/rows` has no `why` on the rows of steps that returned one.

7. **A download shows a step's value without the review's edits.** The file's `output` names steps; the edits live in the review's value (the converter's note says so). The person approves „Erst nachfragen, dann klicken.“ and downloads a script that still says „Nicht klicken – nachfragen!“. The film and the voice have the edit, because their step files merge it.

## Questions for Matthias

1. Research and points are written with „Sie“ (the sources' voice). The film speaks to the audience. Keep it, or tell the research to use „du“?
2. The script stays a little over the word limit (67 of 66). Count in code and send it back, or let it be?
3. The voice and the film: once bug 1 is fixed, should the voice be a download of its own?
4. `wizard.en.json`: same changes there once these are agreed?

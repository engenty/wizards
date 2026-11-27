# x-post → 0.3.0

- Wizard: `FkGVbbJHIezU`, "X-Post mit Bild (0.3.0)", http://localhost:5260/studio/edit/FkGVbbJHIezU
- Source copy in 0.2.0 (made from `wizard.de.json`, untouched since): `m3F0pQ4UD8r3`, still in the space.
- Test run: `BpGKQDtwWvl47KArub`, done. Image: `test-run-image.png`. Export: `x-post-0.3.0.wizard`. Stumbling points before the work: `before.md`.
- Outline: no errors. Draft: no issues, no warnings.

## Converter's notes

1. "A review's edits are in its value. Steps later in the list read them. The file's output reads the step's own value."

## What changed, and why

First page (`wizard.json` → `input`)
- Labels are questions: "Worum geht es?", "Wie soll der Post klingen?". "Link (optional)" is "Link".
- Each open field has a `help` line. The link has an example.
- Button: "Post schreiben". Intro: "Sag mir, worum es geht. Ich schreibe den Post und zeichne das Bild dazu."
- Still three fields. Nothing added.

`steps/post.ts`
- Prompt rewritten: language and voice of the topic, the news in the first sentence, names/dates/figures as typed, nothing invented, hashtags "meist keiner, höchstens zwei", one emoji at most, no quotes.
- Each tone has one line that says how it reads.
- The link is no longer the model's job. Code appends it and strips it from the text if the model wrote it anyway.
- Length is counted in code by X's rule (280, a link counts 23). Too long: one second ask shortens it. Not triggered in the test run.
- A new text after the review goes straight back to the review (`to: "check"`, with `why`). Converted as it was, a new text also drew a new image.
- The converter's `answersOf` block (every answer a second time under "# The person's answers") is gone. The prompt names what it uses.

`steps/visual.ts`
- Two asks in one step: a Low ask describes one motif (place, light, colours, framing, in English), then the image is drawn from that. Before: "Ein auffälliges Bild" plus the whole post text.
- The image comes from the topic, not from the post's words. It still fits after the person changes the text.
- The style follows the tone (photo for Locker, Professionell, Inspirierend; flat illustration for Witzig). Before: one editorial style for all.
- The value drops the sent prompt (`text`) and keeps the motif as `scene`, so a new version can build on it. Made after the test run, so not seen in a run.

`steps/check.ts`
- One review stays. It is the only place to correct before the result.
- Title "Passt der Post?", description says what to check (names, date, link) and what the person can do.
- `why` on both ways back ("Du möchtest einen neuen Text." / "… ein neues Bild.").
- Its value on the way to the end is the post as the person left it. `output.post` and the download read `check`, so an edit reaches the result. Seen in the test run: the edited text is the result's text.

`wizard.json`
- Result: "Dein Post ist fertig. Kopiere den Text und lade das Bild herunter." Post as txt only (md dropped), image as png.
- Edges: `post: [visual, check]`. Limits 6 / 6 / 11 instead of 21 / 41 / 41.
- `lang: "de"`.
- Working lines have a subject: "Ich schreibe den Post …", "Ich überlege mir ein Motiv …", "Ich zeichne das Bild …".

## Test run

Input: opening of a yoga studio in Vienna, Friday 20 November, 17:00, first class free, tone Locker, a link.
- Post: 205 characters + link, date, time and address as typed, no hashtag, one emoji, one exclamation mark.
- Image: 1376×768, an empty Altbau yoga studio with mats in evening light, no text, no logo.
- Review answered with "accept" and a changed text. The result shows the changed text.
- Not run: both ways back from the review (new text, new image), the shortening ask.

## Lost or left open by the conversion

- The first page's title "Worum geht's?" is gone. The first page is titled with the wizard's title. The converter wrote no note about it.
- A review's `description` is carried into the step file but no page shows it (see below).
- Edits in a review did not reach the result (the converter's own note). Solved here by hand in `check.ts`.
- The model's `style` option and `aspectRatio` are carried over unchanged.
- English: only the German definition is converted. `wizard.en.json` has no 0.3.0 counterpart.

## Bugs and gaps (described, not fixed)

Converter
1. A review that sends back to an earlier step re-runs everything after it. `post` returned no `to`, so a new text also made a new image (credits, and an image the person liked is replaced). In 0.2.0 a new version re-made only the step named.
2. A review with `edit` loses the person's changes on the result page and in the download, when no later step reads them. It is a note, but for this template it is the main path.
3. No note that the form step's title is dropped when the form becomes `input`.
4. Limits come out as 21 / 41 / 41 for a three-step wizard.
5. The agent step gets every answer twice: once in the sentence, once in the "# The person's answers (data)" block.

Kernel / run page (`apps/runtime/src/kernel/page.ts`)
6. A review's `description` never reaches the page: the review step built there has title, show, approve, edit, regenerate only.
7. A generate ask answers with `text` = the prompt as sent (here expanded to about 1,000 English characters). The page shows a kernel step as an agent step in markdown, so that prompt stands under the image in the review and on the result. With `edit: true` it is probably an editable text. Checked in the run's JSON and `packages/runner/src/outputs.tsx`, not looked at in a browser.
8. Steps on the result page are titled with their id ("check", "visual"). Only the download's label is in the person's words.
9. `shown[].formats` for the image is `[]` on the result although the download names png. Not checked whether the download button still appears.
10. `GET /api/runs/<id>/steps/check/download?format=txt` answers 404 for the review step's value. The address may be wrong; not followed up.
11. `result` in a 0.3.0 file has `message` and `downloads` only. `share` targets of a 0.2.0 result have no place. This template had none.

Studio
12. `POST /api/studio/wizards` without a starter plus `PUT …/draft` is the only way to make a wizard from a definition over HTTP. Works, two calls.

## Questions for Matthias

1. "In deinem Ton" in the pitch: four fixed tones are not the person's tone. Should the page ask for an example post of theirs, or should the step read the space's brand voice? Left as it is.
2. Two asks in the image step (motif, then image) cost one more Low call per run. Keep?
3. One review for text and image together, or text first and the image only after the text is accepted? Kept one: the image no longer depends on the text.
4. Style per tone: "Witzig" draws an illustration, the others a photo. Wanted, or one look for all?
5. The exclamation mark and the emoji in tone Locker: allowed, or never?
6. `entry.json` searches for "LinkedIn-Post". The wizard writes for X only. Remove the term, or make the platform a choice?
7. Delete the 0.2.0 copy `m3F0pQ4UD8r3`?

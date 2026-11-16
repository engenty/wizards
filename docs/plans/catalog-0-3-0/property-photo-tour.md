# property-photo-tour → 0.3.0

- Wizard: `EJflAo3AoyKm`, „Objekt-Rundgang aus Fotos (0.3.0)“, http://localhost:5260/studio/edit/EJflAo3AoyKm
- Source copy in 0.2.0 (made from the template, left as it is): `YlxqzwrVnGAE`. Matthias's own conversion `-_UqZZ4aBEEW`: not touched.
- Outline: no errors. Draft revision 1, no issues, no warnings.
- Test run: `U9km4neATxd1WjZ2kd`, **failed at the film step** with `raw.trim is not a function` (bug 2 below, not something the polish changed). Reached before that: first page, second page, texts, two images, the review, one request for other texts, the review again.
- Export: `objekt-rundgang-0.3.0.wizard`. Stumbling points written before the work: `stumbles.md`. Converter's output as it came: `converted/`. Final files: `final/`. Run: `run/`.
- **In 0.3.0 this wizard does not do its job yet**: the images are invented instead of edited (bug 1), the texts step never sees the photos (bug 3), the film cannot be cut (bug 2). All three are in the kernel's host. The step files are written so that they are right once those are fixed.

## Converter's notes

`["Texts keep {{facts.…}} as written. The host fills them when it answers the ask."]`

Wrong for this wizard: `{{facts}}` here is the page's field `facts`, not the space's facts. The line „Eckdaten: {{facts}}“ reached the model as written (seen in Matthias's run).

## What I changed, and why

| Where | Before | Now | Why |
|---|---|---|---|
| Description | „… ohne Videomodell und ohne Sprecherstimme.“ | „Aus den Fotos einer Immobilie wird ein kurzes Video für Inserat, Website und Social Media.“ | benefit, not mechanism |
| Intro | „Lade die Fotos … hoch – ich bereite sie auf Wunsch auf …“ | „Zeig mir die Fotos der Immobilie. Ich schneide daraus einen Rundgang mit Bildunterschriften und den Eckdaten am Ende.“ | invites in the wizard's voice, says what comes out |
| First page | 5 fields, help on one, „Titel“, „Kontakt für die Schlusskarte“ | same 5 fields, each with one line that says where it shows up in the video; „Titel“ → „Objekt“, „Kontakt“ | every field says why it is asked; „Schlusskarte“ was a word the person had not met |
| Second page | „Wie sollen die Räume wirken?“: dropdown with 5 mixed options, default „Möblieren – modern & hell“, plus „Licht“ | „Was soll mit den Fotos passieren?“: „So lassen“ / „Aufhellen und gerade richten“ (default) / „Leere Räume einrichten“; „Einrichtung“ (3 styles) only when furnishing | one question, three buttons; the default changes least; the style is asked only where it applies |
| Light | „Goldene Stunde“, „Abendstimmung“ | removed: always natural daylight | a sunset changes what is seen through the windows of a listing |
| Texts step | rows walked by the model's table; `{{facts}}` unfilled; „Lage: .“ when empty | one row per photo, fixed in code; missing answers read „(nicht angegeben)“; captions only from what is seen or given, no area, compass direction or fittings otherwise; a photo that cannot be seen gets no caption | photo and caption cannot drift apart; nothing invented |
| Texts step, value | data only | data plus `text`: the captions and the closing lines as the review shows them | the person reads the texts before the film, not JSON |
| Image prompt | removed clutter, added light mood, furniture in every mode but one | room as built, same camera and framing, nothing invented, verticals straight, natural daylight; furniture and objects stay unless „Leere Räume einrichten“; furniture only where the texts step named some | the brief; removing clutter also invents what was behind it |
| Change request for images | the converter pasted the earlier result as JSON into the image prompt | only the person's note is added | JSON in an image prompt |
| Review | „Passen die Bilder?“ (images only) | „Sieht jeder Raum aus wie auf deinem Foto?“: shows images and texts; „neu machen“ for either. With „So lassen“: „Stimmen die Texte zu deinen Fotos?“ | captions were never shown before the film; the title says what to check because the description is not shown (bug 5) |
| Ways with a `why` | none | texts → review „Die Fotos bleiben, wie sie sind.“; texts → review „Nur die Texte sind neu. Die Bilder bleiben.“; review → images „Die Person will neue Bilder.“; review → texts „Die Person will andere Texte.“ | asked for; new texts no longer make new images |
| Second review „Dein Rundgang“ | after the film, text only „Mit ‚Zurück‘ kommst du zu den Bildern.“ | removed; film → end | the result page shows the same film; everything that can be wrong is checked before the film |
| Result | „Video für Inserat … – und die Fotos einzeln.“; Rundgang mp4+png, Fotos zip+png, Texte md+json | „Dein Rundgang ist fertig. Lade ihn für Inserat, Website und Social Media herunter.“; Rundgang mp4, Aufbereitete Fotos zip+png | poster and JSON are noise for an estate agent |
| Limits | staged 21, stagedCheck 21 | plan 6, staged 6, check 11 | each new set of images costs credits |

## Test run, what it showed

Photos: the two from Matthias's run (a bookshelf, a shelf with boxes, both portrait). „Aufhellen und gerade richten“.

- Both pages as written. `when` on „Einrichtung“ arrives in the page.
- Texts: both captions empty, as the prompt demands when a photo cannot be seen. Title and four fact lines exact.
- Images: two bright, empty living rooms that have nothing to do with the photos (`run/staged-1.jpg`). `ai: "generated"`, not edited.
- Review: images, then the texts as text. Asked for other texts with a note: the texts came back as asked, the images stayed, the run stood at the review again.
- Accept → film: failed, `raw.trim is not a function`.
- Not run: new images from the review, „So lassen“, „Leere Räume einrichten“, the result page.

## What the conversion lost or left open

- `requires.optional.models: ["image"]` became required. With „So lassen“ the wizard needs no image model.
- The result step's title „Objektvideo fertig“: `result` has `message` and `downloads` only; the result page is titled like the wizard.
- The first page's title „Welches Objekt?“: the first page is titled like the wizard.
- A review's `description`: carried into the step file, shown nowhere.
- „Einzelne Bilder neu machen“: the review's answer carries no `items`; the images step runs again as a whole.
- `{{facts}}` (see above).
- `foreach` over `steps.plan.rooms` capped at 8 while the field allows 6: harmless, removed.

## Bugs and gaps (described, not fixed)

1. **A generate ask ignores `referenceImage`.** The converter passes the upload's id; `imagesOf` (`engine/steps.ts`) looks the name up as a field or a step in a state that `kernel/batteries.ts` leaves empty. The image is made from the prompt alone. For this template that is the whole job. Same for every template that edits a photo.
2. **A widget ask cannot take data.** `widgetData` (`widgets/step.ts`) reads every entry of `data` as a path: `dataRef(raw)` calls `raw.trim()`, so a list or an object throws `raw.trim is not a function`, and a plain text is looked up as a path and becomes `null`. The converter writes values. No converted widget or video can run.
3. **An agent ask does not see uploaded photos** (also in damage-report's notes): `seenPhotos` needs `{{field}}` and the run's values, both gone.
4. **`{{facts}}` of a page field is left in the text** and the note says the host fills it. The host's `facts` are the space's.
5. **A review's `description` is not shown** (`kernel/page.ts`; also in four siblings' notes).
6. **A review shows each step under its id** („staged“, „plan“), not the ask's title. A failed step is titled by its id too („film“).
7. **`why` is not kept in a run's rows**: `GET /runs/<id>/rows` has `to` but no `why` on the rows of steps that returned one. The outline shows them.
8. **Events are filed under the wrong step**: the texts step's findings („facts: …“) carry `stepId: "style"`, later `"check"`: the step before.
9. **Every image is named `staged.png`.** A zip of six photos would hold six equal names.
10. **The step preview shows the first `ask` in the file only.** A step that asks one of two reviews previews the first. For a step that ran, it shows a sample text, never images or a film.
11. **The image answer's `text` is the expanded prompt** (about 1,000 English characters). I dropped it from the step's value; where it stays, the review shows it under the image (x-post's notes).
12. The film's widget tells the language and „furnished“ from the option's wording (`/bliert|blieren|furnish/` in `film/tour.html`). I pass the word „Möblieren“ from the step. A flag in the data would be the clean way; I did not change the widget's files.

## Questions for Matthias

1. „Licht“ is gone and the light is always natural daylight. Keep it out, or bring back one evening option, marked as visualisation?
2. „Aufhellen“ no longer removes clutter. Wanted, or should tidying be a fourth choice?
3. The default is now „Aufhellen und gerade richten“, not furnishing. Right for the marketplace's first impression?
4. The review after the film is gone. Should the film have a way back to the texts instead?
5. Portrait photos: the film is 16:9 and the image step is told 16:9. Refuse portrait photos on the first page, or let the film show them with bars?
6. „Kontakt“ is asked in every run. Take it from the space's facts when it is there?
7. The English template (`wizard.en.json`) is not converted. Same changes there once these are agreed?

## Films merged (2026-11-16)

Of the three entries, only property-film is the same job as this one: a tour from property photos. facebook-video-ad and photo-ad advertise a product, from a product idea and an optional product photo. They share the film kit, not the job, so they became one wizard of their own (`facebook-video-ad`, see its notes), and photo-ad is unlisted there.

**property-film into the photo tour.** Wizard `EJflAo3AoyKm`, entry `property-photo-tour`; property-film is `unlisted`, its use cases and search words are on the photo tour.

| property-film had | Now |
|---|---|
| Camera move per room by a video model, 720p or 480p | "Bewegung" on the second page: "Fotos mit sanftem Schwenk" (default, as before), "Kamerafahrt durch jeden Raum" (720p), "Kamerafahrt, günstiger (480p)". One `clips` step, resolution from the choice, from the retouched image of each room (or the photo where they stayed). |
| Voice-over | "Mit Sprecherstimme" (off by default). `plan` writes the text only then; the review shows it under "Sprecherstimme"; `voice` speaks it; the film takes it (fixed in db7cd4a6). |
| Light choice (golden hour, evening) | Not kept: the photo tour lights rooms in plain daylight on purpose (notes above). |
| Two clip steps and two reviews after the film | One `clips` step, no review after the film (as the photo tour). |
| `tour.html` with clips and voice | One `tour.html`: clips where there are, else the stills, else the photos; voice where there is. |

Runs (real models, photos `wohnzimmer.jpg`, `kueche.jpg`):
- `D_7PYzjGolwsHYyU9b`: photos with a pan, with voice. Done. Film 18 s, 1280×720, voice heard (mean −18 dB). Frames: `walk-voice/frames.png`. The voice text says only what the photos and facts hold.
- `zdrD9shwIaeyRAlqKJ`: camera moves 480p, no voice. Done. Two clips, film 11 s. Frames: `walk-clips/frames.png`. The kitchen clip shows a balcony door the photo does not show: the video model extends the room as it moves. The prompt forbids it; the model does it anyway.

Findings:
1. The plan model puts the place into the facts at the end ("Graz · St. Leonhard" as a fact line, though it is the opening line too). Small; the prompt says "aus den Eckdaten".
2. A video model invents what lies outside the frame when the camera moves. Nothing in a prompt stops it. A shorter, slower move would show less.
3. The runtime reloads when its source changes; a widget that is rendering then fails with "Target page, context or browser has been closed" (seen on the ad run). Retry finished it.

Questions:
1. Should the camera moves stay at all, given finding 2? They cost much more and are the only part that can show something that is not there.
2. Default for the voice: off (as here) or on (as property-film had)?

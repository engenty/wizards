# facebook-video-ad + photo-ad → "Video-Anzeige für Facebook und Instagram" (0.3.0)

- Wizard: `YDLqtXfoiWfy` (0.2.0 import `iHzbfOWy18d2` left as it is). Export: `video-anzeige-0.3.0.wizard`.
- Entry `facebook-video-ad` holds it, German only. `photo-ad` is `unlisted`; its use cases and search words are here.
- Test run `9jISoTptb5NsbD7vWt`: still images with motion, 3 scenes, no voice, no product photo. Done (the film step failed once when the runtime reloaded; retry finished it). Film 16.7 s, 720×1280. Frames: `walk-stills/frames.png`.
- Not walked: video clips, the voice, a product photo.

## What differs between the two, and how it is kept

| | facebook-video-ad | photo-ad | Now |
|---|---|---|---|
| Motion | clips 720p / 480p / animated stills | animated stills only | "Bewegung": stills (default), clips 480p, clips 720p |
| Scenes | 2 or 3, 6 s each | 3 or 4, ~4 s each | "Szenen" 2–4; seconds per scene from the motion (6 for clips, 4.5 for stills), worked out in code |
| Voice | toggle, on | none | toggle, off |
| Script | still, motion, caption, voiceover | still, caption | motion and voiceover only when chosen; the word limit of the voice from the seconds, in code |
| After the film | review "Deine Anzeige" | same | removed: it had no way back; the result page shows the film |

## What changed

1. One second page for both: mood, motion, scenes, voice. Help says what clips cost and how long a scene is.
2. `script`: German prompt with the numbers already worked out (scenes, seconds, words); no raw answers block; product photo yes/no told plainly; "only what is said about the product"; exactly as many scenes as chosen, cut or padded in code; texts cut to their limits in code; a `text` for the review and the download.
3. Reviews say what to check: "Passen Hook, Szenen und Texte?", "Zeigen die Bilder dein Produkt richtig?". Change requests go back with a `why`.
4. One `clips` step instead of `clips` + `clipsDraft`; the converter had made a 480p choice run 720p first, then 480p.
5. Image prompts in English (the image model's language), with "invent no brand name or label" when there is no photo.
6. `ad.html`: the closing card leaves out the product line when the headline already names it (the run showed it twice).
7. Placeholder "Hobbyköch:innen" replaced (no gender colon in German copy).
8. Limits 6 instead of 21.

## Converter findings

1. A choice that skips a step in version 1 (`stillsCheck` → `clipsDraft` for 480p) became a step that runs 720p clips first and then 480p ones: `clips.ts` returns `to: "clipsDraft"` after making the 720p clips.
2. The raw answers block again ("# The person's answers (data)").
3. `asData("voiceOn", "yes"/"no")` in a prompt: a toggle turned into an English word.

## Questions for Matthias

1. Default motion: stills (cheap, as photo-ad) or clips (as facebook-video-ad)?
2. The entry keeps the id `facebook-video-ad` and its slugs. Rename to something without "Facebook", since it is for Instagram too?

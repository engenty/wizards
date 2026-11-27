# site-visit-booking → „Vor-Ort-Termin“ (0.3.0)

- Wizard: `kmrhFAM60ATh` in „Mein Computer“ (dev stack with the `appointments` plugin). Its 0.2.0 import `g8WXFLVzbA1W` is unchanged.
- Export: `vor-ort-termin-0.3.0.wizard`. Before the change: `before.md`. Entry `site-visit-booking` holds it, German only.

## Run

`run1.txt`: „Parkettboden abschleifen und neu ölen, etwa 45 m²“, one photo (kueche.jpg: open living room with parquet and a kitchen), „So schnell wie möglich“.
- The model saw the photo (it describes the open, nearly empty room and the parquet) and chose „Besichtigung Parkettschleifen“, 45 minutes. Nothing invented about damage.
- Free times from the first week (urgent), first one the next working day after the notice.
- Picked Di 17.11. 13:00, held, address with a map point, booked: 13:00–13:45, no place of the calendar's (the visit is at the person's), notes with address, map link, urgency, request, the corrected summary and the number of photos; `answers` keeps the address and the photo ids. PDF 200.

## What changed, and why

1. **Minutes in code.** The model picks one of 30/45/60/90/120; code turns it into the number the calendar takes and writes „wir planen 45 Minuten bei dir ein“ on the next page. The summary no longer repeats the number.
2. **„Passt das so?“ says what follows**: the kind of visit and its length above the summary and the times.
3. **Urgent looks one week ahead first**, then three weeks when nothing is free; „Bald“ looks three weeks.
4. **The time is held** as soon as it is picked; a time taken meanwhile goes back to fresh times with a sentence.
5. **No model for booking.** The note is built in code, line by line; the confirmation too, with „Bitte vorbereiten“ from the assessment. The photos are kept by id (the old prompt asked a model for „names“ it never saw).
6. The assessment's prompt: photos as `upload:` refs the model sees directly (no read_document), German, no invention, no guessing at causes. `classifier` dropped from `requires.models` (no step used it).
7. Confirmation download: PDF only.

## What the conversion lost or left open

- The converter appends „Weitere Angaben (Daten)“ to the assessment with answers of later pages (plan, you) that do not exist yet at that point. They are empty at run time, so harmless, but the code reads as if the model got them.
- `landing.json` untouched. `pluginStarter: "appointments.visit"` stays: see appointment-booking's notes, bug 1.

## Questions for Matthias

1. Should the photos go into the booking as files (the owner sees them in the calendar), not only as ids?
2. Is a week the right look-ahead for „So schnell wie möglich“?

# web-job-application → 0.3.0 (one prompt)

- Wizard: `Lq6epf5a95ho` (0.2.0 import `2xctoh_qo2TT`).
- Test run: `UVjRdc1vxBepKXWX27`, done. A CV as PDF and a voice note (made with `say`, transcribed by the run's `/transcribe`). The profile lists the three stations, training and skills exactly as in the CV, quotes the voice note, and asks open questions; it flagged "six years" said vs. about 8.5 years in the CV.
- Export: `web-job-application-0.3.0.wizard`.

## What changed
- `input` plus one step `profile.ts`; raw-answers block gone (it repeated the upload id and the voice note's asset JSON).
- Without a CV the prompt says so instead of naming no file.
- No invention of stations, dates or skills; nothing on age, origin, family or looks.

## Converter
- The raw-answers block dumps the audio value as JSON (`asset`, `transcript`) and the upload ids into the prompt.

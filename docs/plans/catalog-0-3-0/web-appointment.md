# web-appointment → 0.3.0 (one prompt)

- Wizard: `zppyBUyxbfpn`, from import `J1YLu_0h2bxQ`. Test run `m37EaNIwAsg7XobPAU` (Vermietung, typed text), done.
- Shape: `input` plus `steps/checklist.ts` with one agent ask. Export `web-appointment-0.3.0.wizard`.
- Checked by hand: the five documents are exactly the Vermietung section of `kanzlei.md`; duration, cost and place as there; no tax advice.

## What changed
- The checklist addressed the person with „Sie“ while the wizard says „du“; now „du“ throughout.
- An anliegen with no section in `kanzlei.md` falls back to the general part. The prompt forbids figures, deadlines or documents that are not in the file or the story.
- A voice note without speech no longer puts an English placeholder into a German prompt.
- The raw-answers block is gone.

## Questions
- A tax office usually says „Sie“. Should the template keep „du“ like every other web wizard?
- The voice note was not walked (no recorder here).

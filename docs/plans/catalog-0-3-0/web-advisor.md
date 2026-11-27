# web-advisor → 0.3.0 (one prompt)

- Wizard: `Wwy2Wvc4KOGb` („Welches Rad passt zu mir?“), from import `ujCfxTj5HHQp`. Test run `f2PEmO41TNVgLwNhPK`, done.
- Shape: `input` plus `steps/advice.ts` with one agent ask. Export `web-advisor-0.3.0.wizard`.
- Checked by hand: both models, prices, frame size L for 182 cm and links match `sortiment.csv`.

## What changed
- The frame size is worked out in code from the height; a missing or odd height is left out of the prompt.
- The converter's raw-answers block and its helpers are gone. The prompt forbids inventing models, prices or links.
- Working line with a subject; closing sentence in full.

## Found
- The converter keeps `read_workspace_file` working with `tools: []`; fine, but the step's need for the file is nowhere in `requires`.

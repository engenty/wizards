# web-dayplan → 0.3.0 (one prompt)

- Wizard: `A3yh0vjIzhAZ`, from import `9-6e0sfUvEta`. Test runs `2wJHUWOyG4L3sBhGHQ` and `PqyOLwhv6IOhYLVQrS` (after a wording fix), both done.
- Shape: `input` plus `steps/plan.ts` with one agent ask and the `http` tool. Export `web-dayplan-0.3.0.wizard`.
- Checked by hand: the weather call went to api.open-meteo.com (tool event); every place, time and price is in `tipps.md`; „ohne Auto“ left out Pyramidenkogel and Buschenschank.

## What changed
- `requires.hosts: ["api.open-meteo.com"]`: a visitor's (guest's) run reaches no host that is not named. The version 1 template named none.
- The code works out how far the day is; beyond 14 days or in the past the model fetches no weather and plans with rain alternatives.
- The date is written „Donnerstag, 19.11.2026“ by code. The car toggle becomes a sentence, not „yes/no“.
- The first run wrote „Preis laut Tipps nicht angegeben“ several times; the prompt now says to leave out what the file does not name.
- The raw-answers block is gone.

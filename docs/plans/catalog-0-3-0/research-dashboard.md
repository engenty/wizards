# research-dashboard → „Dashboard aus Recherche“ (0.3.0)

- Wizard: `jgvH06wNPW0f`, its 0.2.0 import `irxKe01y8siT` left as it is.
- Test run `Koynk1T_okI-yxTnww`: done. Topic: BEV registrations in Austria 2020–2024. Dashboards: `dashboard.html` (first), `dashboard-2.html` (after one change request). Export `dashboard-0.3.0.wizard`, in the manage entry `research-dashboard`.
- Shape: `input` + `data.ts` (agent) + `dashboard.ts` (generate) + `check.ts` (review, as the template had). Not one step file: a step whose value has files keeps no data, so the data download (xlsx, csv, json) needs the agent's value as its own step, and a review can only show a step that returned.

## The run, checked by hand

Every figure matches Statistik Austria: BEV 2020 15.972 (6,4 %), 2021 33.366 (13,9 %), 2022 34.165 (15,9 %), 2023 47.621 (19,9 %), 2024 44.622 (17,6 %), all cars 2024 253.789. Each figure carries its source URL; four of the yearly ones come from a site quoting Statistik Austria rather than Statistik Austria itself. The dashboard shows them unchanged. The change request („Lass den Vergleich 2023 und 2024 weg“) removed that chart and kept every figure. All six downloads answer 200.

## What changed

1. The agent gets fixed columns (kpis: label, value, unit, change, source; series: label, value, unit, source), a rule that every figure must stand in a source it opened, German output. Empty period/region are left out.
2. The dashboard prompt gets the figures as German tables built in code, not the converter's JSON dump; no raw-answers block; a change request keeps all figures.
3. Review title says what to check; ways have a `why`; limits 5 instead of 21.
4. `classifier` dropped from `requires.models`; intro and result message rewritten.

## Bugs found (not fixed)

1. The review ask comes to the run page with `approve: false, edit: false` although nothing sets them; accepting works anyway.
2. `POST /reviews/<step>` with `regenerate` wants `target`, not `stepId`; the error says only `expected string` at `target`.
3. The converter's `revision()` puts `text(before)` of a step that made files into the prompt, which is always empty.

## Questions

1. Should the agent be told to prefer the primary source (Statistik Austria) over sites that quote it?

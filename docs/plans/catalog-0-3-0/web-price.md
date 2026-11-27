# web-price → „Was kostet das Ausmalen?“ (0.3.0, one prompt)

- Wizard: `QResoUydgRmi` (space „Mein Computer“), its 0.2.0 import `Z7X2Sspgb8a8` left as it is.
- Test run `DZeEf7BFPgN8uYVWWV`: done. Export `richtpreis-0.3.0.wizard`, document `richtpreis.html`, written into the manage entry `web-price` (0.3.0, German only).
- Shape: `input` + one step file `steps/price.ts` with three asks: agent (read the rooms, copy the price list), form (confirm quantities), generate (the document). Draft: no issues.

## Test run, checked by hand

Input: Wohnzimmer 24 m², Schlafzimmer 14 m², Vorzimmer without area, two doors; walls, ceilings, doors; colour of choice; cracks.
The form showed 54 m² floor (16 m² assumed for the Vorzimmer, said in the assumptions), walls 140 m² (54 × 2,6 = 140,4), 2 doors as read. I changed doors to 3.

| | Expected | Document |
|---|---|---|
| Wände 140 × 11,50 | 1.610,00 € | 1.610,00 € |
| Decke 54 × 10,50 | 567,00 € | 567,00 € |
| Spachteln 140 × 6,00 | 840,00 € | 840,00 € |
| Türen 3 × 145,00 | 435,00 € | 435,00 € |
| Abdecken 3 × 45,00 | 135,00 € | 135,00 € |
| Anfahrt | 90,00 € | 90,00 € |
| Netto / USt 20 % / Brutto | 3.677,00 / 735,40 / 4.412,40 € | same |

PDF download answers 200. No contact data invented (the space has no brand).

## What changed, and why

1. Three step files became one. The second form stays: it is where the person fixes quantities, which the price depends on.
2. The model only reads rooms (name, floor area if given), door and radiator counts if given, and copies preise.csv. Areas, quantities, which price-list lines apply, amounts and sums are code. v1 had the model build the positions.
3. The assumptions are written by code and shown on the confirm page and in the document.
4. The document gets a German table with the sums (the converter's table was English: „Amount“, „Net“, „VAT“), no raw-answers block, a rule against invented contact data.
5. `requires.models`: `classifier` dropped (nothing used it). Intro without dash.

## Bugs found (not fixed)

1. **An agent ask with an output field of kind `number` fails on the Claude Code harness:** `--json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. The schema handed to `claude --json-schema` carries `$schema: 2020-12` in that case, and Claude Code 2.1.317 rejects it (reproduced with the CLI directly). Worked around with `kind: "text"`.
2. Converter: same as before, the raw-answers block and English tables.

## Questions

1. The price list is read by a model and copied; a step file cannot read a workspace file. Should step code read `preise.csv` itself?
2. Doors and radiators are not asked on the first page; the code assumes one per room unless the text names a count. Add two number fields instead?

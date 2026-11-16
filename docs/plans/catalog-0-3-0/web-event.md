# web-event → 0.3.0 (one prompt)

- Wizard: `zjIyBjt0iP7h` (0.2.0 import `8mMoedKAZ3-K`), space "Mein Computer".
- Test runs: `di3OknxkMfGBBM1XnY` (Taufe, 28 Gäste); after the prompt change a second run (Firmenfeier, 45 Gäste, Musik bis 2 Uhr) finished done. Both checked against `angebot.md`: rooms, menus, prices, Sperrstunde and Verlängerung exactly as there, nothing invented.
- Export: `web-event-0.3.0.wizard`.

## What changed
- `input` plus one step `proposal.ts` with one agent ask; output and result as converted.
- The converter's block "# The person's answers (data)" is gone; answers stand once, as lines, empty ones left out.
- The prompt forbids inventing rooms, dishes, prices or terms, and tells the model to talk to the guest, not about the file (the first run wrote "steht im Angebot nicht").
- "So geht es weiter" asks the guest to call, matching the result message; no promise of a call back.

## Converter
- Appends the raw answers to a prompt that already holds them (as in every conversion).
- Keeps `<data>` tags inside a Markdown heading of the outline the model copies.

## Questions
- The first run offered the Hirschensaal (30–80) for 28 guests and said so. Should the template allow a room below its minimum?

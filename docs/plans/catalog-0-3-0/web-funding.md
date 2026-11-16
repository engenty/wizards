# web-funding → 0.3.0 (one prompt)

- Wizard: `KGhCz2lQun1n` (0.2.0 import `Ub3xf1KC5ceT`).
- Test run: `Rv3QjOt072-QSTqnq6`, done (Heizung tauschen, Steiermark, Einfamilienhaus 1978). Two programmes with sources (Bund Kesseltausch via sanierungsoffensive.gv.at, Land Steiermark), budget states and dates, an assumption about the current heating stated, no Gemeinde checked and said so. Sources not each re-opened by hand.
- Export: `web-funding-0.3.0.wizard`.

## What changed
- `input` plus one step `research.ts` with web_search and web_fetch; raw-answers block gone.
- Today's date is given to the model, written `16.11.2026` from `run.today` without `Intl` (QuickJS).
- An empty Baujahr leaves its line out; the heading uses plain values, not `<data>` tags.
- Every figure needs an opened source; no programme, amount or deadline invented.

## Questions
- The answer is long (two programmes with full detail). Should the template ask for the current heating on the first page? The model had to assume it.

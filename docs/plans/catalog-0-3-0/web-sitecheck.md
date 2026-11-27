# web-sitecheck → „Website-Check in 60 Sekunden“ (0.3.0, one prompt)

- Wizard: `HnQlK2JeCv81`, its 0.2.0 import `5BnMrEOXSc4M` left as it is.
- Test run `8PWlHdJt3F4cA2bcYc`: done, on https://engenty.ai with goal „Anfragen“. Answer in `check.md`. Export `website-check-0.3.0.wizard`, in the manage entry `web-sitecheck`.
- Shape: `input` + `steps/check.ts` with one agent ask. The converter already made it one step.

## The run, checked by hand

Five improvements with quotes from the start page and the templates page, two good points, a note that title and meta description were not visible in the fetched text. The quotes match the page's English text. Nothing on load time or rankings. PDF download answers 200.

## What changed

1. The address is checked and completed (`https://`) in code. The converter put `<data field="url">…</data>` into the report's heading, which would have shown in the result.
2. Raw-answers block gone. The goal is named inside each „Warum“.
3. Rules: every quote word for word, no invented content, one sentence and stop when the page can't be opened.
4. Title „Website prüfen“, working line „Ich sehe mir deine Website an …“, intro without dash.

## Bugs found

None new. The converter wraps a value in `<data>` even where it goes into the text the model must write out (the heading).

## Questions

1. The answer is written in German even for an English site. Should the report follow the site's language?

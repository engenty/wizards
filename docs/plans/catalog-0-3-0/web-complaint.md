# web-complaint → 0.3.0 (one step file)

- Wizard: `Orz38hq_3Nwx`, from import `c5mmhSKIaPxA`. Test run `tA_igQhIZuTWWycH_C`, done. Document: `report.html`.
- Shape: `input` (photos, order, story), then one step file `steps/report.ts`: the contact page as a form ask, one agent ask for the description, one generate ask for the document. The converter had made three step files (who, summary, report); `start`/`edges` set to `report` by hand.
- Checked by hand: the test photo shows a whole kitchen, the story claims a crack. The description says the crack is not visible and asks for a close-up; nothing invented. Header data as typed.

## What changed
- Header table and the date („16.11.2026“) are built in code; the document prompt says to take everything word for word.
- The photos are passed to the document step as `upload:` ids, not through an appended answers block.
- „Fehlt noch“ only when something is missing; the order number is named only when it is.

## Found
- The document shows its title twice („Reklamation vom …“ as page title and heading), as claim found.
- A step file deleted in the studio leaves its name in `start` and `edges`; the studio has no way to change `wizard.json`, only `PUT /draft`.
- A generate ask needs the photos named in its prompt; nothing hands it the run's uploads.

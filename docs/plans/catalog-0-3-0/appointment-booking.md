# appointment-booking (+ booking-link) → „Termin buchen“ (0.3.0)

- Wizard: `Z5x1JjQK2FTm` in „Mein Computer“ (dev stack with the `appointments` plugin). Its 0.2.0 import `Vr6cBa_gF5Hb` is unchanged.
- Calendar of the dev space: default office hours Mo–Fr 9–17, two places set for the test („Im Büro“, „Videocall“ / Google Meet).
- Export: `termin-buchen-0.3.0.wizard`. Before the change: `before.md`.
- Entry: `appointment-booking` holds the merged wizard; booking-link's use cases and search terms are added to its `entry.json`; booking-link is `unlisted`. German only.

## Runs

| Run | What | Result |
|---|---|---|
| `ja6lJe6GAvdHq31JMf` | Beratung · 60 Minuten, Im Büro, Di 17.11. 10:00 | Booked, confirmed in the plugin (test), place kept, the hold became the booking. PDF 200. |
| A `YlFHER4KeAvUqC8VXs`, B `lVzqZUHrP91tQJeX6Q` | Two runs pick Mi 18.11. 14:00; A holds first | B is sent back: „Diese Zeit ist inzwischen vergeben …“ above fresh free times without 14:00; B booked 15:00. A cancelled: its hold went, 14:00 free again. |
| `MQs5gFb8XnngOxCPjX` | `LEISTUNGEN` with one entry | No service page: free times come first, as booking-link did. Booked Mi 18.11. 14:00, Google Meet. |

## What changed, and why

1. **One wizard for both.** The services are a list in `lib/leistungen.ts` (name, minutes). One entry: the wizard asks nothing about it and starts with the free times (booking-link). Several: the person chooses first (appointment-booking). No minutes in brackets to parse.
2. **Free times before personal details.** Service → free times → time (and place) → name, e-mail → booked. booking-link's order; nobody types their details before knowing a time fits.
3. **The place is asked whenever the calendar has several**, and booked by its id. appointment-booking never asked, so its bookings had no place with two locations.
4. **The time is held** (`appointments.hold`, 20 min) as soon as it is picked.
5. **No model.** Booking is a tool ask from code; the confirmation is written in code from what the calendar returns (label, place, its note, .ics and cancel links). `requires.models` is empty.
6. **A time taken meanwhile** (at hold or at booking) goes back to the free times with a sentence saying so; no dead end. Limits 4–6 for these loops.
7. Confirmation download: PDF only.

## What the conversion lost or left open

- The converter kept the agent step that books; there is no way for it to know a tool call would do.
- `landing.json` still describes appointment-booking's old first page (name and e-mail first).
- `entry.json` keeps `pluginStarter: "appointments.book"`. A runtime with the plugin hides the catalog copy and offers the plugin's own starter, which is still version 1 (`plugins/appointments/src/starter.ts`). So where the plugin runs, this 0.3.0 entry is not what people get.

## Bugs and gaps (described, not fixed)

1. The plugin's starters (`appointments.book`, `.link`, `.visit` in `starter.ts`) are version 1 and win over the catalog's entries. They need the same rework, or the entries need to stop naming them.
2. `location_choices` shows an online place by its service („Google Meet: https://…“), not by its name („Videocall“).
3. With no free time at all in three weeks the time page has a required slot field with no options: the person is stuck. Not handled here (see questions).
4. The run page for a test run (`/work/r/<run>`) redirected to the studio home in the browser; the pages were walked over the API only. The slot field itself is unchanged from version 1.

## Questions for Matthias

1. Services as a code list (`lib/leistungen.ts`), or should a 0.3.0 wizard have a place for settings an owner edits without code?
2. No free time: end with „Gerade ist nichts frei, wir melden uns“ and take name and e-mail, or point to the phone?
3. Should the plugin's own starters go, now that the catalog entries are the same flows in 0.3.0?

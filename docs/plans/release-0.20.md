# Plan: release 0.20, Work and the page

Status: plan, written on 2026-11-16 against `main` at `4bbbfd0b`. Branch `release/0.20.x`.
The next lines follow it: 0.21 the tool harness (2026-11-25), 0.22 the new wizards format, 0.23 the
move to the wizards domains. The branches `release/0.21.x` and `release/0.22.x` were cut before this
order and hold nothing of their own.

## In short

Two modes that are built but switched off become what everyone gets:

- **Work**: the space's chats with its AI, the Studio · Work switch, and Work's places past the
  chats. Built behind `workMode` (#331), the places behind `workWip`.
- **The page**: the organization's own page at `<team>.wizards.page`, with its home, its
  wizards and a way to get in touch. Step 1 is live since v0.17.0 (`docs/plans/org-page.md`),
  the rest behind `pages`.

0.20 is done when `workMode` and `pages` are on by default and a new organization finds both
without a switch.

## Where it stands

| Part | Switch | State on `main` |
|---|---|---|
| Work's chats, the mode switch, Work's start page | `workMode` (off) | built (#331, #487) |
| Work's bell („Wartet auf dich“) | `workWip` (off) | built (`WaitingPlace` in `studio/work/WorkPages.tsx`) |
| Work's engenties, files, data, results | `workWip` (off) | empty places (`EmptyPlace`) |
| Ordner with Infos, Dateien, Ergebnisse | `orgSpaces` (on) | built (`docs/plans/org-spaces.md`, step 4) |
| The page served by the portal app | `pages` (off) | step 1 live since v0.17.0 |
| The page's home and its settings | `pages` | not built (org-page step 2) |
| Wizards and contact on the page | `pages` | not built (org-page step 3) |
| Client spaces and the portal | `clientSpaces` (off) | version 1 and phase 1 built (`docs/plans/client-portal.md`) |

## Steps

One pull request each into `release/0.20.x`, in this order. Each keeps its part behind its
switch until step 7.

### Work

1. **Ergebnisse in Work.** The results of the space's runs and chats in one place, as the
   folder page lists a folder's (`run.chatId`). Leaves `workWip`.
2. **Dateien in Work.** The space's files, the files of its chats and the linked drives
   (`dateien`), as the folder page shows them for one folder. Leaves `workWip`.
3. **Daten in Work.** The wizards' shared data that Space › Daten shows (#598), read-only, with
   CSV export. Leaves `workWip`.
4. **The bell leaves `workWip`.** Built; it moves out of the switch with the three above.
   Engenties stay behind `workWip`: the persona record is after step 3 of
   `docs/plans/work-chats.md` and not in 0.20.

### The page

5. **The home and its settings** (org-page step 2). `home` and `spaces` in the page data,
   Settings › Organisation › Öffentliche Seite in Studio, the home in the portal app, the plan
   checks in the Manage-App (a pull request there too).
6. **Wizards and contact** (org-page step 3). The public wizards on the home, and the contact
   form into the contacts plugin, with consent.
7. **Who offers it.** The run page (`runner/PublicRunner.tsx`) and the page name the
   organization: its imprint from Info, its privacy notice, a line that an AI answers, a link to
   report the wizard (org-page, open point 4).

### The switches

8. **`workMode` and `pages` on by default.** `workWip` keeps only the engenties. `docs/content/user-guide/work-mode.md` (at 0.13.0) says
   what Work is now, and a page says what the organization's page is, each with `version:`.

## How the branch lands

- Pull requests into `release/0.20.x` merge by hand once the checks pass
  (`gh pr merge <n> --squash`): the branch has no protection rules, so auto-merge is refused.
- The branch takes `main` in as it moves (`git merge origin/main`), so it never drifts.
- When step 8 is in, one pull request brings `release/0.20.x` into `main`, then
  `pnpm release` cuts the release from `main`.

## Open

1. **The version** (decided 2026-11-16). Work on this line is pushed, not released: no release
   is cut until step 8 is in. v0.20.0 (#702) was tagged from `main` on 2026-11-16, without Work
   or the page.
2. **Client mode.** The Client mode comes with the page (`workMode`'s hint). Does
   `clientSpaces` and the portal's phase 2 (`docs/plans/client-portal.md`: streaming, hand-off,
   uploads, mails) ride in 0.20, or come later?
3. **`wizards.page` on the Public Suffix List** before more teams get a page (org-page, open
   point 5). The request takes weeks; it can go in now.
4. **The portal's secret on Manage.** `RUNTIMES` lacks `portalUrl` and `portalSecret`, so
   client sign-in doesn't work in production yet. Needed only if open point 2 says yes.
5. **The Manage-App's side.** Step 5 needs a pull request in `engenty-wizards-manage`; it
   ships before this branch reaches `main`.

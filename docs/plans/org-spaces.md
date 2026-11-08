# Plan: organization, spaces and folders

Status: decided on 2026-11-08, built behind `orgSpaces` (off by default): steps 1–5 below. Not built yet: a folder's linked drive (mounts are a local install's, behind `dateien`). The mockups: the
artifact "Organization, Spaces and Folders" (claude.ai/artifact/8eL7YzxQJPcQAeP5SgZNeS).

As in Google Drive: Mein Space is yours, spaces are shared, folders sort what is inside. The
organization holds what everyone shares. The app bar stays on the edge; a path across the top
says which space and folder you are in and switches space from its first step. The sidebar holds
only the space you are in.

## Decided

| | Decision |
|---|---|
| The root | Every organization has one root space (`parentId` null). It carries the organization's name and holds what everyone uses: brand, Info, Wissen, Daten, wizards. It is the first entry of the space menu ("alle") and its page is behind the house |
| Mein Space | One per person and organization (`kind: "personal"`, one member). Only that person sees it. Alone (Free, a local install) the root is the one space and shows as the person's own |
| Spaces | The boundaries. Every space other than the root has the root as parent and reads it, as client spaces read their parent today. Two levels, never more |
| Sharing | Any space is shared with members (`space_member` role `member`) and with outside people as Kund:in (role `client`). A space with Kund:innen shows violet. `kind: "client"` folds into this |
| Ordner | Work only. Work's sections (`chat_section`) become folders: they sort chats and hold Infos, Dateien and Ergebnisse, and may link a drive. Not a boundary |
| Frame | The app bar on the edge stays. The top bar is the path: the sidebar toggle, the space (its menu switches) and the folder, two steps at most, then search. A single space shows the organization's name and no menu |
| The space menu | The organization's root ("alle"), Mein Space ("nur du"), the spaces used last, "Alle n Spaces", "Neuer Space" |
| Studio | "Wizards" is its own item in the app bar. The list shows the space's own wizards and those the organization gives every space |
| Organization switching | Not a use case: platform admins switch under Konto › Organisationen |
| Your computer | The install's root syncs to the cloud root of the person's own organization (Free), or to their Mein Space in another; spaces with Kund:innen stay out of the sync |

## Proposed, not yet decided

1. The word for your own space: „Mein Space“ (alternatives: „Persönlich“, „Meine Ablage“).
2. What a Kund:in sees of a space: the chats they are in, what they uploaded, results marked
   "geteilt", wizards marked "für Kund:innen". Never folders, Daten or the organization's Wissen.
3. New spaces are shared with all members by default.
4. A space may replace brand and Info as a whole; its own Wissen, Daten and wizards add to the
   root's.
5. The plan's space limit counts shared spaces only; Mein Space and spaces with Kund:innen do not.
6. A solo organization's first invitation turns the root into the shared root; the owner gets an
   empty Mein Space.
7. The root is a place to work (first entry of the menu) and its page (the house).

## Steps

1. **Root and Mein Space** (runtime, built: `services/spaces.ts`, `services/space-parent.ts`): the root per organization, Mein Space per person, every
   other space under the root and reading it; existing spaces and client spaces move under the
   root once.
2. **Frame** (studio, built: `studio/SpacePath.tsx`): the path bar with the space menu; the space tile and the organization menu
   go; "Wizards" in the app bar.
3. **Teilen** (built: `services/client-spaces.ts`, `studio/work/ShareSpace.tsx`): the share dialog with Mitglied and Kund:in for any space.
4. **Ordner** (built: Infos the AI reads; Dateien from its chats; Ergebnisse of the runs started in them, `run.chatId`; the folder page, `studio/work/FolderPage.tsx`):
   sections become folders with Infos, Dateien, Ergebnisse and a linked drive; the folder page.
5. **Your computer** (built: `placeArrivingSpace` in `services/spaces.ts`): the sync rule above.

# Plan: organization, spaces and folders

Status: decided on 2026-11-08, built behind `orgSpaces` (off by default): steps 1–6 below. The mockups: the
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
| Spaces | The boundaries. Every space other than the root has the root as parent and reads it. Two levels, never more |
| Sharing | Any space under the root is shared with members (`space_member` role `member`) and with outside people as Kund:innen (role `client`); the root and a Mein Space never. A space with Kund:innen shows violet. Client spaces folded into this on 2026-11-14 (migration 0076) |
| Ordner | Work only. Work's sections (`chat_section`) become folders: they sort chats and hold Infos, Dateien and Ergebnisse, and may link a drive. Not a boundary |
| Frame | The app bar on the edge stays. The top bar is the path: the sidebar toggle, the space (its menu switches) and the folder, two steps at most, then search. A single space shows the organization's name and no menu |
| The space menu | The organization's root ("alle"), Mein Space ("nur du"), the spaces used last, "Alle n Spaces", "Neuer Space" |
| Studio | "Wizards" is its own item in the app bar. The list shows the space's own wizards and those the organization gives every space |
| Organization switching | Not a use case: platform admins switch under Konto › Organisationen |
| Your computer | The install's root syncs to the cloud root of the person's own organization (Free), or to their Mein Space in another; spaces with Kund:innen stay out of the sync |

## Decided on 2026-11-08 (the open points)

| | Decision |
|---|---|
| Your own space | „Mein Space“ / "My space" in an organization. On a computer alone the one space is „Lokaler Space“ / "Local space" |
| What a Kund:in sees | The chats they are in, what they uploaded, results marked "geteilt", wizards marked "für Kund:innen". Never folders, Daten or the organization's Wissen |
| Who sees a new space | Asked in the „Neuer Space“ dialog: everyone in the organization, or only the people chosen (`space.access`: `all` or `members`). Changed later in Teilen |
| Brand and Info | Each space chooses: take the organization's (`space.brandFrom: "root"`, kept in step with the root) or its own (`"own"`). New spaces and Mein Space start with the organization's. Wissen, Daten and wizards always add to the root's |
| Space limit | Counts shared spaces only, the root among them; Mein Space and spaces with Kund:innen do not |
| A solo organization's first invitation | The root becomes the shared root; the owner gets an empty Mein Space |
| The root | A place to work (first entry of the menu) and its page (the house) |

## Steps

1. **Root and Mein Space** (runtime, built: `services/spaces.ts`, `services/space-parent.ts`): the root per organization, Mein Space per person, every
   other space under the root and reading it; existing spaces move under the root once, client
   spaces by tenant migration 0076.
2. **Frame** (studio, built: `studio/SpacePath.tsx`): the path bar with the space menu; the space tile and the organization menu
   go; "Wizards" in the app bar.
3. **Teilen** (built: `services/client-spaces.ts`, `studio/work/ShareSpace.tsx`): the share dialog with Mitglied and Kund:in for any space under the root. A client gets skills and the wizard's own data by the seed; the space's Knowledge and wizards, and the root's, only item by item (Space › Kund:innen: Wizards für Kund:innen, „Für Kund:innen sichtbar“). A client's run carries the space it was started in (`run.client_space_id`), whichever space its wizard is in.
4. **Ordner** (built: Infos the AI reads; Dateien from its chats and a linked mount, `chat_section.mountId`, behind `dateien`; Ergebnisse of the runs started in them, `run.chatId`; the folder page, `studio/work/FolderPage.tsx`):
   sections become folders with Infos, Dateien, Ergebnisse and a linked drive; the folder page.
5. **Your computer** (built: `placeArrivingSpace` in `services/spaces.ts`): the sync rule above.
6. **The open points** (built): the decisions of the table above: „Lokaler Space“, the choice in
   „Neuer Space“ and in Teilen, brand and Info taken or own (Space › Info and Marke), the limit.

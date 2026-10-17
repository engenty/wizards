---
title: The studio half
description: Pages, icons in the app bar, sections of the settings and of the space page – written in React, built once, drawn inside the studio.
version: 0.5.0
---

The studio half is `ui/plugin.tsx`. Its default export is a function; the studio calls it after
sign-in and hands it `studio`. What the plugin draws is part of the studio: the same React, the
same router, the same components.

```tsx
import { defineStudioPlugin } from "@engenty/wizards/plugin/studio";
import { Button, Card, Empty, Spinner } from "@engenty-wizards/web/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";

interface Person {
  id: number;
  email: string;
  name: string | null;
  wizard: string;
}

const messages = {
  de: {
    title: "Kontakte",
    hint: "Wer einen Wizard bis zum Ende durchlaufen hat.",
    empty: "Noch keine Kontakte.",
    remove: "Entfernen",
  },
  en: {
    title: "Contacts",
    hint: "Everyone who ran a wizard to its end.",
    empty: "No contacts yet.",
    remove: "Remove",
  },
};

export default defineStudioPlugin((studio) => {
  const t = studio.i18n.register(messages);

  function ContactsPage() {
    const list = useQuery({
      queryKey: ["contacts"],
      queryFn: () => studio.api.get<{ contacts: Person[] }>("/"),
    });
    const cache = useQueryClient();
    const remove = useMutation({
      mutationFn: (id: number) => studio.api.del(`/${id}`),
      onSuccess: () => cache.invalidateQueries({ queryKey: ["contacts"] }),
    });
    const admin = studio.me().tenant.role !== "member";
    return (
      <div>
        <h1 className="font-display font-semibold text-[1.75rem] tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-[0.9375rem] text-ink-3">{t("hint")}</p>
        <div className="mt-8 flex flex-col gap-2">
          {list.isLoading ? <Spinner className="mx-auto" /> : null}
          {list.data && !list.data.contacts.length ? <Empty>{t("empty")}</Empty> : null}
          {list.data?.contacts.map((person) => (
            <Card key={person.id} className="flex items-center gap-3 px-5 py-3.5">
              <span className="min-w-0 flex-1 truncate font-medium text-[0.9375rem]">
                {person.name ?? person.email}
              </span>
              <span className="text-[0.8125rem] text-ink-3 max-sm:hidden">{person.wizard}</span>
              {admin ? (
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(person.id)}>
                  {t("remove")}
                </Button>
              ) : null}
            </Card>
          ))}
        </div>
      </div>
    );
  }

  studio.registerPage({ path: "/contacts", component: ContactsPage });
  studio.registerNav({ to: "/contacts", label: () => t("title"), icon: Users });
});
```

## What it registers

| Call | Adds |
|---|---|
| `studio.registerPage({ path, component, wide? })` | A page of the studio at `/studio<path>`, inside the studio’s frame. `path` takes `:name` parts. `wide`: the page lays out its own columns and takes the screen’s width |
| `studio.registerNav({ to, label, icon })` | An icon in the app bar that opens a page |
| `studio.registerSettingsSection({ id, label, icon, component, menu? })` | A section of the settings at `/studio/settings/<id>`. `menu`: the user menu links to it directly |
| `studio.registerSpaceSection({ id, group?, label, hint?, component })` | A section of a part of the space page at `/studio/space/<group>#<id>`, below the part’s own. See [The space](#the-space) |
| `studio.registerSpacePart({ id, label, icon, after?, component })` | A part of the space page of the plugin’s own, at `/studio/space/<id>`. See [A part of the plugin’s own](#a-part-of-the-plugins-own) |
| `studio.registerShareSection({ runner, component })` | A runner’s own settings for a wizard (a keyword), under the share dialog’s gear once the runner is on and set up. See [Runners](./runners.md#the-runners-part-of-the-share-dialog) |
| `studio.registerShareSetup({ runner, title, component, notice? })` | What “Set up” in the runner’s row opens: a view inside the share dialog, with its buttons at the dialog’s foot, and a banner of the runner’s news. See [Runners](./runners.md#setting-up-inside-the-dialog) |
| `studio.registerAssistantCard({ tool, component })` | A card in the assistant’s chat for what a tool of the server half returned. See [The space](./space.md#a-card-in-the-chat) |

- The studio’s own addresses are taken: `/new`, `/edit`, `/settings`, `/space`, `/setup`,
  `/sign-in`.
- The settings’ own sections are taken as ids: `account`, `team`, `connectors`, `models`,
  `integrate` and `plugins`.
- `label` is a function, since the language can change while the studio is open.
- `icon` is a component that takes `className`: any icon of `lucide-react`.

A settings section draws its own heading and cards:

```tsx
function ContactsSettings() {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="px-1 font-display font-semibold text-lg leading-tight">{t("title")}</h2>
      <Card className="p-5 text-[0.875rem] text-ink-2">…</Card>
    </section>
  );
}

studio.registerSettingsSection({
  id: "contacts",
  label: () => t("title"),
  icon: Users,
  component: ContactsSettings,
});
```

## The space

A space holds what all its wizards share: a title, logos, colours, facts and Knowledge. The
space page, behind the house icon (Space) in the app bar, shows them in four parts:

| Part | `group` | Holds |
|---|---|---|
| Info & brand | `info` | Basics, Facts, Logos, Colours, Brand assets |
| Knowledge | `knowledge` | Documents, pages, tables and files with their categories: what every AI step looks things up in |
| Data | `data` | What the wizards keep |
| Results | `results` | The runs that reached their result |

A plugin adds a section to one of them, below the part’s own:

```tsx
function ContactsOfSpace() {
  const space = studio.useSpace();
  const list = useQuery({
    queryKey: ["contacts", space?.id],
    queryFn: () => studio.api.get<{ contacts: Person[] }>(`/?space=${space?.id}`),
    enabled: Boolean(space),
  });
  return <Card className="p-5 text-[0.875rem] text-ink-2">…</Card>;
}

studio.registerSpaceSection({
  id: "contacts",
  group: "data",
  label: () => t("title"),
  hint: () => t("hint"),
  component: ContactsOfSpace,
});
```

- `group` is the part; without one the section stands under Knowledge.
- The studio draws the heading and the hint above the section, as it does for the space’s own,
  and lists the section in the part’s menu under the plugin’s name. The component draws the
  rest, usually a `Card`.
- `id` is the section’s anchor: `/studio/space/data#contacts` opens the page there, and so does
  `/studio/space#contacts`. In Knowledge a section is a page of its own:
  `/studio/space/knowledge?show=s:<id>`, where `#<id>` leads too. Ids are unique on the whole
  page; the space’s own are taken: `base`, `facts`, `logos`, `colors`, `typography`, `assets`,
  `documents`.
- `studio.useSpace()` is a hook: `{ id, name, readOnly, brand }`, or `null` while there is none.
  A component that calls it draws again when the person picks another space, or changes its
  brand. `readOnly`: the space is edited in engenty wizards on a computer and only shown here,
  or nothing is built on this runtime. Show it, but change nothing. `brand` is what Info & brand
  holds of the look: `name`, `colors` (`{ name, value }`, the first is the accent) and `fonts`
  (`{ family, role, weights }`).
- Every wizard belongs to a space: a [run event](./events.md) names it as
  `wizard.projectId`. Keep it with what the plugin stores to show a space’s part of it.

### A part of the plugin’s own

A plugin whose subject is as big as one of the parts adds a part of its own: an entry in the
parts’ menu, with a page at `/studio/space/<id>` that the plugin draws whole. The part’s menu
lists what the page holds; `studio.useSpaceMenu` fills it while the page is drawn.

```tsx
function Library() {
  const space = studio.useSpace();
  const sections = useSections(space?.id);
  studio.useSpaceMenu(sections.map((s) => ({ id: s.id, label: s.title, icon: Component })));
  return sections.map((s) => (
    <Anchor key={s.id} id={s.id}>
      <Section title={s.title}>…</Section>
    </Anchor>
  ));
}

studio.registerSpacePart({
  id: "library",
  label: () => t("title"),
  icon: Blocks,
  after: "info",
  component: Library,
});
```

- `id` is the address: `/studio/space/library`. The parts’ own (`info`, `knowledge`, `data`,
  `results`) are taken.
- `after` is the part it follows in the menu: `info`, `knowledge` or `data` (default).
- Each entry of `useSpaceMenu` jumps to the element with its `id` in what the part draws, and
  the menu marks the one in view. `Anchor` and `Section` draw them as the space’s own parts do.
- The component is drawn again for another space: keep the space’s data under its id.

## Words in two languages

The studio speaks German and English. `studio.i18n.register` takes the plugin’s words and gives
the function that reads them in the language in effect:

```ts
const t = studio.i18n.register({
  de: { count: "{n} Kontakte sind gespeichert." },
  en: { count: "{n} contacts are kept." },
});

t("count", { n: 12 });
```

- `de` is the source: a key missing in `en` shows the German, so give every key in both.
- `{name}` in a text is filled from the second argument.
- `studio.i18n.lang()` is `"de"` or `"en"`, for dates and numbers:
  `new Date(at).toLocaleString(studio.i18n.lang())`.

## The plugin’s own routes

`studio.api` calls the routes the server half registered, signed in as the person:

| Call | Asks |
|---|---|
| `studio.api.get<T>(path)` | `GET /api/studio/plugins/<id><path>` |
| `studio.api.post<T>(path, body?)` | `POST`, the body as JSON |
| `studio.api.put<T>(path, body?)`, `studio.api.patch<T>(path, body?)` | `PUT`, `PATCH` |
| `studio.api.del<T>(path)` | `DELETE` |

Each gives the parsed JSON. Use them with `useQuery` and `useMutation`, as the page above does.

## The person

`studio.me()` is the signed-in person:

| | |
|---|---|
| `user` | `{ id, name, email }` |
| `tenant` | `{ id, role }`, the role `owner`, `admin` or `member` |
| `mode` | `"local"`: the runtime runs alone. `"managed"`: on engenty.ai |

Hide what a member may not do, and guard it on the server too with `role: "admin"` on the
route.

`studio.plugin` is the plugin itself: `{ id, name, version }`.

## Where the page stands

The top bar shows a trail after the space’s name. `studio.useCrumbs` is a hook that sets it
while the page is shown, in place of a heading of the page’s own:

```tsx
studio.useCrumbs([{ label: t("title"), to: "/contacts" }, { label: person.name ?? person.email }]);
```

- Each step is `{ label, to? }`; the last one is the page itself. A phone does not show the trail.
- The assistant names the page by its trail.

## A page with a menu

A page with parts of its own puts its menu where the studio’s own pages put theirs. `MenuPage`
from `@engenty-wizards/web/ui` draws the menu in the studio’s sidebar while that is open, and at
the page’s left otherwise, so there is only ever one menu at the left. `PageMenu` draws the menu
as the settings do: a list with one level below it, and tabs on a phone.

```tsx
import { MenuPage, PageMenu } from "@engenty-wizards/web/ui";
import { useParams } from "react-router";

function ContactsPage() {
  const { tab = "all" } = useParams();
  return (
    <MenuPage
      menu={
        <PageMenu
          title={t("title")}
          current={tab}
          entries={[
            { id: "all", label: t("all"), to: "/contacts/all" },
            { id: "new", label: t("new"), to: "/contacts/new" },
          ]}
        />
      }
    >
      <ContactList tab={tab} />
    </MenuPage>
  );
}
```

- An entry is `{ id, label, icon?, to, entries? }`; `entries` is the level below.
- `current` is the id of the entry shown, at either level.

## The assistant

The studio’s assistant stands on a plugin’s pages too. `studio.Assistant`,
`studio.useAssistantPage` and `studio.useAssistantTool` tell it what to say there, what the page
shows and what it may do in it. See [The space](./space.md#the-assistant-on-the-plugins-own-page).

For now the studio shows its assistant only where it is switched on, and it is off by default.
While it is off, these calls do no harm and nobody sees what they say.

## Build it

The studio half is built to two files, `dist/client.js` and `dist/client.css`. The build needs
a checkout of the repository, since it uses the studio’s own tools:

```bash
node scripts/build-plugin.mjs <plugin folder>
```

```bash
node scripts/build-plugin.mjs <plugin folder> --watch
```

The plugin’s folder may be anywhere, also outside the checkout. With `--watch` the files are
built again on every save, and an open studio takes them in place.

Ship `dist/` with the plugin: an install without a checkout cannot build it.

## What the studio shares

These imports are not in `client.js`. The script takes them from the studio that loads it, so
there is one React and one router on the page:

| Import | What a plugin gets of it |
|---|---|
| `react`, `react/jsx-runtime` | All of it |
| `react-dom` | `createPortal`, `flushSync` |
| `react-router` | `Link`, `NavLink`, `Navigate`, `useNavigate`, `useParams`, `useLocation`, `useSearchParams` |
| `@tanstack/react-query` | `useQuery`, `useMutation`, `useQueryClient` |
| `@engenty-wizards/web/ui` | The studio’s components, see [Styles and components](./styling.md) |
| `@engenty/wizards/plugin/studio` | `defineStudioPlugin` and the types |

Everything else a plugin imports is bundled into `client.js`. A package the plugin’s folder
does not have, such as `lucide-react`, comes from the studio’s.

## Undo on reload

The studio half loads again when its built files change. Pages, icons and sections, also those
of the space page, are taken back for it. Anything else it started, it undoes itself:

```ts
const timer = setInterval(refresh, 30_000);
studio.onUnload(() => clearInterval(timer));
```

## When it fails

- A studio half that throws while it loads registers nothing. Settings → Plugins says “The
  studio part didn’t load. Check the plugin and reload” with the reason. The server half keeps
  working.
- A page or section that throws while it draws shows “This part of a plugin crashed.” in its
  place. The rest of the studio stays up.

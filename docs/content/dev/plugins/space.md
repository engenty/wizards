---
title: The space
description: Knowledge a plugin writes, a block and tools for every AI step of a space, texts in its search index, tools and cards of its assistant.
version: 0.5.0
---

A space holds what all its wizards share: a name, its brand (logos, colours, fonts), facts, and
Knowledge – pages, tables and files with their categories. A plugin can write Knowledge and add to
what the space’s AI steps know, to what its search finds and to what its assistant can do. The
runtime’s own tables call a space a project: `wizard.projectId` in a [run event](./events.md) is
a space’s id.

## Knowledge a plugin writes

`server.spaceData` writes pages, tables and files into a space’s Knowledge under keys of the
plugin’s own, with their categories. Every write is indexed: `project_search` finds it a moment
later, filtered by its categories and checked like everything else in Knowledge. `space` is the
space’s id.

```ts
// The source's categories, once. `proposed: true` shows them to the person to confirm first.
await server.spaceData.putCategories({
  space,
  categories: [
    { name: "Team", type: "choice", hint: "folder name" },
    { name: "Meeting date", type: "date" },
    { name: "Duration", type: "number", unit: "h" },
  ],
});

// Then an item per entry. The same key again rewrites it, never doubles it.
await server.spaceData.putPage({
  space,
  key: `${source.id}:2026-03-14`,
  label: "Meeting notes",
  title: "Weekly meeting, 14 March 2026",
  markdown,
  categories: { Team: "Sales", "Meeting date": "2026-03-14", Duration: 1.5 },
  fill: true, // a model fills the categories the entry did not bring
});

// A file is read as an upload is: a page, sub-pages, a table per sheet, or a file.
const doc = await server.spaceData.putDocument({ space, key, label, name, mime, data, fill: true });
```

| `server.spaceData.` | Does |
|---|---|
| `putCategories({ space, categories, proposed? })` | Adds categories, or values to known ones. Types: `choice` (with `values`, `multiple`, `ordered`), `date`, `number` (with `unit`), `text`, `boolean`. `column: { table, column }` takes a category’s values from a column of a table the plugin wrote |
| `putPage(input)` | A page: `title`, `markdown`, `parent` (the key of a page to stand under), `original` (the file it was read from), `categories`, `fill`, `review` (why a person should look) |
| `putTable(input)` | A table: typed `columns`, `rows` (cells by column id, they replace the rows the key had), `format: "faq"` |
| `putFile(input)` | A file that is not a page. It is found by its name, `description` and categories; `text` is what a step reads of it |
| `putDocument(input)` | A file, read the way an upload is. Returns what it became: `items` (pages, tables), and `review` when it was hard to read or could not be read |
| `readPages(space, { parent? })` | The space’s own pages, whoever wrote them, with their Markdown: `{ id, title, path, parentId, markdown, origin, originKey, updatedAt }` |
| `files(space, kind?)`, `readFile(space, id)` | The space’s files of a kind (`document`, `logo`, `asset`, `pattern`; `document` when none is named), newest first, and one file with its bytes, such as a price list someone dropped into Knowledge |
| `list(space)` | Everything the plugin wrote, by key, with its path and `state` |
| `remove(space, key?)` | Takes out one key, or everything the plugin wrote in the space. Returns how many items it removed |
| `summarize(space, category?, value?)` | Writes the “Overview” of one value, or of every value with three items or more. Each costs a model call. Returns how many it wrote |

- `label` is what the person knows the source as. Knowledge shows it beside the item.
- When a person changes an item, it is theirs: the plugin’s next write returns `state: "kept"`
  and changes nothing, and `remove` leaves it.
- What a step reads of an item is its path: `pages/…`, `tables/…`, `files/…`.

## A block for every AI step

```ts
server.registerSpaceContext({
  block: async (space) => {
    const titles = await pageTitles(space.id);
    return titles.length
      ? `# THE SPACE'S WIKI\nPages, read one with wiki_page: ${titles.join(" · ")}`
      : null;
  },
  tools: [
    {
      name: "page",
      description: "Reads a page of the space's wiki by its title.",
      inputSchema: z.object({ title: z.string() }),
      execute: async ({ title }, step) => pageOf(step.space.id, title),
    },
  ],
});
```

- Every agent step of the space’s wizards gets the block in its instructions, after what the
  space says about itself and its documents, and gets the tools with it. No step lists them.
- `block` is called once per step. If it returns `null` or an empty text, the step gets neither
  the block nor the tools.
- A block is cut at 8,000 characters. A block that throws is logged, and the step runs without
  it.
- The tools are [tools](./tools.md) like the ones a step lists; the model sees
  `<plugin>_<name>`. Their names and the names of the plugin’s other tools are one list.
- A model on the device calls no tools. That is Apple Intelligence on a Mac, or on the phone a
  run is followed on, which answers only steps that list no tools themselves. Such a step gets
  the block without the tools.
- `steps` says which steps get the block: `["agent"]` when left out. `"html"` stands for the
  steps that write a document or a dashboard as HTML. They get the block without the tools,
  after the space’s brand – a good place to say how the brand’s elements look.

## The space’s brand

`server.spaces.brand(space)` reads what Info & brand holds of the space’s look, for a block, a
page or a model call in it:

```ts
const brand = await server.spaces.brand(space.id);
// { name: "Mira Kaffee", colors: [{ name: "Primary", value: "#7a3e1d" }, …],
//   fonts: [{ family: "Fraunces", role: "Headings", weights: [600] }, …] }
```

- The first colour is the accent. A font’s `role` is what it is for, in the person’s words.
- It returns `null` for a space the tenant does not have. The studio half gets the same from
  `studio.useSpace().brand`.

## The search index

Every agent step can search the space with `project_search`. It finds Knowledge, written by
people and by `server.spaceData`, and the texts plugins put in themselves, outside Knowledge:

```ts
await server.index.put({
  space: space.id,
  key: `page:${page.id}`,
  title: page.title,
  text: page.markdown,
  link: "/space/knowledge#wiki",
});

await server.index.remove(space.id, `page:${page.id}`);
await server.index.remove(space.id); // every text of the plugin in the space
```

- Putting a key again replaces what it held.
- A text is cut into passages. Its title is searched with it, and a hit is named by it. The test
  search under Knowledge (“Try a search…”) shows hits as a step gets them.
- The index searches by words and by trigrams (codes, parts of compounds). With an embedding
  model set up, it also searches by meaning. A classifier then judges each candidate.
- Such a text has no categories, so a search with a filter leaves it out. Write Knowledge with
  `server.spaceData` when it should be filtered.
- A step gets `project_search` as soon as the space has Knowledge or a plugin’s text.
- A tenant without the plugin does not find its texts. They are deleted with the space.

## Tools of the space assistant

The studio’s assistant, Goose, stands on every page of the studio except the editor. Where a
space is open and the person may change it, the assistant fills the space in from what the person
says, a website or files. A plugin gives it tools:

> Goose is still being tried out and doesn’t show in every studio yet. Where it doesn’t, nobody
> sees the tools, cards and page hooks below.

```ts
server.registerAssistantTool({
  name: "draft_page",
  description: "Drafts a page of the space's wiki on a topic the person names.",
  inputSchema: z.object({ topic: z.string() }),
  card: true,
  execute: async ({ topic }, turn) => {
    turn.emit("Writing the draft …");
    const draft = await draftPage(turn.space.id, topic, turn.signal);
    return { title: draft.title, words: draft.words };
  },
});
```

| `turn.` | |
|---|---|
| `space` | `{ id, name }`: the space the person is filling in |
| `tenantId`, `userId` | The tenant and the person |
| `signal` | Aborted when the person leaves or stops the answer |
| `emit(message)` | The line the chat shows while the assistant works |
| `changed()` | The tool changed what the space page shows: the page draws it again |

- The model sees the tool as `<plugin>_<name>`, beside the assistant’s own tools.
- The assistant doesn’t keep a tool’s result from one message to the next. Keep what a later
  message needs in the plugin’s tables.

### A card in the chat

With `card: true` the result also goes to the chat. The studio half draws it:

```tsx
studio.registerAssistantCard({
  tool: "draft_page",
  component: ({ data, send }) => (
    <Card className="flex items-center gap-3 p-4">
      <span className="flex-1 text-[0.875rem]">
        {data.title}: {data.words} words
      </span>
      <Button size="sm" onClick={() => send("Publish it")}>
        Publish it
      </Button>
    </Card>
  ),
});
```

- `tool` is the name the server half registered, without the plugin’s prefix.
- The card stands below the assistant’s answer. Without a card for the tool, nothing shows.
- `data` is what `execute` returned, sent as it is: keep it small.
- `send(message)` sends a message to the assistant as if the person typed it.

## Events of a space

`space.created`, `space.updated`, `space.deleted`, `space.file.ready` and `space.file.removed`
say what changed. See [Events](./events.md).

## The assistant on the plugin’s own page

The assistant stands on the plugin’s pages too, as on every page of the studio. A page tells it
what to say there, and what it shows; the assistant is told what the page holds and uses the
plugin’s assistant tools first.

```tsx
const Assistant = studio.Assistant;

<Assistant
  title="Ask about your contacts"
  hello="I find people who ran a wizard and tidy the list."
  placeholder="e.g. “Who ran the quote wizard last week?” …"
  suggestions={[
    { label: "Who came back more than once?" },
    { label: "Remove the contacts of …", fill: true },
  ]}
  onChanged={() => queryClient.invalidateQueries({ queryKey: ["contacts"] })}
/>
```

```ts
server.registerAssistantContext({
  block: async (space) => `THE CONTACTS ON THIS PAGE: ${await contactsText(space.id)} …`,
});
```

- `studio.Assistant` draws nothing: place it once, anywhere in the page. `title` and `hello`
  greet the person before the first message, and up to three `suggestions` stand under them. A
  click sends a suggestion at once (its `message`, or the label). With `fill: true` it goes into
  the field instead, for the person to finish.
- `block` is called once per message, and only when the person writes from the plugin’s page. A
  block is cut at 8,000 characters. One that throws is logged and left out.
- Where the person may not change the space, the assistant gets neither the space’s tools nor
  the plugins’. That is a space published from engenty wizards on a computer, or a person who
  may not build here.

### What the page shows

`studio.useAssistantPage` tells the assistant what the person sees: an open item, a selection,
a line on what the page holds, its fields. It is sent with every message, beside the page’s
address and the trail of the top bar.

```tsx
studio.useAssistantPage({
  open: person ? { kind: "contact", id: String(person.id), label: person.email } : undefined,
  selection: picked.map(String),
  summary: `${contacts.length} contacts · ${withoutName} without a name`,
  // A page of full-height tables keeps the assistant small, at the lower right.
  compact: true,
});
```

- `open` is `{ kind, id?, label }`, `selection` holds the ids of what the person picked, and
  `fields` is `{ id, label, value }[]`.
- It takes the words of `studio.Assistant` too (`title`, `hello`, `placeholder`, `suggestions`,
  `onChanged`): one call can do both.
- The data may change on every render; it is read when the person sends.

### Tools in the page

`studio.useAssistantTool` gives the assistant a tool that runs in the browser while the page is
shown: it filters a list, opens an item, picks a tab. The model sees it as `<plugin>_<name>`
(a `-` in the plugin’s id becomes `_`). `run` gets the arguments and returns what the assistant
learns. Such a tool changes what the page shows and never saves: saving stays with the server
half’s tools.

```tsx
studio.useAssistantTool(
  "filter_contacts",
  {
    description: "Shows only the contacts that match: of a wizard, by words.",
    parameters: {
      type: "object",
      properties: {
        wizard: { type: "string" },
        query: { type: "string" },
      },
    },
  },
  ({ wizard, query }) => {
    setFilter({ wizard: wizard as string | undefined, query: query as string | undefined });
    return { shown: count };
  },
);
```

Besides a page’s tools, the assistant can open a studio page, point at an element, read what is
on the screen, fill a field and scroll. It finds elements by their headings, labels and
buttons. `data-assist="<id>"` on an element names it for the assistant.

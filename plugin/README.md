# wizards, the Claude Code plugin

The plugin a running engenty wizards serves at `<APP_URL>/api/claude-plugin/marketplace.json`,
with its own address filled in. It holds:

- **`/wizard <what it should do>`** builds a wizard from a description, with the `build-wizard`
  skill: authoring guide, closest starter, issues fixed, one test run, the studio link.
- **`use-wizard`**, the skill that runs one of your published wizards here in the chat.
- **`/wizards`**, a pane beside the chat with your wizards: each one's engenty, name and
  description. **Run** opens the wizard's own page in the app's browser pane, beside the chat,
  where you fill it as any person would. **Edit** puts a change request into the chat for you to
  finish. The pane opens by itself when the plugin loads; `/wizards close` closes it. A run the
  model drives through the server's tools opens its page beside the chat once it waits for you.

The pane is a mod: a hooks module in `hooks/register.tsx` drawing with the engine's elements,
its state declared in `types/index.d.ts`. `claude plugin validate plugin` checks it,
`claude plugin test plugin` runs `hooks/pane.test.tsx` against the engine.

## Install

From GitHub, for the `engenty-wizards` MCP server you already have (the local install writes it
into your AI apps; `claude mcp add --transport http engenty-wizards <APP_URL>/api/mcp` adds a
hosted one):

```bash
claude plugin marketplace add engenty/wizards
claude plugin install wizards@engenty
```

From a running engenty wizards with a public https address, which bundles its own server:

```bash
claude plugin marketplace add <APP_URL>/api/claude-plugin/marketplace.json
claude plugin install wizards@<host-with-dashes>   # wizards.example.com → wizards-example-com
```

`claude plugin update wizards` brings the next version.

## Permissions in auto mode

The pane calls the server itself, from a button press, not from a model request. In auto mode
such a call has no classifier verdict and is refused unless an allow rule names the tool. Put
these in `permissions.allow` of `.claude/settings.local.json` or your user settings:

```json
["mcp__plugin_wizards_engenty-wizards", "mcp__Claude_Browser__navigate"]
```

A server you configured yourself under the name `engenty-wizards` is `mcp__engenty-wizards`
instead. The browser pane's `navigate` may still ask you; the pane then shows a plain link to
the same page.

## Options

| Option    | Default           | What it names                                              |
| --------- | ----------------- | ---------------------------------------------------------- |
| `server`  | `engenty-wizards` | the wizards runtime's MCP server, as `/mcp` lists it        |
| `browser` | `Claude_Browser`  | the app's browser pane, whose `navigate` opens a page       |

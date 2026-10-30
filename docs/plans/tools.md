# Plan: Werkzeuge, one place for skills and connectors

Status: plan, nothing built. Written on 2026-10-30 against `feat/work-mode` (v0.13.x), revised the
same day after review. Behind a new switch `tools`, off by default. Mockups: the artifact
“Werkzeuge in the Studio” (claude.ai/artifact/SLU1E9iwxQ8SjNAeHVg5qT).

## In short

- **Werkzeuge / Tools**, a place in the app bar: after Quellen in Studio, after Daten in Work,
  none in Client. The name holds for now.
- It holds **Skills** and **Connectors**, each with „Meine“ and „Entdecken“. An MCP server is a
  kind of connector.
- Built-in connectors (Gmail, Drive, Slack, GitHub …) show as a quiet list of names until
  someone connects one.
- A person connects an account **once per space**, not once per wizard. A space can also have
  **one shared account** for a service.
- Each action has one rule: **erlaubt, erst fragen, aus**. Wizard steps, Work chats and Goose
  follow the same rules, with the same connectors.
- Settings › Connectors moves here. Plugins move later (roadmap).
- Held calls stay where they wait today: the bell in Work, the run's page in a wizard.
- On a phone Werkzeuge sits in the „⋯“ menu, as Skills does now.
- A skill's page keeps today's two columns (instructions left, settings right). Dateien moves
  to the top of the right column, above „Wann gilt er“ and „Skripte“.

## Accounts

- **Personal:** each person connects their own account, e.g. their HubSpot login. The AI sees
  what that person sees. The default.
- **Shared:** an admin connects one account for the whole space, e.g. the team mailbox
  info@… or the company's S3 bucket. Every wizard, chat and Goose in the space uses it,
  whoever runs them.

Today an account belongs to one wizard and one person (`store_secret`, slot `connection:<id>`).
It becomes one per space and person, or one per space. Existing rows move once by command.

## Who sees what

| | Wizard step | Work chat | Goose |
|---|---|---|---|
| Skills | by mode; scripts in the run's sandbox | by mode; scripts in the chat's sandbox | reads, runs no scripts |
| Connectors | the ones the step lists | **new:** all of the space's | **new:** all of the space's |

All three use the person's account (or the space's) and the same rule per action.

## Rules per action

- **Erlaubt:** runs without asking. **Erst fragen:** waits for a person. **Aus:** hidden from
  the AI.
- Defaults: reading erlaubt, writing erst fragen, deleting always asks.
- Admins change the rules.

## Addresses

`/tools`, `/tools/skills`, `/tools/connectors`, an item with `?show=`. `/skills` and
`/settings/connectors` redirect.

## Order of PRs

All behind `tools`, off by default.

1. `feat(studio): Werkzeuge in the app bar` — Skills move in, `/skills` redirects.
2. `feat(studio): connectors move to Werkzeuge` — list, page, built-ins as names;
   `/settings/connectors` redirects.
3. `feat(runtime): accounts per space and person, or shared` — with the one-time move.
4. `feat(studio): rules per action` — on the connector's page.
5. `feat(work): Work chats and Goose use the space's connectors`.
6. `feat(studio): Entdecken` — one search over skills.sh and integrations.sh.
7. `feat: Werkzeuge on by default` — switch, docs, glossary.

## Roadmap

- Plugins move to Werkzeuge, with their settings; `/settings/plugins` redirects.

## Open

- Does a Work user (not an admin) see a connector's rules? Mockup 7 shows both ways.

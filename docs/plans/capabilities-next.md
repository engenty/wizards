# Plan: Fähigkeiten, the next four pieces

Status: planned on 2026-11-05, every decision taken the same day. Piece 1 (1a the runtime, 1b
the studio and the docs), 2a, 2b and 3 are built (2026-11-06), the rest is not. Follows
`docs/plans/capabilities.md` and `docs/plans/broker.md`, which are built. Page with the mockups:
the artifact “Fähigkeiten Next Steps” (claude.ai/artifact/2WB6P59ZJgxPYi9rr2h53m). Checked
against `main` at v0.16.2 plus #500–#509.

## In short

| | Piece | Today | What comes |
|---|---|---|---|
| 1 | A server by its address (built) | The runtime reads an address; no screen takes one, and an MCP server outside the registry fails at import | „Per Adresse“ in Connectors: check, correct, import |
| 2 | Limits, stopping, pausing (2a, 2b built) | Only a guest's mails are counted; a stopped run can still call; a connection can only be removed | Calls per run and day, a stop that holds, „Verbindung pausieren“ |
| 3 | Rechte | Rules are written in four places and listed nowhere; some are stored and never asked | One page: who may what, the exceptions as sentences |
| 4 | A Connector that brings skills | Nothing links a skill to a connection; nothing reads a plugin | A Claude Code or Cursor plugin becomes a Connector with its Skills |

Found while checking, and it matters now: „Mit Freigabe“ holds a call only in Work chats
(`chat_approval`). In a wizard's run nothing waits: `needs_approval` goes back to the model, and a
fixed step fails. New connections start with Ändern and Senden on „Mit Freigabe“, so a fixed step
that sends through a space connection fails until an admin sets the rule to „Erlaubt“. Piece 2
warns about it first (2b, built) and makes it wait later (2c).

## Decided on 2026-11-05

| | Question | Decision |
|---|---|---|
| 1 | May a pasted address be a private one? | On your computer yes, in the cloud no. |
| 2 | Who may use a connection to an unknown server at first? | Admins, and the Connector is marked „nicht geprüft“. |
| 3 | A separate „revoke“ beside stopping a run? | No. Stopping is the revoke. |
| 4 | Limits on a new connection | Empty, and for every caller. A guest's mails keep their numbers. |
| 5 | Where does Rechte live? | Fähigkeiten, beside Audit. |
| 6 | Rules that are stored and never asked | The runtime refuses to store them. |
| 7 | A word for a plugin taken into a space | None. It shows as a Connector with Skills; „Plugin“ only names the origin. |
| 8 | How long does a held step wait in a run? | Seven days, then it is refused. |

## 1. A server by its address

Built on 2026-11-06: 1a in `connectors/external.ts`, `connectors/reload.ts` and
`test/connector-by-address.test.ts`, 1b in `studio/ConnectorByAddress.tsx`. How it works now is in
`docs/content/dev/broker.md` („A connector from an address“) and
`docs/content/user-guide/connectors.md` („By its address“). What follows is the state before, and
the design.

What a pasted address still cannot do:

- A guest’s post to a channel works for Slack only (`postsToChannel`). An action of a pasted
  server that names a channel, a phone number or a user id as its recipient is refused for a
  guest: the named field must hold e-mail addresses.
- A key in a query parameter, two credentials at once, OAuth client credentials or a device flow
  cannot be chosen. OAuth is the authorization-code flow the server describes.
- A server that needs a sign-in shows no actions at „Prüfen“, unless the admin types a key for a
  header. With OAuth the actions come after the connection is signed in and reloaded, and their
  kinds are set then.
- Only http servers: streamable HTTP and SSE. A server started on the command line has no home
  (piece 4 says so too).
- A reload does not say which actions came or went, and a new action runs under its guessed kind
  until an admin looks.
- The server’s own name is not read: the connector is named after its host until the admin types
  a name.

What the code did:

- `previewSource` (`apps/runtime/src/connectors/external.ts`) and `POST /connectors/preview`
  (`routes/studio.ts`) read any address; nothing in the studio calls them. `POST
  /spaces/:id/connectors` imports one that is not in integrations.sh, but wants a `domain`.
- An MCP server outside the registry fails at import: `mapAuth` has „no registry auth facts for
  this endpoint“, and `probeOAuth` only runs where the registry returned a document.
- Nobody can say „no sign-in“ or give a key for a header.
- „Aktionen neu laden“ passes no token, so it fails for an MCP server that needs a sign-in. It and
  the preview ask for no admin.
- An action's kind comes from MCP hints, HTTP methods and words (`importer/classify.ts`); nobody
  can correct it. A guest's send works only where the input is `to`, `cc`, `bcc` or `recipient(s)`
  (`broker/send.ts`).
- `net/guarded-fetch.ts` refuses private addresses everywhere.

The design:

- Connectors › Weitere Connectors gets „Per Adresse“ beside „Aus dem Verzeichnis“: paste, „Prüfen“,
  read what it found, correct, „Importieren“, then the „Verbindung hinzufügen“ card that exists.
- Sign-in: what the server describes itself comes first (its OAuth description is read for every
  pasted MCP address). Else the admin chooses: OAuth with an own client, a key in a header, none.
- Every action shows liest, ändert, sendet or löscht, and the admin can change it. For „sendet“
  they name the field that holds the recipient; the broker's kind and the guest's send check use
  both.
- A Connector from an address is marked „nicht geprüft“; a new connection on it starts for Admins.
- A private address is taken on a local install for this path only, and refused on a managed
  runtime in words.

Build: **1a** runtime (sign-in for a pasted address, the id from the host, reload with the space's
sign-in, kind and recipient field per action, admins on preview and reload, private addresses on a
local install). **1b** studio (the form, the preview, the kinds) and the user guide.

## 2. Limits, stopping, pausing

What the code does:

- `brokerCall` (`broker/call.ts`) never reads `run.status`: after a cancel, a later call of that
  run goes through. A space connection is not checked against the run's grant either; the grant
  binds a wizard's own connection.
- Counted are a guest's mails and posts (`broker/send.ts`: 3 per run, `wizard.dailyMailLimit`,
  default 50, per day). `dailyMailLimit` has no field in the studio. Calls are counted nowhere.
- `space_connection` has no paused state. Removing is the only stop, and a step's tools hold the
  row they read at its start, so they work until the step ends.
- A plugin's own job is allowed before the audience is asked (`own_job`).

The design:

- **2a. A stop that holds.** Built. Every broker path (call, host, send, secret) refuses a run
  that is cancelled, done or failed, with its own words (`run_ended`, `broker/over.ts`). „Lauf
  stoppen“ on a line of the Audit. A share job is the one caller of a run that is done.
- **2a. Pause.** Built. „Verbindung pausieren“ on its page: `paused_at`, `paused_by`. The broker
  asks it first, before `own_job`, and reads it on every call rather than from a step's row. The
  lists show „pausiert“, „Was darf …?“ names it, and the change is a critical line. What a paused
  connection refuses is no critical line.
- **2b. Limits per connection.** Built. `calls_per_run` and `calls_per_day` on `space_connection`,
  empty for none, for every caller, „Grenzen“ on the connection's page. A call that would run
  takes its place by writing its line (`takePlace` in `broker/log.ts`: the count and the line are
  one statement), and its end fills the line in. The limits are read with the pause, on every
  call. The refusals are `calls_per_run` and `calls_per_day`, apart from a guest's `run_limit` and
  `day_limit`, so the Audit, a model and a fixed step each have words that are true. A limit is a
  critical line once per run or day, and a changed limit is one. The wizard's mails per day have
  their field in the share dialog below the runs per day, and travel with the runs per day: MCP
  `set_sharing`, the two-way sync and the copy in the cloud.
- **2b. A warning.** Built. `stepWarnings` (`services/wizards.ts`) asks the broker's `decide` for
  each fixed step on a space connection. The editor shows it on the step, in the step row and in
  the publish dialog, with a way to the connection's page. It is no issue: the wizard saves and
  publishes.
- **2c. Waiting**, once `durableRuns` is on: the step sleeps, the admins decide in the bell or the
  Audit, the run goes on. Seven days, then refused.

What 2b does not do:

- Nothing waits: a call past a limit is refused, in a run as in a chat. No queue, no retry at
  midnight.
- A day is the UTC day, for every space. Limits per hour, per person or per action are not there.
- The count is the log's lines. A call counts once it is let through, also where the service then
  fails, and a call under way holds its place until its line is closed. A process that dies in a
  call leaves that place taken for the day.
- A wizard's own connection („Wer den Wizard nutzt“), a request to a host and the server's mail
  have no limit of this kind.
- A step's tools and a chat's still offer a connection whose limit is reached. The call is
  refused with words for the model.
- The warning covers fixed steps on „Mit Freigabe“ only. It says nothing of a rule on „Nie“, a
  paused connection, an audience the run's holder is outside of, or a limit a wizard is sure to
  reach. An MCP client reads no warnings (`get_wizard` returns issues only).
- The fixed step still fails. 2c makes it wait.

## 3. Rechte

Built (3a: #516, 3b: the page). What the code did before:

- Rules (`rwx_rule`) come from four writers: the start set per role (`seedRwx`), „Wer sieht diesen
  Ordner“ in Wissen (`folderRules`), a mount's form in Dateien (`mountRules`), and „Für Kund:innen
  sichtbar“ (`setOpenToClients`). No page listed them.
- `PUT /spaces/:id/rules` replaced every rule of the space. Reading the list and saving it back
  failed once a mount let the AI in Work read: those rows have no subject id, and `checkRule`
  wanted one.
- Enforced are document, table, page, wizard, skill and setup, and mounts by their own readers.
  Stored and never asked: any rule on a connection, mail, a host or the sandbox (connections have
  their own audience and rules, and `broker/call.ts` asks only those); `w` on documents, tables,
  wizards and skills; `r` on setup.
- „Was darf …?“ (`GET /spaces/:id/broker/ask`) answered for connections only.

What is built:

- Fähigkeiten › Rechte, after Audit, for admins, hidden while `broker` is off.
- On top, what Admins (fixed), Mitglieder, Gäste and Kund:innen may do with everything of a kind:
  a switch per right the runtime asks.
- Below, the exceptions as sentences (`rights-words.ts`). Each says where it is set and leads
  there; one set on the page is removed there. Adding one: who, darf or darf nicht, lesen /
  ändern / ausführen, what.
- One table of what a reader asks (`RWX_ASKED`, `packages/shared/src/rwx.ts`): the runtime refuses
  a rule outside it, and the page offers nothing else. A rule is added, changed and removed one
  at a time; the whole-list `PUT` is gone.
- Where a rule is set is read off the rule (`originOf`): no column. A mount's rules stay its
  form's, and the rules routes refuse one.
- Connections keep their rules on their page; Rechte counts them and links there.
- „Was darf …?“ on the page answers for a document, a page or folder, a table, a wizard, a skill
  and the setup (`GET /spaces/:id/rules/ask`), by the readers' own decision.

Found while building, and not changed:

- `w` on a page and on the setup is asked only where Goose writes; `r` and `x` on a wizard only
  for the AI's tools and the client portal. A member in the studio or in Work, and a guest at a
  wizard's link, are not asked. The page words each right as far as the check goes.
- The start set holds flags no reader asks yet (`w` on documents and tables, `r` on the setup
  among them). They stay, so a later reader starts from them.

## 4. A Connector that brings skills

What the code does:

- Skills (`space_skill`) and connections share Fähigkeiten and Entdecken; nothing links them. A
  skill's `allowed-tools` is kept in `meta` and never read. Sources are `own`, `upload`,
  `skills.sh`; an uploaded zip keeps one skill (`unpackSkill`).
- Nothing reads a GitHub repository or a plugin's manifest (`.claude-plugin/plugin.json`,
  `.mcp.json`). A server a plugin starts on the command line has no home here.
- `space_connection.plugin` already notes which engenty plugin set a connection up.

The design:

- A plugin for Claude Code or Cursor, taken into a space: its MCP server over http becomes a
  Connector through piece 1, its skills become Skills that name it.
- Entdecken shows one hit where a repository holds both. „Per Adresse“ takes a repository or a zip.
- Taken: http servers and `skills/*/SKILL.md`. Not taken, and said so: commands, agents, hooks,
  servers on the command line. Scripts stay off.
- The Connector's page lists its Skills. They are read only (copy one to change it), „Aktualisieren“
  where the origin changed, and removing takes all of it at once and names the wizards that use the
  connection.
- Data: one record of what came together (`space_bundle`: name, version, origin, hash) and its id
  on the skills, the connection and the connector; the skill source `plugin`.

Build, after piece 1: **4a** runtime, **4b** studio.

## Order

1a, 1b · 2a · 2b · 3a, 3b · 4a, 4b · 2c. Piece 1 first: nobody can add their own MCP server since
connected systems went (#206), and piece 4 needs it. 2a before the rest of 2: a stop that does
not hold is the one that hurts.

## Seen on the way

- Nothing asks `w` where a member changes a page, a table or the setup in the studio, and nothing
  asks `x` where a person starts a wizard in Work or the studio or a guest opens its link. Rechte
  says so; the readers are not there.
- „Wer sieht diesen Ordner“ replaces every rule about the team, the clients and the guests on its
  page when it is saved, also one Rechte set there that it cannot show (only `w` denied).
- The seed gives a client `w` on pages, which only Goose asks, and a client reaches no studio.

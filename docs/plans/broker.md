# Plan: the broker

Status: plan, nothing built. Written on 2026-10-31 against `feat/work-mode`. Part A of
`docs/plans/capabilities.md` builds it; the connections plan (artifact “Verbindungen in Quellen”,
claude.ai/artifact/GUtiTfPMVvoe1EcgRes3fh) named it first.

The broker is the one place every outside effect of the AI goes through: a read or write on a
connected service, a mail, a request to a host, a file in a folder, a command's network. It
decides by rules a person wrote in their own words, it logs every decision, and it tells someone
when something critical happens. Beside the runtime (agentOS) and the doors it is the component
that has to be right.

## What it must be

1. **Complete.** No tool reaches outside except through it. A tool that doesn't register an
   action with the broker has no way out. A test fails when one does.
2. **Readable.** Its rules are sentences a person in the business understands and can write:
   „Gäste dürfen in HubSpot · Vertrieb lesen. Schreiben nur mit Freigabe von Admins. Löschen
   nie.“ No policy language in the product. The rule is stored as data, the sentence is drawn
   from it, and the same data decides.
3. **Deterministic.** No model takes part in a decision. The same call with the same rules gives
   the same answer, and the answer names the rule that gave it.
4. **Closed by default.** What no rule allows is refused. A wizard can only narrow what the
   connection allows, never widen it. On any failure: deny.
5. **Logged.** Every call, allowed or not, with who, where, what, the decision and the rule.
   Secrets never. The log is what „Letzte Nutzung“, the admin's page and the Manage-App read.
6. **Heard.** A critical decision reaches a person: in the app at once, by mail where nobody is
   in the app, to the Manage-App's admins for the platform.

## First: RWX, and nothing else

Decided 2026-10-31: start simple and clear. Phase 1 has exactly three permissions, per subject
and resource, and they must be bullet-proof. Everything else in this plan (*Mit Freigabe*,
limits, audiences, hosts, notifications) comes after, on top of them.

| | Permission | Means |
|---|---|---|
| **R** | lesen | read the resource: open a document, search it, list a table, read a mailbox, read through a connector's read action |
| **W** | schreiben | change it: write a row, change a document, a connector's write and delete actions |
| **X** | ausführen | make it do something outward: send a mail, call a fixed step, run a command, call a plugin tool, request a host |

**Subjects:** a guest, one person (by id), a role (Mitglieder, Admins), Goose of a person, a
wizard, a plugin. **Resources:** a document or a folder in Wissen, a table or page in Daten, a
connection (as a whole, or one action), „E-Mail senden“, a host, the sandbox. Resources have
stable ids; a rule names the id, never a title.

**One table:** `(space, subject, resource, R, W, X, by whom, since)`, each flag *erlaubt* or
*verboten* or unset. **Deny by default:** unset is *verboten*. **A *verboten* wins** over every
*erlaubt* from any other rule, grant or role, and only an admin can remove it, logged. So „Julia
darf diese Datei nicht lesen“ and „Gäste dürfen keine E-Mail senden“ are one row each and hold
against everything.

The page shows the row as a sentence and lets an admin write it the same way: pick who, pick
what, tick R, W, X. Nothing else to learn.

### Bullet-proof means

1. **One reader.** A document's bytes, a table's rows, a connection's secret, the mail sender:
   each has one function that hands them out, and that function asks the broker first with a
   *who*. Today `search_space`, the store tools, `connectionContext` and the mail tools read on
   their own (`space-index.ts:641`, `tools/store.ts`, `connectors/index.ts:425`,
   `tools/mail.ts`); documents have no read rule at all (`space_file`).
2. **Search filters before it ranks.** The index returns only what the subject may read; a
   document the subject may not read is never in a result, a snippet, a count or an embedding
   neighbour. The same for Daten and Wissen categories.
3. **Nothing leaks around the side.** A refusal says *verboten* and the resource's id, not its
   content. A log line holds no content. A result of a run that read a document the viewer may
   not read is kept in the space, not shown to the viewer (rule 5 of the connections plan). A
   share link inherits the viewer's R.
4. **No path without a *who*.** A call with no subject is refused. Every entry (doors, studio,
   runner, Goose, plugins, MCP) sets the subject before any tool runs.
5. **X is never granted implicitly.** An AI step has X only where the wizard's grant names it
   and the connection allows it; a guest never has X on a space connection; a sandbox command's
   network is X on hosts.
6. **A test suite that proves it.** One fixture per sentence: „B darf Dokument D nicht lesen“,
   „Gäste dürfen keine E-Mail senden“, „Agent A darf nicht löschen“. Each fixture runs every
   path (search, store, a step, a Work chat, Goose, a share link, a plugin, MCP) and asserts the
   content or effect is absent. CI fails on any new tool that isn't in the walk.

What phase 1 does not have: *Mit Freigabe* (a write is *erlaubt* or *verboten*; the ask stays
where it is today for a person's own connection), limits, audiences beyond the role subjects,
rule sentences beyond RWX. They come as rows of the same table or beside it, later.

## The model, later

Beyond RWX. A call is `call(who, where, connection, action, input)`.

| Part | Values | Where it comes from |
|---|---|---|
| **who** | guest (visitor id), member, admin, owner, Goose (for a person), plugin, a wizard's fixed step | the run's holder, the session, the caller |
| **where** | a run (wizard, mode, audience it runs in), a Work chat, Goose's chat | the run or chat row |
| **connection** | a connection of the space (how it signs in, audience), a person's own sign-in, a folder, „the internet“ (hosts), „Mail“ | the space's connections (capabilities plan) |
| **action** | one of the connection's actions, each with a **kind**: *lesen*, *schreiben*, *löschen*, *senden* | the connector's definition, the folder tools, `http_request`, the mail tools |
| **input** | the call's fields | the tool call |

An **outcome** is *Erlaubt*, *Mit Freigabe* or *Nie*.

### Rules, as people write them

A rule is one sentence with four slots: **wer** · **darf was** · **wo** · **Ausgang**.

- „**Mitglieder** dürfen **lesen** in **HubSpot · Vertrieb**: **erlaubt**.“
- „**Gäste** dürfen **schreiben** in **HubSpot · Vertrieb**: **mit Freigabe** von Admins.“
- „**Alle** dürfen **löschen** in **Gmail · Bestellungen**: **nie**.“
- „**Gäste** dürfen **senden** an **die bestätigte Adresse des Laufs**: **erlaubt**, höchstens 3 pro Lauf.“
- „**Wizard Torten-Anfrage** darf **lesen** in **Google Kalender · Backstube**: **erlaubt**.“ (the wizard's grant, frozen at publishing)

Stored as rows, not text: `(space, subject, kind | action, connection | host | recipient-rule,
outcome, limit, by whom, since)`. The page draws the sentence from the row in de and en. A row
with no limit means no limit; a missing row means *Nie*.

Defaults a connection starts with, as the code has them today (`tools/connector.ts:109`): reads
*Erlaubt*, writes and sends *Mit Freigabe*, deletes *Nie*. Admins change them per connection,
and per wizard a publisher only narrows.

### The decision

In this order, the first *Nie* wins and the most restrictive outcome stands:

1. **The grant.** Does the run's or chat's grant name this connection and action? A run's grant
   is frozen at publishing from the definition; a test run gets the draft's; a Work chat's is the
   space's connections open to the person. Not named: *Nie*.
2. **The connection's audience.** May this *who* use this connection (*Admins / Mitglieder /
   alle*)? No: *Nie*.
3. **The connection's rule** for this *who* and this action's kind: *Erlaubt / Mit Freigabe /
   Nie*, with its limit.
4. **The wizard's narrowing**, where the call comes from a run.
5. **Kind-fixed rules nobody can lift:** *löschen* never *Erlaubt* for guests; a write on a
   connection that signs in as the space never comes from an AI step, only from a fixed step or a
   confirmed action.
6. **Limits:** per run, per day, per person; over the limit: *Nie* with the reason.

The answer: `{ outcome, rule, reason }`. *Erlaubt* runs the action with the secret from the vault.
*Mit Freigabe* writes an approval row and waits (the run's page, the bell in Work). *Nie* returns
the reason to the caller, which the model sees as a refusal it can't argue with.

## The log

One append-only table per tenant, `broker_log`:

| Column | What |
|---|---|
| when, duration | |
| who, where | guest id or person, run or chat, wizard, space |
| connection, action, kind | |
| input summary | the fields' names and sizes, a short clipped value where it is not secret, a hash of the whole |
| outcome, rule, reason | which row decided |
| result | ok, error class, size |
| critical | true for the events below |

Never in it: a token, a key, a password, a full mail body. The runtime's log ring and „wizards
report“ (`docs/plans/remote-debug.md`) take the same lines, scrubbed, so the Manage-App's Diagnose
page shows them.

What reads it: „Letzte Nutzung“ on a connection's page; **Fähigkeiten › Protokoll**, a page per
space with filters (connection, who, outcome, critical) and a search; the Manage-App's admins
across tenants; retention as the run log's.

## Notifications

**Critical** is any of: a *Nie* on a write, delete or send attempt; a guest run reaching a
connection outside its audience; a request to a host not in the grant; a limit reached; a
sign-in that ran out or was refused by the service; the first use of a new connection; a rule
changed.

| Who hears | How | When |
|---|---|---|
| the space's admins | the bell in Work (`chat_approval` grows a kind), the Protokoll page | at once |
| the space's admins | one mail per hour with the critical lines, through the mail connector set for it | where nobody was in the app |
| the Manage-App's admins | the runtime's report, the Diagnose page, the Abuse checks page | at once for guests, daily otherwise |
| later: a webhook | the connection's own channel (Slack …) | admins choose |

An admin chooses per space which kinds notify and where; the defaults are above.

## „Was darf …?“

Rules are only understood when they can be tried. The Protokoll page gets a line: pick *who*, an
action and a connection, see the outcome and the rule that gives it, before anything runs. The
same function the broker uses, with no side effect. The same shows on a wizard's publish page:
„Dieser Wizard darf: lesen in …, senden an …“, drawn from its grant.

## What the architecture has to do for it

- **Every outside effect is a broker action.** Connector actions, the mail tools, `http_request`,
  the folder tools, share targets, plugin connections, the browser session. Each tool registers
  `{ connection, action, kind }` and calls `broker.call`; none fetches on its own. `safeFetch`
  and `connectionContext` become private to the broker. A test walks every tool and fails on one
  without a descriptor.
- **The sandbox's network is a broker rule.** agentOS gets its allow-list from the grant
  (registries plus the hosts the wizard named); Docker is not offered to guests (A1). A command
  that needs a service asks the AI, which calls the broker.
- **Secrets live in the vault, read only by the broker.** Today `store_secret` and
  `plugin_connection` hold them sealed; the broker becomes the only reader. Step 2 of
  „Guests and the team“ moves the vault and the key into the broker's own process.
- **One table of connections of the space** (capabilities plan, A5) carries audience and rules;
  the broker reads it, the page writes it.
- **Who calls is known at every call.** Runs carry the holder and mode; chats the person; Goose
  its person; plugins the plugin id; a fixed step its wizard. Nothing is called without a *who*.
- **The model never decides.** Tool descriptions say what the broker may refuse, so the model
  doesn't retry a *Nie*; the refusal text goes back as a result, not an error it can work
  around.

## Phases

0. **RWX.** The table, deny by default, *verboten* wins, one reader per resource kind, search
   filtered by R, the test suite. Documents, tables, connections, mail, hosts, the sandbox.
1. **Library, rules as data, log.** `apps/runtime/src/broker/`: `call`, the decision, the
   table of rules on the space's connections, `broker_log`, the migration of the five call sites
   (A2–A5 of the capabilities plan). Rules editable only through the API; the pages come with
   part B.
2. **Heard and tried.** The critical kinds, the bell and the hourly mail, the Manage-App's
   report, „Was darf …?“, Fähigkeiten › Protokoll.
3. **Own process.** The broker as `RUNTIME_ROLE=broker` holding the vault and the key; runners
   and the studio call it over the private network; a guest instance opens only „alle“. Cedar
   or OPA may read the same rows for an enterprise that wants its own policy engine; the
   product still shows sentences.

## Open

- The German word for the component in the product: it shows as its pages (Protokoll,
  Freigaben, „Was darf …?“) and never needs a name; the docs say „der Broker“.
- Limits: per run and per day are enough at first; per person and per connection later.
- Does a member see the Protokoll of their own calls? Proposed: yes, their own; admins all.

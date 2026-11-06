---
title: The broker
description: The one path every connector call takes in engenty wizards – who calls, what decides, what a run may reach, what is logged and heard, the RWX rules and the routes the studio uses.
version: 0.17.1
---

Every call a wizard step, a Work chat, Goose, a share target or a plugin makes to a connected
service goes through one function: `brokerCall` in `apps/runtime/src/broker/call.ts`. The broker
reads the account’s secret (nothing else does), decides *allow*, *ask* or *deny*, asks where the
rules say so, runs the action and writes one row of `broker_log`, whatever came of it. Model calls
don’t pass it.

The broker is a library inside the runtime’s processes, not a process of its own. Everything it
exports comes from `apps/runtime/src/broker/index.ts`. The words the studio shares with it live in
`packages/shared/src/connectors.ts` and `packages/shared/src/rwx.ts`.

## Words

| Word | Means |
|---|---|
| Broker | The gate in the runtime every connector call passes. The app never shows the word |
| Connection | A space’s account at a service (`space_connection`), set up by the space’s admins. It signs in as the space or as each person |
| A wizard’s own connection | A `connections` entry of a wizard definition. The person running the wizard signs in during the run (`store_secret`) |
| Grant | What a run may reach outside, fixed when the run is created (`run.grant`) |
| Approval | An admin’s yes to a call held by „Mit Freigabe“ (With approval) on a connection that signs in as the space |
| Critical | A log row someone should hear of: one of `CRITICAL_KINDS` |
| RWX rule | One row of a space’s `subject × resource × r w x` table, behind the `broker` switch |
| Guest, member, admin | A guest runs a wizard from its link and has no role. A member or an admin (the owner counts as one) is signed in to the organization |

## Who and where

Each call carries `who` and `where`.

```ts
type WhoKind = "guest" | "person" | "admin" | "goose" | "plugin" | "step";

interface Who {
  kind: WhoKind;
  id?: string;      // the visitor, the person, the plugin or the step
  for?: Who;        // a fixed step: whom its run is held for
  admin?: boolean;  // Goose for an admin
}

interface Where {
  runId?: string;
  stepId?: string;
  chatId?: string;
  wizardId?: string;
  spaceId?: string;
  mode?: "test" | "live";
  guest?: boolean;  // a live run nobody signed in for
  share?: boolean;  // a share job: the one caller of a run that is done
}
```

- `whoOf(holder, role)` turns a run’s holder into a `Who`: `u:<user>` is a person, or an admin
  for the roles owner and admin. `v:<visitor>` and `r:<run>` are guests.
- `whereOf(ctx)` and `whereOfRun(run, holder, spaceId)` build `where` for a step or a share job.
- A plugin never names its caller. The runtime sets it with `withCaller({ who, where }, fn)`
  where it hands the plugin a call, and `server.connections.call` reads it with
  `currentCaller()` (`broker/caller.ts`).

`ActionKind` is `read`, `write`, `destructive` or `send`. `kindOf(group)` maps a connector
action’s group to the kind of the same name. A connector action that mails, messages or posts to
other people has the group `send` (SMTP’s, Gmail’s and Outlook’s `send_message`, Slack’s
`post_message`); creating or changing a record is `write`, deleting is `destructive`. An imported
connector’s action has no such group in its spec, so `groupOf`
(`connections-external/importer/classify.ts`) guesses it by name: an action that is no read,
whose id or summary says send, mail, message, post or notify, and not draft, update or delete,
is a `send`. A caller may name the kind itself, as the mail tools, the share targets and
`http_request` do.

An admin’s word comes before that guess. `PATCH /spaces/:id/connectors/:connectorId/actions`
keeps, per action of an imported connector, a kind and for a `send` the input field that holds
the recipient (`action_kinds` on the stored record, `body.to` for a field inside an HTTP body).
`groupIn` (`classify.ts`) reads it first, so the connector’s action carries the admin’s group and
`kindOf` returns the admin’s kind everywhere: in `brokerCall`, in the run’s grant and in „Was
darf …?“. The named field reaches the broker as the action’s `recipientField`. Reloading the
actions keeps both. A changed kind is logged like a changed rule (`change_rules`), once for every
connection on that connector.

## Connections

`BrokerConnection` is one of two:

| `kind` | What it is | Who signs in |
|---|---|---|
| `store_secret` | A wizard’s own connection (`def: ConnectionDef`) | The person running the wizard, kept in the run’s store |
| `space_connection` | A row of `space_connection` with its connector | The space once (`signIn: "space"`), or each person (`signIn: "person"`, rows in `space_connection_sign_in`) |

A space connection holds its `audience` (`admins`, `members` or `all`), its `rules` per
`ActionKind` and optionally the action ids it is for. `DEFAULT_CONNECTION_RULES` start a new one:
`read: "allow"`, `write: "ask"`, `destructive: "deny"`, `send: "ask"`. `inAudience(audience, who)`
decides the audience. A fixed step is in the audience of whom its run is held for, and Goose for
an admin counts as an admin.

A space connection can pause: `paused_at` and `paused_by` on its row, set by
`pauseSpaceConnection` (`POST /connections/:id/pause` and `/resume`, admins only). While it pauses
the broker refuses every call through it. Nothing else changes: the sign-ins, the rules and the
audience stay.

A space connection can limit its calls: `calls_per_run` and `calls_per_day` on its row, both empty
on a new one, set with `PATCH /connections/:id` (admins only). See
[A connection’s limits](#a-connections-limits).

## A stop that holds

Two things are asked before anything else, on every call. Neither trusts what a step or a chat
turn read when it started.

**The run.** `runOver(where)` in `broker/over.ts` reads `run.status` for `where.runId`. A run that
is `cancelled`, `done` or `failed` calls nothing more, whatever the connection: a space
connection, a wizard’s own, a host, the server’s mail, a kept secret. All four paths ask it first
(`brokerCall`, `brokerHost`, `brokerSend`, `brokerSecret`), refuse with `run_ended` and log the
call with the rule `run.<status>`. There is no separate revoke: stopping a run (`cancel()` in
`engine/runner.ts`, `POST /api/runs/:id/cancel`, MCP `control_run`, “Stop run” in the Audit) is
the revoke. Three things to know:

- A call already under way finishes. The broker refuses the next call and does not take back what
  has left.
- A share job is the one caller of a run that is done. `sharing/jobs.ts` sets `where.share`, and
  the share agent’s step and the run’s browser carry it. With `share` a `done` run calls, a
  `cancelled` or `failed` one does not.
- A run this tenant does not have is not refused here. The grant refuses it for a wizard’s own
  connection and for a bound host (`not_in_grant`).

**The pause.** For a space connection `brokerCall` reads `paused_at` again on every call
(`stateOf` in `broker/account.ts`, which reads the limits with it) and puts it on the row before
`decide` sees it. So a step whose
tools hold the row from before the pause is refused at its next call, and so is a chat turn. A
connection that was removed since is refused the same way, as `not_connected`. The account is not
read and no token is renewed for a call that is refused here.

## A connection’s limits

A space connection takes at most `calls_per_run` calls from one run and `calls_per_day` calls a
day. Empty means no limit, and a new connection has both empty. They count for every caller: an
admin, a member, a guest, an AI step, a fixed step, Goose, a plugin’s own job. A wizard’s own
connection has none.

- **What counts.** A call the broker lets through to the service, whatever comes of it: one that
  fails counts, and one still under way. A call that is refused, one that waits for an approval
  and a changed rule count for nothing. `counted()` in `broker/log.ts` says so in one place, from
  the lines of `broker_log`: there is no counter beside the log.
- **Per run** counts the lines of that connection with the call’s `run_id`. A call with no run (a
  Work chat, Goose, a plugin’s job) is bound by the day only.
- **Per day** counts the connection’s lines since midnight UTC (`startOfToday`), runs, chats and
  jobs together.
- **One write.** A call that would run takes its place first: `takePlace` writes the call’s line
  with one `INSERT … SELECT … WHERE` whose condition is the count. Of two calls at once only one
  gets the last place, in whichever process they run. The line has no `result` while the action
  runs, and `closeLine` fills in `result`, `duration_ms` and `result_size` at its end. These are
  the only rows of `broker_log` that are written twice. A connection without a limit keeps
  writing its line once, at the end.
- **Read at the call.** The limits come from `stateOf` with the pause, so a changed limit binds a
  step or a chat turn that read the row before.
- **Past a limit** the call is refused as `calls_per_run` or `calls_per_day`, with the rule
  `limits.run` or `limits.day`, and the action does not run. Where the limits cannot be counted
  (the database fails), `takePlace` throws and the call does not run either.
- **A guest’s mails keep their numbers.** `guestSendCheck` runs before, with `run_limit` and
  `day_limit`. A connection’s limits come on top, under their own names.

`spaceConnectionViews` adds `callsPerRun`, `callsPerDay` and `callsToday` (`callsToday` in
`broker/log.ts`) to each view. A changed limit is logged with `logRuleChange`; its input is the one
field `limits` (`calls per run: none → 20`), which is how the Audit tells it from other changes.

## `decide`

`decide({ who, where, connection, actionId, kind, grant })` is pure: it reads nothing and runs
nothing. `brokerCall` uses it for every call, and „Was darf …?“ answers with it. It returns a
`Decision` with `outcome`, the `rule` that decided, a `reason`, and for an ask of the space’s
admins `admins: true`. The checks run in this order:

1. **The grant.** A wizard’s own connection in a run, outside the run’s grant: deny, rule `grant`.
2. **A space connection:**
   - a connection that pauses: deny, rule and refusal `paused`, for every caller and before a
     plugin’s own job;
   - a plugin’s own job on a connection it set up, outside any run or chat: allow, `own_job`;
   - a caller outside the audience: deny, `audience`;
   - an action the connection is not for: deny, `actions`;
   - a change, delete or send by an AI step on a connection that signs in as the space: deny,
     `ai_step_writes`. Only a fixed `call` step or a Work chat’s confirmed action writes there;
   - otherwise the connection’s rule for the kind, `rules.<kind>`: *deny*, *allow*, or *ask*. An
     ask goes to the person where each person signs in, and to the space’s admins where the space
     signs in.
3. **A wizard’s own connection:** deleting always asks (`destructive`). Otherwise the wizard’s
   `connection.policy` for the action decides (`policy.<action>`). Without one, reading is
   allowed (`read`) and anything else asks the person running (`policy`).

## `brokerCall`

```ts
brokerCall({ who, where, connection, action: { id, kind? }, input, ctx?, handler? })
  → { ok: true, result, account } | { ok: false, refused, reason }
```

![brokerCall asks whether the run is over and whether the connection pauses, reads the account, checks the grant, decides, checks a guest’s send, asks where it must and takes the call’s place under a space connection’s limits, then runs the action. Each check can refuse, and every call goes to broker_log](../../assets/diagrams/broker-order.svg)

In order, it:

1. refuses a call of a run that is over (`runOver`, above): `run_ended`;
2. reads a space connection’s pause and limits again and refuses a paused one (`paused`), and one
   that was removed (`not_connected`);
3. reads the account. A sign-in that ran out and can’t be renewed is logged as `sign_in_failed`
   and refused as `not_connected`;
4. checks the grant where one binds the call (`grantBinds`: a wizard’s own connection, in a run,
   and not a share target’s connection);
5. refuses a missing account (`not_connected`) or an unknown action (`no_action`);
6. asks `decide`. A deny returns its refusal;
7. checks a guest’s send (`guestSendCheck`, below);
8. on an ask of the admins, runs only with `ctx.approved`. Otherwise it refuses with
   `needs_approval`, and the caller holds the call (a Work chat in `chat_approval`, under the bell);
9. on an ask of the person, runs when `ctx.allowed` holds `<connection>:<action>` (“for the rest of
   the run”) or `ctx.confirmed` is set and the call deletes nothing. Otherwise it calls `ctx.ask`.
   With no one to ask it refuses with `nobody`, and on a no with `declined`;
10. takes the call’s place under a space connection’s limits (`takePlace`, above). With none left
    it refuses with `calls_per_run` or `calls_per_day`;
11. runs the action (the connector’s handler, or `handler`), marks the space connection used and
    logs the call. An error the action throws is logged and thrown on. A 401 or a lost OAuth grant
    is logged as `sign_in_failed`.

`brokerConnected(connection, who)` says whether and as whom a connection is signed in, without the
secret. `brokerSecret` reads a run’s kept secret that is no connection (the browser’s kept
sign-ins) through the same log. It answers `{ ok: true, result }`, or for a run that is over
`{ ok: false, refused: "run_ended" }`. Then its handler does not run, and the run’s browser opens
signed in nowhere.

### Refusals

`BROKER_REFUSALS` in `packages/shared/src/connectors.ts` lists every `refused`, and the Log page
has words for each:

| Refusal | Why |
|---|---|
| `not_connected` | Nothing is connected, the person has not signed in, or the sign-in could not be renewed |
| `no_action` | The connector has no such action |
| `not_in_grant` | The run’s grant does not include the connection, the action or the host |
| `denied` | A rule says no: the audience, the connection’s actions, *Nie*, or the grant in `decide` |
| `declined` | The person asked said no |
| `nobody` | The rules say ask, and nobody can be asked |
| `needs_approval` | *Mit Freigabe* on a connection that signs in as the space: the call waits for an admin |
| `ai_step_writes` | An AI step wanted to change, delete or send as the space |
| `not_allowed_recipient` | A guest’s send to an address that is neither the run’s own nor in the space’s mail domains, or a send that names no recipient |
| `channel_not_fixed` | A guest’s post to a channel that the published step does not fix |
| `run_limit` | A guest’s run has sent its mails and posts (`GUEST_MAILS_PER_RUN`, 3) |
| `day_limit` | The wizard’s guests have sent today’s mails and posts (`wizard.dailyMailLimit`, 50 unless set) |
| `calls_per_run` | The run has made the calls the space connection takes from one run |
| `calls_per_day` | The space connection has taken today’s calls |
| `run_ended` | The call’s run was stopped, is done or failed. The rule says which: `run.cancelled`, `run.done`, `run.failed` |
| `paused` | An admin paused the space connection |

The model reads each refusal in words from `prompts/tools.md`, through `refusalNote`
(`tools/connector.ts`) and `connectionRefusalNote` (`tools/connections.ts`): `note.run_ended` and
`note.connector_paused` for these two, `note.connector_calls_per_run` and
`note.connector_calls_per_day` for a connection’s limits. A fixed step that a limit refuses fails
with a note of its own (`stepCallsPerRun`, `stepCallsPerDay`). A share job reaches a space
connection only through its agent’s tools, so it reads the model’s note. A plugin’s call throws
the broker’s reason.

A connection’s limits have refusals of their own, apart from `run_limit` and `day_limit`. Four
readers word a refusal (the Audit, a model, a fixed step, the Audit’s filter by result), and three
of them see the refusal alone, not the rule beside it. With one name for both, a model would be
told of mails where a connection’s calls ran out.

### A fixed step that would wait

„Mit Freigabe“ holds a call only in a Work chat. In a run nothing waits: a fixed step whose call
asks the space’s admins gets `needs_approval` and fails. `stepWarnings(spaceId, draft)` in
`services/wizards.ts` finds these steps before a run does. For each fixed step on a space
connection it asks `decide` as the step of an admin’s run, and warns where the answer is an ask of
the admins. It reads the rule as it is, so the warning is gone once the rule says *Erlaubt*. A
read, a rule on *Nie*, a paused connection and a wizard’s own connection never warn. The warnings
are `StepWarning[]` (shared) on the wizard’s state and on the answer of `PUT /wizards/:id/draft`,
beside `issues`. They are no issue: the draft saves and publishes. The editor words them in
`apps/web/src/studio/editor/step-warnings.ts`.

## The run’s grant

`grantOf(definition)` in `broker/grant.ts` is pure: the same definition gives the same grant.

```ts
interface Grant {
  connections: Record<string, string[]>; // action ids, or the kind "read"
  hosts: string[];                       // names, or "*.example.org"
  tools: string[];
  channels?: Record<string, FixedChannel>; // by step id: { connection, action, channel }
}
```

- A step’s `connections` add the actions its connection names, or `read` without a list.
- A fixed step’s `call` adds its one action on its connection.
- A step’s `hosts` add the hosts `http_request` may reach.
- A fixed step whose `call.input.channel` is a literal adds that channel under the step’s id.
  A literal is a text with no `{{…}}` in it. A channel that comes from a field, a value or an
  earlier step is a template and adds nothing. `connection` is the id the log uses: the space
  connection’s where the wizard’s entry names one, else the entry’s own. A run that started
  before this has no `channels`.

`createRun` (`engine/runner.ts`) computes the grant from the definition the run starts on: the
published one for a live run, the draft for a test run. It keeps the grant in `run.grant`, so an
edit never widens a run under way. `runGrant(runId)` reads it, and for an older run computes it
once from the run’s definition and writes it. `inGrant` always lets `list_tools` through.
`grantNote` writes the run’s first log line (“This run may: …”).

### Hosts, sends and results kept in the space

- `brokerHost` (`broker/host.ts`) runs `http_request`. It logs the call as connection
  `host:<name>`, action `http_request`, kind `send`. A guest’s run reaches only the hosts in its
  grant. A member’s run reaches any public host, until the `broker` switch is on.
- `brokerHost` and `brokerSend` (the server’s own mail, `mail:server`) ask `runOver` first, like
  `brokerCall`: a run that is over reaches no host and sends no mail.
- `guestSendCheck` (`broker/send.ts`) lets a guest’s send go only to an address a page field of
  kind `email` collected in the run, or to the space’s `mailDomains`. It holds a connection’s
  send action as well as the email share target.
- A guest’s post to a channel is Slack’s `post_message` (`postsToChannel`), and its input names
  the channel as `channel`. `guestPostCheck` is pure and allows it only when a fixed step posts
  (`who.kind` is `step`) and `channelInGrant` finds that step, connection, action and channel in
  the run’s grant. The grant comes from the published definition, so nothing the guest typed
  decides it. Everything else is refused as `channel_not_fixed`: a templated channel, even
  where it renders to the same id, and the guest’s own call from an AI step or the Slack share
  target.
- `recipientsOf(input, field)` reads a send’s addresses from `to`, `cc`, `bcc`, `recipients` and
  `recipient`, and from the field an admin named for the action (`recipientField`). The named
  field comes on top of the others, never in their place: an address in `cc` still counts.
- Any other send that names no address is refused as `not_allowed_recipient`. That holds an
  imported connector’s send until an admin names the field with the recipient.
- The limits count mails and posts together, per run and per wizard and day. They count what
  `broker_log` holds as an `ok` send of a guest (`who_kind` `guest`) or of a fixed step in a
  guest’s run (`who_kind` `step`), and no request to a host.
- `keptStepIds` (`broker/kept.ts`) names the steps of a guest’s run that read from a space
  connection whose audience is not `all`. Their results stay in the space.

## The log

`broker_log` holds one row per call: when and how long, who (`who_kind`, `who_id`), where
(`run_id`, `step_id`, `chat_id`, `wizard_id`, `space_id`), `connection_id`, `action_id`, `kind`,
`input_summary`, `outcome`, `rule`, `reason`, `result`, `result_size`, `critical` and
`critical_kind`. `summarizeInput` keeps the input’s field names and sizes, one clipped value whose
field name doesn’t look like a secret, and a SHA-256 of the whole. No token, key, password or body
is ever written. A log that can’t be written never stops the call. The one exception is a call
through a space connection with a limit: its line is how it takes its place, so it is written
before the action runs and filled in after ([A connection’s limits](#a-connections-limits)).

Admins read the whole log of a space. A member reads their own lines, where the space’s Studio is
open to members (`services/members-studio.ts`). `ownLines(userId)` in `broker/log.ts` says which
those are:

- `who_kind` is `person` or `goose` and `who_id` is the member. An AI step calls as the person
  its run is held for, so its lines are among them;
- `who_kind` is `step` and the line’s run is held for the member (`run.user_id`).

`logOfSpace` and `logLine` take the member as `own` and put `ownLines` into the query’s `where`.
So a page, a cursor, a filter and a search never count another person’s line, and
`GET /spaces/:id/broker/log/:line` answers 404 for one, as for a line that isn’t there. A line
the member wrote as an admin (`who_kind` `admin`, `change_rules` among them) is not theirs.

`routes/broker.ts` names a member’s lines with less than an admin’s: the only person is the
member, a space connection outside their audience has no name, connector or action name, and
`run` with its grant is there only for a run held for them. Everything else on the line is the
member’s own call: the input’s summary, the outcome, the rule, the reason and the critical mark.

`criticalOf(row)` in `broker/log.ts` is the one place that decides whether a row is critical:

| `CRITICAL_KINDS` | When |
|---|---|
| `refused_write` | A change, delete or send was refused |
| `outside_audience` | A guest’s call was refused by a connection’s audience |
| `host_not_in_grant` | `http_request` to a host the grant doesn’t include |
| `limit_reached` | `run_limit` or `day_limit`, each time. `calls_per_run` or `calls_per_day`, the first time in that run or on that day |
| `sign_in_failed` | A sign-in ran out, or the service refused it |
| `first_use` | A space connection’s first call that ran |
| `rule_changed` | An admin changed RWX rules, or a connection’s rules, audience, limits or way of signing in, or paused or resumed a connection (`logRuleChange`) |

A call that a paused connection refuses is not critical, whatever its kind. The admins paused it
themselves and heard of that, and the hourly mail about critical lines may go through that very
connection. A refused call of a run that is over follows the rule above: critical where it wanted
to change, delete or send.

A connection’s limit is heard of once per run or day: the first call it refuses is critical, the
ones after it are refused and logged (`limitHeard`). A model that tries again, and the hourly mail
going through that connection, add no further critical lines.

A critical row goes four ways:

- a warning line in the runtime’s own log, so the log ring and `wizards report` carry it;
- `onCritical` listeners: `services/manage-reports.ts` posts a guest’s rows to the Manage-App at
  once and the rest daily, to `POST /v1/broker/:tenant`;
- the bell in Work: `GET /api/studio/work/approvals` answers `{ approvals, critical, unseen }` for
  an admin, and `POST /api/studio/work/approvals/seen` marks the lines seen;
- an hourly mail to the space’s admins (`services/broker-notify.ts`), only when none of them was in
  the app since. It goes through the space’s mail connection that signs in as the space, else the
  server’s address. `space.notify` (`{ bell, mail: "hourly" | "off" }`, `PATCH
  /api/studio/spaces/:id`) turns it off.

### The walk test

`reachesOutside(id, reaches)` (`broker/registry.ts`) registers what a tool or share target reaches.
`test/broker-walk.test.ts` fails on a file that reaches outside without `brokerCall` and without
registering. A new tool that calls a service registers there.

## RWX and the `broker` switch

`broker/rwx.ts` keeps one table of permissions per space (`rwx_rule`): a subject, a resource (a
kind with an id, or `*` for all of the kind), and `r`, `w`, `x` each `allow`, `deny` or unset.

| Subject | Id | Who it is |
|---|---|---|
| `guest` | none | Someone at a shared link or a public page |
| `role` | `member`, `admin`, `owner`, `client` | Everyone with that role in the organization |
| `person` | The user’s id | One person |
| `goose` | The user’s id | Goose working for that person |
| `agent` | none | An AI working for a person: a Work chat, a client’s chat, Claude or Codex through MCP |
| `wizard` | The wizard’s id, or `*` | A run of that wizard |
| `plugin` | The plugin’s id | A plugin, beside whom it was called for |

- Unset means deny, and a deny wins over every allow.
- A rule on a page of Wissen holds for what lies in it: its deny closes the folder, its allow
  opens it (`withFolders`). The document behind a page or a table is asked as well.
- Every space starts with a seed: owners and admins read, write and execute, members read and
  write, guests read. It holds flags no reader asks yet, so a later reader starts from them.

All of this is behind the `broker` switch, on by default. With it off, `decide`, `readable` and
`assertRwx` in `rwx.ts` say yes to everything, the rules routes answer 404, and a member’s
`http_request` reaches any public host. On, the seed changes nothing until an admin
writes a deny.

### What is asked

`RWX_ASKED` in `packages/shared/src/rwx.ts` is the one table of what a reader asks today: per
kind of resource and permission, the kinds of subject it is asked for. The runtime refuses a rule
outside it (`refusalOf`), and the studio offers nothing else.

| Resource | Perm | Asked for | By |
|---|---|---|---|
| `document` | `r` | every subject | Every reader of Knowledge; a plugin’s `files` and `readFile` |
| `page` | `r` | every subject | Every reader of Knowledge; a plugin’s `readPages` |
| `page` | `w` | `person`, `role`, `goose` | Goose’s `write_knowledge_page` |
| `table` | `r` | every subject but `plugin` | The readers of Knowledge and Daten, shared lists |
| `wizard` | `r`, `x` | `person`, `role`, `agent` | `wizard_list` and `wizard_run` in a Work chat and for outside clients; the client portal |
| `skill` | `r` | every subject but `plugin` | `skill_list`, `skill_load`, `skill_read` |
| `skill` | `x` | `guest`, `person`, `role`, `wizard`, `agent` | A skill’s scripts placed in a sandbox |
| `setup` | `w` | `person`, `role`, `goose` | Goose’s writes to the space’s setup |
| `mount` | `r` | every subject but `plugin` | `readableMounts` |
| `mount` | `w` | `person`, `role`, `agent` | A draft and „Veröffentlichen“ (`mounts/drafts.ts`) |

Nothing asks a rule on `connection`, `mail`, `host` or `sandbox`: a connection’s own audience and
rules decide (`broker/call.ts`), and a run’s grant decides hosts. Nothing asks `w` or `x` on a
document or a table, `x` on a page, `w` on a wizard or a skill, or `r` on the setup. What only
Goose asks (`w` on a page and on the setup) is not asked for the role `client`, who reaches no
studio.

Some of it is narrower than the kind suggests. `w` on a page and on the setup is asked where
Goose writes; a person changing them in the studio is not asked. `r` and `x` on a wizard are
asked for the AI’s tools and the client portal; a guest at a wizard’s link and a person starting
one in Work or the studio are not asked. A reader that starts asking adds its line to `RWX_ASKED`,
and `test/rwx-rules.test.ts` holds the table against `ENFORCED`.

### Who writes rules

| Writer | What it writes | `origin` in the list |
|---|---|---|
| The seed (`seedRwx`), and Rechte for a role | A role’s or the guests’ rule on `*` of an enforced kind | `start` |
| „Wer sieht diesen Ordner“ (`setFolderAudience`) | On a page of Wissen: the team or the guests closed, the clients let in | `folder` |
| A mount’s form (`mountRules`) | Every rule on a mount | `mount` |
| „Für Kund:innen sichtbar“ (`setOpenToClients`) | The clients’ read on a document, a table or a wizard | `clients` |
| Rechte (`addRule`, `changeRule`, `deleteRule`) | Every other rule | `rights` |

`originOf` in `broker/rights.ts` reads the origin off the rule, with no column for it. A place
that shows a rule also replaces it, so a rule in the folder dialog’s shape is the dialog’s whoever
wrote the row. The rules routes add, change and remove one rule at a time and never touch
another. They refuse a rule on a mount: its form reads the rules back as its switches and replaces
them all.

Every reader takes its subjects from whoever it serves: the studio’s person (`whoOf(c)`), a
run’s holder and wizard (`subjectsOf(ctx)`, `runHolder(run)`), Goose for its person. What a step
is told about Knowledge is counted the same way: how many pages, tables and files there are and
the categories with their values and ranges (`knowledgeBlock`), and what `space_list` counts,
hold only what the run’s holder and wizard may read.

A plugin reading the space’s pages and documents (`server.spaceData.readPages`, `.files`,
`.readFile`) reads as whom it serves, and as itself: a tool in a step or a Work chat as its
caller (`subjectsOfCaller`), an HTTP route as the person it answers, a job as the runtime itself.
Anything else reads as the plugin alone, which no seed allows: the lists come back empty and
`readFile` is refused. The runtime itself is the subject `SYSTEM`, set with
`readingAs([SYSTEM], …)` around a plugin’s job (`plugins/jobs.ts`) and nowhere else: no person,
guest or run stands behind a job. It may read, write and run everything; a deny for the plugin
beside it still wins. No rule can name it, no helper builds it from a request, `decideWith`
knows it only by identity, and
`test/rwx.test.ts` fails when a new file uses it. A call with no subject at all stays a no.

The `capabilities` switch is on by default. It shows the studio’s Capabilities place, opens
`/spaces/:id/discover` and makes the rule „Mitglieder dürfen ins Studio“ count. It does not turn
on RWX. The routes for connections, rules and the broker (`/connections`, `/rules`, `/broker/*`)
don’t read the switch: with it off they still answer, and only the studio’s pages for them hide.

## Routes

All under `/api/studio`, for a signed-in person of the organization.

| Route | What it does | Who |
|---|---|---|
| `GET /spaces/:id/connections` | The space’s connections, each with who set it up and, where a plugin holds it, the plugin (`plugin`, `pluginName`). `reachedByGuests` (shared) says which ones guests reach: `audience: "all"` and `signIn: "space"`. `callsPerRun` and `callsPerDay` are its limits (null: none), `callsToday` the calls it took today | Everyone; a member sees the ones in their audience |
| `POST /spaces/:id/connections` | Sets one up: connector, name, `signIn`, `audience`. `signIn: "person"` answers `403 { code: "plan" }` where the plan’s switch `personSignIn` is off | Admins |
| `PATCH /connections/:id`, `DELETE /connections/:id` | Changes its name, `signIn`, audience, rules, limits (`callsPerRun`, `callsPerDay`: a whole number from 1, or null for none) or the actions it is for, or removes it. A changed `signIn` forgets the sign-ins of the way it leaves; to `person` it answers `403 { code: "plan" }` without `personSignIn`, and `400` on a plugin’s connection | Admins |
| `POST /connections/:id/pause`, `POST /connections/:id/resume` | Pauses the connection, or resumes it. The view carries `pausedAt` and `pausedByName`. Logged as a changed rule | Admins |
| `POST`, `DELETE /connections/:id/sign-in` | Signs the space in or out: `{ credentials }`, or `{ oauth: true }` for a sign-in page | Admins |
| `POST`, `DELETE /connections/:id/my-sign-in` | The person’s own sign-in, where each person signs in | Everyone in the audience |
| `GET /person/sign-ins` | The person’s connections across their spaces | The person |
| `GET /spaces/:id/rules` | The RWX rules, each with its `origin` and the names of who and what it is about (`subjectName`, `resourceName`, `folder`) | Admins; 404 while `broker` is off |
| `POST /spaces/:id/rules` | Adds one rule: `subjectKind`, `subjectId`, `resourceKind`, `resourceId`, `r`, `w`, `x`. `400` with the reason for a rule no reader asks, one on a mount, one about a resource the space does not have, and a second rule about the same subject and resource | Admins; 404 while `broker` is off |
| `PATCH /spaces/:id/rules/:ruleId` | Sets the flags it names (`null` takes one away), and leaves the others. A flag set here is checked against `RWX_ASKED`; a rule left without a flag is refused | Admins; 404 while `broker` is off |
| `DELETE /spaces/:id/rules/:ruleId` | Removes one rule | Admins; 404 while `broker` is off |
| `GET /spaces/:id/rules/ask?who=&id=&for=&resource=&resourceId=&perm=` | „Was darf …?“ for content: `who` is `guest`, `person`, `goose`, `agent`, `wizard` (`for`: the person its run is held for, else a guest) or `plugin` (its own job); `resource` is `document`, `page`, `table`, `wizard`, `skill` or `setup`. Answers `{ ok, rule, reason }` by `decideWith`, as the readers decide. `400` for what no reader asks. Nothing is read, run or logged | Admins; 404 while `broker` is off |
| `GET /spaces/:id/rules/choices` | The people, wizards, plugins, documents, pages, tables and skills a rule can name | Admins; 404 while `broker` is off |
| `GET /spaces/:id/broker/log` | The log, newest first. Filters: `connection`, `who`, `outcome`, `result`, `refused`, `critical`, `since`, `until`, `q`; `cursor` with the `next` of the page before, `limit` | Admins: every line. A member: their own lines (`ownLines`); 403 where the space’s Studio is closed to members |
| `GET /spaces/:id/broker/log/:line` | One line, with the run’s grant and status. The Audit’s “Stop run” reads the status and calls `POST /api/runs/:id/cancel` | Admins. A member: their own line; 404 for another person’s |
| `GET /spaces/:id/broker/ask?who=&for=&resource=&action=&in=` | „Was darf …?“: `decide`’s outcome, rule and reason. A guest’s post to a channel is answered as the call is: a fixed step gets the connection’s rule and the condition in its reason, any other caller `deny` by `guest_send`. Nothing runs and nothing is logged | Admins (403 for a member) |
| `GET /spaces/:id/broker/choices` | The people and the space’s connections with their actions, for the question | Admins (403 for a member) |
| `GET /spaces/:id/discover?q=` | Skills from skills.sh and connectors from integrations.sh, marked where the space has them. `bundles` names each repository among the skills that is a plugin with a server over http, with the hits it stands for (`covers`) | Everyone; 404 while `capabilities` is off |
| `POST /spaces/:id/connectors/preview` | Reads an address before it is imported: `{ sourceUrl, sourceKind?, signIn? }`. Answers what is there (`mcp` or `openapi`), each action with its guessed kind and input fields, the sign-in the source describes, the id and tool prefix its host suggests, and `privateAddress` | Admins of a space that can be changed here |
| `POST /spaces/:id/connectors` | Imports a connector. For a pasted address `domain`, `id` and `toolPrefix` may be left out, `signIn` is the admin’s choice (`described`, `header` with a name, `none`) and `actionKinds` what single actions do | Admins |
| `POST /spaces/:id/connectors/:connectorId/refresh` | „Aktionen neu laden“: reads the source again, with the sign-in of a signed-in connection on that connector. The broker reads the sign-in, so it is logged as `list_tools` | Admins |
| `PATCH /spaces/:id/connectors/:connectorId/actions` | What single actions do: `{ actions: { <id>: { kind, recipientField? } \| null } }`; `null` takes one back to the guess | Admins |
| `POST /spaces/:id/bundles/preview` | Reads a plugin for Claude Code or Cursor: `{ address, path?, servers? }`, or a form with `file` and the rest as JSON in `options`. Answers `{ preview, plugins }`: the name and version, each server over http as an address is read, the skills, what is left out, and a `hash`; `plugins` where the repository holds several | Admins of a space that can be changed here |
| `POST /spaces/:id/bundles` | Takes it: the same source, `hash`, `servers` (per server’s name: `take`, `id`, `toolPrefix`, `name`, `signIn`, `actionKinds`), `skills` (the folders to take). Answers the bundle, the connectors and warnings | Admins |
| `GET /spaces/:id/bundles` | What came together, each with its connectors, connections and skills | Admins |
| `GET /bundles/:id/update`, `POST /bundles/:id/update` | What the origin has now (`update`, or `upload: true` for one from a file), and taking it: `{ hash }`, or a form with the new `file` | Admins |
| `GET /bundles/:id/removal`, `DELETE /bundles/:id` | What removing takes and the wizards that use its connections, and removing all of it | Admins |

### A connector from an address

A connector whose record has no `registry_surface_slug` came from a pasted address
(`connectors/external.ts`). Its view says `fromAddress`, the studio marks it „nicht geprüft“, and
a new connection on it defaults to the audience `admins`.

- **Sign-in.** An MCP server is asked for its tools without a sign-in. If it answers, the
  connector needs none. If it answers 401, its own OAuth documents are read (`probeOAuth`: the
  protected-resource document, then the authorization server’s metadata). Otherwise the import
  takes the admin’s choice: a key in a header, stored as `api_key` with a header placement, or
  none. An OpenAPI description says it in its security schemes. An import that can work out no
  sign-in and got no choice refuses with a sentence that names the choices.
- **Private addresses.** `createGuardedFetch({ allowPrivate: true })` lets loopback and private
  hosts pass and still refuses link-local ones. Only a connector from an address gets it, and only
  on a runtime that is not managed (`reachesPrivate`). It is decided at every request and stored
  nowhere, so the same record on a managed runtime stays behind the guard. On a managed runtime
  the preview and the import refuse a private address with `connectorPrivateAddress`.
- **Token calls.** An imported connector’s code exchange, refresh and client registration go
  through the same guarded fetch (`ConnectorOAuth2Config.fetchImpl`).
- **A server without SSE.** A server that answers 401 to streamable HTTP and 405 to the SSE try
  loses its 401 on the way. Where its own OAuth documents are there, it is read as one that wants
  a sign-in: its tools come once an account is connected.

### A connector that brings skills

A plugin for Claude Code or Cursor, taken into a space (`apps/runtime/src/bundles/`). The studio
has no word for it: it shows a connector with its skills. The record is a `space_bundle`.

- **Reading** (`read.ts`). The source is a zip: a public repository’s archive from
  `codeload.github.com` through the guarded fetch (`fetch.ts`), or an uploaded `.zip` or `.plugin`.
  At most 60 MB and 50,000 files; a manifest or MCP file at most 1 MB; a skill’s files under the
  limits of an uploaded skill. Read are `.claude-plugin/plugin.json` (optional), `.mcp.json` and
  the manifest’s `mcpServers`, `skills/` and the manifest’s `skills`; for Cursor
  `.cursor-plugin/plugin.json`, `mcp.json`, and a `plugin.json` at the root. A `marketplace.json`
  lists the plugins of a repository that holds several: the preview answers with them, and `path`
  or `…/tree/<branch>/<folder>` names one.
- **Taken.** Each server over http (`type` `http`, `streamable-http`, `sse`, or a `url` without a
  type) goes through `importConnector` with the bundle’s id. Its headers with a fixed value are
  kept as the record’s `required_headers`. A header that holds a key (`Bearer ${TOKEN}`) becomes
  the sign-in where the server describes none. The connector is from an address: „nicht geprüft“,
  admins first, a private address only on a runtime that is not managed. Each skill becomes a
  `space_skill` with `source: "plugin"`, `origin` its folder in the plugin, `mode: "demand"`,
  scripts off.
- **Left out, and named** (`leftOut`): commands, agents, hooks, Cursor rules, and servers with a
  `reason`: `stdio`, `socket`, `noAddress`, `variable` (an address with `${…}` and no default),
  `file` (an MCP bundle), `address`, `refused` (with the words in `detail`), `count`. A skill
  whose `SKILL.md` cannot be read is left out as `invalid`.
- **The record.** `space_bundle` holds the name, version, format, origin (`github` with
  repository, branch and folder, or `upload` with the file’s name), a hash of what was taken, and
  what was left out. `bundle_id` is on `space_skill`, `space_connector` and `space_connection`; a
  connection gets it from its connector when it is set up. `space_connection.plugin` is something
  else: an engenty plugin that set a connection up.
- **Skills and no server, a server and no skills.** Skills alone come as skills with a bundle that
  has no connector. A server alone comes as a connector with a bundle. Neither is refused.
- **Read only.** `PATCH /skills/:id` refuses a change to the content of a bundle’s skill, and
  `DELETE` refuses it. `mode` and `runScripts` change. A copy is `own` and has no bundle.
- **The link.** A skill’s view names its bundle and the bundle’s connectors (`SkillSummary.bundle`),
  a connector’s view its bundle (`ConnectorView.bundle`). `skill_load` tells the step which
  connector the skill came with and what its tools’ names start with. `allowed-tools` is not read.
- **Update.** The origin is read again and its hash compared. Taken are skills that are new,
  changed or gone, and new servers. A skill that changed keeps its name, `mode` and `runScripts`.
  Connectors, connections and sign-ins are not touched. A connector whose server the origin no
  longer names leaves the bundle (`bundle_id` null) and stays: no sign-in is sent to an address
  that changed. A new server that cannot be imported as it stands is named in `notTaken`.
- **Removal.** `DELETE /bundles/:id` removes the connections on the bundle’s connectors, the
  connectors, the skills and the record in one transaction.
- **Entdecken.** For up to six repositories among a search’s skills, the manifest and the MCP file
  at the root are read from `raw.githubusercontent.com` (`bundles/discover.ts`,
  `GITHUB_RAW_URL` for tests) and kept for an hour.

Not built: private repositories and hosts other than github.com; npm, archive and command
sources of a marketplace; a plugin’s `userConfig` and its `oauth.clientId`; moving a connector to
a changed address; a branch name with a slash in `…/tree/<branch>/<folder>`; the bundle’s record
in the sync of a local space.

## Not built

- **Isolated instances.** Guest runs share the runner process with test runs, and every process
  can open every secret. The plan’s separate runner role for guests and a broker process that
  alone holds the sealing key don’t exist.
- **The company sign-in.** A third way to sign in, through the organization’s SSO (MCP
  Enterprise-Managed Authorization), is not built.
- **Plans.** Each person signing in is the plan switch `personSignIn`, meant for the Pro and Team
  plans. The Manage-App’s Free plan doesn’t name it `false` yet, so every plan has it.
- **The Manage-App’s side of the report.** The runtime posts to `POST /v1/broker/:tenant`, and the
  Manage-App has no endpoint for it yet.
- **More of RWX.** Connections, mail, hosts and the sandbox have no reader that asks RWX, and
  the runtime refuses a rule on them. A person changing a page, a table or the setup in the
  studio, and a person or a guest starting a wizard, are not asked either. `space_search` still says how many items pass its
  `where` (`filtered`) without asking who reads, and what a plugin makes of pages it read in a
  job (the shop’s products) is the plugin’s own data: the rules don’t follow it.
- A webhook for critical rows, a choice per kind of what notifies, and one connection offered to
  several spaces.

The plan behind all of this is `docs/plans/capabilities.md`, with `docs/plans/broker.md`.

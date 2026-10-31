---
title: The broker
description: The one path every connector call takes in engenty wizards – who calls, what decides, what a run may reach, what is logged and heard, the RWX rules and the routes the studio uses.
version: 0.13.0
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

## `decide`

`decide({ who, where, connection, actionId, kind, grant })` is pure: it reads nothing and runs
nothing. `brokerCall` uses it for every call, and „Was darf …?“ answers with it. It returns a
`Decision` with `outcome`, the `rule` that decided, a `reason`, and for an ask of the space’s
admins `admins: true`. The checks run in this order:

1. **The grant.** A wizard’s own connection in a run, outside the run’s grant: deny, rule `grant`.
2. **A space connection:**
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

In order, it:

1. reads the account. A sign-in that ran out and can’t be renewed is logged as `sign_in_failed`
   and refused as `not_connected`;
2. checks the grant where one binds the call (`grantBinds`: a wizard’s own connection, in a run,
   and not a share target’s connection);
3. refuses a missing account (`not_connected`) or an unknown action (`no_action`);
4. asks `decide`. A deny returns its refusal;
5. checks a guest’s send (`guestSendCheck`, below);
6. on an ask of the admins, runs only with `ctx.approved`. Otherwise it refuses with
   `needs_approval`, and the caller holds the call (a Work chat in `chat_approval`, under the bell);
7. on an ask of the person, runs when `ctx.allowed` holds `<connection>:<action>` (“for the rest of
   the run”) or `ctx.confirmed` is set and the call deletes nothing. Otherwise it calls `ctx.ask`.
   With no one to ask it refuses with `nobody`, and on a no with `declined`;
8. runs the action (the connector’s handler, or `handler`), marks the space connection used and
   logs the call. An error the action throws is logged and thrown on. A 401 or a lost OAuth grant
   is logged as `sign_in_failed`.

`brokerConnected(connection, who)` says whether and as whom a connection is signed in, without the
secret. `brokerSecret` reads a run’s kept secret that is no connection (the browser’s kept
sign-ins) through the same log.

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
| `not_allowed_recipient` | A guest’s send to an address that is neither the run’s own nor in the space’s mail domains |
| `run_limit` | A guest’s run has sent its mails (`GUEST_MAILS_PER_RUN`, 3) |
| `day_limit` | The wizard’s guests have sent today’s mails (`wizard.dailyMailLimit`, 50 unless set) |

## The run’s grant

`grantOf(definition)` in `broker/grant.ts` is pure: the same definition gives the same grant.

```ts
interface Grant {
  connections: Record<string, string[]>; // action ids, or the kind "read"
  hosts: string[];                       // names, or "*.example.org"
  tools: string[];
}
```

- A step’s `connections` add the actions its connection names, or `read` without a list.
- A fixed step’s `call` adds its one action on its connection.
- A step’s `hosts` add the hosts `http_request` may reach.

`createRun` (`engine/runner.ts`) computes the grant from the definition the run starts on: the
published one for a live run, the draft for a test run. It keeps the grant in `run.grant`, so an
edit never widens a run under way. `runGrant(runId)` reads it, and for an older run computes it
once from the run’s definition and writes it. `inGrant` always lets `list_tools` through.
`grantNote` writes the run’s first log line (“This run may: …”).

### Hosts, sends and results kept in the space

- `brokerHost` (`broker/host.ts`) runs `http_request`. It logs the call as connection
  `host:<name>`, action `http_request`, kind `send`. A guest’s run reaches only the hosts in its
  grant. A member’s run reaches any public host, until the `broker` switch is on.
- `guestSendCheck` (`broker/send.ts`) lets a guest’s send go only to an address a page field of
  kind `email` collected in the run, or to the space’s `mailDomains`, within the limits above.
  It holds a connection’s send action as well as the email share target. A send whose input
  names no address, such as a Slack post, is refused for a guest.
- `keptStepIds` (`broker/kept.ts`) names the steps of a guest’s run that read from a space
  connection whose audience is not `all`. Their results stay in the space.

## The log

`broker_log` holds one row per call: when and how long, who (`who_kind`, `who_id`), where
(`run_id`, `step_id`, `chat_id`, `wizard_id`, `space_id`), `connection_id`, `action_id`, `kind`,
`input_summary`, `outcome`, `rule`, `reason`, `result`, `result_size`, `critical` and
`critical_kind`. `summarizeInput` keeps the input’s field names and sizes, one clipped value whose
field name doesn’t look like a secret, and a SHA-256 of the whole. No token, key, password or body
is ever written. A log that can’t be written never stops the call.

`criticalOf(row)` in `broker/log.ts` is the one place that decides whether a row is critical:

| `CRITICAL_KINDS` | When |
|---|---|
| `refused_write` | A change, delete or send was refused |
| `outside_audience` | A guest’s call was refused by a connection’s audience |
| `host_not_in_grant` | `http_request` to a host the grant doesn’t include |
| `limit_reached` | `run_limit` or `day_limit` |
| `sign_in_failed` | A sign-in ran out, or the service refused it |
| `first_use` | A space connection’s first call that ran |
| `rule_changed` | An admin changed RWX rules, or a connection’s rules or audience (`logRuleChange`) |

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

`broker/rwx.ts` keeps one table of permissions per space (`rwx_rule`): a subject (`guest`,
`person`, `role`, `goose`, `wizard`, `plugin`), a resource (`document`, `table`, `page`,
`connection`, `mail`, `host`, `sandbox`, with an id or `*`), and `r`, `w`, `x` each `allow`,
`deny` or unset.

- Unset means deny, and a deny wins over every allow.
- Every space starts with a seed: owners and admins read, write and execute, members read and
  write, guests read.
- Readers ask today for `document`, `table` and `page` (`ENFORCED`): the knowledge readers, and
  search filters its hits by `r`. The other resource kinds wait for their reader.

All of this is behind the `broker` switch, off by default. With it off, `decide`, `readable` and
`assertRwx` in `rwx.ts` say yes to everything, the rules routes answer 404, and a member’s
`http_request` reaches any public host. Turning it on with the seed changes nothing until an admin
writes a deny. No studio page draws the rules yet.

The `capabilities` switch is on by default. It shows the studio’s Capabilities place, opens
`/spaces/:id/discover` and makes the rule „Mitglieder dürfen ins Studio“ count. It does not turn
on RWX.

## Routes

All under `/api/studio`, for a signed-in person of the organization.

| Route | What it does | Who |
|---|---|---|
| `GET /spaces/:id/connections` | The space’s connections, each with who set it up | Everyone; a member sees the ones in their audience |
| `POST /spaces/:id/connections` | Sets one up: connector, name, `signIn`, `audience` | Admins |
| `PATCH /connections/:id`, `DELETE /connections/:id` | Changes its name, audience, rules or the actions it is for, or removes it | Admins |
| `POST`, `DELETE /connections/:id/sign-in` | Signs the space in or out: `{ credentials }`, or `{ oauth: true }` for a sign-in page | Admins |
| `POST`, `DELETE /connections/:id/my-sign-in` | The person’s own sign-in, where each person signs in | Everyone in the audience |
| `GET /person/sign-ins` | The person’s connections across their spaces | The person |
| `GET /spaces/:id/rules`, `PUT /spaces/:id/rules`, `DELETE /spaces/:id/rules/:ruleId` | The RWX rules, saved as a whole list | Admins; 404 while `broker` is off |
| `GET /spaces/:id/broker/log` | The log, newest first. Filters: `connection`, `who`, `outcome`, `result`, `refused`, `critical`, `since`, `until`, `q`; `cursor` with the `next` of the page before, `limit` | Admins (403 for a member) |
| `GET /spaces/:id/broker/log/:line` | One line, with the run’s grant | Admins |
| `GET /spaces/:id/broker/ask?who=&for=&resource=&action=&in=` | „Was darf …?“: `decide`’s outcome, rule and reason. Nothing runs and nothing is logged | Admins |
| `GET /spaces/:id/broker/choices` | The people and the space’s connections with their actions, for the question | Admins |
| `GET /spaces/:id/discover?q=` | Skills from skills.sh and connectors from integrations.sh, marked where the space has them | Everyone; 404 while `capabilities` is off |

## Not built

- **Isolated instances.** Guest runs share the runner process with test runs, and every process
  can open every secret. The plan’s separate runner role for guests and a broker process that
  alone holds the sealing key don’t exist.
- **The company sign-in.** A third way to sign in, through the organization’s SSO (MCP
  Enterprise-Managed Authorization), is not built.
- **Plans.** Signing in as each person is not limited to the Team plan.
- **The Manage-App’s side of the report.** The runtime posts to `POST /v1/broker/:tenant`, and the
  Manage-App has no endpoint for it yet.
- **More of RWX.** No page in the studio draws the rules, and connections, mail, hosts and the
  sandbox have no reader that asks RWX.
- A webhook for critical rows, a choice per kind of what notifies, and one connection offered to
  several spaces.

The plan behind all of this is `docs/plans/capabilities.md`, with `docs/plans/broker.md`.

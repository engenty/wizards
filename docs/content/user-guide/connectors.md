---
title: Connectors
description: Services a wizard works in for the person who runs it – built in, from the registry, by their address or brought by a plugin with its skills.
version: 0.17.1
---

**[Capabilities](./capabilities.md) › Connectors** lists the services the space’s wizards, Work
chats and Goose can work in. Each space has its own connectors. In the cloud, a space you publish
from your computer shows its connectors without letting you change them: you change them on your
computer.

A wizard reaches a service in one of two ways:

- through a [connection of the space](#connections-in-the-space), which the space’s admins set up
  once;
- with the account of the person who runs it: they connect their account during the run, on a page
  that asks for it.

## Built in

| Service | The person signs in with |
|---|---|
| Gmail, Google Drive, Google Calendar, Google Contacts | Google (OAuth) |
| Outlook, OneDrive | Microsoft (OAuth) |
| Slack | Slack (OAuth) |
| GitHub | GitHub (OAuth) |
| HubSpot | A token they enter |
| S3 | Keys they enter |
| Email over SMTP, for sending | Address and password (or app password) they enter |

The OAuth services need an OAuth client of your own, which you enter in the settings file of
engenty wizards. A built-in connector shows up in the list once it can be connected, so a service
without its client doesn’t appear. Google is the exception on your computer: without a Google
client of your own, Gmail, Drive, Calendar and Contacts connect through your engenty account,
which holds the client. Connecting then asks you to sign in to the account first (Settings →
Account).

| Service | Settings |
|---|---|
| Google | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| Microsoft | `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` |
| Slack | `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET` |
| GitHub | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` |

- Give each client the redirect address `<your address>/api/connect/callback`.
  `CONNECT_REDIRECT_URL` sets a different one.
- For Google, enable the APIs you use and add their scopes to the consent screen.
- A connection asks only for what the wizard’s actions need.

You find the settings file under [Command line](./command-line.md#settings).

## From the registry

Any other service comes from the [integrations.sh](https://integrations.sh) registry:

1. Search for the service, for example Notion or Stripe.
2. “Import” adds it from its API description or its MCP server.
3. Its actions appear, marked as “reads”, “changes” or “deletes”. Some services list them only
   once an account is connected. “Reload actions” asks the service again.

If a service needs an OAuth client of your own, it says so. Remove it and import it again with
“Your own OAuth client”.

A service the registry doesn’t list comes in [by its address](#by-its-address).

The **Discover** tab of Capabilities › Overview searches integrations.sh and skills.sh at once. Admins set up a
service from its result with “Set up”, and a service the space already has shows “In this space”.

The editor’s chat does the same while it builds a wizard: ask it to work with a service, and it
finds and imports the connector. An [AI app](./ai-apps.md) connected to engenty wizards can do
this too.

## By its address

A service the registry doesn’t list comes in by its address: an MCP server, or an OpenAPI
description. This is how you add your own MCP server. Admins do it under “More connectors”, with
“By address”:

1. Paste the address and choose “Check”. engenty wizards reads what answers there: whether it is
   an MCP server or an OpenAPI description, its host and its actions.
2. Give it a name and a short name. The name starts as what an MCP server calls itself, or as
   its host. Its actions start with the short name.
3. Choose the sign-in. What the server describes itself comes first: a sign-in with OAuth, an API
   key, or none. If the server asks for a sign-in and describes none, choose “Key in a header”
   and name the header, or “None”.
4. Check what each action does: “reads”, “changes”, “sends” or “deletes”. engenty wizards reads
   this from the server’s hints and from the action’s name. Change one that is wrong: the
   connection’s rules go by it. For “sends”, name the field that holds the recipient. That’s how
   engenty wizards checks who a guest’s run sends to.
5. “Import” adds the connector and opens “Add connection” with it.

With “Key in a header”, the API key itself belongs to the connection: whoever sets it up enters
it. If you enter it in the form, “Read actions” lists the server’s actions right away. The form
doesn’t keep the key.

You can change what an action does later. Open the connector under “More connectors” and set it
there. A changed kind shows in the [audit](./capabilities.md#audit) of every connection on that
connector, like a changed rule.

**Not checked.** A connector from an address is marked “not checked”, in the lists and on its
connections. Nobody has looked at the server: not engenty and not the registry. Its descriptions
and its answers reach the AI as they are. That’s why a new connection on it is for admins only at
first. Widen it on the connection’s page once you trust the server.

**Private addresses.** On your computer the address may be a private one: `localhost`, or a server
in your home or office network. The form says so when it sees one. Only a connector from an
address reaches such addresses. In the cloud a private address is refused.

**Reload actions.** Some servers list their actions only to a signed-in account. Set up the
connection, sign in, then choose “Reload actions” on the connector. It asks the server with that
sign-in, and what you set for each action stays. Only admins check an address and reload actions.

## A connector that brings skills

A plugin for Claude Code or Cursor often holds two things that belong together: an MCP server for
a service, and [skills](./skills.md) that say how to work with it. engenty wizards takes both
into a space. There is no extra name for the result: it is a connector with its skills, and
“plugin” only says where it came from.

Admins add one under “More connectors”, with “By address”:

1. Paste the address of the plugin’s repository on GitHub, such as
   `https://github.com/makenotion/claude-code-notion-plugin`, and choose “Check”. A plugin in a
   folder of a repository has the folder in its address: `…/tree/main/customer-support`. “Upload a
   zip” takes a plugin as a `.zip` or `.plugin` file.
2. A repository that holds several plugins lists them. Choose one.
3. Read what engenty wizards found: the plugin’s name and version, each MCP server over http, the
   skills, and what it doesn’t take.
4. Each server becomes a connector. Correct its name, its sign-in and what each action does, as
   for [an address](#by-its-address). With several servers, untick the ones you don’t want.
5. Untick the skills you don’t want. “Import” adds the rest and opens “Add connection” with the
   first connector.

**What comes along, and what doesn’t.**

| In the plugin | In the space |
|---|---|
| MCP servers over http (streamable HTTP, SSE) | A connector each, marked “not checked”. A new connection on it is for admins only at first |
| Skills (`skills/<name>/SKILL.md`, and the folders the plugin’s manifest names) | Skills, “on demand”. Their scripts stay off until you switch them on |
| Commands, agents, hooks, Cursor rules | Not taken. The form names them |
| MCP servers started on the command line | Not taken. engenty wizards reaches a server by its address only |
| A server whose address needs a value from you | Not taken. Paste the finished address under “By address” |

A plugin with skills and no server over http brings its skills alone. One with a server and no
skills brings its connector alone.

**On the connector’s page.** A connection on such a connector says where it came from: the plugin,
its repository and version, and what it brought. Below the connection’s settings the page lists
the skills, each with when it applies. They are listed under Skills too, with the connector’s
name.

**Update.** When the repository has changed, the page offers “Update” and says what is new:
skills added, changed or gone, and new servers. The connection and its sign-in stay as they are.
A server the plugin no longer names stays in the space as a connector of its own. A plugin from
a file updates with “Upload a new file”.

**Remove.** “Remove connector, connection and skills” takes everything the plugin brought at
once. Before it does, it names the wizards that use the connection. They won’t run through after
that.

The **Discover** tab shows such a plugin as one result, “Connector with skills”, where a
repository on skills.sh holds an MCP server too. “Set up” opens this form with its address.

## What a wizard may do

A wizard names the actions it uses. Without a list, it uses only the actions that read. What a run
may use is fixed when it starts: a change to the wizard during the run doesn’t widen it. On the
account of the person who runs it:

| The action | What happens |
|---|---|
| Reads | It runs without asking, unless the wizard says to ask |
| Changes something | The person allows each call, or chooses “Allow for the rest of this run”. A wizard can let it run without asking |
| Deletes | The person allows it like a change. A wizard can never let it run without asking |

## Connections in the space

In Capabilities › Connectors, “In this space” lists the space’s connections. A connection belongs to
the space, not to the person who set it up: it stays when they leave. The page notes who set it up
and when, and when it was last used. Several connections to one service are fine, for example
Gmail · Orders and Gmail · Support.

Only the space’s admins set up connections. “Add connection” starts one, and so does a built-in
connector below the list or an imported one under “More connectors”, where you also search the
registry or add a server [by its address](#by-its-address). When you set one up, you choose how it signs in:

| Signs in | What it means |
|---|---|
| As the space | An admin signs the space in once, with an API key, an app token or a team account. Everyone uses that account, even when nobody is watching. On this kind of connection the AI only reads; writing happens in fixed steps or as an action someone confirms |
| Each person signs in | Each person signs in once with their own account, here or in their menu › Connections. The connection then acts as that person, and asks them before it changes something |

An admin can change how a connection signs in later, on its page. The sign-ins made until then go
with the change. In the cloud, your organization’s plan decides whether “Each person signs in” is
available. [Capabilities](./capabilities.md#connectors) has the details.

**Who may use it.** Admins, Members or Everyone. Everyone includes guests who start a wizard from
its link. Admins see above the list which connections guests reach, and narrow each to members
with one click ([Connections that guests reach](./capabilities.md#connections-that-guests-reach)).
A connection on a connector that is “not checked” starts with Admins.

**What it may do.** One rule for each kind of action:

| Kind | What it covers |
|---|---|
| Read | Searching and reading, in AI steps and chats |
| Change | Creating and changing, only in fixed steps or as a confirmed action |
| Delete | Removing something for good |
| Send | Sending emails and messages to others |

Each rule is Allowed, With approval or Never. A new connection reads freely, asks for approval
before a change or a send, and never deletes. With approval asks the space’s admins. In a Work
chat the action waits until one of them agrees. A wizard’s run doesn’t wait: a fixed step with
such a rule fails there, and the editor warns you on that step
([Capabilities](./capabilities.md#connectors)).

**How often.** An admin can limit a connection’s calls per run and per day. Empty means no limit.
[Limits](./capabilities.md#limits) has the details.

Members see the connections open to them, with their rules, but change nothing. Where each person
signs in, they sign in right there.

## Connections in your menu

A space’s admins set up a connection and choose how it signs in: once as the space, or each
person for themselves. Your menu › Connections lists the connections of your spaces that are open
to you. Where each person signs in, you sign in or out there; your chats, your runs and your Goose
then act as you, and nobody else sees your sign-in. Where the space signs in, you see its account
and who set it up. You set up no connection there: that stays with the space’s admins.

## The person’s mailbox

A wizard can ask for the person’s mailbox and read it: search emails, read them and keep
attachments. It never writes. The person chooses how to connect:

| Way | What engenty wizards needs |
|---|---|
| Any mailbox over IMAP | Nothing |
| “Gmail” button | The Google client, with the Gmail API enabled and the scope `gmail.readonly`. On your computer without one, your engenty account |
| “Outlook” button | The Microsoft client, with the delegated permission `Mail.Read` |

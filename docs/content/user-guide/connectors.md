---
title: Connectors
description: Services a wizard works in for the person who runs it – built in, from the registry or over MCP.
version: 0.13.0
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

The **Discover** tab of Capabilities › Overview searches integrations.sh and skills.sh at once. Admins set up a
service from its result with “Set up”, and a service the space already has shows “In this space”.

The editor’s chat does the same while it builds a wizard: ask it to work with a service, and it
finds and imports the connector. An [AI app](./ai-apps.md) connected to engenty wizards can do
this too.

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
registry. When you set one up, you choose how it signs in:

| Signs in | What it means |
|---|---|
| As the space | An admin signs the space in once, with an API key, an app token or a team account. Everyone uses that account, even when nobody is watching. On this kind of connection the AI only reads; writing happens in fixed steps or as an action someone confirms |
| Each person signs in | Each person signs in once with their own account, here or in their menu › Connections. The connection then acts as that person, and asks them before it changes something |

You can’t change how a connection signs in later. Set up a new one instead.

**Who may use it.** Admins, Members or Everyone. Everyone includes guests who start a wizard from
its link.

**What it may do.** One rule for each kind of action:

| Kind | What it covers |
|---|---|
| Read | Searching and reading, in AI steps and chats |
| Change | Creating and changing, only in fixed steps or as a confirmed action |
| Delete | Removing something for good |
| Send | Sending emails and messages to others |

Each rule is Allowed, With approval or Never. A new connection reads freely, asks for approval
before a change or a send, and never deletes. With approval asks the space’s admins, and the action
waits until one of them agrees.

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

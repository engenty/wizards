---
title: Accounts
description: Accounts a plugin connects for a space, such as a calendar or a mailbox, through the runtime's built-in connectors.
version: 0.5.0
---

A wizard’s connections belong to the person who runs it. A plugin that works for the whole
space, such as a calendar that every booking wizard reads, connects an account of its own with
`server.connections`. It uses the runtime’s built-in connectors (Google, Microsoft, Slack,
GitHub, HubSpot, S3 …). The runtime keeps the tokens and keys sealed in the tenant’s database and
refreshes the tokens.

```ts
const ACTIONS = ["list_events", "create_event", "delete_event"];

// Which of them can be signed in to on this runtime now.
const offered = await server.connections.available(["google-calendar", "microsoft-outlook"]);

// The provider's sign-in page, for a route of the plugin to hand to its studio half.
const { url } = await server.connections.start({ space, connector: "google-calendar", actions: ACTIONS });

// Later, in a route, a tool or a job:
const [account] = await server.connections.list(space);
const { events } = await server.connections.call<{ events: unknown[] }>(account.id, "list_events", {
  time_min: from,
  time_max: to,
});
```

| `server.connections.` | Does |
|---|---|
| `available(ids)` | Returns the connectors of these ids that a person can connect here now: `{ id, name, auth }`, and for `auth: "api_key"` the `fields` to ask for (`key`, `label`, `placeholder`, `required`, `secret`). An OAuth connector is offered once its client is set up (`GOOGLE_OAUTH_CLIENT_ID` …) or when it registers a client itself. On a local install Google is also offered through the linked engenty account. A connector that takes keys (HubSpot, S3) is always offered |
| `start({ space, connector, actions, lang? })` | Returns the provider’s sign-in page of an OAuth connector. The provider asks only for the rights that `actions` need. `lang` (`"en"` or `"de"`) is the language of the page the person comes back to; without it, the page follows their browser |
| `connect({ space, connector, actions, credentials })` | Connects a connector that takes keys. `credentials` holds the keys by field key. The runtime tries them once at the provider and then keeps them sealed. Keys the provider refuses throw an error with the status `400` and the code `credentials`, whose message says what was wrong. Returns the connection |
| `list(space)`, `get(id)` | Return what is connected: `{ id, space, connector, label, actions, createdAt }`, the newest first. `label` is the account as the provider names it, often an email address |
| `call(id, action, input)` | Runs one of the connector’s actions with the account. When the token has run out, the runtime fetches a fresh one first |
| `remove(id)` | Forgets the connection and its tokens |

## Signing in

`start` returns an address. Open it in a window from the studio half. The provider sends the
person back to the runtime (`/api/connect/callback`, the address a wizard’s connections use too).
The runtime keeps the account under the plugin and the space. The window then posts
`{ type: "wizards:connected", ok }` to the studio and closes:

```tsx
const { url } = await studio.api.post<{ url: string }>(`/connect?space=${space.id}`);
window.open(url, "connect", "width=520,height=700");

window.addEventListener("message", (event) => {
  if (event.data?.type === "wizards:connected" && event.data.ok) {
    refetch();
  }
});
```

- A second sign-in to the same account for the same space replaces the first one’s tokens and
  actions. It does not add a second connection.
- A local install without a Google client of its own connects Google through the linked
  engenty account. Without a linked account, `start` throws an error with the status `409` and
  the code `account`, whose message says what to do.

## What `call` refuses

- An action the connection was not made for. Connect again with that action in `actions`.
- What the provider refuses. `call` throws the provider’s error, with the status and the first
  words of its answer. If the person removed the connection at the provider, the next call
  fails this way.

## Where it is kept

The connections are kept in the table `plugin_connection` of the tenant’s database, by plugin
and space. A plugin sees only its own connections. Deleting a space deletes them. Unloading or
removing the plugin leaves them in place.

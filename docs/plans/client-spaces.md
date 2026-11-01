# Plan: client spaces

Status: decided on 2026-10-31. Step 1 built (#411), inviting clients built; the rest of steps 2 and 3 open. Phase 2b of `docs/plans/modular.md` (decision 8). The
proposal and its mockups: the artifact "How a Space Works", question 8
(claude.ai/artifact/RwejkjT7hj7BwuWYcooVsw).

A firm works for its clients in one space. Each client gets a client space under it: its own
data, results and chats, kept apart from the firm's other clients by the same line that keeps
spaces apart today. The client space reads the firm's setup from its parent, and only the
parent's Knowledge marked for clients when a client asks.

## Decided

| | Decision |
|---|---|
| Levels | Two: a space, then client spaces under it. A client space has none of its own |
| Per client or per matter | The firm chooses; a client with several matters gets several client spaces |
| Reads | A client space reads its parent's wizards, skills, brand and connections, and the parent's Knowledge that its rules open to clients |
| Writes | Everything done in a client space stays there: results, data, uploads, chats |
| Who asks sets the reach | A firm member in a client space reads the parent's whole Knowledge and the client's; a client reads only what is open to clients |
| Clients | Sign in with an engenty account; the organization gives them the role `client`. They see their own client spaces only, never Studio or Work |
| The firm | Members see every client space; "assigned only" is a later switch per space |
| Default | The parent's Knowledge is internal; opening an item to clients is a deliberate act |
| Where | Cloud only: a local install stays one space with no clients |
| Words | Code: kind `client`. UI: "Client space" in English, "Space" in German |
| Switch | `clientSpaces`, off by default |

## How it works

- **A space gets a parent and a kind** (`space` or `client`). Every table is already keyed by
  space, so the line between two clients is the line between two spaces.
- **Membership per space** (`space_member`): who of the organization is in a client space, as
  `member` (the firm) or `client`.
- **The broker carries "for clients".** `client` joins the roles RWX rules name. A client space
  is seeded with rules for its clients (read and write its data, run its wizards and skills).
  The parent is not: a client reads a parent item only where a rule for the role `client` allows
  it. Marking an item "Firm and clients" writes that rule; the search already filters by rules,
  so nothing else needs a client filter.
- **The catalogue reads two places.** In a client space, Knowledge tools search the client space
  and the parent, as the caller; the rules decide what of the parent comes back.
- **The space menu stays short.** Client spaces never show in it; they are a part of their space.

## Steps

1. **Foundation** (this branch): parent and kind, `space_member`, the `client` role in RWX and
   its seed, client spaces listed and made under a space, Knowledge read through to the parent,
   "for clients" as a rule, wizards a client may start as a rule. Behind `clientSpaces`.
2. **The firm's side**: the space's "Clients" part in Studio (list, new, people, wizards for
   clients), the mark in Knowledge, the group in Work's chat sidebar, View as in Client mode.
3. **Clients**: the `client` role in the Manage-App and its invitation (built: a client takes no
   seat, is invited only where `clientSpaces` is on, and is taken into the client space that
   invited their address at the first sign-in; until the portal, a client's session and token
   reach only who they are, their client spaces and their elements), the client portal (For you,
   Chats, Files, Results, phone), runs a client starts writing into their client space, results
   shared with the client on purpose.

## Open

- A run started in a client space runs a wizard of the parent: its run must belong to the client
  space (step 3).
- The space limit of a plan: client spaces do not count as spaces; their own limit per plan is
  open.

## Option, to decide later: people on an open runtime

Noted on 2026-11-01. Decide once the client portal and the rest of the client spaces are built:
they only make sense where several people sign in.

Today an open runtime without the Manage-App has one person, its owner. Studio, Work, Client,
client spaces and the broker are all in the open repo; only the people come from the Manage-App.

The smallest way to give an open runtime (one organization, no plans) team members and clients:

1. **People** in the control database: `id`, `email`, `name`, `role` (owner, admin, member,
   client). The first is the owner.
2. **Sign-in by e-mail link** over the runtime's SMTP. Only how a session is made differs: the
   session table and everything that reads its role stay as they are.
3. **Members behind one interface** (`invite`, `setRole`, `remove`, `list`): the Manage-App's
   calls as today (`manage.ts`), or a local implementation.
4. **The member rules in one shared module** (only an owner makes owners, the last owner stays,
   a client takes no seat, clients only with client spaces), called by both implementations, so
   the rules cannot drift. The Manage-App imports it from the release it pins.
5. **Stays Manage-only:** plans, seats, credits, the model gateway, several organizations, OAuth
   for apps (API keys stand in).

Parallel code: two small adapters (making a session, storing members), roughly 100 and a few
hundred lines. Everything after the session is shared.

To decide then: open teams make the team feature free on a self-hosted server. A middle way is
server mode only (a runtime with `APP_URL`, run as a server), never on a desktop install.

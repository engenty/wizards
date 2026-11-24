# @engenty/model-setup

The setup in which a person picks what an app thinks with. MIT. The engenty wizards studio and
wizards.bot show the same one, so a new way to think is added here and both have it.

- **Catalog** (`@engenty/model-setup`). `CLIENTS` names the AI clients the setup offers, in its
  order: the subscription each answers on, the vendor's app, how it is installed.
  `installCommand` is that as the person would type it. No Node, no DOM: a page may import it.
- **Server** (`@engenty/model-setup/server`). `ClientSetup` finds the clients on this computer
  and says how each stands; `Terminals` runs a client's install or sign-in in a terminal the page
  shows; `setupRoutes(host)` are the Hono routes the page asks. `Tested` keeps which sources a
  test call has worked on.

Three rules the routes keep:

1. Finding a client never runs a model.
2. A test call runs on the source the person picked, when the page asks for one.
3. A terminal runs the catalog's install and the client's own sign-in, nothing a request names.

What a host gives: its clients, where they are installed, where the pick and the keys are kept,
its test call, its words for an error. Who may ask is the host's to check before it mounts the
routes.

```ts
import { ClientSetup, setupRoutes, Terminals } from "@engenty/model-setup/server";

const clients = new ClientSetup({ clients: [codex, claude], folder, env });
app.route("/local", setupRoutes({ clients, terminals: new Terminals(), workDir, models, tested }));
```

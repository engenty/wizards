---
title: Events
description: Do something when a run ends or a space changes – keep who it was, post a message, read a new document.
version: 0.5.0
---

A plugin can listen to runs that reach their end, and to spaces that change.

```ts
// A real run ended: keep who it was.
server.on("run.done", async ({ run, wizard, values }) => {
  const email = typeof values.email === "string" ? values.email.trim().toLowerCase() : "";
  if (run.mode !== "live" || !email) {
    return;
  }
  const seen = {
    name: typeof values.name === "string" ? values.name : null,
    wizard: wizard.title,
    seenAt: new Date(),
  };
  await db()
    .insert(person)
    .values({ email, ...seen })
    .onConflictDoUpdate({ target: person.email, set: seen });
});
```

## Events

| Event | A run |
|---|---|
| `run.done` | reached its result |
| `run.failed` | stopped with an error |
| `run.cancelled` | was cancelled |

| Event | A space | Gets |
|---|---|---|
| `space.created` | was made here, or arrived from engenty wizards on someone’s computer | `{ space: { id } }` |
| `space.updated` | changed its name, its brand (Info & brand), its facts or its connected systems, or arrived again from a computer | `{ space: { id } }` |
| `space.deleted` | was deleted | `{ space: { id } }` |
| `space.file.ready` | has a file that was read: a document is in the index now | `{ space: { id }, file: { id, name, kind, mime } }` |
| `space.file.removed` | lost a file | `{ space: { id }, file: { id, name, kind, mime } }` |

`file.kind` is `"document"`, `"logo"`, `"asset"` or `"pattern"`.

```ts
// A document arrived: read it into the wiki.
server.on("space.file.ready", async ({ space, file }) => {
  if (file.kind === "document") {
    await queue(space.id, file.id);
  }
});
```

Nothing waits for the space events: the request that changed the space answers before its
listeners are done.

## What a run listener gets

| | |
|---|---|
| `run.id`, `run.wizardId` | The run and its wizard |
| `run.mode` | `"live"`: a real run, over the wizard’s link or from an AI app. `"test"`: a test run |
| `run.status` | `"done"`, `"failed"` or `"cancelled"` |
| `wizard` | `{ id, title, projectId }` |
| `values` | What the person answered, by field id |

`values` holds the answers as the wizard asked for them. Which fields exist depends on the
wizard. A listener that wants an email address looks for a field with the id it expects and does
nothing when it is missing. Check the type of every value you use.

## Rules a listener runs under

- **It runs inside the run’s tenant.** `server.getTenantDb()` is that tenant’s database.
- **It runs after the run ended.** A listener cannot change the run or its result.
- **It cannot fail the run.** A listener that throws is logged with the plugin’s id.
- **It can be called twice.** A finished run that is redone and ends again fires the event
  again. Write listeners so that a second call does no harm: update a row instead of adding one,
  or remember the run’s id.
- **Nothing waits for it.** Give outside calls a time limit:

  ```ts
  await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
  ```

## Test runs

Test runs fire the same events with `run.mode === "test"`. A plugin that keeps data about real
people, or tells someone outside, leaves test runs out, as the example above does.

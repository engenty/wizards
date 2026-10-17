---
title: Routes
description: HTTP routes below the plugin's own address – signed in, inside the person's tenant.
version: 0.5.0
---

A plugin’s routes live below `/api/studio/plugins/<id>`, and for programs with a key below
`/api/v1/plugins/<id>`. Every request is a signed-in person’s, inside that person’s tenant.

```ts
// GET /api/studio/plugins/contacts/
server.registerHttpRoute({
  method: "GET",
  path: "/",
  handler: async () => ({
    contacts: await db().select().from(person).orderBy(desc(person.seenAt)).limit(200),
  }),
});

// DELETE /api/studio/plugins/contacts/42
server.registerHttpRoute({
  method: "DELETE",
  path: "/:id",
  role: "admin",
  handler: async ({ params }) => {
    const [gone] = await db()
      .delete(person)
      .where(eq(person.id, Number(params.id)))
      .returning();
    if (!gone) {
      throw Object.assign(new Error("No such contact."), { status: 404, code: "no_contact" });
    }
    return { ok: true };
  },
});
```

| Field | |
|---|---|
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE` |
| `path` | `/`, `/items`, `/items/:id`. A `:name` part matches one segment |
| `role` | `"admin"`: owners and admins only; others get `403`. Default: every member of the tenant |
| `handler(request)` | Answers with a value, sent as JSON, or with a `Response` |

## The request

| | |
|---|---|
| `request.params` | What the `:name` parts matched |
| `request.query` | The query string, as `URLSearchParams` |
| `request.json()` | The body as JSON. An empty body is `{}` |
| `request.user` | `{ id, tenantId, role, name, email }`: the signed-in person. `role` is `owner`, `admin` or `member` |
| `request.path` | The address below the plugin’s own |
| `request.request` | The web `Request` as it came in: headers, a body that is not JSON |

## The answer

| The handler | The client gets |
|---|---|
| Returns a value | `200` with the value as JSON. `undefined` becomes `null` |
| Returns a `Response` | That response: a file, a redirect, another status |
| Throws an error with a `status` (400 to 599) and a `code` (a string) | That status with `{ "error": "<message>", "code": "<code>" }` |
| Throws anything else | `500` with `{ "error": "The plugin failed.", "code": "plugin_failed" }`. The error itself is logged, not sent |

Send a `code`, not a sentence for the person. The studio half says it in the person’s language:

```ts
throw Object.assign(new Error("No such contact."), { status: 404, code: "no_contact" });
```

## Who can call a route

- The studio, signed in. A request without a session gets `401` before it reaches the plugin.
- A program with a key, at a second address: [With a key](#with-a-key).
- Only people of a tenant that has the plugin. For any other tenant the studio’s address
  answers `404`.
- Not the people who run a wizard on its link, and not the outside world. For a webhook of
  another service, a plugin has [public routes](#public-routes).

## With a key

A program that is not the studio, such as the [WordPress plugin](../../user/wordpress.md),
calls the same routes below `/api/v1/plugins/<id>`. It signs in with an API key or with an
access token of engenty.ai. On a runtime that runs alone, you create the key under Settings →
Integrate; on engenty.ai, in your account:

```bash
curl -H "Authorization: Bearer $KEY" https://wizards.example.com/api/v1/plugins/contacts/
```

- The route runs as the key’s person, inside that person’s tenant: `request.user` is that
  person, with the role. A `role: "admin"` route answers a member’s key with `403`. `name` and
  `email` can be empty.
- `GET` needs the scope `wizards:read`, every other method `wizards:write`. A key has every
  scope, a token the ones the person granted. A call without the scope gets `403` with the code
  `insufficient_scope`.
- A plugin that the runtime has but the key’s account does not have answers `403` with the code
  `plugin`. An id the runtime does not know answers `404`.
- `x-api-key: <key>` works in place of the `Authorization` header.
- The answers and errors are the same as at the studio’s address.

## Public routes

A public route answers anyone: a CMS that says a page changed, another service’s webhook. Its
address names the tenant without giving its id away; the plugin hands it out:

```ts
server.registerPublicRoute({
  method: "POST",
  path: "/signal/:token",
  handler: async ({ params, tenantId, json }) => {
    const source = await sourceByToken(params.token);
    if (!source) {
      throw Object.assign(new Error("Unknown."), { status: 404, code: "unknown" });
    }
    await refreshSoon(source, await json());
    return { ok: true };
  },
});

// In a route of the studio: the address to paste into the CMS.
const address = await server.publicUrl(`/signal/${source.token}`);
// https://…/api/public/plugins/<id>/<ref>/signal/<token>
```

- Nobody is signed in. Check a secret of your own: a token in the address, a signature of the
  body. Keep only a hash of it.
- The handler runs inside the tenant of the address: `server.getTenantDb()` is its database.
- `publicUrl` gives the same address for a tenant every time.
- A body is taken up to 4 MB. Answers and errors work as for the plugin’s other routes.
- A tenant without the plugin, or a suspended one, answers `404`.

## Shared routes

Some services post to one webhook for everyone: one account of the runtime’s, one app. A shared
route has one address for all tenants, and the call itself says which tenant it is for, with
the ref the plugin handed the service before:

```ts
// Handed to the service with the call it is about to make: names the tenant.
const ref = await server.publicRef();

server.registerSharedRoute({
  method: "POST",
  path: "/incoming",
  handler: async ({ request, inTenant }) => {
    const raw = await request.text();
    if (!signedByTheService(raw, request.headers)) {
      throw Object.assign(new Error("Bad signature."), { status: 401, code: "bad_signature" });
    }
    const event = JSON.parse(raw);
    return inTenant(event.ref, () => pickUp(event));
  },
});

// The address to enter at the service, once: the same for every tenant.
server.sharedUrl("/incoming");
// https://…/api/public/plugins/<id>/shared/incoming
```

- The handler runs outside any tenant: check the service’s signature, then call `inTenant`.
- `inTenant(ref, work)` runs `work` inside the tenant of that ref, as a public route of the
  tenant would run. A ref no tenant has, a suspended tenant and one without the plugin throw
  `404` / `not_found`.
- `publicRef()` is the part of `publicUrl` that names the tenant; it is the same every time.
- A body is taken up to 4 MB, as on a public route.
- Where the call does not carry a ref (a keyword written to a number every tenant shares),
  [`server.claims`](./server.md#keys-across-tenants) finds it: `holder(key)` is the ref of the
  tenant that holds the key.

## From the studio half

`studio.api` calls the plugin’s own routes and gives the parsed JSON:

```ts
const { contacts } = await studio.api.get<{ contacts: Person[] }>("/");
await studio.api.del(`/${id}`);
```

See [The studio half](./studio.md#the-plugins-own-routes).

## Addresses that are taken

`/api/studio/plugins/-/…` is the runtime’s own part: the built files, reloading. No plugin is
called `-`, so the two never meet.

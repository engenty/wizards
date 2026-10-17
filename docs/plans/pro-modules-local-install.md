# Plan: Pro modules in a local install

Status: built on 2026-10-08 (runtime and studio here, packing and `/v1/modules` in the closed
repository); not released. Reference: [Pro modules](../pro-modules.md).

Built differently from the text below:

- Pro modules are installed into `<DATA_DIR>/pro-modules/<id>/`, not `plugins/pro/`: apart from
  the person's plugins and not watched.
- No new OAuth scope: `/v1/modules` takes any access token of the linked account, as
  `/v1/connect` does, so installs linked before need no new consent.
- The Manage-App streams the zip itself instead of handing out a short-lived address; it reads
  the packages from a GitHub release `modules-<tag>` of the closed repository.
- Team plans: every member's install gets the team's modules (the plan is the team's).
- Offline grace: 7 days (`MODULES_ENTITLEMENT_DAYS`). A failed check is tried again within the
  hour.
- Installed modules update by themselves when the account lists another build for the release.

Scope: a person with a Pro (or Team) plan links their local install to their account and gets
the closed plugins of their plan (`contacts`, `data-sourcer`, …) there, as the cloud runtime
already has them. The cloud runtime, the plans themselves and the plugin framework are not part
of this plan.

## What "secure" can mean

A plugin's code that runs on the person's machine can be read, copied and patched there. No
scheme stops that. What can be secured:

| Goal | Locally | How |
|---|---|---|
| Only accounts on a plan with the module can download it | yes | the download needs the linked account's token and the plan's `modules` |
| No tampered or foreign code is taken for a Pro module | yes | the package is signed; the runtime checks it against a public key it ships with |
| The module stops when the subscription ends | yes, for honest users | a signed entitlement with an end date, renewed online |
| The module cannot be copied or cracked | no | bundled and minified code only raises the effort; the terms of use protect it |
| What runs on the server stays gated | yes | gateway calls (e.g. `data-sourcer` → systemone) are checked and billed there anyway |

The signature matters most: a plugin runs with the app's full rights
([shipping](../content/dev/plugins/shipping.md)), so a package that only claims to be a Pro module
must never load.

## What exists

- Linking an account: PKCE sign-in in the system browser, token in the vault
  (`apps/runtime/src/auth/account.ts`, `startLink`, `accountToken`).
- Verifying tokens of the Manage-App against its JWKS (`apps/runtime/src/manage.ts`).
- Plans with `modules` (manage table `plan`), answered in `GET /v1/tenants/:id`.
- Which plugins a tenant has: `pluginIdsOf` (`apps/runtime/src/plugins/registry.ts`). A runtime
  that runs alone has every plugin it loaded; only a runtime of a Manage-App filters by `modules`.
- Plugin folders: `modules/` of the runtime, then `PLUGINS_DIR`; an installed app reads
  `~/.engenty/wizards/plugins`.
- The private cloud image with the closed plugins, built by the manage repo on each open release
  (`runtime-released` dispatch, `runtime/build.sh`).

## Flow

### 1. Build (manage repo, closed)

- The workflow that builds `engenty-wizards-runtime-cloud` also packs each closed plugin as a
  tarball for that release: manifest, server half bundled into one file, built `dist/`,
  `migrations/`.
- Each tarball is signed (ed25519) with a key kept as a CI secret. The signature covers the
  tarball's hash, the plugin id, its version and the runtime release it was built for.
- Tarballs go into private storage (MinIO on the VPS or private release assets), never public.

### 2. Manage (closed)

- New endpoint `GET /v1/modules`, called with the account token of a local install (new scope,
  e.g. `wizards:modules`). It answers:
  - the modules of the tenant's plan that exist for the install's runtime version: id, name,
    version, size, a download address valid a few minutes;
  - an entitlement: a JWT signed with the Manage-App's key, `{ tenantId, modules, exp }`,
    `exp` a few days ahead.
- A tenant whose plan has no modules gets an empty list and no entitlement.
- Downloads are logged per tenant, so unusual numbers stand out.

### 3. Local runtime (open)

- Settings → Plugins shows a section "Pro modules" when an account is linked: what the plan
  offers, what is installed, install / update / remove.
- An install downloads into `~/.engenty/wizards/plugins/pro/<id>/`, a folder of its own, apart from
  the person's own plugins. The tarball's signature is checked before it is unpacked; a failed
  check leaves nothing on disk.
- The public key for the signatures ships with the runtime (open code; only the private key is
  secret).
- Updates: on each runtime update, installed Pro modules are fetched again for the new version
  before they load. A module built for another runtime version does not load.

### 4. Which modules are on

`pluginIdsOf` for a runtime that runs alone:

- plugins outside `pro/`: on, as today;
- plugins inside `pro/`: on only when a valid entitlement lists them.

The entitlement:

- is stored in the vault and checked against the Manage-App's JWKS (as access tokens are);
- is renewed at start and once a day while an account is linked;
- keeps counting offline until its `exp` (grace of a few days);
- unlinking the account drops it, and the Pro modules go off.

### 5. When the subscription ends

- The module goes off at the entitlement's end; its tables and data stay in the database.
- Settings → Plugins says why and links to the plan page.
- A renewed plan turns it on again with the data as it was.

## Per module

| Module | What protects it | Note |
|---|---|---|
| `contacts` | the entitlement check and the terms of use only | pure local code; a cracked copy works |
| `data-sourcer` | also the gateway | its sources run through systemone, which checks the plan |
| `appointments` | not checked yet | see whether it needs the server |

## The alternative not taken

A module could run on the cloud runtime only, and the local studio call it through the linked
account. That protects the code fully, but puts the module's data in the cloud, against the
local-first install. Worth it only for modules that need the server anyway.

## Open questions

- Is a crackable local `contacts` acceptable, or are only modules with server-side value offered
  locally?
- Length of the offline grace.
- Team plans: does every member's local install get the team's modules, or only the owner's?
- Terms of use: a clause on Pro modules in a local install (no copying, ends with the plan).

## Order

1. Manage: signing in the cloud-runtime workflow, private storage, `GET /v1/modules`,
   entitlement JWT.
2. Runtime: `pro/` folder, signature check, entitlement in the vault, `pluginIdsOf` for a runtime
   that runs alone.
3. Studio: the "Pro modules" section in Settings → Plugins.
4. Docs: `docs/content/dev/plugins/shipping.md` and `docs/manage-contract.md`.

# Cloud-first onboarding (0.4.x)

Planning on 2026-10-13. Nothing here is built. Mockups: the canvas
https://claude.ai/artifact/VQkn4dE33GpAyjZjnYZnAB (twelve artboards, same order as the flow
below). Screenshots of everything as it is today, the reasoning and the open decisions: the
concept page https://claude.ai/artifact/Ck2oG9WHGboPyzszySdDMj (private).

## Why

When engenty wizards started there was no cloud, so the only way in was the install on your own
computer, and the account came later, as an add-on that syncs the one local space up to
engenty.ai. Today the cloud exists (studio, doors, runner, plans, credits, Pro modules), and
every door still points at the terminal:

- The home page has one call to action, "Install". Its e-mail form sends the install mail. The
  word "account" does not appear on the page. Sign-up lives only at account.engenty.ai/sign-up,
  reachable from the studio's sign-in page and from the local app's Settings → Account.
- The installer and the terminal setup never mention an account. The studio's setup page
  ("Choose your Engine") has no account step either. A new install is local-only by default and
  learns of the cloud through teasers.
- The docs' user guide says "This guide describes the install on your own computer".
- Of the four mails, three are German only and in a plain layout; only the install mail is
  designed and bilingual.
- Free accounts cannot build in the cloud (`limits.build = false`): a person who signs up gets a
  studio that shows nothing until they install.

The direction now: promote the account. Two ways in, one account; local-only stays, but as a
documented flag, not a story on the landing page.

## The two ways, and the third

| Way | Who | What happens |
|-----|-----|--------------|
| **Sign up** | most people | Invitation code → sign in (Google, GitHub, e-mail link) → welcome step (name, first space) → the cloud studio, building on credits. Nothing to install. |
| **Install, signed in** | people with a Claude/ChatGPT/Gemini/Cursor subscription, local files, browser steps | `curl … | bash` → the installer's setup signs the computer in (device code or browser) → the account's space comes down to the computer → it thinks with the local AI clients, credits step in for the rest → what it publishes runs in the cloud behind the same links. |
| **Local only** | developers, the privacy case | `install.sh --local` (and `wizards setup --local`): no account, nothing leaves the machine, links answer on that computer only. Today's behaviour, kept under a flag. Explained in the docs under "Your install", not on the site. A later Pro feature may give it a UI ("private space"). |

Rule for the copy: the account is where a space lives. A computer *joins* a space; it does not
own one. "Your space, your wizards and their links live in your account."

## Words

| Word | In the code | What it is |
|------|-------------|------------|
| Account | `user` | The person who signs in (Google, GitHub, e-mail link). |
| Team | `tenant` + Better Auth `organization` | The organisation the sign-up creates ("<First>s Team" today): credits, plan, members, API keys, the tenant database. The welcome step names it. |
| Space | `project` | A project inside the team: info & brand, knowledge, data, results, and the wizards. Free 1, Pro 5, Team unlimited. "Meine Wizards" is made when the studio first opens; a local install holds exactly one. |
| Wizard | `wizard` | Lives in a space; has a home (below). |

## Where the space lives: the data direction

Today the sync is one way, local → cloud, on publish; the cloud studio shows the synced space
read-only. Cloud-first turns this around: the space is in the cloud, the install holds a copy.
Two-way sync of drafts would need merge rules; a wizard gets a **home** instead:

- `wizard.home` = `cloud` or `device:<installId>`. The home holds the draft and edits it. Every
  other place shows the wizard read-only ("edited on Matthias's MacBook") with "Edit here", which
  moves the home. No merge, no conflict.
- Published versions, the space's data (name, facts, colours, logo, tables) and the link
  settings live in the cloud and come down to every install. Drafts travel only when the home
  moves. Runs happen where they start; their results sync up when the install is online.
- Offline: the install works on its copy; publishes queue and go up on reconnect (the retry
  every 60 s exists).
- A new install signs in and pulls the space; the one-space-per-account rule of Free stays. The
  "replace the space of the old computer" step goes away: a second computer joins instead.

This replaces `project.origin = "local"` (space-wide, one direction) with a per-wizard home in
both directions. The cloud studio's `FromLocal` empty state goes.

## Phases

### 0.4.0 — the front door

Manage (closed):

- Home page stays the one-page experience it is, with no menu: the "Install →" button becomes
  "Get started →", which opens the next step: your e-mail (the waitlist) or your invitation
  code. Below the fold nothing is added (no pricing, no "two ways"); only the about block's
  "Runs on your computer" becomes "Runs in the cloud, or on your computer". The install
  command leaves the home: it is offered after sign-up (studio card, welcome mail) and in the
  docs.
- Waitlist: the same step on every template page ("Get the template" becomes "Use this
  template": signed in → `/studio/new?starter=<id>`, else the step). E-mail, consent, nothing
  else. Double opt-in mail.
- Leads in manage: table `lead` (the `download_signup` table widened: email, lang, source,
  wish, consent, confirmedAt, status new | invited | account | unsubscribed, note,
  resendContactId, userId once signed up). Admin page "Interessenten": list, filters, "Einladen"
  (creates a personal code and mails it, as `/admin/beta` does today), remind, CSV, Resend
  contacts in a segment. No broadcasts in manage; a newsletter goes out from Resend's UI on that
  segment.
- Sign-up: after the first sign-in an onboarding wizard, one question per page, the engenty
  beside it, dots instead of a stepper, no sidebar:
  1. Who you are: "What is your team called?" (today the tenant is named "<First>s Team" by
     `ensurePersonalTenant`; name and e-mail come from the sign-in).
  2. About you & brand: "Where can the wizards read about you?" The website; engenty reads
     title, about, logo and colours into the space's Info & brand (what the assistant does
     today when a website is named). "Write a line instead" and "Skip for now".
  3. Knowledge: "What should the wizards know?" First documents or a page into the space's
     Knowledge. "Skip for now".
  4. Your space: explains the first space, "Meine Wizards" (made as today when the studio
     opens), and its four parts; "Build your first wizard" opens the studio.
  Later pages explain Pro features; the wizard is a definition in manage, so pages can be
  added without a release of the open runtime.
- Footer on every page: just "engenty"; the legal links only on public pages.
  Mails bilingual and in the install mail's look: sign-in link, invitation, welcome (new),
  waitlist confirmation (new), team invitation. The sign-up and the mails take the person's
  language from the site, not the browser.
- Free builds in the cloud: `build = true` for the Free plan with a cap (proposal: 5 published
  wizards, runs on credits; 500 start credits + 100 a month, both placeholders from the pricing
  paper). Plan description rewritten without "synchronisiert mit deiner lokalen Installation".
- No pricing page and no price tables in this phase.

Open (runtime, CLI, studio, docs):

- `install.sh --local`, `wizards setup --local`, `wizards account` (sign in / out / status).
  `--local` writes `account=off` into `.features` (the flag exists and already hides every
  account surface) and skips the account step.
- Terminal setup gains the account step first: device code (`/device` exists) or "press Enter
  to open the browser" (PKCE loopback exists). After it: "Signed in as … · space … · credits",
  the space comes down, then the engine step with "engenty credits" as a choice next to the
  clients.
- Studio setup page (`/setup`): an account panel beside the engine list; "engenty credits" as an
  engine; the footer line "Runs locally on this device" becomes "This computer: <space>".
- Studio: the home's "Install on your computer" card in the cloud studio (with "Mail me the
  command"); the share dialog and the link teaser lose the "sign in to get a link" teasers in
  the cloud; German-only callback and error strings get English.
- Docs: the user guide starts with "Create an account" and "The studio"; "Install on your
  computer" is the second chapter; local-only moves to "Your install → Local only". README gets
  the same order. `wizards` help lists `account`.

### 0.4.1 — the space in the cloud

- `wizard.home`, the pull on sign-in, the push on publish, "Edit here" moving the home. Space
  data and link settings down to every install. The cloud studio edits wizards whose home is
  the cloud. `project.origin` and `FromLocal` removed.
- Runs and results: cloud runs listed on the install, local results sent up (optional, a
  setting).

### 0.4.2 — the computer as a device of the account

- The install offers its AI clients to the cloud's runs the way the phone offers Apple
  Intelligence today (`run.device_offer`, device calls, v0.2.58): a cloud run of a wizard built
  anywhere thinks with the person's Codex or Claude Code while the Mac is on, and with credits
  when it is off. This is the strongest reason to install with an account, and it makes "install"
  an upgrade of the cloud, not an alternative to it.

### Later, Pro

- Local-only with a UI: a private space that never leaves the machine, next to the account's
  spaces. Several spaces per install (the data model has them).

## Built on 2026-10-13 (the 0.4.0 slice)

Open repo, this branch:

- `services/onboarding.ts`: the first visit of a cloud studio (`needsOnboarding`: managed, an
  owner or admin, no mark under `onboarding:<tenant>` in the control database, no wizard yet;
  `finishOnboarding`; `applyWebsite`: `readWebsite` into the space's name, about, up to three
  colours and the logo, without a model). Routes `PUT /api/studio/team`, `POST
  /api/studio/onboarding/done`, `POST /api/studio/projects/:id/website`, `POST
  /api/studio/install-mail`; `/me` answers `onboarding` and the account's `team`.
- Studio: `/start` (`OnboardingPage.tsx`), four pages, reached by the redirect in `App.tsx`;
  the setup page's account panel and the "engenty credits" engine; the cloud home's "Also on
  your computer" card with "Mail me the command"; footers say "engenty".
- CLI: `install.sh --local`, the account step first in `wizards setup` (device code, `auth/device.ts`),
  `wizards account`, English server strings.
- Docs: `create-account.md`, `local-only.md`, the user guide reordered, README; contract rows
  for `PATCH /v1/tenants/:id` and `POST /v1/install-mail`.

Manage repo, branch `feat/cloud-first-onboarding`:

- The lead list (table `lead`, the former `download_signup`), `POST /api/waitlist` with the
  confirmation mail and `GET /api/waitlist/confirm`, the admin page "Interessenten" with Invite,
  the welcome mail, every mail bilingual in the install mail's look (`mails/layout.ts`), the
  `engenty_lang` cookie, Free builds in the cloud, `PATCH /v1/tenants/:id`, `POST /v1/install-mail`.
- www: "Get started" in place of "Install", the one step (e-mail or code), "Use this template",
  the about block, the footer.

Walked through on a local stack on 2026-10-13 (site → waitlist → confirmation link → admin
invite → sign-up with the code → welcome mail → cloud studio `/start` → team renamed at the
Manage-App, website read into the space → `/new`; local install → setup's account panel →
sign-in in the browser → "engenty credits" as the engine; `wizards account` shows the team).

Not built in this slice: the cap on Free's cloud build, `wizard.home`, the pricing page, the
onboarding wizard as a definition in manage (it is a page of the studio for now). Seen on the
way and done the same day: a new account goes on to the studio, not the account pages (manage
`ae24de6`), and so does a sign-in at /sign-in that no client asked for (manage `c8a0dbc`); the
account pages themselves still return to the page that was asked for. Still so: a sign-up by e-mail link has no name, so the studio greets without one
and the team's first name defaults to "New team" / "Neues Team" ("Team Anna" with a name) until the first page.

## Decisions for Matthias

1. Free builds in the cloud, with which cap? (Without it, sign-up leads to an empty studio.)
2. Start credits and monthly refill for Free (500 + 100 are the pricing paper's placeholders).
3. Double opt-in for the waitlist (a confirmation mail before the address counts): yes, as
   mocked, or the consent box alone as the install form has it today.
4. Invitation codes: keep personal codes per lead (mailed from the admin page), or one shared
   code per wave.
5. `wizard.home` as the two-way model (no merge), or a true two-way sync of drafts.

## What exists and is reused

- Sign-up with codes, personal and shared, caps, Turnstile; `/device`; PKCE loopback;
  `wizards-desktop` client; magic link; Google, GitHub, Microsoft.
- `download_signup` + Resend contacts, unsubscribe with HMAC; the install mail's design and
  copy in `download-mail.ts`.
- Feature flag `account` (gates every account surface in the studio); `.features` file;
  `FEATURES` env.
- `firstSync`, the retry loop, `PUT /api/v1/spaces/:id/wizards/:id`, per-tenant ids,
  `limits.build` / `limits.projects` from manage.
- The device channel for a phone's on-device thinking (0.4.2 generalises it).
- Admin pages for codes, plans, teams, users, content; `GET /v1/plans`.

## Not in scope

- Several spaces on a local install; team pages or roles on the install (decided 2026-10-10:
  a local install is one space, no team).
- A desktop app. The Chrome app stays the install's "app".
- Broadcast mailing inside manage.

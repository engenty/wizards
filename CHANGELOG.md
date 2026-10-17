# Changelog

All notable changes to engenty wizards. Generated from [Conventional Commits](https://www.conventionalcommits.org/)
by [git-cliff](https://git-cliff.org) via `pnpm release`. Pre-`1.0`: a **minor**
bump is a notable or breaking change, **patch** is fixes and small features.

## [0.7.6] - 2026-10-17
- ADDED **[runtime]** Sandbox engines installed apart from the package, starting with agentOS 0.4 (#45)

## [0.7.5] - 2026-10-17
- ADDED **[cli]** `npx wizards` downloads a small launcher; the runtime is published as @engenty/wizards-runtime (#39)

## [0.7.4] - 2026-10-17
- ADDED **[runtime]** Replace Gemini CLI with Antigravity as the Google AI client (#42)
- ADDED **[setup]** Test each own key on its own, without picking models (#41)
- CHANGED One package for code outside the repo, @engenty/wizards, with plugins at /plugin (#44)
- DOCS **[plans]** Wizards in generative UI chats
- FIXED **[studio]** Onboarding for people on their own, browser Back, and answers that survive a reload (#40)

## [0.7.3] - 2026-10-15
- FIXED **[studio]** Template cards on a phone in a column with a block title (Safari cut the footer off a card whose title wraps); a search brings its field to the top so results show
- FIXED **[cli]** Onboarding sign-in a new person can finish or skip (#38)

## [0.7.2] - 2026-10-15
- FIXED **[studio]** On a phone the read-only note leaves the top (a lock on the tabs instead); with the keyboard up the run page drops its bar, shrinks the title and keeps the focused field above Weiter

## [0.7.1] - 2026-10-15
- FIXED **[cli]** Clearer setup and menu wording, and an Uninstall menu entry (#37)

## [0.7.0] - 2026-10-15
- ADDED **[cli]** Auto-update the installed wizards in the background (#34)
- ADDED **[cli]** Wizards uninstall (#33)
- CHANGED One implementation for helpers whose copies drifted (#29)

## [0.6.2] - 2026-10-15
- ADDED **[format]** A wizard's own language is any real language – `lang` in the schema is a two-letter code (JSON Schema v1: pattern ^[a-z]{2}$, no longer en|de), validateWizard says when it names no real language (isRealLanguage, Intl.DisplayNames). wizardLang gives the code; engenty's own strings read it through textLang (English where they lack it), dates and numbers through localeOf, speech through speechLocaleOf. The studio's language menu offers the languages of Europe (WIZARD_LANGS). A wizard written in a language outside LANGS loads the runner's words in it. Fix: translations sent the texts' own keys as schema property names, which Claude refuses (only letters, digits, _ . -); calls now use t0, t1, … and map them back

## [0.6.1] - 2026-10-15
- ADDED **[schema]** MIT license notice in the wizard and package JSON Schemas

## [0.6.0] - 2026-10-15
- ADDED **[runtime]** Prompts design results first; json steps report what they write
- ADDED **[runner]** A json result without a view shows things as cards, not tables
- ADDED **[results]** Agent steps return nested data through output.schema
- ADDED **[runner]** Result views that read like an app, themed from the brand
- FIXED **[runner]** A yes/no never reads true or false; progress only while an answer streams

## [0.5.13] - 2026-10-15
- ADDED **[runner]** A wizard in the viewer's own language, translated on request – the page opens in the wizard's language (`wizardLang`) and, where the viewer reads another (`viewerLang`: any language, from the browser or the time zone), offers it in the studio's two-sided pill (LangPill, LangSwitch now built on it), the pick kept in the browser. One structured call per wizard and language on the `standard` class at effort low (gpt-6-luna today, measured against cheaper text models in docs/plans/wizard-translation.md), kept per wizard as original text → translation (`wizard_translation`, machine or author), so later viewers read it and a republish translates only changed texts; answers that lose a placeholder or a translated definition that fails the schema or the validator are not kept. Choices keep their values and show `labels[value]`; ids, branches, AI instructions and slot dates are never sent. The runner's words in languages outside LANGS are translated once per runtime (`ui_translation`, chunked calls, plural forms per Intl.PluralRules) – the runner table moves to shared/runner-texts with the runner pages' 57 studio lines. Runs carry `run.lang`: the view shows the translation, AI steps write in that language, a switch mid-run keeps what is made, a finished result can be translated (`state.translated`). Authors turn it off per wizard (`wizard.translate`, synced to the cloud copy) and correct a language line by line in Share → Settings. "The wizard doesn't match the schema." goes through the runtime's string table (ServerLine on NotedError)

## [0.5.12] - 2026-10-15
- ADDED **[studio]** The first visit asks what the team uses engenty for (guessed from the address: free mail personal, a club's domain a club, else a business) and the questions that fit, sends the answers to the Manage-App (PUT /api/studio/team/profile), and takes a website's address or just its name
- FIXED **[brand]** Engenty.wizards under the door's engenty and at the foot of the guests' start page
- FIXED Review findings – runner exports, own keys fail closed, one secret reader, run cleanup, CI checks (#28)
- FIXED **[copy]** Remove hard-coded German, widen copy-check (#31)

## [0.5.11] - 2026-10-15
- ADDED **[studio]** On the new-wizard page (and the guests' start page) the mic is an outlined "Sprechen" button at the start of the row, its menu opening to the right; on a phone the guests' top bar shows the mark, the language and "Anmelden" only

## [0.5.10] - 2026-10-15
- ADDED **[studio]** Voice input on the start page for guests – the browser's own speech recognition, nothing sent to the server without an account; where the browser has none, no microphone button
- FIXED **[studio]** The light/dark pick is shared with the account pages (cookie engenty_theme on the parent domain, also what a first visit shows), and the guests' start page ends like the landing page – engenty and the legal pages, no version

## [0.5.9] - 2026-10-15
- FIXED **[cli]** The npm package `wizards` is for macOS and Linux only (os in its package.json) – on Windows npm refuses within a minute or two instead of an install of twenty minutes that ends in a crash
- FIXED **[cli]** `npx wizards` on Windows says engenty wizards for Windows is coming soon and how to run it in WSL meanwhile, instead of an npm install of several minutes that ends in a crash (no libsql build for Windows on Arm; no installer, service or AI client lookup for Windows yet); --version, --help, validate and mcp still run

## [0.5.8] - 2026-10-15
- ADDED **[i18n]** Every line in a string table, a new language needs only translations – shared/texts (MIT) holds the table shape (English has every line, a language may lack some), plural forms by Intl.PluralRules on {count}/{n}, numbers written the language's way. RUN_NOTES becomes one table per language and takes the ~160 bilingual() lines as notes (note(code, params), gaps may hold other notes and lists); bilingual() and the "text" code are gone. The runtime gets its own table (apps/runtime/src/texts.ts, serverText, say(c, key) for inLang) for answers, assistant activity lines, first-space and new-wizard words. Marketplace labels, provider notes, basic facts and product credits move into language-first tables or the studio's strings; SPEECH_LOCALES joins LOCALES; the voice conversation's rules are written in English and name the language to speak. Studio and runner t() pick plural forms; copy-check reads them form by form
- ADDED **[i18n]** One language list, the person's own language beside English – LANGS, Lang, LANG_NAMES, LOCALES, isLang, langOf and localLang in shared/definition replace every "de" | "en" and z.enum(["de", "en"]). The studio starts in the person's pick, else the first browser language engenty speaks other than English, else the language of the time zone's country, else English; requestLang reads the whole Accept-Language list the same way. Each language has its own strings, what one lacks is said in English (studio and runner). LangSwitch holds English and that own language and shows nothing without one; the account page picks among all languages (LangPick). JSON Schema v1 regenerated (enum order only); local-lang.test.ts covers the pick

## [0.5.7] - 2026-10-15
- ADDED **[studio]** Someone not signed in gets the new-wizard page instead of the door – the wish and the gallery (GET /api/guest/marketplace, no stars or plugins), "Build" signs in with the wish along and keeps it; the team's first visit shows it, and "new" builds it once the person is in

## [0.5.6] - 2026-10-15
- DOCS **[install]** Curly quotes around the menu entry, as the copy style wants

## [0.5.5] - 2026-10-15
- FIXED **[studio]** Sign-out ends the account's sign-in too – the studio's sign-in page no longer signs the person in again by itself

## [0.5.4] - 2026-10-14
- ADDED **[editor]** The editor on a phone – the pane is a sheet over the whole room or folded, and the row under the header has "Ablauf" (folds it to the diagram and back) with Test and Share as icons; the tab Chat is Assistent, the Steps tab has the chat's composer too (on every screen), a swipe left or right goes to the next or the previous step, the tab in effect scrolls into view, the zoom bar is gone on a phone, and the wizard's menu has vertical dots at the very right. The home page drops the offer to install on one's own computer

## [0.5.3] - 2026-10-14
- ADDED **[cli]** `npx wizards` installs, sets up and runs the studio – a copy from npm (npx, npm i -g) on macOS and Linux installs engenty wizards into ~/.engenty/wizards with the install.sh it carries (own Node, runtime, the `wizards` command), brings an older install up to its own version and restarts a runtime that runs, then hands every command to the installed `wizards`; a Node older than 24.11 gets the same instead of a refusal; --version, --help, validate and mcp still run from npm; node-pty is an optional dependency of the package, so npx installs on a Linux without a compiler; the install page names `npx wizards` beside the curl installer

## [0.5.2] - 2026-10-14
- ADDED **[editor]** On a phone the sheet opens over the whole room, and the tab Ablauf folds it to the diagram – a drag near the top takes all of it, the tabs scroll sideways where they do not fit

## [0.5.1] - 2026-10-14
- ADDED **[plugins]** Keys a plugin holds across tenants – server.claims takes, puts, drops and finds keys of the plugin's own, each for one tenant at a time (control table plugin_claim, migration 0009): a keyword on a number every tenant shares, who last wrote to it, a number a tenant connected; holder gives the tenant's ref for a shared route's inTenant. channels.book takes whatsapp, by message sent. Documented in the server, routes and reference pages and the manage contract; managed.test.ts covers two tenants holding one key
- ADDED **[studio]** A copy style guide, with every word people read brought to it (#23)
- FIXED **[deps]** Patch vulnerable dependencies from pnpm audit (#22)
- FIXED **[runtime]** One SSRF range check, pinned connections, closed DevTools origins (#21)
- FIXED **[runtime]** Keep run uploads to allowlisted types and never serve them as pages (#20)
- FIXED **[release]** Commit the regenerated COPYRIGHTS.md with the release (#18)

## [0.5.0] - 2026-10-14
- ADDED **[studio]** Mark spaces synced from a local install (#17)
- CHANGED **[knowledge]** English names in the source for Wissen and its parts; packages keep pages under files/knowledge/ (#13) **[breaking]**

## [0.4.7] - 2026-10-14
- ADDED **[studio]** Goose is hidden for now – the studio no longer shows the assistant's dock, its sidebar or its highlights
- FIXED **[studio]** The header of /new takes about half its height on a phone – below md the fluffy engenty is scaled to 84px (Mascot draws a flat one below 120), the title is 1.5rem on one line and the gaps are smaller

## [0.4.6] - 2026-10-14
- ADDED **[share]** A channel is set up inside the share dialog – a runner's problem may say its kind (setup, waiting, plan) with the row's note and the plan that has it, so a row says "Nummer angefragt" without a button or "Ab Pro" with "Pro ansehen" instead of "Noch nicht eingerichtet"; studio.registerShareSetup gives a plugin the view "Einrichten" opens, inside the dialog at its height with a back arrow, its buttons at the dialog's foot (Actions) and done(banner) back to the rows, and a banner of the runner's news above them (notice); QrCode for a plugin's studio half; channels say whether the plan has a number of its own (allowed). Documented in the runners, studio, server and reference pages and the manage contract; plugins.test.ts covers the problem kinds

## [0.4.5] - 2026-10-14
- ADDED **[studio]** Keep the picked language with the person and share it with the account pages (#5)
- ADDED **[i18n]** English is the base language everywhere; the studio follows the picked language, not the browser's (#4)
- ADDED **[studio]** One menu at the left – a page with a menu of its own (the space's areas, the settings, a plugin page through the new MenuPage) draws it into the sidebar while that is open, else at its own left; the top bar runs across the sidebar and the page with the toggle, the space's name and the trail, open or closed; the space menu opens fixed under the name, so the sidebar no longer cuts it off, and its actions are a line glyph and a word
- ADDED **[studio]** The space sidebar – a toggle left of the space's name opens it (animated, closed below 1024 px, the toggle never moves); it holds Wizards, New wizard and the space's parts under SPACE, and in an area of the space page that area's own menu instead, so one menu stands at the left; the space's name opens the space menu (the spaces, Wizards in space, Add wizard, Edit space name in a dialog) with a computer or cloud icon after it; the area menu's top level is "Space" with a way back to the wizards; the list is titled "Wizards in <space>"; the breadcrumb starts with a slash; a wizard has a ⋯ menu on its card and in the editor (Duplicate, Export, Delete behind a confirm dialog, admins only); the assistant is one card – the open chat or the last turn above the bar, the handle always on top, Goose perched once on top of it, 600 px wide, a taller input
- ADDED **[studio]** The studio has no footer – version and changelog stay in the About dialog behind the mark – and Goose perches on top of the assistant's bar only while it is in use (focused, open, working or live), rising in animated, instead of standing beside it
- ADDED **[studio]** The space chooser has no "Add space" row at the plan's limit, the chevron shows only where there is something to switch to or add, and the menu opens under the chevron
- ADDED **[studio]** A new wizard starts as a step-by-step wizard only, with a + beside the channel button and "How should it run?" as the question, the hint stands below the input, dark is the default theme (System stays a pick), the top bar has no wordmark, the space name is plain text and only its chevron opens the chooser, and a local install's first space is called "Local Space"
- ADDED **[studio]** The sign-in page gets the logo, the theme and language switches and a footer with the version; the headline and the sub line are the new wish text in both languages, the hint is shorter and points to wizards open --print
- FIXED **[harness]** The authoring guide says when a step goes without the store's file tools, and the check for kept files reads one row – guide.ts no longer promises files_list, read_document and scan_documents to every agent step (an installed client gets them only where there is something to read), and buildStepTools asks hasStoreFiles instead of loading every kept file
- FIXED **[store]** A list keeps its rows in the order they came – a new row is stamped after every row the list holds, so two saves in one millisecond no longer tie and swap places by their random ids (a shared list across saves, a person's list even within one save); the flaky "a shared list" test met exactly that (#12)
- FIXED **[studio]** The space sidebar's state stands in a module of its own (side-menu.ts), so a plugin page that imports MenuPage no longer pulls the studio into its typecheck; the wizard menu imports base relatively; the cloud test expects a lone runtime's first space to be "Local Space"
- PERFORMANCE **[harness]** A tool-less step on an installed client answers without the MCP bridge – a step that declares no tools or connections, got no uploads and whose wizard keeps no lists and no files no longer gets the store's file tools (files_list, read_document, scan_documents), so without other tools (Wissen, a workspace file) the client starts no bridge for the call; harness.test.ts covers both

## [0.4.4] - 2026-10-14
- ADDED **[plugins]** Numbers of the Manage-App and routes for every tenant – server.channels gives a plugin the tenant's numbers (get, request, withdraw) and books what they carry (book: SMS segments, call minutes, priced by the Manage-App) through the runtime's service key; registerSharedRoute, sharedUrl and publicRef give a service that posts to one webhook for all tenants one address (/api/public/plugins/<id>/shared/…), whose handler enters a tenant by the ref the call carries (inTenant). The calls GET/POST/DELETE /v1/tenants/:id/channels(/requests) and POST /v1/tenants/:id/channels/usage are in docs/manage-contract.md, the SDK in the plugin docs; managed.test.ts covers both

## [0.4.3] - 2026-10-13
- FIXED **[runner]** The wizard's live voice no longer interrupts itself – the microphone asks for echo cancellation, and the session filters input as far-field with a higher speech threshold (0.7) and 600 ms of silence to end a turn
- FIXED **[assistant]** Live voice no longer hears itself – the recognition starts fresh when the voice ends, what sounds like the voice is ignored for 3 s after it, the echo check compares plain words and takes 75 % as a match, and the microphone asks for echo cancellation

## [0.4.2] - 2026-10-13
- CHANGED **[modules]** WhatsApp, SMS and calls leave the open repository – modules/whatsapp, modules/sms and modules/calls and their tests are gone, the runtime's image no longer copies them and the plugin lists in the tests shrink; what they are built on stays in the runtime and the SDK (runners with problem and address, the thread door, server.speech.conversation(), registerShareSection). The plugin docs say what a messenger or call plugin does instead of naming the modules, "Test and share" describes WhatsApp, SMS and calls as channels of engenty.ai, and the two channel plans note the move

## [0.4.1] - 2026-10-13
- ADDED **[studio]** A colour is added as a row in place, and the assets are "Brand Assets" with a round search field; plugins get a part of the space page of their own (registerSpacePart, useSpaceMenu), the space's brand (useSpace().brand, server.spaces.brand), a block for the steps that write documents and dashboards (registerSpaceContext steps: ["html"]), pictures and PDFs for generate (files), and the space page's pieces from @engenty-wizards/web/ui

## [0.4.0] - 2026-10-13
- ADDED **[onboarding]** The account becomes the front door – a cloud studio's first visit is a wizard of four pages (the team's name, the website read into the space, first documents, the space explained), the setup on a computer starts with the account (a device code in the terminal, the panel and "engenty credits" as an engine on the setup page), install.sh --local and wizards account keep and name the install without one, the cloud home offers the computer with the install mail, and the docs start with "Create an account"
- DOCS **[plans]** A plain sign-in lands in the studio as well – noted with the manage commit
- DOCS **[plans]** After the sign-up the account pages send a new account to the studio – the plan's note on the landing is settled

## [0.3.8] - 2026-10-13
- ADDED **[assistant]** The studio assistant is Goose and takes what is written while it works – Enter sends a message into the running answer, which reads it before its next step (or goes on with it after its answer), ⌘↩ queues it for after the answer, "Jetzt senden" stops and sends at once, Stop stands where Send does; the chat at the bottom moves by its grip, stays where it is put and snaps to the middle or the right near the bottom and into the sidebar near the right side, the handle on top sets the thread's height and folds it, ✕ closes it into the engenty at the lower right, which opens it where it stood (the small card is gone); "New chat" clears at once and writes the old chat's summary meanwhile, the next turn waits for it; developer mode (ASSISTANT_DEV here, the platform's admins when managed) shows each step's model, tokens, time and cost, the tools' arguments and results, the context window, and the turns' timeline, prompt and events to copy or download

## [0.3.7] - 2026-10-13
- ADDED **[studio]** Info & Marke becomes a brand book – Fakten right after Basis, one "Hinzufügen" menu in each section's head and trash on hover; Logos: the standard logos first, optional sections with when to use them, a logo from a URL (a picture, or the logos found on a page to pick); Farben: sections of colours, gradients (linear, radial or conic, angle, colour stops, CSS read and written, PNG download) or patterns (pictures tiled or filling), colours read off a page's stylesheet (oklch and hsl too); Typografie: fonts with what they are for and their weights, previewed from Bunny Fonts, an optional type scale, fonts read off a page's CSS; Assets: sections as tabs with search and view beside them, from a URL or a page's pictures, and PDFs, fonts, Lottie and 3D models taken too; rules as rows with a sign (bullet, do, don't, to check, important, numbered) for logos, colours and type; the studio assistant fills all of it only where a source says so (set_logo_sections, set_asset_sections, set_typography, set_gradients, set_rules), and every AI step and the film step get it with the brand

## [0.3.6] - 2026-10-13
- ADDED **[studio]** "Veröffentlichen" is gone – the first share publishes (the dialog says "Beim Teilen veröffentlicht", or what to fix first), and later changes go live from "Änderungen live schalten" in the editor's top bar: a dialog with what changed since the version people run (the wizard, each step by its title and part, the order, the files), whether exactly this draft was tested, that runs under way keep their version, what a run costs now, then "Live schalten"; the runtime answers it at /wizards/:id/changes

## [0.3.5] - 2026-10-13
- ADDED **[studio]** The share dialog starts over – who may open the wizard (anyone with the link, or only you), how others reach it by the channels it was made for, each with its own link or number to copy (SMS and WhatsApp show keyword and number from the runner's new `address`), and "Link kopieren"; QR code (any way's link, print, download), website (what it shows, where on the page, the tag; WordPress by plugin or as a package without an account), the gear (runs a day, each channel's keyword, a new link) and "Ändern" (the new-wizard page's channel list) open inside it with a way back; a draft, unpublished changes, a local install without an account and a cloud that lacks something say so on top; in the editor sharing stays at hand while there is something to publish
- FIXED **[studio]** On the new-wizard page pictures and files sit above the wish, as in a chat's input

## [0.3.4] - 2026-10-13
- ADDED **[studio]** The channel menu on the new-wizard page grows out of the button that opened it and fades in; still where motion is reduced
- ADDED **[studio]** The new-wizard page asks how the wizard runs and shows what is there already – "Läuft als" above the wish picks the channels (in the browser: Wizard in Schritten, Chat, Live Voice, Video Call; on the phone: Anruf, WhatsApp; by message: SMS, WhatsApp; one stays on), saved as the wizard's runners and named in the first message, which the guide tells the assistant to build for; the box takes files (+, paste, drop; pictures as thumbnails, names made fit for the workspace), dictation and the build button; while the wish is typed, up to ten of the space's wizards and templates that come close are listed, Pro marked, the rest one line that searches the gallery; the example chips are gone

## [0.3.3] - 2026-10-12
- DOCS Every page checked against v0.3.2 – the wizards menu (Start as service, Service settings, an update that restarts what runs), the version line at the top of Settings → Account, the templates the assistant shows as cards, the wizard format's code under MIT, the server page's clone folder (wizards)

## [0.3.2] - 2026-10-12
- ADDED **[assistant]** Templates the assistant recommends show as the gallery's cards under its answer – a new show_templates tool sends them as a card of the studio's own, kept with the chat; a card opens the gallery's dialog and makes a wizard of it in the space

## [0.3.1] - 2026-10-12
- FIXED **[cloud]** Studio, doors and runner share one /data volume – the tenant databases are files there while the Manage-App's TENANT_DB_PROVISIONER is none, so with a volume per role each process saw a tenant of its own: a wizard published in the studio was not found on the doors, and the runner never found the runs it claimed

## [0.3.0] - 2026-10-12
- ADDED **[runtime]** The web is cut into studio and doors – RUNTIME_ROLE studio serves the makers' half (sign-in, authoring, MCP, the sync API, the studio's pages), doors the customers' half (the wizards' pages, their API, shared results, the plugins' public routes, the app links); web is both, all adds the runner; the runs' API, the connect callback and the app's files serve both halves. PUBLIC_URL names the doors' origin when it is not APP_URL: wizard and result links, link previews, the embed script, public logos and icons, a plugin's public address and the AI app widget carry it, /api/config tells it and the studio's own link to a wizard uses it. compose.cloud.yaml runs runtime (studio), doors and runner from one image; docs/plans/runner-process.md says which paths go where

## [0.2.61] - 2026-10-12
- ADDED **[studio]** The account settings say the version on top – one line in the first card (Lokale Installation, the linked account or the cloud): the version, which opens the About dialog with what is new, and on a runtime that runs alone whether it is the newest, the newer one with Aktualisieren, and the check again; the About dialog and that line share about/UpdateCheck.tsx; no link to the GitHub release any more
- FIXED **[runtime]** An update from the About dialog no longer ends on {"error":"Interner Fehler"} – packageVersion() reads package.json once, so a runtime still running the old code goes on saying its own version while the installer replaces its files, and the studio reloads only once the new one answers instead of into the old process whose index.html is gone

## [0.2.60] - 2026-10-12
- FIXED **[studio]** The opened assistant at the bottom no longer grows past the page – its dock covers the column, so the chat's max height has a height to measure against

## [0.2.59] - 2026-10-12
- FIXED **[cli]** The menu tells what an update did – a runtime that runs restarts into the new version inside the update, and the menu ends with the commands used most instead of claiming `wizards` opens the new version; "Start" is "Start as service", and starting at login moved into "Service settings" with a yes/no question

## [0.2.58] - 2026-10-11
- ADDED **[runtime]** With web and runner apart, the phone still thinks for a run and plugins hear of its changes – the device's offer is run.device_offer and each call a device_call row in the tenant database, which the runner polls for the answer and any web's stream sends to the phone; watchRun hands on event rows another process wrote, each once, and tells of new device calls; the plugins' runs.subscribe uses it

## [0.2.57] - 2026-10-11
- ADDED **[runtime]** The runner is its own process – RUNTIME_ROLE web | runner | all (a runtime that runs alone stays one process). The line of runs lives in the control database: run_index gained owner and seen, a runner claims a run in one statement that counts the tenant's held runs against its limit, reports every 10 s, hears of a cancel the web wrote and hands its runs back when it stops; a runner silent for 30 s loses them. A step's question and the person's answer go through the run's row (run.answer; run.unattended marks an autopilot), so the web that takes the answer need not be the process that asked. watchRun tells the stream, the autopilot and waitWhileMoving of changes another process made within a second. Runners register with an address (table runner, RUNNER_URL); the web hands a run's browser screen and acts on it to the runner holding it. compose.cloud.yaml runs web and runner apart. docs/plans/runner-process.md

## [0.2.56] - 2026-10-11
- DOCS Every page describes v0.2.56
- DOCS Every page checked against v0.2.55 – the wizard format's example in English, the WordPress page's key link to the new Integrate page
- DOCS Apple Intelligence keeps High and Highest on their way; the WordPress import follows the shared check and a thinking step gets the pages that match it
- DOCS Every page checked against v0.2.50
- DOCS Every page checked against v0.2.48, public pages only, versions tracked
- FIXED A wizard package's errors in English like the definition's issues – wizards validate, the studio's import and the runner's check (which the WordPress plugin carries) said them in German
- FIXED Apple Intelligence leaves High and Highest on their way, a visitor reads the runtime's answers in their language
- FIXED A live conversation only where the wizard has it on, the browser the setup found, plugin runs without device signals, the WordPress plugin's download

## [0.2.55] - 2026-10-11
- FIXED **[mcp]** An AI app names spaces and wizards, not their ids – list_projects says where each space comes from (from: "your computer" for one a local install sent, "here"), list_wizards gives each wizard its space's name and origin, and the tools' descriptions and the server's instructions say ids are for the tools only; claude.ai had listed two spaces both called "Meine Wizards" by their ids

## [0.2.54] - 2026-10-11
- ADDED **[format]** The JSON Schemas live at engenty.ai/schema/v1/wizard.json and …/v1/wizard-package.json – one folder per definition version, names that say what they hold; the docs site answers /schema/* by asking itself for its public files (Next rewrites past its basePath only to a full URL), the proxy sends /schema to it; /docs/schema/wizard/1.json and …/wizard-package/1.json are gone

## [0.2.53] - 2026-10-11
- ADDED **[integrate]** Einbinden starts with what it is for and the apps found here, and every app walks through numbered steps to its first sentence in the chat – a start page with one card and one button per app on this computer and an "Über engenty.ai" card; the menu groups the apps (on this computer, through engenty.ai, more apps folded; in the cloud: in the browser, on your computer) with a legend for its dots; an app's page shows what it gets in plain words (wizards in the chat, the wizard as a window or as text) and three steps – add, restart, try – instead of the stage bar and a spinner, the config path behind Details, the address with an API key as a link for another computer; once an app called a tool it offers first sentences with the space's own wizard. claude.ai and ChatGPT on a local install lead to the engenty account (or Claude Desktop) instead of a dead end, and with an account linked or in the cloud they get four steps: open the connector settings, name and address, sign in and allow (with a preview of the consent page), a first sentence with its checks. The runtime asks the Manage-App (POST /v1/grants/check, kept 30 s) whether the grant behind an OAuth token still stands, so "Trennen" on the account page, leaving the team or a lock-out end an app's access at once; no answer refuses the token. "Verbundene Systeme (MCP)" is "Verbundene Systeme", the note against mixing them up is gone, the studio's new strings say API Key

## [0.2.52] - 2026-10-11
- CHANGED **[runner]** The package check takes the .wizard format's names from shared (wizard-package.ts) – extension, media type, format, wizard.json and files/ are written down once; check.ts still exports PACKAGE_EXTENSION and PACKAGE_MIME for its hosts; COPYRIGHTS.md lists ajv, the schema test's

## [0.2.51] - 2026-10-11
- ADDED **[format]** A published JSON Schema for wizards and `wizards validate` – pnpm schema writes the definition's and a package's wizard.json schema from the Zod schemas the app parses with (packages/shared/src/json-schema.ts) into the docs site, served at engenty.ai/docs/schema/wizard/1.json and …/wizard-package/1.json; objects take no unknown key there, which the app would drop without a word; the export writes "$schema" into every wizard.json. `wizards validate <path…>` checks a .wizard file, an unpacked package or a wizard's JSON as the import does, offline and without an account (--json, exit 1 on issues); a project's connectors, MCP servers and plugins stay checked on import. The package format moved to shared (wizard-package.ts), its reading to services/package-file.ts so the CLI loads no database; shape issues name the step everywhere (parseWizard). A test keeps the published schemas equal to a fresh run and checks them with ajv. docs/content/dev/wizard-format.md

## [0.2.50] - 2026-10-11
- FIXED **[deploy]** The runtime image installs the runner package's dependencies – its package.json was missing from the manifests, so vite was not there to build it and v0.2.49's image failed

## [0.2.49] - 2026-10-11
- ADDED **[runner]** A written output's PDF made in the browser where the server writes none – on a standalone host (the WordPress plugin, standalone: true in its RunnerEnv) the PDF button lays an agent's Markdown or JSON out with pdfmake and Roboto (packages/runner/src/pdf.ts, loaded on the first click, about 1.5 MB), saves the file and hands it to the share sheet; an HTML download there is a page to print, opened beside the run; the fit no longer counts a written text's PDF as a need (web-event and web-dayplan run as is), a document's PDF stays the browser's print; tests for the content tree and a render through the library's server build; the credits list pdfmake; the plan records the change
- ADDED **[standalone]** The site runs web_fetch and http itself, so the check counts them as no need; a package takes the project's pages along on request (knowledgeSnapshot: files/wissen/<path>.md with title and path in front, 60 000 characters a page and 2 MB in all, the manifest's knowledge field, ?knowledge=1 on the package route and the studio's export, the share dialog's Wissen mitnehmen switch); the runner names what a closed choice lacks on a site, an engenty account among the groups; the plan records the second round, the real-provider runs and what stays open
- ADDED **[standalone]** The start texts live in the runner package, api is exported for hosts, widgets count as a need of the runtime; the plan records what was built on the WordPress side, what changed against it and what is open
- ADDED **[standalone]** The check and the runner package – standaloneFit/needs/standaloneEntry in shared (fit.ts, the steps every run passes through and the closed choices lifted there, requirements.ts on them); documents and dashboards count as text the standalone runner writes, a PDF as the browser's print; @engenty-wizards/runner (MIT) holds the runner's components, UI primitives, texts and env, RunnerBody takes a RunSource, the studio configures it and uses the package (one copy), a Vite build with React external and a scoped runner.css for hosts without Tailwind; /api/v1/wizards lists standalone per wizard and /wizards/:id/package hands the published version over; the share dialog's WordPress section with the gallery's Braucht list and the package download, Einbinden's Ohne Konto line; pnpm templates:export writes every marketplace template as a .wizard with its fit, the release attaches templates and the runner
- ADDED **[api]** What the WordPress plugin calls – /api/v1/me (account, plan, plugins and the ones the plan lacks, spaces, credits, the studio's and the account's addresses), /wizards (published with token, ID and icon; drafts without), POST /wizards from a template published at once, /templates, /runs and /runs/:id with scope runs:read (live runs with the answers by the fields' labels, the e-mail, the page they started on), /space and POST /space/site (a website's own statements fill the space's empty details, its pages go into Wissen under the origin wordpress, the space assistant reads the rest; a job to ask after), /plugins/:id/* calling a plugin's routes as the token's person and answering 403 plugin for a plan without it; run.origin from embed.js's data-page (migration 0011); embed.js has a bubble at the bottom right with data-text and data-color; the share dialog offers it as a third mode; Settings → Integrate → WordPress; docs page WordPress and the contract's section on clients of an account; the plan says what was built
- ADDED **[app]** Scanning one tap away on the add sheet – a glass tile with a QR frame under the ID entry opens the scanner, where the room below the ID was empty; the switch above stays
- ADDED **[models]** Voice notes on the Mac read any browser's recording in the right language – a WebM or Ogg recording becomes WAV through ffmpeg before SpeechAnalyzer reads it, and a note carries the runner's language (AudioValue.lang) so the Mac listens in it instead of its own; checked end to end with spoken audio: the transcript and Apple's answer are about the call and the invoice that were said
- ADDED **[app]** The tab bar as glass that shows – the capsule gets a light tint and answers a touch with the glass's shimmer, and the active tab sits under a clear-glass lens that slides to the tab just picked (a plain pill where there is no Liquid Glass); Glass takes a tint and a clear kind
- ADDED **[app]** Apple's models on the phone and voice notes on the Mac – an Expo module in Swift (the same Shared.swift as the Mac helper) gives the runner bridge `transcribe` (SpeechAnalyzer, iOS 26) and `think` (Apple Intelligence, where switched on), named to a page only where the phone has them; the runner writes a recording down on the phone before the field keeps it and offers the phone for a run's Classifier and Standard calls, which the runtime sends over the run's stream as `device` events and takes back by POST, falling back to its own way when the phone does not answer in time, errs, the prompt is too long, or the step declared tools or has uploads; the Mac's helper writes voice notes down as well (`apple:transcribe`, offered under Voice notes); the recorder prefers AAC where the phone transcribes
- ADDED **[models]** Apple Intelligence on this Mac as a model – the on-device model of macOS 26 answers the Classifier and Standard classes through a Swift helper (wizards-apple: status, guided generation from the step's JSON schema), shown in the setup and under Text & Denken only on a Mac with Apple silicon on macOS 26, picked once Apple Intelligence is switched on; High and Highest keep their way; nothing leaves the Mac. The release builds the helper on a macOS 26 runner and packs it in; the plan for the phone side (transcription, then text over the app's bridge) is in docs/plans/local-models-apple.md
- DOCS **[plans]** The plugin's source strings are English with German as de_DE; what make-json does to a built file named admin.js and why the bundle is app.js
- DOCS **[plans]** The plugin repository is public as engenty/engenty-wizards-wp-plugin; what Plugin Check found and what changed for wordpress.org, the listing's assets, and what the submission still needs from the user
- DOCS **[plans]** The no-key path shown through Ollama on the site, the Word branch and the prompt filter as deviations recorded
- DOCS **[plans]** Checkpoints 7 and 8 shown on the test site (the pull against a stubbed account, the Word branch closed and the open way run), the photo run, the step timeout and the Ollama finding; the login-shell test of the harness gets twenty seconds on a loaded machine
- DOCS **[plans]** Standalone mode of the WordPress plugin – wizards run on the site without an account: the browser follows the flow and draws, PHP keeps the prompts and the run and calls WordPress 7.0's AI Client once per thinking step with the site's Connectors provider; one shared check (needs, standaloneFit) labels every wizard full / with less / needs an account in the studio and on upload; the start stays the hero, 'Eigene KI erstellen' opens the choice between an engenty account and local with the site's own provider, local sites pick from wizards shipped with the plugin and run them without credits; tables, routes, the PHP ports line for line, files, phases, checkpoints, what is open; mockups on the design canvas
- DOCS **[wordpress]** Connecting by hand with an address and an API Key
- DOCS **[wordpress]** The plugin's repository is engenty/engenty-wizards-wordpress – the studio's download link, the docs page and the plan
- DOCS **[plans]** How the WordPress plugin is built – its own public GPL repository engenty-wordpress with the PHP, block and admin app laid out; the eight runtime changes in order with the files and what they reuse; seven steps with a checkpoint each; what is left out
- DOCS **[plans]** The WordPress plugin – a client of a runtime (engenty.ai or an own server), never PHP: block, shortcode, Elementor widget, PHP function and a bubble render the embed tag; the admin lists wizards, results and the Pro plugins' contacts and bookings through a PHP proxy with the key; what the runtime needs (/api/v1/me, /wizards, /runs, plugin routes with a key, run.origin, a bubble mode), phases and open decisions; mockups on the canvas
- DOCS **[plans]** Apple's local models – what the iOS simulator showed: the 26.5 runtime answers a run's Standard step on the phone, 26.2 fails with ModelManagerError 1026 and the runtime falls back; no simulator holds speech assets, so transcription is verified on the Mac
- DOCS COPYRIGHTS.md – who owns the code, the FSL-1.1-MIT terms in one paragraph, the marks, what is not ours (the Commission's AI labels) and every third-party package with its licence; pnpm about:data --credits writes that part beside the About page's credits, with the docs site and the development tooling the page leaves out

## [0.2.48] - 2026-10-11
- ADDED **[core]** What a shop plugin needs from the runtime – a select or multiselect draws the rows of a table output as cards (cards: label, value, image, subtitle, meta, link; the runner shows a grid with Auswählen and Details), server.web.read hands over a page's JSON-LD so a product page costs no model, server.connections takes keys (available names the fields, connect tries them once and keeps them sealed; the same account again replaces the first), server.secrets seals keys a plugin keeps itself, and server.spaceData reads the space's own pages and files for a plugin that learns from Wissen; a plan for the shop plugin in docs/plans
- ADDED **[studio]** The assistant stands on every studio page but the editor, with one chat per person and team – docked at the bottom (opened, it greets with the page's words and three suggestions; a click sends one, a "fill" one goes into the field), small at the lower right (Data and Results keep it so) or as a sidebar on a window of 1,520 px and more, kept per person (GET/PUT /api/studio/assistant/layout); its height is kept free below the page (--assistant-dock), which fixes the last section under the bar; the chat is stored (assistant_chat, assistant_message, FTS5 trigrams), survives pages, reloads and devices, "New chat" closes it with a dense summary by the standard model, the last five summaries ride every turn, chats_search and chat_read find older ones, a long chat folds into a running summary; it knows the app from the guides of the installed version (docs/content bundled into dist/docs, docs_search, docs_read, the authoring guide, a one-page primer) and reads live data (gallery, plans from the Manage-App's public GET /v1/plans, account, usage per month via GET /v1/tenants/:id/usage or /v1/me/usage, the space's wizards and runs, models); every message carries the page's snapshot (route, trail, section in view, open item, selection, summary, fields; useAssistantPage, studio.useAssistantPage), and six browser tools run in the page while the turn stays open (navigate, highlight with spotlight or ring and a card whose buttons answer, look_at_page, read_section, fill_field, scroll_to; studio.useAssistantTool adds a page's own) – the same for an installed client over the MCP bridge, own keys and credits; the turn's events keep our SSE names with AG-UI's fields (run_started, text with messageId, tool_call and tool_result for every tool, card, changed, done, error); Talk starts a live chat the browser's way: speech to text in the browser (recording and the voice-notes model where it cannot), a pause sends, the same assistant answers, the computer's voices or the speech model read it aloud, talking over it stops it; studio.Assistant now only tells the assistant what to say on a plugin's page; user guide page "The assistant", plugin guide and the Manage contract updated
- FIXED **[studio]** The sign-in page says why the studio does not open – while the app does not answer (it restarts, or is stopped) it says so and asks again every two seconds, so the studio opens by itself once it is back, instead of standing on the slogan; opened under a name the app does not answer to (127.0.0.1, the machine's address) it names the studio's own address, which the runtime now gives in its 403; a local install's browser without its sign-in hears why (the cookies, another studio on localhost) and how to get in (wizards open, the link of the start); the slogan and the line under it break between their sentences
- FIXED **[web]** The space assistant's thread stays when the page changes – one thread per space, part and plugin page lives outside the page, so a turn still running goes on while the person moves from Shop to Produkte and is found again, still running, on the way back; before, the page remount dropped the thread and the stream
- FIXED **[studio]** A page's tools also work when the assistant opens that page during an answer – navigate and look_at_page list the tools the page now shown offers and page_tool runs them, so "show me only the sold-out products" from the shop's start opens Produkte and filters it; a page's snapshot is cut to what the runtime takes instead of refusing the turn; a write no longer shows the editor's "Baue den Ablauf"; a chip never names a ref of look_at_page

## [0.2.47] - 2026-10-11
- ADDED **[runtime]** A person's own feature switches from the Manage-App lie over the team's in the cloud studio's /me
- ADDED **[plugins]** A plugin declares its feature switches in its manifest – known as <id>.<name>, with default, kind and label; the runtime's list of switches is the core's plus the loaded plugins', the report to the Manage-App carries it, the features command lists what the plugins here declare, and a plugin asks for its own switch by its short name
- ADDED **[runtime]** Feature switches – one map of what is on, resolved from the code's defaults, what the account or the team's Manage-App says and what this install sets; the studio, the mobile app and plugins (open and closed) read it from the config and the person's /me, a plugin through its API; the studio's compile-time switches move into it and the team page waits for its switch

## [0.2.46] - 2026-10-11
- ADDED **[debug]** A look from afar at every installation – every process keeps the last 3000 lines it printed in memory (log.ts: the console is hooked once, each line still goes where it went, keys, tokens, JWTs and one-time links are taken out before a line is kept). The runtime answers about itself in debug.ts, read-only and never with a key: status, logs, one run of any tenant with its error and events, where a tenant's classes run. The Manage-App reaches it over /api/internal/debug/* with the service key; the command line of a local install over /api/local/debug/* with a ticket (wizards logs, wizards report – status, model settings without keys and the last 500 lines go to the account's /v1/diagnostics only when the person runs it). A page in a browser sends the errors it meets to POST /api/log, capped and rate-limited, so the studio's side shows in the same log. The raw words of an installed AI client's failure are logged before they are summed up for the person. docs/plans/remote-debug.md

## [0.2.45] - 2026-10-11
- ADDED **[studio]** The home's pills narrow the wizards by status – Entwurf, Lokal, Live, Nicht in der Cloud, as the cards' chips say it – in place of the channels, drawn once two statuses are in play; the import lives on the new-wizard page alone; the new-space dialog says what a space is and holds (its wizards, Info & Marke, Wissen & Daten, Connectors, Ergebnisse) and that account, models and plugins are everyone's
- ADDED **[studio]** The home is searched once a space holds more than twelve wizards – a search over title and description stands in the title's place ("Suche nach deinen Wizards"); with fewer than three own hits the marketplace is asked the same and answers with its first cards under "Aus dem Marktplatz", each opening and usable as on the new page, and "Neuen Wizard bauen: …" carries the words to the new page as the wish (?wish=); an empty space offers the first wizard under its line; the import is an icon beside "Neuer Wizard"
- ADDED **[studio]** The About dialog looks like an About window – the mark, the name and the version centred at the top with the update line and its button under them, no title, the close in the corner where it stays while the dialog scrolls; the three tabs are one button group in the middle, a thumb sliding to the pick and taking its width (ui Tabs, in the look of the theme switch)
- ADDED **[studio]** The About dialog's three parts are tabs – Was ist neu, Frühere Versionen, Credits – one at a time, sliding in from the side it stands on like the settings' levels; the newest release's notes stand under their version and date
- ADDED **[studio]** The About dialog folds the open-source credits under the earlier versions – the same body as the Open Source dialog in the footer, loaded when unfolded
- ADDED **[studio]** The mark in the app bar opens "Über engenty wizards" – which version this is and how it got here (local install, checkout, npm, cloud); on a runtime that runs alone whether a newer release is out, checked right now on "Nach Updates suchen" (GET /api/studio/update?fresh=1 asks GitHub again within the hour, the answer says when it last asked) and installed from there where install.sh put it, with the release's page beside it; what is new in the newest release known, and the earlier versions folded away, each unfolding to its changes; the update banner and the dialog share one hook (lib/update.ts); the space's row in the switch menu opens its wizards, the space's page stays behind the home glyph
- FIXED **[studio]** The footer's version opens the About dialog; its Changelog and Credits links are gone – both live in the dialog's tabs; the credits' own dialog went with them (about/Credits.tsx keeps the body)
- FIXED **[studio]** The About dialog's middle tab says Versionen, so the three tabs stand in one row on a phone
- FIXED **[studio]** On a phone a dialog fills the screen – no gutter, no rounded corners, clear of the notch and the home indicator; the fixed height of a tall dialog is a wide screen's
- FIXED **[studio]** A dialog's height does not jump while it is open – one with tabs, folds or lists (About, Changelog, Credits: height="tall") stands as tall as the window allows, up to 56 rem, and scrolls inside; any other keeps the tallest height it has had, so a shorter tab or a folded section leaves it where it is, within what the window allows
- FIXED **[studio]** The credits are called Credits – in the About dialog's fold, the footer link and the dialog's title, not Open Source
- FIXED **[studio]** The About dialog is as wide as the changelog, so a release's notes run in fewer lines

## [0.2.44] - 2026-10-10
- ADDED **[studio]** The app bar's menu picks the colour scheme – Hell, Dunkel or wie das System under its own heading, on a phone too; 'wie das System' gives the pick back to the OS, which the theme switch could not; the bar can no longer be hidden – the item, the hidden state and the strip at the edge that brought it out are gone, the bar always stands at its edge
- FIXED **[studio]** The space has a home in the app bar – a house glyph after the space's tile opens the space's page (Info & Marke, Wissen, Daten, Ergebnisse), which was only behind the current space's row in the switch menu, where nothing said so; every space has one, the glyph opens the one that is open; the tile's ring now says the menu is open, not the page; and the app bar along a phone's edge keeps its items inside – its height is its own padding plus the safe area, where before the safe area was taken out of a fixed height and the icons rose over the bar's top edge in Safari

## [0.2.43] - 2026-10-10
- ADDED The wizard's browser is live in the chat – the run's page streams into the working bubble (GET /api/runs/:id/browser/live) with what the wizard just did over it ("Klickt auf …"), four fifths of the chat's width from tablet size up; the person can take the browser over and hand it back, the wizard's next browser action waits for that and gets the page as it was left; the sign-in panel shows the same live page; agent steps read a page with ids the page keeps, a banner's controls first, and a click on something a banner covers is refused with the banner's name; new browser tools read, select, scroll, press, back and wait; cookie banners are clicked away with the least consent; browser_run_fast hands mechanical stretches to a decision model like Jev wherever one is reachable (BROWSER_FAST_LOOP=off turns it off), ported from engenty-pro; what the person typed is never read out to a model
- ADDED Live voice on the web is a live audio screen, like a call – /w/<token>/talk opens the stage without the camera: the wizard's engenty alone in the middle, breathing while it speaks and glowing while it listens, the whole transcript of what either side said scrolling under it, mute, camera and leave underneath; switching the camera on turns it into the video call; the chat beside it stays the screen the wizard draws on; the chat with the phone button inside it stays for the plain chat
- ADDED The video call as a door of its own – /w/<token>/video opens a call screen, not a chat with a camera toggle: a stage with the person's camera and the wizard's engenty as the two on the call, what either said as captions (the model's transcripts, the person's through input transcription in the session), mute, camera, switch camera and leave underneath, and the chat beside the stage (under it on a phone) as the screen the wizard draws on; "Join" starts the conversation with the camera on, the composer beside a call only types; a built-in runner "video" the owner switches on like live voice, offered only where a speech model is set up, with its icon on the home and in the channel filter
- ADDED The home shows where a wizard runs – each card lists the channels that are on as icons, the link's door first, and a row of pills above the cards narrows them to one channel (all, steps, chat, live voice, WhatsApp, …) once channels beyond steps and chat are in play; the studio asks the runtime for the tenant's runners at GET /api/studio/runners
- ADDED Live voice on a WhatsApp call, and on the phone – the module modules/calls runs a wizard as a conversation on a call without any audio in the runtime: Meta's SIP mode sends a WhatsApp call to the tenant's Twilio SIP domain (a phone call reaches a Twilio number), Twilio asks the plugin for TwiML, the TwiML hands the call to the tenant's OpenAI project over SIP with a token in a header, OpenAI posts the incoming call to the plugin's public route (Standard Webhooks signature checked), the plugin picks it up with the wizard's rules and tools and answers the model's tool calls over the WebSocket to the call (a field, the page, a review, a question, back, hang up), reading the run's state to the model after every change; what a voice cannot take (a photo, a signature) is texted as a link from a Twilio number and the call goes on once it was filled there, the result is texted at the end; with several wizards on, the call starts by asking which, a WhatsApp call button's payload picks one; Settings → Calls takes the Twilio account, the texting number, the OpenAI project and webhook secret and the region, and shows what to enter in Twilio, OpenAI and Meta; the SDK gains server.speech.conversation(), the tenant's realtime speech model for a call a plugin drives itself
- ADDED SMS as a door, text only – the module modules/sms runs a wizard by text message on the tenant's own Twilio number: the account and the number under Settings → SMS with the address to enter in Twilio, a keyword per wizard with its sms: link and QR code under the SMS row of the share dialog, the webhook on the plugin's public route with Twilio's signature checked; one field per text, choices as numbered lines answered with the number (several with commas), yes or no, a place as a typed address, a page with a photo, a file or a signature as a link to the screen and the texts go on once it was filled there, long texts as their gist, every picture and document a link; the conversation WhatsApp and SMS share moved out of the WhatsApp module into the SDK as @engenty-wizards/plugin-sdk/thread – ThreadDoor holds it, each messenger brings a ThreadSurface (how a question is drawn, how a file is fetched, whether a message may go out now), and a typed number or an option's own words count as a tap on it, so a channel without buttons works the same
- ADDED WhatsApp as a door – the module modules/whatsapp runs a wizard in a WhatsApp thread on the tenant's own business number (Meta's Cloud API): the number, the token and what to enter in the Meta app under Settings → WhatsApp, a keyword per wizard with its wa.me link and QR code under the WhatsApp row of the share dialog, the webhook on the plugin's public route with Meta's signature checked; in the thread one field per message (buttons for up to three choices, a list for more, yes/no, the location request, photos and files sent in the chat, a voice message written down for a text field), a page the thread cannot take arrives as a link to the screen and the thread goes on when it was filled there, a review and a question are two buttons, the result arrives as text, pictures, documents and a link, after a day of silence only through an approved template; the framework gains what a channel needs: a runner's problem per tenant (not connected → cannot be switched on), runs.report with a draft so a field's condition follows the answers so far, runs.wizards, runs.transcribe, the report's lang and a picture of every output that has one, and studio.registerShareSection
- ADDED Live video on the web – in a live conversation the camera is a toggle: the wizard sees what the person shows (a frame goes to the model when the person starts speaking, at most every four seconds, and whenever the model takes a look), and a photo field is filled from the camera on the wizard's word ("hold it still": the frame is uploaded to the run and put into the field); a small picture shows what the wizard sees; the back camera on a phone, the one there is elsewhere
- ADDED Live voice on the web – a wizard can be talked to: the chat gets a phone button that opens a live conversation with a realtime speech model (audio both ways between the browser and the model over WebRTC; the runtime only mints the session on the tenant's OpenAI key at POST /api/runs/:id/talk and writes the rules), the model fills the page from what the person says through tools the browser runs against the run's own routes (set a field, send the page, accept or redo a review, answer a question, go back), hears every change of the run as it happens, and leaves photos, files and signatures to the screen beside it; a built-in runner "talk" the owner switches on per wizard, offered at /w/<token>/talk and only where the runtime has a key for it; the run view says whether a conversation can start, the engenty breathes while the wizard speaks
- ADDED The chat reads aloud and takes dictation – a speaker in the composer reads what the wizard says with the browser's own voice in the wizard's language (nothing leaves the page, kept on per browser; the last thing said when switched on, every new bubble after, hushed when the person answers), and a microphone (⌘⇧M) dictates into the composer: the browser writes along where it can recognise speech, elsewhere the recording is written down on the run's own route (POST /api/runs/:id/transcribe, with the run's access, at most 60 an hour, charged to the run); the run view carries the wizard's language
- ADDED A plugin can drive runs through its own door – wizards.server.runs holds the functions behind the MCP tools (start a live run for a person of the door, the report with what the run waits for, answer a page, a review or a question, back, retry, cancel, hear every change, the hand-off link with the run's ticket, upload a file) – and a page runner a plugin registers is served at /w/<token>/<runner> for every wizard that switched it on (from source at /api/public/wizards/<token>/runners/<runner>); the person of a door is kept on the run as a hash, so what the wizard remembers is theirs on the run page too, and a run carries the door it came through; the plugin docs get a Runners page
- ADDED A wizard is offered through runners the owner switches on – the stepped page and the chat ship with the runtime, a plugin can register more (server.registerRunner, with what it takes in and shows) – and the share dialog gets a Channels list: the link opens the default runner, the others answer under /w/<token>/<runner> and are offered under "Let's go"; each runner says how far it gets with the draft (everything in the channel, hands off to the page at these steps, not possible), from a matcher that walks every step; a sub-path that is off redirects to the link; the settings go with the cloud copy
- ADDED A run's report (get_run, run_wizard, answer_page over MCP) lists a page as the run page shows it – fields a decision kept, choices taken from earlier data, what the fields' conditions read from before the page, and for a field with a condition the condition itself and whether it holds now – so a client that asks one field at a time asks the right ones
- ADDED The chat asks a page's fields as v0.2.26 shows them – only those whose condition holds, decided again with each answer (a hidden one is neither asked nor kept), only the ones a decision picked, with choices from earlier data; a view's new-version button in a review points the change request at its step; how a field is answered without the form comes from one table, FIELD_WAYS in the definition, which the chat and the MCP tools' inChat both read
- ADDED The chat has its own address, /w/<token>/chat (a run at /w/<token>/chat/<runId>), in place of ?ui=chat; a website embeds it with data-runner="chat" in place of data-ui, and the popout loads it there; a chat link gets the wizard's link card
- ADDED The chat button in a website's corner shows the wizard's engenty on the pale ground of its hue (new /api/public/wizards/<token>/avatar.svg); the speech bubble stands in where it cannot load, the chevron while the chat is open
- ADDED The chat's quick replies stand in the thread, left under the wizard's question, instead of at the bottom; the composer stays below and waits greyed out while the answer is tapped or the wizard works
- ADDED Experiment – a wizard can also run as a chat: it asks one field at a time, answers come from the composer or quick replies, reviews and results arrive as messages; on the wizard's link with ?ui=chat, in a website as an inline chat (data-ui="chat") or a chat button in the corner that opens it above (data-mode="popout"), and in the editor's test drawer through a Steps/Chat switch
- DOCS The share dialog's Channels list, the chat's embed modes and the sub-path addresses in the user docs; the plan records what of phase 2 is built
- DOCS Two plans for the doors a wizard runs through – the concept (six channel patterns, what a wizard needs from a door, the admin's, owner's and customer's view) and the plan with the hooks the plugin framework needs (a run API for plugins, a runner registry with capabilities, sub-paths with a fallback) and the order of the work
- FIXED An agent step's JSON answer is taken as it stands when it fits the step's fields – a list in a table cell joined, a missing column empty – and only otherwise structured by a second model, which on Claude Code could fail after five tries on kilobytes of listings; Claude Code's own reason for a failure (subtype, errors) reaches the run log instead of "error"; web_fetch reads a PDF or Word file as text and answers an image or other bytes with their type and size instead of garbage
- FIXED The chat's quick replies keep their outline – the scrolling row cut off the top of a picked answer's ring

## [0.2.42] - 2026-10-10
- ADDED **[studio]** The studio installs as an app on every device – the user menu offers "Als App installieren": Chrome and Edge install on the word, elsewhere a dialog says how the browser does it (the share sheet on an iPhone, File → Add to Dock in Safari on a Mac, Chrome's menu on Android); the studio registers the service worker the public pages already had, and an iPhone's home screen names the icon "wizards"

## [0.2.41] - 2026-10-10
- DOCS LIMIT_PROJECTS is no longer listed in the example env or the Manage contract – the runtime still reads it, but it is not documented

## [0.2.40] - 2026-10-10
- ADDED **[studio]** A long press on a phone's app bar opens the bar's menu, with the phone's two edges and no hiding; the tap that follows the release is swallowed; the menu measures itself and moves back inside the window, so from a bar along the bottom it stands right above the finger
- ADDED **[studio]** A phone has the app bar too – along the bottom, or the top where that was picked, clear of the home indicator and the notch, never hidden; its menus open toward the page; the page's top bar keeps only the space's name, the trail and the credits, and the editor's header no longer carries the person
- ADDED **[studio]** The app bar stands at any edge of the window and can hide, as in engenty-pro – a right click on it opens its own menu with the four edges and "App-Leiste ausblenden"; the page and its inset follow the edge, the bar lays its tiles out in a row along the top or the bottom, and its menus open away from it; hidden, a small mark stays at the edge and the bar comes out while the pointer rests there, where the same menu pins it again; the pick is kept per browser, like the theme
- ADDED **[studio]** The app bar is 4 rem wide with 40 px tiles; the space's tile and its name in the top bar open one menu that lists the spaces as Slack lists workspaces – the one shown first, whose row opens its page, the others to switch to, and a row that adds one, greyed at the plan's limit; the top bar writes the wordmark on a wide screen and starts at the space's name on a phone, so the home page keeps no switcher of its own and its title shares the row with its actions; the engenties on the home cards and in the gallery wobble and follow the pointer
- ADDED **[studio]** The studio takes engenty-pro's frame – an app bar at the window's left edge with the mark, the space as a filled tile (a chevron below it switches between several), the pages plugins added after a divider, and the settings and the person at its foot; the page stands beside it set in from the window's edge with rounded corners and scrolls inside, so the top bar holds only the trail and the credits; the editor fills the frame with its own top bar; a phone keeps the bar it had
- DOCS **[plugins]** A plugin's icon stands in the app bar, where the top bar was

## [0.2.39] - 2026-10-10
- FIXED **[studio]** A signed-out visitor of /studio/ sees the sign-in page instead of being sent to the landing page – the start page is a door like every other page of the studio; someone signed in at engenty.ai is still signed in by itself; SIGNED_OUT_URL is gone, nothing reads it any more

## [0.2.38] - 2026-10-10
- DOCS The Chrome app's manifest and the mobile app's config carry the product's one line – "Make a wish, describe it once, and let the wizards run it on your own AI or in the cloud"

## [0.2.37] - 2026-10-10
- ADDED **[cli]** `wizards` alone is the menu and nothing starts by itself – without a command it opens the menu (start options without `start`, or no terminal, end with a hint to `wizards start`); the setup, also at the end of install.sh, no longer offers to start it but says whether it runs and how to start, open, stop, check and restart it from now on; new `wizards studio` opens the studio and starts it as a service first when it does not run; a fresh install folder no longer breaks the setup's last step, and every hint names the command as this install types it

## [0.2.36] - 2026-10-09
- ADDED **[studio]** The setup has a light · dark switch beside the language switch – dark stands on the blue ground as before, light on the studio's paper with white choices and the pick in the ground's blue; without a pick it follows the system, and the pick holds for the whole studio. The setup's copy writes engenty in lower case and without an article: "Womit soll engenty denken?"

## [0.2.35] - 2026-10-09
- FIXED **[studio]** A local studio's sign-in page names the command that lets a browser in, `wizards open`, instead of the link printed at start – a runtime started as a service prints nothing to a terminal

## [0.2.34] - 2026-10-09
- FIXED **[studio]** Someone signed in at engenty.ai who opens the studio is signed in to it by itself instead of being sent back to the landing page – the studio's start page sees the account's engenty_signed_in cookie and starts the sign-in, which goes through without a question; only visitors without an account go to the landing page

## [0.2.33] - 2026-10-09
- ADDED **[cli]** `wizards` on a terminal opens a menu – it shows what runs (address, pid, since when), whether it starts at login and whether a newer version is out, and offers start, start here, open the studio, restart, stop, update, start at login, connect AI apps, status, setup and help; with options or without a terminal it starts as before. New: `wizards restart` (one the command started starts again where it ran, any other is stopped and started as a service) and `wizards start --service` / `-s` (detached from the terminal, the command returns, output in logs/runtime.log); after an update the command says `wizards restart`

## [0.2.32] - 2026-10-09
- FIXED **[mcp-app]** The flow widget keeps a usable size and never goes blank – it is at least 360px tall from its first paint (the page root no longer holds the frame at full height, so a host can also shrink it), a runner that breaks leaves the diagram and panel instead of an empty frame, and the whole widget shows a short message if it cannot render at all; the docs say the runner reaches the runtime with the run's ticket and note that Cursor folds the widget into its "Worked for …" group (a known Cursor bug)

## [0.2.31] - 2026-10-08
- FIXED **[runtime]** Pictures from the web show in what a step makes – a generated page may load nothing from the network, so an <img src="https://…"> a model wrote or a photo URL in a widget's data (a listing's photos, a product's cover; by key or extension) stayed blank; now each is fetched once when the step runs through the public-only guard (image/* only, 8 MB, 10 s, up to 40 per step), kept as a web-image asset of the run and referred to as asset://ID, inlined wherever the page is shown or rendered to PNG, PDF or film; a picture that cannot be fetched is left as it was; the authoring guide says so

## [0.2.30] - 2026-10-08
- ADDED **[plugins]** Pro modules on a local install – the closed plugins the linked account's plan includes come from its Manage-App (/v1/modules) as zips signed for the release, checked against the public key the runtime ships with before anything is unpacked, and installed into <DATA_DIR>/pro-modules apart from the person's plugins; they load only while the entitlement the Manage-App signed lists them, belongs to the linked account and has not ended (a week offline), and only in the release they were built for, are fetched anew for a new release or build, and go off with the plan or the account while their files and tables stay; Settings → Plugins has a Pro modules section (install, update, remove, check the plan) and stays reachable for a linked account without plugins; concurrent refreshes of the account token share one request, so the start-up checks no longer refuse each other
- DOCS Plan for Pro modules in a local install – signed packages downloaded with the linked account, a signed entitlement that turns them on and off with the plan, what can and cannot be protected on the person's machine

## [0.2.29] - 2026-10-08
- ADDED **[engine]** An AI step can call one plugin tool without a model – call { tool, input } with the inputs filled from earlier answers (a whole number or true/false passed as one, an empty one left out), checked against the tool's schema, the answer kept as the step's json output (output.fields name the keys later steps read); it costs no credits, needs no model and answers as fast as the tool; the authoring guide and the plugin docs show it for free appointment times

## [0.2.28] - 2026-10-08
- ADDED **[marketplace]** The catalog knows which plugins a wizard needs and the plan that has them – an entry carries plugins (read from its tools named <plugin>.<tool>), plan (free, or pro as soon as it uses a plugin) and the plugin starter it stands for; searching filters by plan with its counts; a runtime with the plugin lists the plugin's own starter and leaves out the entry for it, one without marks the entry with what it needs and refuses to start it; the studio shows Pro on such templates, a Paket filter beside the others and what is missing, list_starters says needsPro

## [0.2.27] - 2026-10-08
- ADDED **[ui]** A time picker in the studio's look – a field that opens an hour and a minute column below it, arrow keys move the time by its step, compact without the clock for narrow rows; the plugin docs list it with the page menu and the composer
- ADDED **[plugins]** What a booking plugin needs from the runtime – a plugin connects accounts of the space itself (server.connections: start, list, call, remove, with the shared sign-in callback and token refresh), brings starters to the marketplace (registerStarter), learns whether a step runs as a test (step.mode) and in which wizard, and tells the space assistant what its own page holds (registerAssistantContext), where the assistant now stands docked (studio.Assistant) and the page names its place in the top bar's trail (studio.useCrumbs); a page field of kind slot offers free times as chips by day; the studio has a date picker and a date range picker, a composer shared by every chat (a pill on one line, the buttons level with the text, a menu beside the mic to choose the microphone and to hold to record) that floats docked over a blurred band clear of a phone's home bar, and a page menu that slides one level down at the side and becomes tabs on a phone; Google Calendar and Outlook events take a location, Google's an invitation to send and Outlook lists every event with its free/busy; the first slash of the trail stands as close to the wordmark as the others

## [0.2.26] - 2026-10-08
- ADDED The wizard editor has a Memory tab – the wizard's part of the space data, the notes its AI steps keep with the pages tool and the tables of its shared lists, a short list that opens each in the space's own editor, with a new note at hand; a test run reads the memory but writes into a copy of its own in the run, which goes with it; files dropped on the Files tab are uploaded and files dropped on the conversation are attached to the next message, each with a drop sign over the pane; the Files and Memory explanations sit small at the foot of their pane; holding to delete takes 1.2 seconds; costs say credits instead of cr
- ADDED A view step shows a preview of itself with sample data in the shape of what it reads (a kept list's rows by its columns, an AI step's table and fields by their kind), and a small button in its corner turns it into its JSON with highlighting, edited in place and kept when it is valid; deleting a step takes holding its button for two seconds while it fills up, a short press says to hold; the step panel's resize grip sits outside the panel beside its edge, clear of its scrollbar
- ADDED A step can be added that only some runs take – the add-step prompt asks when the step comes (always, only if a condition the admin writes in their own words holds, or when the AI finds a statement true) and the assistant builds it as a side path; a branch with only a target is now the step's "otherwise", where every run goes that no other branch takes, so a side step rejoins the flow – the engine, decided branches and the required-steps checks follow it, the step panel shows and edits its target, the diagram labels it and draws no plain line beside it; the diagram's add action is now "Add step" on the selected step's lower edge instead of a + on every line, and the step panel's button says the same
- ADDED A step is added by saying what it should do – the step panel's one-line footer opens a prompt (and a + on a line in the diagram does too) where the admin describes the step and picks its kind or leaves it to the AI; the request goes to the conversation as the admin's message, the new step is shown in its place as being built and selected once the assistant has built it completely (a widget with its HTML and sample data); an empty step can still be inserted; a widget without its HTML offers to let the assistant build it or to upload an HTML file instead of a dead end
- ADDED The step panel shows where the run goes next – a step without branches shows the step that follows, folded to its title and unfolding to what it asks or makes, its cost and where it leads; a step with branches lists one row per way (conditions, the statements the AI decides, otherwise) with its target, each unfolding to edit it, and conditions can now be added and edited there too; how a decision is made moved into the AI chip's hint; a test run's decision is shown only while the step's branches are still the ones it decided over
- ADDED A wizard's branches can be inspected in the studio – a click on a branch line in the diagram opens the step's branches: its conditions in the order they are checked, the statements the AI decides together in one call with their target steps, where the run goes when none clearly holds, how it is decided and how often a loop may run; statements can be edited, added and removed there; after a test run the diagram marks the branch the decision took with how probable it found it, and the step shows the probability of each statement and whether a decision model or the language model decided
- ADDED A wizard can show what a run found in its own look – a new step type "surface" (a view) is built from a fixed set of native parts (text, facts, key figures, lists with pictures, tables, bar, line and ring charts, buttons) bound to the run's answers, results and kept lists, written once by the assistant and free on every run; a view can leave some of its parts to the AI, which shows a chart only when there is something to compare; an AI step with json output can lay out a view of its own result, checked against the parts before it is kept; reviews and the result page show a step's view instead of a plain table, a view's button can ask for a new version in a review or open a file, and a view downloads as JSON
- ADDED The AI can decide how a wizard goes on and which questions it asks – a branch can carry a statement instead of a condition ("the person wants a refund") and all such branches of a step are decided together in one small call, a field can be shown when the AI finds a statement true and fields of a group are alternatives of which it shows the one that fits, decided once as the run reaches the page; every decision goes to a decision model where there is a way to one (Jev through the credits, an AI Gateway key or a TypeSafe key) and otherwise to the classifier class's language model, so decision steps now carry how probable their answers are (branches read it as steps.<id>.<field>.p) and Wissen's relevance check works without Jev; decision steps answer scores on a scale; a branch back to an earlier step is a loop that stops after its max (ten without one) and the step that runs again sees what it made last time; an AI step can run once per row of a table or a kept list and hands on one table of the results
- ADDED A field can be shown only under a condition – it appears as the person answers another field of the same page, or depends on anything known before the page – and a hidden field is neither required nor kept; the choices of a select can come from earlier data (a list an AI step found, a column of its table, or a column of a list the wizard keeps), with the fixed choices standing in while that data is empty; branches compare numbers (greater, less), look into multiselects, lists and texts (contains), read how many rows a kept list has, and take several conditions that must all hold; the studio edits a field's condition and the source of its choices, the diagram labels the new conditions, and the assistant is told to use conditions instead of one copy of a page per answer
- ADDED Gmail, Drive, Calendar and Contacts connect on a local install without a Google client of its own: through the linked engenty account, which holds the client and refreshes the tokens; before an account is linked, connecting asks to link it first

## [0.2.25] - 2026-10-07
- FIXED Connecting a mailbox over IMAP finds Google Workspace on a company domain through its MX record, gives up after 15 seconds instead of spinning, and a failed connect names the server it tried and says what to check

## [0.2.24] - 2026-10-06
- ADDED A run opened in the drawer (editor test runs and the space's results) can be dragged wider or narrower at its left edge – arrow keys too, a double click resets – and an expand button in its bar makes it fill the browser window; width and expansion are remembered per browser

## [0.2.23] - 2026-10-06
- FIXED A wizard's brand colour no longer makes its buttons unreadable: the text on a button is light or dark by the button's own colour, not by the theme (a black accent in dark mode got dark text), and ember as text and marks on the page keeps a lightness the paper can carry; the selected chip of an output follows the same rule instead of always white

## [0.2.22] - 2026-10-06
- FIXED A model an own AI Gateway key may not use is found before a run starts, not after minutes of work: the check before a run (and the runtime's start, and the Models page) asks Vercel once per key and model with a call of a token or a word – a refusal of the free tier costs nothing, is asked again after five minutes so a top-up counts, and an allowed model is not asked again for a day; videos and images not made by a chat model cannot be asked that cheaply, there a refusal a run met counts; a step refused for the free tier says so and how to fix it (top up at Vercel, with the link, or pick another way under Einstellungen → Modelle) instead of Vercel's raw message, and web addresses in a run's error, the editor's missing-models notice and the Models page are links

## [0.2.21] - 2026-10-06
- ADDED A wizard can make a film with Claude Code: the new step type "film" lets the AI client installed on this computer write a motion-graphics film as code in a folder of its own – with HyperFrames' skills (fetched once from GitHub at a pinned version), the wizard's style kit (a .zip in its workspace, unpacked as the bar to reach), the space's brand (name, colours named by use, facts, logos) and the run's material (voice, script, pictures, uploads) – and the runtime renders the MP4 with HyperFrames (installed into the data folder on the first film); the client's shell runs in its sandbox, writing only inside the folder and without network, and reaches HyperFrames' render, snapshots and checks through a tool of the step limited to the folder; sounds come only from a catalog of CC0 effects (soundcn by Kenney, HyperFrames' own); a film runs only where Claude Code is the AI subscription, never on credits or in the cloud, the runner says so before a run starts and the marketplace shows it as a capability; a film that stops picks up the client's session on the next try, a failed final render goes back to the client to fix, and a review's note changes the film's code instead of making it again; the folder goes with the run's files

## [0.2.20] - 2026-10-06
- ADDED A team's plan reaches the runtime: the Manage-App names the plan, its feature switches and the people it allows, and a count of spaces may be unbounded (null); in a team the owner and the admins make and delete wizards, spaces and connectors while a member edits, tests and publishes the wizards there are – enforced in the services for studio, API and MCP alike (403 forbidden); the settings get a Team page with the plan, the places and who is in the team, managed at the Manage-App; own API keys in the cloud studio are a feature of the plan; and the Manage-App learns which plugins a runtime carries (GET /api/internal/plugins)

## [0.2.19] - 2026-10-06
- ADDED The gallery has three more categories (Bilder & Video, Anfragen & Termine, Beratung & Preise) so the category row fills two even rows

## [0.2.18] - 2026-10-06
- ADDED Wissen in the space: what the space's wizards look things up in, as pages with sub-pages, tables and files sorted by typed Kategorien (choice, date, number, text, yes/no), filtered by them and searched by words and meaning, with a classifier that keeps only what answers the question; an upload is converted on arrival (a long document becomes a page with sub-pages, a sheet a table, the original stays beside it) and a model fills its Kategorien; every value of a Kategorie has its Übersicht and its entries, numbers in ranges; steps get project_search with a filter, project_list, page_read and table_read by path; the assistant docks at the bottom of an opened item and knows Wissen; plugins write into Wissen through server.spaceData (pages, tables, files, documents with their Kategorien), and what a person edits stays theirs

## [0.2.17] - 2026-10-06
- FIXED A run's price follows one way through the wizard instead of adding up branches that exclude each other, and leaves out the steps that have no model here (the video ad: about 111 credits with clips, 11 without a video model, was 207 either way); what a step reports while it works shows in the language the person reads, the run's log keeps it in German; English wizards write amounts and today's date the English way (€2,400.00) instead of the German one

## [0.2.16] - 2026-10-06
- ADDED A wizard that needs a model not set up here says so before anything is paid for: in the gallery, video, speech output or voice notes that only some answers need no longer block a template ("Works without: …"); on its pages, the choices that would lead to such a step are locked with the reason and the default moves to one that works, an optional voice note nothing here can listen to gives way to the reason, and the server refuses those answers

## [0.2.15] - 2026-10-06
- ADDED On phones and small tablets the editor's pane is a bottom sheet whose height is dragged at its handle, touch included; a tap on the handle folds it to its tabs and unfolds it to the height it had, a step tapped in the diagram or a tab unfolds it too, and the height is remembered per browser; the sheet and the diagram now fit the screen, so the chat's input is no longer cut off at the bottom
- FIXED **[mobile]** A saved wizard whose link is gone (a new link, or the wizard deleted) shows as unavailable instead of offering Start into the runner's not-found page

## [0.2.14] - 2026-10-06
- FIXED "What's new" in the banner about a newer release opens the changelog of that release in the studio instead of its page on GitHub; offline it shows the changelog this version came with

## [0.2.13] - 2026-10-06
- ADDED The space opens behind the folder in the top bar and has four parts in the settings' sliding menu: Info & Marke (Basis, Logos, Farben, Assets, Fakten), Wissen (Dokumente), Daten and Ergebnisse; Daten holds tables with typed columns, edited cell by cell, and Markdown pages, of the space or of one of its wizards; a wizard's list can be shared, one table for every run that the person running it never sees, and a step with the new Pages tool writes the wizard's pages; the space's own tables and pages go to the cloud with each published wizard and are read-only there, while what runs write stays where they ran; Ergebnisse lists the finished runs of all wizards or of one, the wizard with the latest result first, with search, live or test and the last days; a plugin's section of the space chooses its part; the studio is a step smaller on laptops and nearer the edge on phones; the run-log example no longer adds an icon to the top bar

## [0.2.12] - 2026-10-06
- FIXED The documentation deploys like the cloud runtime: its image is built on GitHub's runners beside the checks of a release tag and pushed to GHCR, and the server only pulls it (deploy/Dockerfile.docs, built with --pull); the docs Dockerfile keeps its install cached across releases; a change of the docs image no longer redeploys the runtime

## [0.2.11] - 2026-10-06
- FIXED The cloud runtime deploys in minutes: its two images are built on GitHub's runners beside the checks of a release tag, with their layers cached in the registry, and pushed to GHCR; once both are green they become latest and the server pulls them instead of building for up to an hour; the runtime's Dockerfile keeps both dependency installs cached across releases (the root version blanked out, the production install in its own stage) and puts what changes every release last; IMAGE_TAG on the server pins a release

## [0.2.10] - 2026-10-06
- FIXED Signing in from the studio returns to the studio page that asked for it, not to the host's root, which is the landing page since the studio moved to /studio

## [0.2.9] - 2026-10-06
- ADDED Plugins add to the space: sections of the space page under the plugin's name in its menu, tools of the space assistant whose results the plugin draws as cards in its chat, a block and tools for every AI step of the space, texts in the space's search index that project_search finds beside its documents, events when a space is made, changed or deleted and when a file is read or removed, jobs that run on a schedule, public routes under an address of their own, and the runtime's web reader and document parser; the run-log example shows a space's last runs on the space page; the plugin docs describe the space

## [0.2.8] - 2026-10-06
- ADDED Settings → Models says what the wizards can do (text, images, videos, voice, voice notes) and who does each: an AI subscription on this computer, an own API key (OpenAI, Anthropic, Google, fal.ai, ElevenLabs, Replicate, AI Gateway), a local model, or the credits, which step in where nothing of one's own is set up (a switch, on with a linked account) and may name a model of the gateway (credits:<model>: fal, ElevenLabs, Veo …); each provider's key is checked with the provider before it is kept, and a try makes a text, an image, a voice or a short clip to look at; in the cloud the page is the team's, its keys sealed per tenant and changed by its admins; voice notes run on transcription models (Scribe, Whisper) where one is bound, also on the credits; the settings show their name in the top bar's trail instead of a heading, and one container on the left slides one level down to the menu of Models and Integrate and back; on a phone the sections, a section's menu and the page take turns with a way back; Integrate puts the app's name, what it gets and its steps on one line

## [0.2.7] - 2026-10-06
- ADDED The space is a page of its own: the top bar opens it beside the gear, and a menu at its left jumps to Basis, Logos, Farben, Assets, Dokumente and Fakten and marks the one in view (a picker on a phone); the studio, its assistant and the docs call a project a space (German „Space“), the address is /space and /settings/project leads there; the settings keep Konto, Connectors, Modelle and Einbinden, and the gear opens Konto; the assistant's input is one line until the text needs more, in its card and docked at the bottom

## [0.2.6] - 2026-10-06
- ADDED A wizard's link installs and bookmarks with the wizard's own icon: its engenty in its own colour on a pale ground of that colour with its name in small capitals below, drawn by the runtime for the manifest, the iPhone's home screen and phones that cut icons to their own shape; the page's favicon is the engenty alone, so a bookmark or tab shows it too; the name keeps the whole words that fit and never ends on a short word like "aus"; the studio's icon stands in where the runtime cannot draw; on a computer the start page offers a bookmark (⌘ D or Strg + D) instead of an install, phones keep "Zum Startbildschirm hinzufügen"

## [0.2.5] - 2026-10-06
- ADDED A local install says where each wizard runs and which link others can open: the cards and the editor's top bar show Live with a cloud when engenty.ai runs the version, Lokal when it runs only on this computer, Wird gesendet or Nicht in der Cloud when it did not arrive; a card's Link copies the cloud's address; the share dialog leads with that one link, says on top where the wizard runs and what the cloud lacks, folds website, QR code and the settings away, and creates a new link in the cloud too; the avatar and its menu show whether an account is connected, with its credits; Settings → Konto puts engenty.ai first and takes name and e-mail from the account; without an account the share dialog, a card's Link and the note about missing models say what an account would add

## [0.2.4] - 2026-10-05
- FIXED A wizard a local install sends arrives whole or not at all, and the install sends again by itself: the cloud runtime keeps the files' bytes first and writes the project, the wizard, its workspace, the version and the logo in one transaction, so an object store that fails in the middle leaves nothing half done; the install plans another try after a minute, then twice as long each time up to an hour, when the cloud was out of reach or answered with an error of its own, and the share dialog says when; refusals stay with the person; a first sync that stops at an unreachable cloud marks the remaining wizards for the retry too; the public link is set on every sync; the runtime asks GitHub for a newer release once an hour instead of every six

## [0.2.3] - 2026-10-05
- ADDED With an account signed in, what a local install publishes also runs in the cloud: the published version and its files go to the account's cloud runtime under the ids they have here, which shows the project without editing and makes the link; Settings → Konto signs in or creates an account with an invitation code and shows the credits and when they end; the share dialog says what a wizard lacks in the cloud; a team without building rights changes nothing on the server, and what visitors send is capped in size
- ADDED Inside the mobile app the runner reads in the system's font, like the app's own screens; headings keep the brand's
- ADDED The mobile app looks native: the system font, Liquid Glass (a blur before iOS 26) on the floating tab bar and the nav buttons, inset grouped lists with hairlines, Add as a form sheet with eight ID boxes, swipe to share or delete a result, files listed as the Files app does, settings rows with icon tiles
- ADDED The mobile app (apps/mobile, Expo): wizards added by QR code, ID or link, runs in the runtime's runner with the app's scanner, share sheet, downloads, notifications and sign-in sheet, results kept on the phone and shared from there; engenty.ai's /w/ and /s/ links and engenty-wizards:// open in it
- ADDED A run tells the mobile app's device when it is done, failed or waits for the person: the app gives the run its device (POST /api/runs/:id/notify), the runtime asks the Manage-App to push (POST /v1/push in the contract); the app's own requests name the visitor in an x-wizards-visitor header, since iOS merges a Cookie header with its cookie store
- ADDED The runner works inside the mobile app: ?app=1 drops the web's header, footer and install hint, and window.engentyApp takes over the scanner, share sheet, downloads, wake lock, notifications and account sign-in; a wizard gets an 8-character ID (GET /api/public/codes/:code) and the studio's share dialog shows it with a QR code to download as PNG or SVG; the runtime serves apple-app-site-association and assetlinks.json for the app
- DOCS Plan for the mobile app that runs wizards on iOS and Android
- FIXED The mobile app's data folder (apps/mobile/src/data) is in the repository: the ignore rule for the runtime's data folder hid every folder of that name, so main neither typechecked nor passed the mobile app's tests; the rule now names the runtime's two data folders
- FIXED The mobile app runs on Android: no iOS-only WebView prop that crashed the Run screen, plain http only for a runtime on this computer, result rows in the wizard's colour

## [0.2.2] - 2026-10-05
- ADDED **[plugins]** Server.generate asks a model of the current tenant (a class, a prompt, optionally a zod schema for an object), on the models its studio is set up with and paid like any other call; without a model it throws with status 503 and the code no_model, which a route passes on
- DEPLOY The documentation deploys to engenty.ai/docs: an image of its own (apps/docs/Dockerfile, a standalone Next.js server on port 8896), and a release tag moves the branch deploy/docs when the site or its pages changed
- DOCS A documentation site with a user guide and the developer docs for plugins, built like the engenty repo's: Next.js and Fumadocs in apps/docs, the pages in docs/content, in the app's light and dark colours; docs/plugins.md became its pages, and the product's build, image, package and credits leave the site out

## [0.2.1] - 2026-10-05
- ADDED The wizards run in the person's own AI apps — connect writes the MCP server into Claude Desktop, Cursor, Codex and others, a run shows the wizard itself as an MCP App widget, and Settings → Einbinden adds an app with one click and tests it until it works
- FIXED The AI apps start the MCP server as the wizards command, after the rename from engenty-wizards

## [0.2.0] - 2026-10-05
- ADDED A runtime takes plugins: tools for agent steps, routes with tables of their own, listeners on runs that end, and pages, top bar icons and settings sections in the studio; they load from modules/ and PLUGINS_DIR at start and again while it runs

## [0.1.11] - 2026-10-05
- DOCS The package is on npm as wizards, and the README's studio picture shows the branches with their conditions
- FIXED A branch that skips steps runs beside them in the editor, with its condition readable on the line; it ran behind the step with the condition hidden

## [0.1.10] - 2026-10-05
- DOCS The README shows the studio with a branched flow and a wizard in use, from its first page to the result
- FIXED The editor's review notes, tool names and branch labels follow the language; they were German in the English studio

## [0.1.9] - 2026-10-05
- CHANGED The installer is engenty.ai/install.sh (was wizards.sh), and the command and the npm package are wizards (were engenty-wizards); the installer renames an install made under the old names
- DOCS The proxy sends the runtime /w/ and /s/ with the slash

## [0.1.8] - 2026-10-05
- DOCS The marketplace's pages are written by the site at engenty.ai, at /wizards/<slug> and /de/wizards/<slug>

## [0.1.7] - 2026-10-05
- ADDED A banner in the studio says when a newer release is out; the update installs from there, the runtime restarts into the new version and the page reloads
- ADDED The studio chat counts the seconds of a turn and says what the architect is doing and thinking; pasted pictures show in the thread and the architect sees them

## [0.1.6] - 2026-10-05
- ADDED Video models render at 720p, or 480p when a step asks; a larger clip is scaled down, and the price follows the resolution
- FIXED The settings say Codex makes images on the sign-in too; only video and audio still need a key

## [0.1.5] - 2026-10-04
- ADDED A wizard says which models it lacks before it runs, and only refuses to start when every path needs one; templates can be filtered by capability, and those this install cannot run are greyed out
- ADDED Codex makes images on the ChatGPT plan, and runs each model class on its own model (Luna, Sol, Astra); image, video and voice stay empty without a gateway key instead of naming models nothing can reach
- DOCS Plan for a setup by capability

## [0.1.4] - 2026-10-04
- FIXED The changelog's groups read NEW, FIXED, DOCS in every language, like the entries they stand before

## [0.1.3] - 2026-10-04
- FIXED **[release]** The publish job fetches the package artifact by name; with one artifact left it no longer lands in its own folder

## [0.1.2] - 2026-10-04
- ADDED A marketplace entry opens in the local studio at localhost:24368 instead of the Mac app's engenty-wizards:// link
- ADDED The Mac app is no longer built or offered; the studio offers to install itself as a Chrome app in a banner, starting at login on a Mac is a LaunchAgent that runs the command, and the setup, README and docs point there
- ADDED Engenty wizards starts at login — the Mac app opens in the menu bar without its window ("Open at Login" in its menus), on Linux a systemd user service; the setup asks, `engenty-wizards autostart on|off` switches it, and the Mac app's server takes port 24368 too
- ADDED The setup page installs a missing AI client in its own terminal, and both setups suggest the client whose app is on the Mac — its subscription is most likely already paid for
- FIXED An inline terminal's stream sends its last lines and its end before it closes; a page that opens it afterwards gets them all

## [0.1.1] - 2026-10-04
- ADDED The studio says when a newer release is out and, on an install made by wizards.sh, updates it from the footer
- ADDED The local runtime listens on 24368, AGENT on a phone keypad; the Docker image stays on 8891
- ADDED Wizards.sh opens with the tall engenty — one eye; it wakes up, looks around, hops and blinks
- ADDED The studio moves to /studio; the root of a host is free for a landing page
- ADDED The marketplace is an app of its own; the runtime searches it live and keeps its starters and the starred entries for offline use
- ADDED Engenty-wizards://new?starter=<id> opens a marketplace template in the desktop app
- DOCS The German tagline on the sign-in page follows the new one
- DOCS The tagline is "Make a wish. Get your wizard." In the README, the npm package description and the banner of wizards.sh.
- FIXED Ctrl-C stops engenty-wizards again — the login shell that reads the person's variables runs in a session of its own and no longer keeps the terminal

## [0.1.0] - 2026-10-04
- ADDED The desktop app is a window on the local install and brings no runtime along
- ADDED An installer, wizards.sh, that every runtime serves
- ADDED An engenty-wizards command for a local install in ~/.engenty/wizards
- ADDED A changelog and open-source credits in the studio's footer; pnpm release cuts a release from the commits
- ADDED Marketplace entries carry the words people ask for, so a search by words finds them
- ADDED One project unless the limit says more; an account page; previews and layouts in the project settings
- ADDED A project holds base infos, logos, colours, assets, documents and facts for all its wizards
- ADDED A template opens with its flow as a diagram; the gallery's field is narrower, its chips centred
- ADDED The gallery says what it is, compact and from the left; its search is a two-line field to write into
- ADDED The gallery opens with one question and the search field; quieter filter chips
- ADDED A marketplace of wizards to start from, with a gallery, admin, translation and search
- ADDED AI media is marked in its file and labelled with the EU icons (AI Act, Art. 50)
- ADDED Wizard packages carry their own extension, .wizard
- ADDED Wizards export as a package (.wizard.zip) and import into a project
- ADDED The editor pane's resize handle is a short, thick pill
- ADDED Chat composer takes files (+) and dictation
- ADDED Editor side pane resizable; Steps tab steps with ← / →, header and strip spacing fixed
- ADDED The arrow on a live wizard's card opens it in a new tab
- ADDED The AI clients page says it is an MCP server and sets a client up step by step
- ADDED Settings in sub-pages with a nav on the left (a dropdown on phones); MCP servers under Connectors
- ADDED Settings button in the top bar; the user menu closes on Einstellungen
- ADDED At most 5 projects per tenant
- ADDED Light / dark in the user menu, in place of the top bar's toggle
- ADDED Upload limits and sorting, pictures while a step works, faster photo steps, a feedback box on reviews
- ADDED Starters for receipts, video ad, property film, window offer, menu plan and ten website helpers
- ADDED Embed a wizard in a website, inline or behind a button that opens it in a window
- ADDED Wizards at /w/<token>, the app at the root of https://engenty.ai
- ADDED Serve the app under a path (https://engenty.ai/w)
- ADDED The drop engenty as app icon, tray icon and favicon
- ADDED Installed AI clients as the model of a local runtime, first-start setup as a wizard
- ADDED **[engenty]** Add furry and jelly renderers with an interactive builder
- ADDED Whole credits in the top bar, a footer line with the account's places
- ADDED Decision steps — yes/no and choice output fields, branches on step outputs
- ADDED Desktop app — Tauri shell with the runtime as a Node sidecar
- ADDED A database per tenant, model classes, sign-in at the Manage-App, phone inputs
- ADDED Engenty's built-in connectors — Gmail, Drive, Calendar, Contacts, Outlook, OneDrive, Slack, GitHub, HubSpot, S3
- ADDED Connectors from the integrations registry, asked-first changes in connected accounts
- ADDED Harden browser and file downloads, step navigation in the inspector, store and mailbox docs
- ADDED Light/dark mode with engenty-coloured dark pages, jelly and fur coats, quiet focus rings
- ADDED Lists and connections kept between runs, mail and browser tools, camera and ask panel
- ADDED Setup per AI client and a self-served plugin with /wizard
- ADDED Interactive widgets with a workspace per wizard, shareable results
- ADDED Live studio — MCP and other edits show up without a reload
- ADDED OAuth sign-in for MCP clients, connected apps in settings
- ADDED MCP endpoint for authoring wizards with personal API keys
- ADDED Engenty wizards — prompt-built AI wizards with shareable links
- CHANGED Pnpm workspace with apps/ and packages/
- DOCS Install with wizards.sh; the local install and how its pieces share it
- DOCS Plan for definition versions and importing older packages
- DOCS A README for people who install it, developer notes in docs/development.md
- FIXED The search skips filler words with umlauts too
- FIXED The gallery's footer stays without version, changelog and open-source links
- FIXED An entry's search terms are scored one by one, not as one long text
- FIXED The gallery has the studio's footer line
- FIXED The gallery's field is narrower
- FIXED A template's header is the dialog's own colour under a spotlight; in the light a tinted grey
- FIXED The marketplace search asks the model for the signed-in tenant; a sentence without a model keeps only close finds
- FIXED Two writers of the same blob no longer share a temporary file
- FIXED The project switcher switches the wizard list
- FIXED Photos reach an installed AI client, and a photo without text is described
- FIXED The editor at /edit/<id>, signed-out visitors of the start page go to SIGNED_OUT_URL
- FIXED The hosted addresses (engenty.ai) as defaults, no private repo names in the public sources
- FIXED A built runtime links to its own port, the sandbox falls back to agentOS
- FIXED **[setup]** No links to the clients' pages, a placeholder dot in the footer
- FIXED **[engenty]** Align vertical head turn with pointer gaze
- OTHER The gallery invites to start a wizard from a template

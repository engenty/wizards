<!--
AI apps (Claude, ChatGPT, …) that use and build wizards over MCP. Read by mcp/handler.ts
(`instructions`, the server's instructions) and mcp/tools.ts (tool descriptions, long parameter
descriptions, the note on people editing a wizard, the `design_wizard` prompt) and
services/runs.ts (the hints in waitingFor). The studio's architect (agents/architect.ts) uses the
tool.* descriptions of the tools it shares with this server. Tool titles and short parameter
descriptions stay in the code.
-->

<!-- Behaviour: product owns the sections below. -->

<!-- section: instructions -->
engenty wizards: page-by-page AI wizards — the person answers pages, AI steps write, research and make images or videos, the person reviews, the result is files.
Use one: list_wizards, then run_wizard straight away — its widget shows the wizard itself (show_wizard only when the person wants to see a wizard before running it), then follow waitingFor (answer_page, review_step, answer_ask, get_run with waitSeconds). Runs spend credits.
Build one: get_authoring_guide (schema + design rules), a close starter with get_starter, create_wizard, edit_wizard until "issues" is empty, check with start_test_run + get_test_run. Publish only when the person asks.
A result on a wizard may list "present": people and other agents in that wizard now. Nobody is locked out; when people are editing, tell your user before larger changes.
When a run needs the browser, hand over its browserUrl, the wizard's own run page. The studioUrl is for building only: never send someone who uses a wizard to the studio.
Projects are called spaces in the studio. Ids are for the tools only: name wizards and spaces by their titles and names, and where two spaces share a name, by where each comes from.

<!-- Technical: engineering owns everything below. -->

<!-- section: tool.get_authoring_guide -->
Read this before writing a wizard: the JSON schema, field kinds, step types and tools, templates, design rules, and the MCP servers of the project.

<!-- section: tool.find_connectors -->
Search the integrations registry for a service that can be imported as a connector, from its OpenAPI spec or its MCP server. Returns domains with a short description.

<!-- section: tool.list_connectors -->
The connectors a project has imported, each with its actions.

<!-- section: tool.import_connector -->
Import a registry service into a project as a connector. Returns its id, tool prefix, how people connect (OAuth, API key, none) and its actions with their marks (read / write / destructive). Importing again returns the existing one. A wizard uses it through a connection { id, connector }.

<!-- section: tool.list_starters -->
Ready-made wizards to start from: first those the space's plugins bring (marked with the plugin), then the marketplace's (tweet with image, video ad, research briefing, dashboard, invoice, offer …), with what each makes and needs. Give a query to search them; without one you get the starters.

<!-- section: tool.get_starter -->
A starter's complete wizard JSON — the best example to copy from.

<!-- section: tool.list_projects -->
The person's projects, called spaces in the studio. Each holds wizards, a brand and MCP servers. Name a space by its name; where two share one, add where it comes from (`from`). Ids are for the tools: never show them to the person.

<!-- section: tool.list_wizards -->
The person's wizards, newest first, each with its space's name and where that space comes from. Ids are for the tools: never show them to the person.

<!-- section: tool.get_wizard -->
A wizard's draft with its revision and validator issues, whether it differs from the published version, and its links.

<!-- section: tool.validate_wizard -->
Check a wizard JSON without saving it. Returns ok and the issues.

<!-- section: tool.create_wizard -->
Create a wizard from your JSON, or copy a starter. The draft may still have issues; fix them with edit_wizard.

<!-- section: tool.edit_wizard -->
Apply ops to the draft atomically, in order:
- set_meta {title?, description?, avatar?, costume? (null takes it off), intro? (null removes), themes? (theme ids in order; null removes)}
- set_theme {theme}: a theme of the space (see "type Theme"), made or replaced, worn first by this wizard
- set_lists {lists} / set_connections {connections}: replace the wizard's lists or connections as a whole
- upsert_step {step (complete), before?|after?}: replaces the step with that id, else inserts it (default: before the final result step)
- remove_step {stepId}
- move_step {stepId, before|after}
Returns the new revision and the issues.

<!-- section: tool.replace_wizard -->
<!-- Also the studio architect's: its wizard exists before the chat opens, so it writes a new one with this. -->
Replace the whole draft: for a new wizard, a rewrite, or anything edit_wizard can't do in a few ops. Returns the new revision and the validator's issues.

<!-- section: tool.publish_wizard -->
Publish the draft as a new version behind the share link. Refused while the draft has issues. Only when the person asked for it.

<!-- section: tool.set_sharing -->
Turn the share link on or off, or change how many runs it allows per day.

<!-- section: tool.start_test_run -->
Run the draft once with your answers. Spends the person's credits (short copy + image about 15, research about 150, video about 250). Pages are filled from `answers`, reviews accepted when acceptReviews is true. Follow it with get_test_run. Shows the flow with the run on it.

<!-- section: tool.get_test_run -->
Status, recent events, outputs (text clipped) with signed download links valid one hour, credits spent, and what the run waits for.

<!-- section: tool.show_wizard -->
Show a wizard as its flow diagram: its pages, AI steps, reviews and branches. The published version when there is one, else the draft. Also returns the steps as text.

<!-- section: tool.run_wizard -->
Start a run of a published wizard for the person, here in the chat. Spends credits like any run.
Start it right away — no show_wizard first: the widget shows the wizard's pages and the person can answer there. What the person already said goes to the first page with answer_page, using the field ids in waitingFor. Then follow waitingFor:
- page: ask the person for the fields with inChat=true, in order, answer_page; fields with inChat=false (files, recordings, signatures) need the run page at browserUrl. A field with a when is asked only while its condition holds on the answers so far (shown says so for what is known now); fields the wizard decided against are not listed
- review: show the outputs, then review_step
- ask: answer_ask (allow/skip a change in a connected account) or the run page for a sign-in
While status is running, get_run with waitSeconds. Hosts with MCP Apps also show the run as a widget the person can answer in.

<!-- section: tool.get_run -->
A run's status, what it waits for, its outputs (text clipped) with signed download links valid one hour, and the credits it spent.

<!-- section: tool.answer_page -->
Fill the page a run waits for: field id → value (items: an array of row objects; toggle: true/false; multiselect: an array; slot: one of the offered times, as given). Returns the run, after waitSeconds.

<!-- section: tool.review_step -->
Answer the review a run waits for: accept (optionally with edited texts, step id → text, when the review is editable) or regenerate one step it shows, with a note what to change.

<!-- section: tool.answer_ask -->
A running step asks before it changes something in a connected account (waitingFor.ask, kind confirm): allow it once, or skip it. Ask the person first.

<!-- section: tool.control_run -->
back: return to the previous page or review. retry: run the failed step again. cancel: stop the run.

<!-- section: tool.list_files -->
The files in the wizard's workspace (path, mime, size): widget HTML/JS/CSS, vendored libraries, reference data. Runs use a snapshot of it.

<!-- section: tool.read_file -->
A workspace file as text (binary files are described, not returned).

<!-- section: tool.write_file -->
Create or overwrite a workspace file: `content` for text (HTML, JS, CSS, JSON, CSV, SVG) or `base64` for binary (images, fonts). Max 5 MB per file, 25 MB per workspace. A widget may only use files from here — no network when it runs.

<!-- section: tool.delete_file -->
Remove a file from the workspace.

<!-- section: tool.check_widget -->
Load a widget step of the draft in a real browser with its sample data (or the data you pass): script errors, the timeline it registered (seconds, for the MP4 export) and a screenshot.

<!-- section: param.run_wizard.theme -->
The widget's look: the id of a theme the wizard names (its definition's themes), brand or default. Left out: host, this app's own look. Only when the person asks for the wizard's look.

<!-- section: note.present -->
<!-- In a tool result on a wizard while people edit it; who: "Ana (page 2), Ben", verb: is | are. -->
${who} ${verb} editing this wizard in the studio right now. Your change is in; their editor merges it with what they type. Tell your user before larger changes.

<!-- section: prompt.design_wizard -->
Build an engenty wizard: ${description}

1. Call get_authoring_guide and follow its rules.
2. Pick the closest starter (list_starters, get_starter) as an example.
3. create_wizard with a short note; fix every issue with edit_wizard.
4. start_test_run with realistic answers, then get_test_run with waitSeconds until it is done; fix what looks wrong.
5. Give me the studioUrl and a short summary. Publish only if I ask.

<!-- What a waiting run asks of the AI app (services/runs.ts, waitingFor). -->

<!-- section: hint.slot -->
One appointment time: show the person the labels, answer with the value of the one they pick, exactly as given.

<!-- section: hint.slot_none -->
No times are free right now: tell the person.

<!-- section: hint.confirm -->
Ask the person, then answer_ask with allow or skip.

<!-- section: hint.sign_in -->
A sign-in: the person types it on the run page (browserUrl).

<!-- section: hint.page -->
Ask the fields in order; skip a field whose `when` does not hold on the answers so far (a hidden one is not required and not kept).

<!-- section: hint.review -->
Show the person the outputs, then review_step: accept, or regenerate one with a note.

<!--
The tools AI steps get, and the notes their results and errors carry: the web, the sandbox, programs
over the tools, the wizard's lists, files and pages, Knowledge, mail, connectors and the browser.
Read by tools/*.ts, sandbox/index.ts, connectors/mail.ts and browser/fast/run.ts. The motion-graphics client's
own tool is in step.md. A description is all a model knows of a tool: say what it does, what it
returns and when to use it.
-->

<!-- Technical: engineering owns everything below. -->

<!-- Web: search, fetch, HTTP (tools/index.ts) -->

<!-- section: tool.web_search -->
Search the web.

<!-- section: tool.web_fetch -->
Fetch a public web page or file and return its readable text (Markdown).

<!-- section: note.web_fetch_image -->
An image, not a page: the address works. Its bytes are not text and are not shown.

<!-- section: note.web_fetch_binary -->
Not a text page: its bytes are not shown.

<!-- section: tool.http_request -->
Call a public HTTP API. Use for REST endpoints the instructions name.

<!-- section: note.net_private -->
Private addresses are not reachable from a wizard.

<!-- section: note.net_scheme -->
Only http and https URLs are allowed.

<!-- Sandbox, images, workspace (tools/index.ts, sandbox/index.ts) -->

<!-- Filled: the engine's commands, working directory and network; the engine's own notes follow. -->
<!-- section: tool.run_command -->
Run a shell command in a private Linux sandbox (${commands}). Working directory ${workdir}. Network: ${network}.

<!-- The authoring guide's line about the sandbox (sandboxGuideLine). -->
<!-- section: tool.run_command.guide_line -->
- The sandbox runs code (python/node) for ${uses}; export_file hands files to the person.

<!-- section: tool.export_file -->
Hand a file from the sandbox to the person as a result (e.g. a chart PNG, a CSV).

<!-- section: tool.generate_image -->
Draw an image from a detailed visual prompt. The image is shown to the person.

<!-- section: tool.read_workspace_file -->
Read a file from the wizard's workspace. Files: ${files}

<!-- Programs over the tools (tools/code.ts) -->

<!-- section: tool.execute_typescript -->
Run a TypeScript program that calls your tools as external_* functions: loops, Promise.all, filtering, sums. Only what it returns comes back to you. Use it when a task needs many tool calls or arithmetic over their results.

<!-- Appended to the code mode's own instructions, after a blank line. -->
<!-- section: tool.execute_typescript.limits -->
A program makes at most ${maxCalls} tool calls, ${maxParallel} at a time, and stops after ${seconds} seconds; all programs of this step together make at most ${stepCalls}. Return only what you need: a long answer is cut at ${resultChars} characters. A tool that asks the person first cannot run from a program, and tools that cost credits on every call (${paidTools}) are not offered there: call them directly.

<!-- section: note.code_max_calls -->
A program makes at most ${maxCalls} tool calls. Split the work.

<!-- section: note.code_step_calls -->
The programs of this step have made ${stepCalls} tool calls, all a step may make. Finish with what you have.

<!-- section: note.code_answer_too_long -->
${tool} answered ${size} characters; a program takes at most ${answerChars} from one call. Ask for less, or call ${tool} directly.

<!-- section: note.code_failed -->
The program could not finish (${error}). Work on smaller pieces: return less from each step, or call the tool directly.

<!-- The wizard's lists and files (tools/store.ts) -->

<!-- section: tool.list_read -->
Read one of the lists this wizard keeps between runs: for the person, or for every run where the list is shared.
${catalog}

<!-- section: tool.list_write -->
Save rows into one of the wizard's lists, so the next run knows them. A row whose key column matches an existing row updates that row (only the columns you give change); otherwise it is added. Values must fit the column: dates as YYYY-MM-DD, numbers as numbers.
${catalog}

<!-- After a shared list's title in the catalog of list_read and list_write. -->
<!-- section: note.list_shared -->
(shared: every run of the wizard reads and writes the same rows — never repeat other people's rows to the person)

<!-- section: tool.files_list -->
List the files this wizard keeps for the person (invoices collected on earlier runs, scans …), optionally only one folder.

<!-- section: tool.files_keep -->
Keep files the person gave in the wizard's files, several at once: each is stored under `path`, is there on the next run and belongs to this step's result. Returns the path each file now has.

<!-- After read_document's and scan_documents' description when the person gave files. -->
<!-- section: note.files_given -->
The person gave: ${uploads}.

<!-- section: tool.read_document -->
Read a document as text: PDF, scan or photo (read by a vision model), Word, Excel, CSV, a saved mail. `file` is an upload reference or a path in the wizard's files.

<!-- section: tool.scan_documents -->
Pull the key fields out of invoices or receipts, several at once: vendor, number, dates, net/tax/total, currency, VAT ID. Cheaper and more exact than reading each document yourself. Amounts come back exactly as printed.

<!-- The wizard's pages (tools/pages.ts) -->

<!-- section: tool.page_read -->
Read a page: one this wizard wrote, by its title, or a page of Knowledge, by its path (pages/…). Without either it lists the wizard's pages.

<!-- section: tool.page_write -->
Write a page of this wizard in Markdown, kept for every later run and shown to the admin in the studio. A page with the same title is replaced — or added to with append: true (a log, a list that grows). Pages of Knowledge are read-only.

<!-- Knowledge (tools/space.ts) -->

<!-- section: tool.space_search -->
Search the space's Knowledge: its pages, tables and files, its images, videos and sounds by their description, and what its plugins keep (wiki pages, questions and answers). Gives items with their path, categories and best section, each checked for relevance. Ask in their language, with the words they would use; filter with `where` when the task names a category's value. Then read the items you need whole with page_read or table_read.

<!-- The `where` input of space_search and space_list. -->
<!-- section: tool.space.where -->
Filter by categories before searching, by their names: a value ("Baustelle": "Graz Süd"), a list of values, a range of numbers ({ "gte": 20000 }) or of days ({ "after": "2026-03-01", "before": "2026-03-31" }), { "contains": "…" } for a text, true/false. space_list without arguments names the categories and their values.

<!-- section: tool.space_list -->
List Knowledge by its categories. Without `where`: the categories with their values and how many items each has. With `where`: the items it leaves, with their paths — all of them, where space_search gives the best few.

<!-- page_read when the step does not list "pages". -->
<!-- section: tool.page_read.knowledge -->
Read a page of Knowledge whole by its path: front matter (title, categories, its source and original, its parent and sub-pages) and its Markdown. Long pages come in parts: pass `from` to continue. `section` reads one section.

<!-- section: tool.table_read -->
Read a table of Knowledge by its path: its rows as CSV, filtered by its columns (by their names, like `where` of space_search). A few hundred rows at a time: pass `offset` to continue.

<!-- section: tool.space_document -->
Read a file of Knowledge as text by its path (files/…): a file that is not a page, or the original a page was read from. Long files come in parts: pass `from` to continue.

<!-- Skills of the space (tools/skills.ts); Goose gets the same tools. `names` joined with ", ". -->

<!-- section: tool.skill_load -->
Load a skill of the space by its name: its instructions and the list of its files. Skills: ${names}.

<!-- section: tool.skill_read -->
Read a file of a skill by its path, as skill_load lists it: a reference, an example, a template.

<!-- section: tool.skill_read.text_only -->
<!-- After tool.skill_read where no skill's scripts run in this step (no sandbox, or none switched on). -->
Scripts are text to read here; nothing runs them.

<!-- section: note.skill_unknown -->
No skill "${name}". Skills: ${names}.

<!-- `files` joined with ", ", or "none". -->
<!-- section: note.skill_no_file -->
No file "${path}" in ${skill}. Its files: ${files}.

<!-- In skill_load's answer for a skill whose scripts may run, in a step with the sandbox. `folder`: skills/<name>. -->
<!-- section: note.skill_folder -->
This skill's folder is in the sandbox at ${folder}: its SKILL.md and every file. Run its scripts with run_command from the working directory, e.g. python3 ${folder}/scripts/<file>.py, and install what they import first (pip install, npm install). Write what you make outside ${folder}.

<!-- section: note.skill_folder_failed -->
This skill's folder could not be put into the sandbox (${error}): its scripts can't run in this step. Follow its instructions without them.

<!-- A file of a skill that is not text: a font, a template, a schema. -->
<!-- section: note.skill_blob -->
${path} is a file for the skill's scripts, not text to read.

<!-- section: note.skill_more -->
${rest} characters more: pass from=${from}

<!-- Mail (tools/mail.ts) -->

<!-- section: note.mail_not_connected -->
The person has not connected a mailbox. Go on without mail and say in your result that the mailbox is not connected.

<!-- section: tool.mail_search -->
Search the person's mailbox (read-only), newest first. Returns id, date, sender, subject, snippet and attachments (id, name, size) of each mail. Search broadly with several terms at once rather than one call per word.

<!-- section: tool.mail_read -->
Read one mail in full: sender, recipients, text, attachments.

<!-- section: tool.mail_save -->
Keep mail attachments (invoice PDFs) as files, several at once: each is stored under `path` in the wizard's files and added to this step's result. Leave attachment_id out to keep the mail itself as a PDF — for receipts that only exist as mail text. Then read them with scan_documents or read_document.

<!-- The actions of every mail connector (connectors/mail.ts). -->
<!-- section: connector.mail.search -->
Search the mailbox, newest first. Returns id, date, sender, subject, a snippet and the attachments of each mail.

<!-- section: connector.mail.read -->
Read one mail in full: sender, recipients, text and attachments.

<!-- section: connector.mail.get_attachment -->
Fetch one attachment's bytes (base64).

<!-- Imported connectors (tools/connector.ts) -->

<!-- Each connector tool is "<service>: <the action's own description>", then connector.asks
     where the person is asked first, then connector.file_note. -->
<!-- section: connector.asks -->
The person is asked before this runs.

<!-- section: connector.file_note -->
File content never passes through you: returned content is kept as a file and you get its path; to send a file, give `file:<path>` of a kept file or `file:result:<step>.<format>` of a result where an input asks for `*_base64`.

<!-- A connector with many actions: <prefix>_actions finds them, <prefix>_call runs one. -->
<!-- section: connector.actions -->
${service} offers ${count} actions. Find the ones you need by words from their name or purpose; you get each action's id, what it does and its input. Then call ${prefix}_call.

<!-- section: connector.call -->
Run one ${service} action found with ${prefix}_actions. Some wait for the person's yes first.

<!-- section: note.connector_kept -->
The content is kept as a file; read it with read_document.

<!-- section: note.connector_not_connected -->
The person has not connected ${service}. Go on without it and say so in your result.

<!-- section: note.connector_in_program -->
This change waits for the person's yes, which a program cannot ask for. Call the tool directly, outside the program.

<!-- section: note.connector_nobody -->
Nobody is there to allow this change, so it was not made. Report it as open in your result.

<!-- section: note.connector_declined -->
The person did not allow this change. Do not try it again; say in your result that it was not made.

<!-- section: note.connector_refused -->
The rules of ${service} do not allow this action here. Do not try it again or another way; say in your result that it was not done.

<!-- The browser (tools/browser.ts) -->

<!-- section: tool.browser_open -->
Open a URL in the browser and return the page: its controls, each with a [number], and its text. A cookie banner in the way: click its least consent (only necessary / reject all) first. Sites the person signed in to on an earlier run may still be signed in.

<!-- section: tool.browser_read -->
Read the current page again: its controls with their [numbers] and its text. A number stays with its element as long as the element is on the page.

<!-- section: tool.browser_click -->
Click an element by its [number]. It is scrolled into view first; a click on something covered by a banner or dialog is refused and names what covers it.

<!-- section: tool.browser_type -->
Type text into a field by its [number], replacing what is in it; set submit to press Enter afterwards. Never for passwords or codes — those the person enters through browser_request_credentials.

<!-- section: tool.browser_select -->
Choose an option in a dropdown (a select element) by its [number] and the option's name as the page lists it. For a dropdown the page draws itself (no options listed), click it open and click the option instead.

<!-- section: tool.browser_scroll -->
Scroll the page down or up by most of a screen, or bring the element with this [number] into view. For results further down, lists that load as you scroll, and footers.

<!-- section: tool.browser_press -->
Press a key on the page: Enter to send, Escape to close a popup, Tab to move on, the arrows to move through a list of suggestions.

<!-- section: tool.browser_back -->
Go back to the previous page, like the browser's back button.

<!-- section: tool.browser_wait -->
Wait for the page: until a text appears on it (results that load, a confirmation), or for a few seconds. Then returns the page.

<!-- section: tool.browser_screenshot -->
Look at the current page: returns a picture of it to you. Use it when the text is not enough (charts, a layout you cannot make sense of, a captcha or cookie wall). Set save to also hand the picture to the person as part of the result.

<!-- section: tool.browser_request_credentials -->
THE way to get a login into a page: ask the person to enter a username, e-mail, password or one-time code into fields on your current page, WITHOUT you seeing it. The person sees the page live, the site's address and a form; what they type goes straight into the page, never to you. Give each field's [number] from your latest page, and submit_ref to press the sign-in or next button afterwards. A login spread over several pages (e-mail, then password, then code) is one call per page. WAITS for the person. Never ask for a password any other way.

<!-- section: tool.browser_request_user -->
Hand the page to the person for something no form can do: a captcha, 'continue with Google', a passkey, a cookie wall you cannot get past. They click and type in the live page and say when they are done. For a plain login form use browser_request_credentials instead. WAITS for the person.

<!-- section: tool.browser_upload -->
Attach a file to the page: give the [number] of the file input, or of the button that opens the file picker ("Add photo", "Upload"). The file is one the person gave (`upload:<id>`), a result of this run (`result:<step>.<format>`) or a kept file's path.

<!-- section: tool.browser_download -->
Download a file (an invoice PDF, an export) with the browser's sign-in and keep it: click the element with this [number], or fetch this URL. The file is stored under `path` in the wizard's files and added to this step's result.

<!-- section: tool.browser_run_fast -->
Hand a small, concrete browser sub-goal to the fast executor: on the CURRENT page it reads the visible controls, picks one element per step with a classifier (no language model), types field values taken from your goal, and repeats until the goal is visibly satisfied or it is unsure. Use it for mechanical sequences — click a cookie banner away, fill and submit a form, pick a date in a calendar, choose an autocomplete suggestion, set filters and dropdowns, open a matching result. Give one page's worth of work per call with every value spelled out (dates, names, filters); it never invents data. Returns status `done`, or `uncertain`/`blocked`/`budget`/`error` with the page and a note naming the step it could not decide. Then do THAT ONE step with the other browser_* tools and call browser_run_fast again with the same goal — do not finish the rest by hand. Open the page with browser_open first; it does not open URLs.

<!-- Under the page's controls when some are not listed; on a line of its own. -->
<!-- section: note.browser_more -->
… ${count} more not listed: close what is open, scroll, or read the page again.

<!-- Why a [number] cannot be used. -->
<!-- section: note.browser_covered -->
[${ref}] is covered by "${by}". Deal with that first — a cookie or consent banner: click its least consent (only necessary / reject all).

<!-- section: note.browser_disabled -->
[${ref}] is disabled right now.

<!-- section: note.browser_gone -->
[${ref}] is not on the page any more. Use the numbers of the page below.

<!-- section: note.browser_hidden -->
[${ref}] cannot be seen on the page.

<!-- section: note.browser_password_field -->
[${ref}] is a password field: the person fills it through browser_request_credentials.

<!-- Signing in: browser_request_credentials and browser_request_user. -->
<!-- section: note.browser_no_site -->
Open the site's sign-in page first.

<!-- section: note.browser_fields_gone -->
[${ref}] is not on the page any more. Read the page again and ask with its numbers.

<!-- section: note.browser_nobody -->
Nobody is at the keyboard for this run, so a sign-in cannot be asked for. Go on without it and report what the person has to do.

<!-- section: note.browser_declined -->
The person did not sign in. Do not ask again for this site; go on without it and say in your result what is missing and what the person can do.

<!-- section: note.browser_signed_in_self -->
The person signed in on the page themselves.

<!-- section: note.browser_fill_failed -->
Nothing you can read was entered. Read the page again and ask with its current numbers.

<!-- After the person filled in fields: note.browser_entered, note.browser_entered_submitted when a
     button was pressed, note.browser_entered_unseen. -->
<!-- section: note.browser_entered -->
The person entered ${fields} straight into the page.

<!-- section: note.browser_entered_submitted -->
It was submitted.

<!-- section: note.browser_entered_unseen -->
You do not see what they typed and must not try to read it back.

<!-- section: note.browser_took_over -->
The person took the browser over and has handed it back; nothing you asked for was done. The page may have changed — here it is as it stands now. Go on from here.

<!-- browser_run_fast's notes (browser/fast/run.ts). note.fast_resume follows every note that stops
     short of done. -->
<!-- section: note.fast_resume -->
Do that one step with the browser_* tools, then call browser_run_fast again with the same goal.

<!-- section: note.fast_interrupted -->
The seat was taken or the run stopped; no further step ran.

<!-- section: note.fast_no_decision -->
The classifier gave no usable decision: ${error}.

<!-- section: note.fast_tiebreak_failed -->
The tiebreak gave no usable answer: ${error}.

<!-- section: note.fast_undecided -->
The classifier could not choose between ${contest}; a tiebreak did not settle it either (${probability}).

<!-- section: note.fast_done -->
The classifier saw every requirement of the goal visibly satisfied.

<!-- section: note.fast_blocked -->
The classifier found no supported operation that makes progress.

<!-- After note.fast_blocked and note.fast_resume. -->
<!-- section: note.fast_blocked_ask -->
If the page itself is the obstacle, ask the person.

<!-- section: note.fast_unknown_action -->
Decision named an action the page did not offer.

<!-- section: note.fast_needs_value -->
The field "${label}" needs a value the goal does not contain. Supply it in the goal and call browser_run_fast again, or ask the person.

<!-- section: note.fast_step_failed -->
Step failed: ${error}.

<!-- section: note.fast_stuck -->
The last ${count} steps changed nothing on the page.

<!-- section: note.fast_budget -->
Stopped at the ${max}-step budget for one call. Check the page, then call browser_run_fast again with the remaining goal.

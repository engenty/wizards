import { SURFACE_GUIDE } from "@engenty-wizards/shared/surface";
import { WIZARD_SCHEMA_URL } from "@engenty-wizards/shared/wizard-package";
import { sandboxGuideLine } from "../sandbox/index.js";
import { EXAMPLE_WIZARD } from "./example.js";

/**
 * How a wizard is written down and what makes a good one. The studio's architect and the MCP
 * tools hand the same text to whichever model authors the wizard.
 */
export const SCHEMA_DOC = `
type Wizard = {
  version: 1
  title: string                 // short, what the end user gets ("Rechnung erstellen")
  description: string           // one sentence
  avatar: "round"|"drop"|"dome"|"flame"|"oval"|"bean"|"pebble"|"sprout"|"tower"|"wedge"  // the engenty mascot shown to end users
  intro?: string                // one friendly sentence above the first page
  lang?: string                 // two-letter code of the language the wizard's texts are in ("en", "de", "it", "fr") — ALWAYS set it to the language you write them in
  lists?: List[]                // tabular data the wizard KEEPS between runs — separately for each person who runs it, or for all with "shared"
  connections?: Connection[]    // accounts the PERSON connects during a run (their mailbox); kept for their next run
  steps: Step[]                 // run top to bottom; the LAST step is always a "result"
}

type List = {
  id, title, description?,
  key?: columnId                // rows are matched on this column: saving a row with a known key updates that row
  shared?: true                 // ONE list for every run (leads, sign-ups, bookings, a log) instead of one per person.
                                //   The person running the wizard never sees it: no list field, review or deliverable of it;
                                //   the admin sees and edits it in the studio under Space → Data
  check?: { file?: columnId, status?: columnId }
                                // a review that shows the list lets the person go through it ROW BY ROW on a split screen:
                                //   "file" = a text column holding the path of a kept file (PDF, photo), previewed beside the row;
                                //   "status" = a select column whose options are the answer buttons (the FIRST option = not looked at yet)
  columns: Column[]             // { id (lowercase_slug), name (shown to the person), type, format?, required? }
}
//   type "text":    format? { style: "single"|"multiline" }
//   type "number":  format  { style: "integer"|"decimal"|"percent"|"currency", currency?: "EUR" }   // currency only with style "currency"
//   type "date":    format  { kind: "date"|"datetime" }          // values are YYYY-MM-DD
//   type "select":  format  { options: { id, label }[], allowCustom: boolean }
//   type "boolean"

type Connection =
  | { id, kind: "mail", title?, description? }
      // the person picks how to connect (Gmail, Outlook, or any mailbox over IMAP); steps only ever READ it
  | { id, connector: connectorId, actions?: actionId[], policy?: { [actionId]: "allow"|"ask" }, title?, description? }
      // connector = a service the wizard works in for the person: a built-in one (Gmail, Google Drive, Calendar and
      //   Contacts, Outlook, OneDrive, Slack, GitHub, HubSpot, S3) or one imported into the project from the
      //   integrations registry. The person connects their own account (OAuth or API key) on a page.
      //   kind "mail" reads any mailbox the same way and keeps attachments as files; use the gmail / outlook
      //   connectors only for what it cannot do (drafts, sending, labels, calendar).
      // A step that lists the connection gets the connector's actions as tools named <toolPrefix>_<actionId>.
      //   actions: exactly the actions the wizard may use. Default: only those marked "read".
      //   policy: "allow" = runs without asking, "ask" = the person confirms each call first.
      //           Default: read → allow, write → ask. Deleting always asks. Set "allow" for an action marked
      //           "write" that in truth only looks something up (MCP servers often leave the mark out).

// Every step: { id (camelCase, unique), title, description?, next?: Branch[] }
// Branch = { when: Condition | Condition[], goto: stepId | "end", max? }
//        | { ask: "a statement about the run", goto: stepId | "end", max? }
//        | { goto: stepId | "end" }   // otherwise: where the run goes when no other branch holds (one per step)
//   ask: a decision reads the person's answers and what the steps made so far and takes the branch when the
//   statement is true ("The person wants a refund, not an exchange"). All ask branches of a step are decided
//   together in one cheap call, after no "when" branch matched; if none clearly holds the next step follows.
//   Use ask where a rule on one field cannot say it; never one decision step per branch.
//   max: how often the branch may be taken in one run. A branch BACK to an earlier step is a loop ("improve until
//   the check passes": a decision step branches back to the writing step) — give it max (at most 10 without);
//   the step that runs again sees what it made last time.
// Condition = { field, op: "equals"|"notEquals"|"in"|"notEmpty"|"empty"|"gt"|"lt"|"contains", value? }
//   field is a page field id, an output field of this or an earlier agent step as "steps.<stepId>.<fieldId>",
//   or how many rows a stored list has as "lists.<listId>.count"
//   gt / lt compare numbers (value is a number); contains looks into a multiselect, a list output or a text;
//   in takes a list of values. A list of conditions holds when every one holds.
//   first matching branch wins, otherwise the step's "otherwise" branch, else the next step in the list.
//   A step only some runs take sits right after the step that branches to it; that step's otherwise branch
//   leads every other run past it, and the step itself goes on as the next in the list.

type PageStep = { type: "page", fields: Field[] (1–5 per page), groups?: { id, instructions, optional? }[], cta?: string }
// Decided fields: a field with ask: "statement" is shown when a decision finds the statement true of the run;
//   fields with group: groupId are alternatives of which the decision shows one ("How should we reach the person?"),
//   or none when the group is optional. Decided once as the run reaches the page. Such a page has up to 12 fields
//   and shows at most 5. Use them where the earlier answers decide which question makes sense and no single field
//   rule can say it; "when" stays the first choice.
type Field = {
  id (camelCase, unique across the WHOLE wizard), label, kind, required?, placeholder?, help?,
  options?: string[]            // select / multiselect / slot
  default?: string|number|boolean|string[]
  columns?: { id, label, kind: "text"|"number"|"money" }[]   // items only; row amount = product of number/money columns
  vat?: { rate?: number, field?: fieldId }                    // items only; VAT % fixed or read from a field
  currency?: "EUR"|...                                        // items only
  multiple?: boolean            // image / file: several files, in the order the person puts them (they can drag them)
  min?: number, max?: number    // image / file with multiple: how many files at least / at most (up to 30). Set max wherever
                                //   every file costs something later (a video clip per photo)
  camera?: boolean              // file: also offer the camera, for papers the person has not scanned (image always offers it)
  video?: boolean               // file: the camera also records a short clip (up to 30 s); the clip is a file like any other
  listen?: boolean              // file: a recording (video/audio) is listened to before the next step: {{field.speech}} gives what is
                                //   said piece by piece between pauses, with exact times "[12.40–15.10] text" — to cut slips and pauses
  scan?: boolean                // text: a "scan" button fills it from a QR code or barcode (serial number, ticket, article number)
  connection?: connectionId     // kind "connection": the page shows "connect your account"; with required the person must connect
  list?: listId                 // kind "list": the page shows that stored list for the person to check, correct and extend
  prefill?: "steps.<id>.<key>"  // what the field starts with, from an earlier step. An "items" field takes a table whose
                                //   columns are exactly its column ids — the step proposes the positions, the person corrects them
  when?: Condition | Condition[] // the field is shown only while this holds: it reads another field of the SAME page (decided as
                                //   the person types) or anything known before the page (an earlier answer, steps.<id>.<field>).
                                //   A hidden field is not required and not kept; its {{template}} is empty.
  optionsFrom?: "steps.<id>.<key>" | "steps.<id>.<key>.<column>" | "lists.<id>.<column>"
                                // select / multiselect / slot: the choices come from earlier data — a "list" output, one column of a
                                //   "table" output, or a column of a stored list. "options" stand in while that data is empty.
  cards?: { label, value?, image?, subtitle?, meta?, link? }
                                // select / multiselect with optionsFrom "steps.<id>.<key>" naming a TABLE output: every row is a
                                //   choice drawn as a card. Each entry names a column of that table: label (the title), value (what the
                                //   answer holds, default the label — an id column when there is one), image (a URL or asset id),
                                //   subtitle, meta (a price), link (a page "Details" opens). Products, places, candidates to pick.
}
// kinds: text textarea number select multiselect date email url toggle color image file items connection list
//        location audio signature slot
//   location:  where the person is — the phone's position on a tap (with its accuracy), or an address they type.
//              {{field}} → "Herrengasse 16, 8010 Graz (47.07071, 15.43950, ±12 m)" · {{field.lat}} {{field.lng}}
//              {{field.accuracy}} (metres) · {{field.label}} (the address line) · {{field.map}} (a map link).
//              A typed address has no lat/lng. Widgets take the numbers: data { lat: "place.lat", lng: "place.lng" }.
//   audio:     a voice note recorded on the page (up to 5 minutes). It is written down before the next step runs:
//              {{field}} is what the person said, as text. {{field.seconds}} is its length.
//   signature: drawn with the finger — a picture (dark ink, clear ground). A document step can place it:
//              {{field}} → asset://ID, used as <img src="asset://ID">.
//   slot:      the person picks one appointment time, shown by day. Options are ISO 8601 date-times with their offset
//              ("2026-10-12T09:00:00+02:00"), nearly always from optionsFrom; {{field}} is the chosen one, as offered.
//              Booking: agent step "free" with call { tool: "appointments.availability", input: { duration_minutes: 30, days: 14 } }
//              and output { format: "json", fields: [{ id: "slots", kind: "table", columns: ["start","end","label"] }] };
//              then a page { kind: "slot", optionsFrom: "steps.free.slots.start" }; then an agent step with appointments.book.

type AgentStep = {
  type: "agent"
  instructions: string          // the task, with {{templates}} ("" with call)
  call?: { tool: "<plugin>.<tool>", input: { … } }
                                // NO MODEL: one plugin tool called once with this input; its answer IS the json output
                                //   (fields name the keys later steps read). Use it where a model would only fetch and copy
                                //   data (free appointment times) — it answers in a second instead of half a minute.
                                //   String inputs are templates; a filled-in whole number or true/false is passed as one.
  tools: ("web_search"|"web_fetch"|"browser"|"sandbox"|"image"|"http"|"pages"|"code")[]
  mcp?: string[]                // ids of the project's MCP servers this step may use
  connections?: string[]        // ids of wizard connections this step may read (mail → mail_search, mail_read, mail_save)
  output: { format: "text"|"markdown"|"json", fields?: { id, kind: "text"|"number"|"list"|"table"|"yesno"|"choice"|"score", description, columns?: string[], options?: string[] }[], schema?: Schema, surface?: SurfaceComponent[] | true }
                                // "score" answers its description on the scale in options, lowest first ("low", "medium", "high")
                                // fields: one level of keys (the short form). schema: nested data, below. One of the two, not both.
  each?: "steps.<id>.<key>" | "lists.<id>"
                                // ONE RUN PER ENTRY (at most 20): the rows of a table output, the entries of a list output, or the
                                //   rows of a stored list; the instructions read {{item.<column>}}, {{index}}, {{count}}. The output is
                                //   one table, steps.<id>.rows: the entry's columns plus the step's output fields, a row per entry.
                                // a table with columns gives rows as objects with exactly those keys — what widgets read
                                // "yesno" answers the question in its description with true/false; "choice" picks one of its options
  model?: "classifier"|"standard"|"high"|"highest"  // the kind of model, see "Models"; default "high"
  effort?: "low"|"medium"|"high"                    // how hard it should think; leave out unless it matters
  working?: string              // shown while it runs ("Recherchiert im Web …")
}
// Every agent step also has, without listing them: list_read / list_write (the wizard's lists), files_list,
//   read_document (PDF, scans and photos, Word, Excel, CSV, saved mails) and scan_documents (invoice / receipt fields, many at once)
//   — on an installed client only where there is something to read: tools or connections, uploads, lists or kept files;
//   and where the space has Knowledge: project_search (a question, "where" on its typed categories, hits checked for relevance),
//   project_list (by categories), page_read / table_read / project_document (an item whole, by its path).
// "pages" brings: page_read / page_write — Markdown pages of the space the wizard keeps for every run (notes, a log
//   that grows with append), shown to the admin under Space → Data; page_read also reads Knowledge by path.
// "code" brings: execute_typescript — the model writes one program that calls the step's other tools (not the browser) as
//   functions: loops, Promise.all, filtering, sums; only its answer reaches the model. For many calls of one kind (fetch 30
//   pages, read every row of a list, search a mailbox month by month). It needs other tools to call; a change the person
//   must allow first is never made from a program.
// "browser" brings: browser_open/read/click/type/select/scroll/press/back/wait, browser_screenshot (the model looks at the page),
//   browser_run_fast (a decision model clicks through a page's mechanical part, where one is reached),
//   browser_request_credentials (the PERSON types a login into the page — the model never sees it; sign-ins can be remembered),
//   browser_request_user (the person solves a captcha or "continue with Google" in the live page; they can also take the browser over any time),
//   browser_download (keeps a file from a signed-in site).
//   It clicks cookie banners away by itself with the least consent (only necessary / reject all) —
//   no need to say so in the instructions.

type SurfaceStep = {
  type: "surface"
  components: SurfaceComponent[]  // a view from the surface catalog (below), written once; every run brings new data
  data: { [key]: "fieldId" | "steps.<id>" | "steps.<id>.<key>" | "lists.<id>" | "brand.name" | "today" }
                                // what the components read by path: {"path": "/<key>/..."}
  // or instead of components — pieces a decision picks per run (no chart when there is nothing to chart):
  candidates?: { id, description, components: SurfaceComponent[] (the first has the piece's id), group?, required? }[]
  groups?: { id, instructions, optional? }[]
}
// SCHEMA (json only): nested data — lists of entries that hold lists of their own (days with meals, recipes with
//   ingredients and steps). Its root is { kind: "object", label, fields: { <key>: Field } }; a Field is
//     { kind: "text", label, description?, long?: true }           long: paragraphs, not a line
//     { kind: "number", label, description?, unit?: "Min" }
//     { kind: "yesno", label, description?, yes?: "da", no?: "einkaufen" }   (yes/no: the words people read)
//     { kind: "choice", label, description?, options: string[] }
//     { kind: "ref", label, description?, to: "<top-level list key>" }   the id of an entry of that list; its entries
//                                                                          need { id: { kind: "text" } }
//     { kind: "list", label, description?, of: Field-without-list | { kind: "object", label, fields: { … } } }
//   Labels are in the wizard's language: column heads, part titles, "add <label>" in the admin's editor. Description:
//   what the model is to put there. Objects nest at most 4 deep (the root counted), at most 100 keys in all.
//   The model gets it as a strict JSON Schema: every key is always filled.
//   DESIGN THE VIEW FIRST, then the schema it needs: write output.surface (Tabs, Card, Fold, Group, Chips, Checklist,
//   Steps, Link, Callout …) for what the person should see, then give the schema exactly the lists and keys that
//   view binds — nothing it does not show or a later step does not read. One step returns the whole tree.
//   Paths: {"path": "/recipes"} from the data; inside a repeated entry "title" or "meals" reads the entry; a Link's
//   view reads the entry it opens. The view is checked against the schema.
//   Later steps read top-level keys ({{steps.id.key}}, optionsFrom, each, conditions); a list of entries is a table
//   there ("steps.id.recipes.title"). Downloads: xlsx one sheet per top-level list, csv the first list of flat
//   entries, md and pdf the whole tree.
//   Example (Kühlschrank-Koch): { kind: "object", label: "Menüplan", fields: {
//     summary: { kind: "text", label: "Zusammenfassung", long: true },
//     days: { kind: "list", label: "Tage", of: { kind: "object", label: "Tag", fields: {
//       label: { kind: "text", label: "Tag" }, theme: { kind: "text", label: "Motto" },
//       meals: { kind: "list", label: "Mahlzeiten", of: { kind: "object", label: "Mahlzeit", fields: {
//         slot: { kind: "choice", label: "Mahlzeit", options: ["Frühstück", "Mittag", "Abend"] },
//         recipe_id: { kind: "ref", label: "Rezept", to: "recipes" } } } } } } },
//     recipes: { kind: "list", label: "Rezepte", of: { kind: "object", label: "Rezept", fields: {
//       id: { kind: "text", label: "Kennung" }, title: { kind: "text", label: "Titel" },
//       time_minutes: { kind: "number", label: "Zeit", unit: "Min" },
//       steps: { kind: "list", label: "Zubereitung", of: { kind: "object", label: "Schritt", fields: {
//         text: { kind: "text", label: "Schritt", long: true }, minutes: { kind: "number", label: "Dauer", unit: "Min" } } } } } } } } }
//   with a view: Tabs over a Grid of day Cards (each meal a Link to its recipe) and a Grid of recipe Links whose
//   view is a Card, a Fold of ingredients and the Steps.
// A SURFACE is a native view in the runner — facts, a list of results, key figures, a chart — themed, on phones, free per run.
//   Prefer it to a widget for such views; a widget is for what the catalog cannot show (a map, an animation).
//   An agent step with output.format "json" can also carry such a view of its own result: output.surface: [components],
//   written once and bound to its fields or schema by path ({"path": "/<key>"}; a step with "each": "/rows"). Prefer it to
//   output.surface: true, which has a model compose a new view on every run.
//   Reviews and the result show a step's view instead of its plain table.
type GenerateStep = {
  type: "generate"
  asset: "image"|"video"|"voice"|"document"|"dashboard"
  prompt: string                // the brief, with {{templates}}; for "voice" the exact text that is read aloud
  options?: { aspectRatio?: "1:1"|"16:9"|"9:16"|"4:5"|"3:2"|"2:3", duration?: 4–10 (video seconds; 4, 6 or 8 are safe),
              resolution?: "720p"|"480p",   // video: 720p by default and at most; 480p for drafts and many clips
              style?: string,   // image/video: the look · voice: how to speak ("ruhig, warm"; may name a field: "{{voiceStyle}}")
              template?: "invoice"|"offer"|"briefing"|"letter"|"report"|"free" }   // template for documents
  referenceImage?: fieldId | stepId   // the image the image/video starts from: an image field, or an earlier step that made images
  each?: fieldId | stepId | "steps.<id>.<key>"
                                // image/video: ONE RESULT PER ENTRY (at most 8) — per upload of an image field (multiple), per image
                                //   of an earlier step, or per row of an agent step's table. The prompt reads the row as
                                //   {{item.<column>}} (plus {{index}}, {{count}}); referenceImage gives entry n its n-th image.
                                //   With each the prompt goes to the model AS WRITTEN (no rewriting step): let the agent step
                                //   that makes the table write complete visual descriptions.
                                //   In a review the person can make single results again.
  working?: string
}

type WidgetStep = {
  type: "widget"
  entry: string                 // workspace path of the widget's HTML, e.g. "weather/index.html"
  data: { [key]: string }       // what the widget gets as wizard.data: key → fieldId | steps.stepId | steps.stepId.key | brand.name | facts.key | today
  sample?: string               // workspace path of example data (same shape as data) for previews
  layout?: "fixed"|"page"       // fixed (default): drawn at size and scaled to the page — maps, charts, films.
                                //   page: part of the run page, as wide as it and as tall as its content, never scaled —
                                //   a result people scroll and use (a cook mode, a configurator, a planner)
  size?: { width, height }      // design size in px, default 1280×720 (9:16 → 1080×1920); exports render at it
  video?: boolean               // a FILM: the timeline is rendered to an MP4 WITH SOUND when the step runs; the person sees and
                                //   downloads that video. data may then name generate steps: "steps.<id>" of an image / video / voice
                                //   step arrives as a URL (a list of URLs for a step with "each").
                                //   "steps.<agentStepId>.assets" gives the pictures an agent step kept (browser screenshots
                                //   with save, export_file, generate_image) as { assetId: URL }; the step's JSON names them by id.
  working?: string
}
// an interactive HTML app written ONCE into the workspace; every run only brings new data (no model call, no cost)

type FilmStep = {
  type: "film"
  brief: string                 // a template: what the film is — story, look, length, what to use. The kit carries the craft.
  skills?: string[]             // skill packages the client reads; default ["hyperframes"]. A workspace package: "skills/<name>" (has SKILL.md)
  kit?: string                  // workspace path of a STYLE KIT (.zip): a showreel made once with its rules (frame.md),
                                //   techniques (SHOWCASE.md), helpers and stills — the bar every film of this wizard reaches
  inputs?: { [name]: string }   // name (lowercase, -) → fieldId | steps.stepId: voice lines, pictures, uploads become files in
                                //   input/<name>/, text in input/<name>.md, json in input/<name>.json
  format?: "16:9" | "9:16" | "1:1"
  seconds?: number              // about how long
  model?: "standard" | "high"   // default standard
  effort?: Effort
  working?: string
}
// the AI client installed on the person's computer (Claude Code) writes the film as code in a folder of its own, with the
// skills, the kit, the space's brand (colours, logo, facts) and the inputs; it looks at its frames and fixes them; the
// runtime renders the MP4. It runs only where Claude Code is set up as the AI subscription — never on credits or in the
// cloud — and takes 10–40 minutes. Sounds come from a fixed catalog (CC0); voice comes from a generate voice step before it.

type ReviewStep = { type: "review", show: (stepId | "lists.<listId>")[], edit?: boolean, regenerate?: boolean }
// shows earlier outputs; the person accepts, edits text outputs (edit), or asks for a new version with a note (regenerate)
// a shown list is edited in place by the person

type ResultStep = { type: "result", message?: string, deliverables: { from: stepId | "lists.<listId>", label?, formats: Format[] }[] }
// formats per source: image→png · video→mp4 (several results: zip) · voice→mp3 · document→pdf docx html md png · dashboard→html pdf png
//                     film widget (video: true)→mp4 png · film→mp4
//                     widget→html png pdf mp4 json (mp4 only when the widget registers a timeline)
//                     agent text/markdown→md txt docx pdf html · agent json→json csv xlsx md (xlsx: one sheet per table)
//                     agent json with schema→json csv xlsx md pdf
//                     agent, any format→zip: the FILES the step kept with mail_save / browser_download
//                     lists.<id>→xlsx csv json md · zip (a list with check.file: the kept files its rows name, plus the list)

Templates (in instructions/prompt): {{fieldId}} · {{steps.stepId}} (whole output) · {{steps.stepId.key}} (json key)
  · {{itemsField}} (line items as a table WITH computed net/VAT/total) · {{itemsField.net|vat|gross}} · {{today}}
  · the project (its settings): {{brand.name}} {{brand.about}} {{brand.colors}} · {{facts.key}} (one fact: address, VAT ID, …) · {{facts}} (all facts)
    — every AI step already knows them, name one only where the text must carry it; agent steps also search the space's Knowledge
      and are told its categories: say in a step's instructions which category to filter by when the task names one
  · {{lists.listId}} (the stored list as a table, as it is when the step starts) · {{fileField}} (the names of the uploads, for read_document)
  · {{locationField}} {{locationField.lat|lng|accuracy|label|map}} · {{audioField}} (the transcript) · {{signatureField}} (asset://ID)
A template may only use fields asked and steps run EARLIER.`;

export const PRINCIPLES = `
How good wizards look:
- For non-technical end users. Plain words, friendly titles phrased as questions ("What is the post for?").
- The wizard speaks for itself: the first page invites in its own voice ("Show me your fridge."), every field's help says in
  one line why it is asked ("For the amounts in the recipes"), every step that takes a while has a "working" line that
  names what happens ("Looking into your fridge…"). Choices with up to five options are buttons, not a dropdown.
- The result is what people come for: design how it looks first, then the data it needs. A json step's result gets a view
  (output.surface, written once) or a widget; give its data the fields only the view uses — a yes/no that picks a colour
  ("in_fridge"), a key that groups ("category"), one human line (a summary, a tip, a theme per day) — and links instead of
  copies (a meal names its recipe's id). Things are cards, ordered work is Steps, things to get or do are a Checklist;
  never a table of things for a person — a table only for figures compared across columns (prices, dates).
- A page whose fields depend on an earlier answer uses "when" on its fields, never one copy of the page per answer and a branch to each copy. Choices that depend on what an earlier step found use "optionsFrom", never one page per possible result.
- Few pages, 1–5 fields each, one theme per page. Only ask what the result really needs; prefer selects with sensible defaults.
- Put a review step before anything expensive (video) and before anything written elsewhere (mail, CRM), so people can
  correct or regenerate. A result people can simply make again needs no review before it.
- Money/totals: use an "items" field with vat — the runner computes totals; documents must use {{items}} verbatim. Never let a model compute totals.
- Facts from the web need an agent step with web_search + web_fetch BEFORE writing; documents then cite those notes.
- Live data with a free public JSON API (weather and wind: api.open-meteo.com; sunrise/sunset is in it too) → an agent step with the http tool and model "standard" that calls the API and returns json. Far cheaper and more exact than web research; use web research only when no API exists.
- Writing into other systems (CRM, database, spreadsheet, website): an agent step with the matching mcp server, http, or browser tool, preceded by a review step.
${sandboxGuideLine()}
- Remembering between runs ("merke dir", "führe eine Liste"): declare a list and let an agent step save into it with list_write; a later run reads it as {{lists.id}} or list_read. Give it a key column so known rows are updated, not duplicated. Never make the person re-upload last time's result.
- Collecting from everyone who runs the wizard (requests, leads, sign-ups, feedback): a list with "shared": true, saved with list_write. It is the admin's, under Space → Data; never show one person's rows to another. Longer text for every run (a running summary, a log): the "pages" tool.
- The person's mail: one connection of kind "mail", a page field of kind "connection" early in the wizard, and the agent step lists it in "connections". Do not ask for the provider or the address in other fields — the connect field does that.
- Working in a service for the person (read their Notion, create an issue, look up a customer): import the service as a connector, declare a connection with "connector", put a page field of kind "connection" before the step, and list the connection in the step's "connections". Prefer a connector over the browser whenever the service has one.
- Logins on websites: never ask for passwords in page fields. An agent step with the browser tool asks the person at the moment it meets the login (browser_request_credentials); write that into its instructions, and that it must go on without the site when the person skips.
- Most people open a wizard on their phone. Keep pages short, and let the phone do the typing: photos with an "image" field (multiple) instead of descriptions, the place with a "location" field instead of an address form, what happened as an "audio" field instead of a long textarea (keep an optional textarea beside it), a sign-off as a "signature" field, a serial or ticket number as a "text" field with scan. Typical: damage report, handover protocol, site inspection, delivery note.
- How it runs: the first message may name the channels ("Läuft als: …" / "Runs as: …"); they are set already, never ask about them. A call, an SMS or WhatsApp asks by voice or text only: where one of them is named, keep each answer to text, a choice, a number or a date, and leave photos, files, signatures and maps to pages that only the browser shows (a call hands over a link by SMS).
- Photos in documents: a document step can place the photos of an earlier "image" field and a "signature" (it gets them as asset:// images); say in its prompt where they go.
- Pictures from the web (a listing's photos, a product shot an agent found): a document's <img src="https://…"> and image URLs in a widget's data (keys like image, photo, thumbnail, or a URL ending in .jpg/.png/.webp) are fetched once when the step runs and kept with the run — up to 40 per step. The page itself loads nothing from the network, so a URL left as is stays blank.
- Looking at photos: an agent step whose instructions name an image field ({{photos}}) gets up to 8 of its photos attached and sees them itself, in the person's order — do not tell it to call read_document for them. Photos in a "file" field, PDFs and scans are read with read_document / scan_documents.
- Papers and scans: a "file" field with multiple and camera. Agent steps read uploads with read_document; for invoices and receipts scan_documents returns the fields (vendor, number, date, totals, currency) exactly as printed.
- Collecting documents (invoices from mail or portals): the step keeps each file with mail_save / browser_download under a dated path ("invoices/2026-09/2026-09-03_Notion_INV-123.pdf"); its deliverable offers "zip". Split a big job into steps (mail, then statements, then portals) — one step manages about 60 tool calls.
- Going through documents one by one (receipts against payments): never one model step per document. One step reads them in batches (scan_documents takes 30 at once) and writes rows into a list with "check"; the review shows that list split-screen — the person answers each row beside its file, without any model call.
- Video that convinces is built in stages, each with its own review: idea and script (agent, json with a table of shots) → one still per shot (generate image with "each", starting from the person's product photo) → one clip per still (generate video with "each" and referenceImage = the stills step) → a voice-over (generate voice) → a film widget (video: true) that cuts clips, captions, voice and a closing card with the call to action. The starters "facebook-video-ad" and "property-film" carry such a widget (film/film.js) to copy. Offer a cheaper path without clips: the film animates the stills.
- Motion-graphics films (explainers, product spots, shorts) are a "film" step after the preparation, each with a review:
  research and script (agent, high) → the voice-over (one generate voice step for the whole script; the film step finds the
  word timings itself) → film (inputs: the voice, pictures, the script). The look comes from a style kit in the workspace (kit), so the film step stays on "standard".
- Prices come from a file the admin keeps in the workspace (a CSV price list): the agent step looks them up with read_workspace_file and proposes positions as a table; the next page shows them in an "items" field with "prefill" for the person to correct; the runner computes the totals.
- AI media is marked for you (EU AI Act, Art. 50): images, clips, voice-overs and films carry the marking in their file metadata, and the pages lay the EU's "AI" label over them. Never ask an image step to draw such a label into the picture. A film is different — it leaves the page as a video file, so its widget shows the EU label in the picture: wizard.ai tells a widget whether the run's media in its data is "generated" or "edited" (film/film.js draws the matching icon).
- Every step a person sees later (review/result) must come from an earlier step id.
- Write all wizard texts in the admin's language.`;

export const WIDGET_GUIDE = `
Widgets — when to use: the result must look the same every run, animate, or be explored (a map with
animated arrows, a timeline with a scrubber, a dashboard with filters, a configurator). Documents and
one-off pages stay "generate" steps. A widget is code in the wizard's WORKSPACE (files), written once:
- Files: "<widget>/index.html" (+ optional app.js, style.css), libraries under "lib/", reference data
  (GeoJSON shapes, station lists, price lists) as JSON/CSV files, and "<widget>/sample.json" with
  example data in exactly the shape of the step's data.
- Its data usually comes from an agent step with output.format "json"; give its table fields fixed
  "columns" so rows have known keys, and write sample.json in that exact shape.
- NO NETWORK when it runs: no CDN, no fetch, no external fonts or images — everything is inlined.
  Put libraries into the workspace (cdnjs.cloudflare.com, cdn.jsdelivr.net) and include them with
  <script src="lib/name.min.js">. Fetch reference data ONCE now (e.g. lake outlines
  from nominatim.openstreetmap.org/search?q=…&format=json&polygon_geojson=1&polygon_threshold=0.0005)
  and save it as a workspace file.
- Runtime, window.wizard: data · brand {name, accent, logo, colors [{name, value}], facts {key: value}, theme} · ai "generated"|"edited"|null · mode "view"|"export" · file(path) ·
  json(path) · url(path) (data URL for images/fonts) · ready() · timeline({ duration, seek, poster }) ·
  state (what the person did last time, kept with the run) · save(state) (keep ticks, an open tab, a step reached: small JSON) ·
  share(text) (the device's share sheet).
- layout "page": let the document grow with its content (no height: 100vh, no fixed body height) and lay out for phones
  first; the page sets the frame's height from it. Keep what the person does with wizard.save and start from wizard.state.
- Animation: call wizard.timeline({ duration: seconds, seek: t => draw(t) }) and drive your own
  play/pause and <input type=range> scrubber from it. seek(t) must draw time t synchronously — the MP4
  export steps through it frame by frame. In mode "export" hide all controls and do not autoplay.
- A film (step.video): seek(t) may return a promise that resolves once the frame is drawn (set a clip's
  currentTime, wait for "seeked", draw it to a canvas). Name the sound in the timeline:
  audio: [{ src, start, duration?, from?, volume? }] with the URLs from wizard.data (the voice-over, the
  clips themselves for their own sound; up to 48 tracks). "from" is the second of the source a track
  plays from — a recording cut into pieces names one track per piece. Clips and images of the run
  arrive as URLs, not inlined.
- Call wizard.ready() once the first frame is drawn. Lay out for the step's size and scale to fit
  the window on every "resize" event — the window can be 0×0 when your script first runs.
- Plain HTML/CSS/JS, SVG or canvas. Take the look from wizard.brand.theme: accent for actions, second for meaning (done,
  there, a tip), background for the ground, display for headings, body for text (system fonts behind them); dark: a dark
  ground. Cards for things, generous spacing, legible labels; no table of things.
- After writing, ALWAYS run check_widget, read its errors and look at the screenshot; fix until clean.`;

export interface GuideServer {
  id: string;
  name: string;
}

export interface GuideConnector {
  id: string;
  name: string;
  toolPrefix: string;
  /** Whether people can connect an account on this server right now. */
  usable: boolean;
  actions: { id: string; group: string }[];
}

export function connectorsLine(connectors: GuideConnector[]): string {
  const lines = connectors.map((c) => {
    const actions = c.actions
      .slice(0, 40)
      .map((a) => `${a.id}${a.group === "read" ? "" : ` (${a.group})`}`)
      .join(", ");
    const more = c.actions.length > 40 ? `, … ${c.actions.length - 40} more (list_connectors)` : "";
    const state = c.usable
      ? ""
      : " — NOT SET UP on this server: tell the admin before you build on it";
    return `- ${c.id} — ${c.name}${state}, tools ${c.toolPrefix}_*: ${actions || "actions appear once an account is connected"}${more}`;
  });
  return `Connectors a wizard of this project can use (built in, or imported from the integrations registry; find more with find_connectors + import_connector):\n${lines.join("\n")}`;
}

export interface GuideTool {
  /** `<plugin>.<tool>`, as a step lists it. */
  id: string;
  description: string;
}

/** The tools this app's plugins add; nothing where there are none. */
export function pluginToolsLine(tools: GuideTool[]): string {
  if (!tools.length) {
    return "";
  }
  const lines = tools.map((t) => `- ${t.id} — ${t.description}`);
  return `\n\nTools of this app's plugins. An agent step lists one in "tools" by its full id, next to the built-in ones; a wizard that uses one runs only where that plugin is installed:\n${lines.join("\n")}`;
}

export function mcpServersLine(mcp: GuideServer[]): string {
  return `Project MCP servers available to agent steps: ${mcp.length ? mcp.map((m) => `${m.id} (${m.name})`).join(", ") : "none — if the admin wants to write into an external system that needs one, build the step with http or browser, and tell them they can connect a server in the project settings"}.`;
}

export function exampleWizard(): string {
  return JSON.stringify(EXAMPLE_WIZARD, null, 2);
}

/** The guide an MCP client reads before it writes a wizard. */
export function authoringGuide(
  mcp: GuideServer[],
  connectors: GuideConnector[] = [],
  pluginTools: GuideTool[] = [],
): string {
  return `engenty wizards: a wizard is a page-by-page flow an end user walks through on a shared link. Pages ask questions; AI steps research, write, draw images, render video, build documents and dashboards, or write into other systems. You author the wizard as JSON; the person who asked you is the ADMIN, the people who later open the link are END USERS.

${SCHEMA_DOC}
${PRINCIPLES}
${WIDGET_GUIDE}

Surface catalog (for surface steps and output.surface):
${SURFACE_GUIDE}

${mcpServersLine(mcp)}

${connectorsLine(connectors)}${pluginToolsLine(pluginTools)}

Models: a step names the KIND of model it needs, never a model. Pick the cheapest class that does the job:
- "classifier": routing, yes/no, picking from options, pulling a few values out of text.
  A DECISION is a "classifier" step with no tools whose json output has only "yesno", "choice" and "score" fields: it is answered in one fast, very cheap call. A branch can also read how sure it is: "steps.<id>.<field>.p" is the probability of its answer (a number 0–1; 1 or 0 where no decision model is set up), e.g. { field: "steps.check.urgent.p", op: "gt", value: 0.8 }. Write the question into each field's description, give the step everything it must judge in its instructions via {{templates}}, and branch on the answer with "next" (e.g. { when: { field: "steps.check.refund", op: "equals", value: true }, goto: "refund" }).
- "standard": short copy, calling an API, reformatting, simple summaries.
- "high": research with tools, long documents, reasoning over many sources (the default).
- "highest": hard reasoning or writing code; rare in a run, several times the cost of "high".
"effort" ("low" | "medium" | "high") tells the model how hard to think where it can be told; leave it out unless a step is clearly trivial ("low") or clearly hard ("high").
A generate step for a document or dashboard takes the same "model" (default "high"). Image and video steps use the image and video class; which model serves a class is set by the platform, not in the wizard.

Editing:
- Every write returns the new "revision" and the validator's "issues". Pass the revision you last saw as "baseRevision"; on revision_conflict re-read with get_wizard and apply your change again.
- Prefer edit_wizard with small ops; use replace_wizard only to rewrite most of the wizard.
- A draft may have issues while you work. publish_wizard and start_test_run refuse until there are none.
- Put a short "note" on writes (what changed, in the admin's language) — the admin sees it in the studio.
- A wizard written as a file instead (a .wizard package, its wizard.json, or the JSON alone) follows the JSON Schema at ${WIZARD_SCHEMA_URL}; \`wizards validate <path>\` checks it as the import does.
- Test runs and published runs spend the admin's credits (research ~150, video ~250, short copy with an image ~15).

Example of a complete wizard:
\`\`\`json
${exampleWizard()}
\`\`\``;
}

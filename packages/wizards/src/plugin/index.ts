import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { z } from "zod";

/**
 * What the runtime hands a plugin's server half. A plugin is a file or a folder the runtime finds
 * at start (docs/content/dev/plugins); its default export is a factory that registers what it adds. The
 * runtime remembers every registration under the plugin's id and takes it back when the plugin
 * unloads or reloads.
 */

/** `engenty.plugin.json`, the file an engenty module has too. A plugin of one file has none. */
export interface PluginManifest {
  /** Lower case, digits and `-`: part of the plugin's addresses and of its tools' ids. */
  id: string;
  name: string;
  version: string;
  description?: string;
  kind?: string;
  provides?: string[];
  requires?: string[];
  /** The server half, from the plugin's folder. Default `src/plugin.ts`. */
  server?: string;
  /** The studio half, built. Default `dist/client.js`. */
  studio?: string;
  /** The studio half's styles, built. Default `dist/client.css`. */
  styles?: string;
  /**
   * The plugin's feature switches, by short name; each is known as `<id>.<name>` everywhere
   * (`wizards features`, the `.features` file, the Manage-App's admin). `true`/`false` is the
   * default alone; a `plan` switch is one a plan includes.
   */
  features?: Record<
    string,
    boolean | { kind?: "release" | "plan"; default?: boolean; label?: string; hint?: string }
  >;
}

export type PluginRole = "owner" | "admin" | "member";

/** The signed-in person a request acts as. */
export interface PluginPrincipal {
  id: string;
  tenantId: string;
  role: PluginRole;
  name: string;
  email: string;
}

export interface PluginRequest {
  /** The web request as it came in. */
  request: Request;
  /** The address below the plugin's own: `/` for `/api/studio/plugins/<id>/`. */
  path: string;
  /** What `:name` parts of the route's path matched. */
  params: Record<string, string>;
  query: URLSearchParams;
  user: PluginPrincipal;
  /** The body as JSON; an empty body is `{}`. */
  json<T = unknown>(): Promise<T>;
}

export type PluginHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A route below `/api/studio/plugins/<id>`: signed in, inside the person's tenant. */
export interface PluginRoute {
  method: PluginHttpMethod;
  /** `/`, `/items`, `/items/:id`. */
  path: string;
  /** `admin`: owners and admins only. Default: every member. */
  role?: "member" | "admin";
  /**
   * Answers with a `Response`, or with a value that goes out as JSON. An error thrown with a
   * `status` and a `code` goes out as `{ error, code }` with that status.
   */
  handler(request: PluginRequest): unknown | Promise<unknown>;
}

/** A space: what all its wizards share. The runtime's own tables call it a project. */
export interface PluginSpace {
  id: string;
  /** What the studio's switcher calls it. */
  name: string;
}

/** What a tool knows about the step that calls it. */
export interface PluginStepContext {
  runId: string;
  stepId: string;
  tenantId: string;
  /** The space of the step's wizard. */
  space: PluginSpace;
  /** The same as `space`, by its older name. */
  project: { id: string; name: string };
  wizard: { id: string; title: string };
  /** "test": a test run from the studio. Keep what it makes apart from what real runs make. */
  mode: "test" | "live";
  /** Aborted when the run is cancelled. */
  signal: AbortSignal;
  /** Tells the person what the step is doing right now. */
  emit(message: string): Promise<void>;
}

/** A tool for agent steps. A step allowlists it as `<plugin id>.<name>`. */
export interface PluginTool<S extends z.ZodType = z.ZodType> {
  /** Lower case, digits and `_`. */
  name: string;
  /** What the editor calls it; default: the name. */
  title?: string;
  /** For the model: what the tool does and when to use it. */
  description: string;
  inputSchema: S;
  execute(input: z.infer<S>, ctx: PluginStepContext): unknown | Promise<unknown>;
}

/** A run that reached its end. It fires again when a finished run is redone and ends again. */
export interface PluginRunEvent {
  run: {
    id: string;
    wizardId: string;
    mode: "test" | "live";
    status: "done" | "failed" | "cancelled";
  };
  wizard: { id: string; title: string; projectId: string };
  /** What the person answered, by field id. */
  values: Record<string, unknown>;
}

/** A space was made, changed (title, about, colours, facts, systems) or deleted. */
export interface PluginSpaceEvent {
  space: { id: string };
}

/** A file of a space: read and ready (a document is in the index then), or removed. */
export interface PluginSpaceFileEvent {
  space: { id: string };
  file: { id: string; name: string; kind: "logo" | "asset" | "document" | "pattern"; mime: string };
}

export interface PluginEvents {
  "run.done": PluginRunEvent;
  "run.failed": PluginRunEvent;
  "run.cancelled": PluginRunEvent;
  "space.created": PluginSpaceEvent;
  "space.updated": PluginSpaceEvent;
  "space.deleted": PluginSpaceEvent;
  "space.file.ready": PluginSpaceFileEvent;
  "space.file.removed": PluginSpaceFileEvent;
}

/** The tenant's database. A plugin reads and writes its own tables with it. */
export type PluginDb = LibSQLDatabase<Record<string, never>>;

/** What a plugin asks a model. */
export interface PluginGenerateRequest<T = undefined> {
  prompt: string;
  system?: string;
  /** The answer as an object of this shape instead of text. */
  schema?: z.ZodType<T>;
  /** The tenant's model class. Default `standard`; `classifier` is the fast, cheap one. */
  model?: "classifier" | "standard" | "high" | "highest";
  maxOutputTokens?: number;
  /** Default: two minutes. */
  signal?: AbortSignal;
  /**
   * Pictures (PNG, JPEG, WebP, GIF) and PDFs the model looks at with the prompt: a screenshot to
   * build after, a brand guide. Text files go into the prompt as text.
   */
  files?: { data: Uint8Array; mediaType: string; name?: string }[];
}

export interface PluginGenerateResult<T = undefined> {
  text: string;
  /** Set when the request had a `schema`. */
  object: T;
}

/** What a plugin adds to the AI steps of a space's wizards: every agent step, unless `steps` says. */
export interface PluginSpaceContext {
  /**
   * A block of the step's instructions, after what the space says about itself and its
   * documents: what the plugin holds for the space, and which of its tools read it. Empty or
   * null: the step gets neither the block nor the tools.
   */
  block(space: PluginSpace): string | null | Promise<string | null>;
  /** Tools the step gets with the block, named `<plugin>_<name>` for the model. */
  tools?: PluginTool[];
  /**
   * The steps that get it: `agent` (default), `html` — the steps that write a document or a
   * dashboard as HTML, which get the block without the tools.
   */
  steps?: ("agent" | "html")[];
}

/** A space's brand as the studio's Info & brand has it: what a plugin draws or writes in its look. */
export interface PluginBrand {
  /** The title end users see. */
  name: string;
  /** The colours in order: the first is the accent. */
  colors: { name: string; value: string }[];
  /** The fonts, each with what it is for ("Headings") and the weights the brand uses. */
  fonts: { family: string; role: string; weights: number[] }[];
}

/** A text a plugin puts into a space's search index, beside the space's documents. */
export interface PluginIndexEntry {
  /** The space's id. */
  space: string;
  /** The plugin's own name for it: putting the same key again replaces what it had. */
  key: string;
  /** What a hit is called: a page's title, a question. */
  title: string;
  /** Markdown, cut into passages like a document's text. */
  text: string;
  /** Where the studio shows it, an address of the studio: `/space#faq`. */
  link?: string;
}

export interface PluginIndex {
  /** Puts the entry in; `project_search` finds it from then on. */
  put(entry: PluginIndexEntry): Promise<void>;
  /** Takes one key out, or without a key every entry of the plugin in the space. */
  remove(space: string, key?: string): Promise<void>;
}

/** A category of a space: a typed property set on pages, tables, rows and files of Knowledge. */
export interface PluginCategory {
  name: string;
  type: "choice" | "date" | "number" | "text" | "boolean";
  /** A number's unit: `h`, `€`, `kg`. */
  unit?: string;
  /** A choice: several values per item. */
  multiple?: boolean;
  /** A choice whose values are ranked, in the order of `values`. */
  ordered?: boolean;
  /** Where its values come from, in a few words: "Kopfzeile", "Filter der Website". */
  hint?: string;
  /** A choice's values, known beforehand: a site's filter. Others are added as items bring them. */
  values?: string[];
  /** A column of a table the plugin wrote (by the table's key) whose cells are its values. */
  column?: { table: string; column: string };
}

/**
 * Categories of an item, by their names: a choice's value (or a list of them), a day as
 * `YYYY-MM-DD`, a number, a short text, true or false. Null takes one off.
 */
export type PluginCategoryValues = Record<
  string,
  string | number | boolean | (string | number)[] | null
>;

/** The original an item was read from, kept as the evidence beside it. */
export interface PluginOriginal {
  name: string;
  mime: string;
  data: Uint8Array;
}

/** `written`: the plugin's version stands. `kept`: a person changed it, the plugin no longer writes it. */
export type PluginItemState = "written" | "kept";

export interface PluginPageInput {
  space: string;
  /** The plugin's own name for the page: the same key again rewrites it, never doubles it. */
  key: string;
  /** What the person knows its source as: "Tagesberichte". */
  label?: string;
  title: string;
  markdown: string;
  /** The key of a page the plugin wrote before, to stand under it as a sub-page. */
  parent?: string;
  position?: number;
  original?: PluginOriginal;
  categories?: PluginCategoryValues;
  /** A model fills the space's categories the page did not get from `categories`. */
  fill?: boolean;
  /** Why a person should look at it ("hardly readable"); shown in Knowledge. */
  review?: string | null;
}

export interface PluginTableInput {
  space: string;
  key: string;
  label?: string;
  title: string;
  /** Typed columns, as a table of the space has them (`text`, `number`, `date`, `select` …). */
  columns: unknown[];
  /** Cells by column id. They replace the rows the key had. */
  rows: Record<string, unknown>[];
  /** `faq`: a question and its answer per row. */
  format?: "faq";
  original?: PluginOriginal;
  categories?: PluginCategoryValues;
  review?: string | null;
}

export interface PluginFileInput {
  space: string;
  key: string;
  label?: string;
  name: string;
  mime: string;
  data: Uint8Array;
  /** What it is, in a sentence: a file that is no page is found by its name and this. */
  description?: string;
  /** What a step reads of it, when there is text. */
  text?: string;
  categories?: PluginCategoryValues;
}

export interface PluginDocumentInput {
  space: string;
  key: string;
  label?: string;
  name: string;
  mime: string;
  data: Uint8Array;
  /** Set on what it becomes: its first page, its first table, or the file. */
  categories?: PluginCategoryValues;
  /** A model fills the space's categories it did not get from `categories`. */
  fill?: boolean;
}

/** What a document became: pages and tables (the first is the one it is found as), or a file. */
export interface PluginDocumentResult {
  /** The file, kept as the original. */
  id: string;
  path: string;
  state: PluginItemState;
  items: { kind: "page" | "table"; id: string; path: string; title: string }[];
  /** Why a person should look at it: hardly readable, or not readable at all. */
  review: string | null;
}

/** A page of a space, as a plugin reads it. */
export interface PluginSpacePage {
  id: string;
  title: string;
  /** How a step names it: `pages/…`. */
  path: string;
  parentId: string | null;
  markdown: string;
  /** The plugin that wrote it, or null for one made in the studio or uploaded. */
  origin: string | null;
  originKey: string | null;
  updatedAt: string;
}

/** A file of a space, as a plugin reads it. */
export interface PluginSpaceFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "logo" | "asset" | "document" | "pattern";
  updatedAt: string;
}

/** What a plugin wrote into a space. */
export interface PluginSpaceItem {
  key: string;
  kind: "page" | "table" | "file";
  id: string;
  title: string;
  /** How a step names it: `pages/…`, `tables/…`, `files/…`. */
  path: string;
  state: PluginItemState;
  review: string | null;
  updatedAt: string;
}

/**
 * Knowledge of a space, written by a plugin: pages, tables and files under keys of its own, with
 * their categories. Every write is indexed: `project_search` finds it a moment later.
 */
export interface PluginSpaceData {
  /**
   * Adds categories to the space, or values to ones it has. `proposed`: shown to the person to
   * confirm, never filled before; a later call without it takes them.
   */
  putCategories(input: {
    space: string;
    categories: PluginCategory[];
    proposed?: boolean;
  }): Promise<void>;
  putPage(input: PluginPageInput): Promise<{ id: string; path: string; state: PluginItemState }>;
  putTable(input: PluginTableInput): Promise<{ id: string; path: string; state: PluginItemState }>;
  putFile(input: PluginFileInput): Promise<{ id: string; path: string }>;
  /**
   * A document read as an upload is: a page (sub-pages when it is long and has headings of its
   * own), a table per sheet of a workbook, or a file when nothing reads it. The document stays as
   * the original. The same key again reads it again, unless a person changed what it became.
   */
  putDocument(input: PluginDocumentInput): Promise<PluginDocumentResult>;
  /** Everything the plugin wrote into the space. */
  list(space: string): Promise<PluginSpaceItem[]>;
  /**
   * The space's own pages (not a wizard's), whoever wrote them, with their Markdown: for a
   * plugin that reads what the space knows. `parent`: only the pages under that page.
   */
  readPages(space: string, opts?: { parent?: string }): Promise<PluginSpacePage[]>;
  /** The space's files of a kind (`document` when left out), newest first. */
  files(
    space: string,
    kind?: "logo" | "asset" | "document" | "pattern",
  ): Promise<PluginSpaceFile[]>;
  /** One file of the space with its bytes: a price list someone dropped into Knowledge. */
  readFile(space: string, fileId: string): Promise<PluginSpaceFile & { data: Uint8Array }>;
  /** Takes out one key, or every item of the plugin in the space; what a person changed stays. */
  remove(space: string, key?: string): Promise<number>;
  /**
   * Writes the summary of values: of one, or of every value of a choice (or of every choice)
   * that has three items or more. Returns how many were written. Costs a model call each.
   */
  summarize(space: string, category?: string, value?: string): Promise<number>;
}

/** What a tool of the space assistant knows about the turn that calls it. */
export interface PluginAssistantContext {
  tenantId: string;
  space: PluginSpace;
  /** The person talking to the assistant. */
  userId: string;
  /** Aborted when the person leaves or stops the turn. */
  signal: AbortSignal;
  /** Tells the person what the assistant is doing right now: "Liest die Sitemap …". */
  emit(message: string): void;
  /** Say so when the tool changed what the space page shows: the page draws it again. */
  changed(): void;
}

/** A tool of the space assistant: the chat on the space page that fills the space in. */
export interface PluginAssistantTool<S extends z.ZodType = z.ZodType> {
  /** Lower case, digits and `_`. The model sees it as `<plugin>_<name>`. */
  name: string;
  /** For the model: what the tool does and when to use it. */
  description: string;
  inputSchema: S;
  /**
   * The result also goes to the chat, where the card the studio half registered for this tool
   * (`registerAssistantCard`) draws it. It is sent as it is: keep such a result small.
   */
  card?: boolean;
  execute(input: z.infer<S>, ctx: PluginAssistantContext): unknown | Promise<unknown>;
}

/** A page of the web, as `web.read` gives it. */
export interface PluginWebPage {
  /** Where it ended up, after redirects. */
  url: string;
  status: number;
  /** As the server sent them, for asking later whether the page changed. */
  etag: string | null;
  lastModified: string | null;
  title: string;
  description: string;
  /** The page's text as Markdown. */
  text: string;
  /** Every link of the page, absolute, each once. */
  links: { url: string; text: string }[];
  /**
   * The page's structured data: its `application/ld+json` blocks, parsed, a `@graph` spread
   * out. A shop's product page says title, price, availability and image here exactly.
   */
  jsonld: unknown[];
}

export interface PluginWeb {
  /**
   * `fetch`, behind the guard of the runtime's own requests: addresses of this machine and of
   * the local network are refused, after a redirect too.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /**
   * A page read the way the space assistant reads one: guarded as `fetch`, and drawn in a
   * browser when it has hardly any text without its scripts.
   */
  read(url: string, options?: { signal?: AbortSignal }): Promise<PluginWebPage>;
}

export interface PluginDocuments {
  /**
   * A file as Markdown: PDF and Word by their text, scans and photos by a vision model (paid
   * like every model call), spreadsheets as tables. Kept by content: the same bytes are read once.
   */
  parse(
    file: { data: Uint8Array; name: string; mime: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ markdown: string; pages: number | null }>;
}

/** One turn of a job `every` runs. */
export interface PluginTick {
  tenantId: string;
  /** When it ran for this tenant before; null the first time. */
  lastRun: Date | null;
  /** Aborted when the plugin unloads. */
  signal: AbortSignal;
}

/** What a public route's handler gets. Nobody is signed in. */
export interface PluginPublicRequest {
  request: Request;
  /** The address below the plugin's public one. */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /** The tenant whose address was called; the handler runs inside it. */
  tenantId: string;
  json<T = unknown>(): Promise<T>;
}

/**
 * A route anyone may call, below the address `publicUrl` gives: a CMS that says a page
 * changed, a service's webhook. Check a secret of your own in it, a token or a signature.
 */
export interface PluginPublicRoute {
  method: PluginHttpMethod;
  path: string;
  handler(request: PluginPublicRequest): unknown | Promise<unknown>;
}

/** What a shared route's handler gets: nobody is signed in, and no tenant yet. */
export interface PluginSharedRequest {
  request: Request;
  /** The address below the plugin's shared one. */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /**
   * Runs `work` inside the tenant whose public address has this ref (`server.publicRef()`),
   * when the tenant is active and has the plugin. Throws with the status `404` and the code
   * `not_found` otherwise.
   */
  inTenant<T>(ref: string, work: () => T | Promise<T>): Promise<T>;
}

/**
 * A route for every tenant at once, at the address `sharedUrl` gives: for a service that posts
 * to one webhook for all of them (one account of the runtime's, one app). The call names its
 * tenant only by what it carries – the ref of the tenant's address, handed to the service
 * before (`publicRef`) – so check the service's signature first, then `inTenant`.
 */
export interface PluginSharedRoute {
  method: PluginHttpMethod;
  path: string;
  handler(request: PluginSharedRequest): unknown | Promise<unknown>;
}

/** A kind of use of a number of the Manage-App's. */
export type PluginChannelKind = "sms" | "call" | "whatsapp";

/**
 * The numbers a Manage-App gives the tenant (docs/manage-contract.md): its own number for
 * texts and calls, asked for and assigned there, and the numbers every tenant shares.
 */
export interface PluginChannels {
  number: {
    /** With the country code: `+43…`. */
    number: string;
    /** ISO 3166, upper case: `AT`. */
    country: string;
    kinds: PluginChannelKind[];
    /** The provider's id of the number (Twilio's `PN…`); null when none was entered. */
    providerRef: string | null;
  } | null;
  /** The tenant's open request for its number; null for none. */
  request: { id: string; country: string; wish: string | null; createdAt: string } | null;
  shared: { number: string; country: string; kinds: PluginChannelKind[] }[];
  /** The tenant's plan has a number of its own; false on a plan without one (Free). */
  allowed: boolean;
}

/** An account a plugin connected for a space: a calendar, a mailbox. */
export interface PluginConnection {
  id: string;
  /** The space it was connected for. */
  space: string;
  /** The built-in connector behind it: `google-calendar`, `microsoft-outlook`. */
  connector: string;
  /** The account, as the provider names it: an e-mail address. */
  label: string;
  /** The actions it was connected for; the provider granted what they need. */
  actions: string[];
  createdAt: string;
}

/**
 * Accounts a plugin connects on its own, for a space rather than for a wizard's run: the
 * runtime's built-in connectors (Google, Microsoft, …), signed in with OAuth. The runtime keeps
 * the tokens sealed, refreshes them, and on a local install connects Google through the linked
 * account's Manage-App, as it does for wizards.
 */
/** A connector a plugin may connect: signed in with OAuth, or with keys the person types. */
export interface PluginConnectorOffer {
  id: string;
  name: string;
  auth: "oauth2" | "api_key";
  /** `api_key`: what to ask the person for, in this order. */
  fields?: {
    key: string;
    label: string;
    placeholder?: string;
    /** Default: true. */
    required?: boolean;
    /** A password field: never shown again. */
    secret?: boolean;
  }[];
}

export interface PluginConnections {
  /** Of these connector ids, the ones a person can connect on this runtime now, with their names. */
  available(connectors: string[]): Promise<PluginConnectorOffer[]>;
  /**
   * The provider's sign-in page of an `oauth2` connector. Open it in a window: when the person
   * is done, the window posts `{ type: "wizards:connected", ok }` to the studio and closes.
   * `actions` are the connector's actions the plugin will call; only the rights they need are
   * asked for. `lang` is the language the person reads; the page they come back to speaks it,
   * else their browser's.
   */
  start(input: {
    space: string;
    connector: string;
    actions: string[];
    lang?: "de" | "en";
  }): Promise<{ url: string }>;
  /**
   * Connects an `api_key` connector with the keys the person typed (`fields` of the offer, by
   * key). The connector tries them once first; keys it refuses throw an error with the status
   * `400` and the code `credentials`, whose message says what was wrong. The same account
   * connected again for the space replaces the first connection's keys and actions.
   */
  connect(input: {
    space: string;
    connector: string;
    actions: string[];
    credentials: Record<string, string>;
  }): Promise<PluginConnection>;
  /** What is connected for the space, the newest first. */
  list(space: string): Promise<PluginConnection[]>;
  /** One connection by its id, or null. */
  get(connectionId: string): Promise<PluginConnection | null>;
  /**
   * Runs one of the connector's actions with the connection's account. Throws when the action
   * is not one the connection was made for, or when the provider refuses (the account was
   * disconnected there: connect again).
   */
  call<T = unknown>(
    connectionId: string,
    action: string,
    input: Record<string, unknown>,
  ): Promise<T>;
  /** Forgets the connection and its tokens. */
  remove(connectionId: string): Promise<void>;
}

/**
 * A wizard a plugin brings as a template: offered beside the marketplace's starters when a
 * wizard is made, and to the assistant and AI apps as an example to copy.
 */
export interface PluginStarter {
  /** Lower case, digits and `-`; the starter is known as `<plugin id>.<id>`. */
  id: string;
  title: string;
  /** What it makes, in one or two sentences. */
  description: string;
  /** The language its texts are in. Default: English. */
  language?: "de" | "en";
  /** A complete wizard definition. Checked when it is registered. */
  definition: unknown;
  /** Workspace files it needs (widgets, sample data), by path. */
  files?: Record<string, string | Uint8Array>;
}

/**
 * What the space assistant is told when the admin talks to it from the plugin's own page (the
 * studio half's `studio.Assistant`): what the page holds now, so it can change it with the
 * plugin's assistant tools.
 */
export interface PluginAssistantPage {
  /** Text for the assistant: the state of the page, in a few lines. Cut at 8,000 characters. */
  block(space: PluginSpace): string | null | Promise<string | null>;
}

/** What a runner can take in and show; the runtime works out per wizard how far it gets. */
export interface PluginRunnerCapabilities {
  /** The field kinds the runner asks itself (`text`, `select`, `image`, …); the rest hand off. */
  input: string[];
  output: {
    /** What it shows as it is: `text`, `data`, `image`, `video`, `voice`, `document`, `dashboard`, `widget`, `film`, `surface`. */
    shows: string[];
    /** What it shows as a picture with a link to the real thing. Anything else is a link. */
    pictures: string[];
  };
  /** A sign-in is typed on a page the model never sees: only a browser can take it. */
  asks: ("confirm" | "login")[];
  review: ("accept" | "regenerate" | "edit")[];
  /** Stays through a step that takes minutes, with a note now and then. */
  waits: boolean;
  /** How a link to the run page reaches the person for what the runner cannot do itself. */
  handoff: ("screen" | "thread" | "sms" | "push")[];
}

/** What a page runner's handler gets: the wizard behind the address, nobody signed in. */
export interface PluginRunnerRequest {
  request: Request;
  tenantId: string;
  wizard: { id: string; token: string; title: string };
  /** The rest of the address below `/w/<token>/<runner>`. */
  path: string;
  query: URLSearchParams;
}

/**
 * Where a person reaches a wizard through a channel runner, as the share dialog shows it: the
 * number with the keyword that picks the wizard there, and the link that opens the channel with
 * the keyword written.
 */
export interface PluginRunnerAddress {
  /** The number people write to or call, with the country code: `+43660…`. */
  number?: string | null;
  /** The word that picks this wizard on that number. */
  keyword?: string | null;
  /** Opens the channel with the keyword written (`sms:…`, `https://wa.me/…`): copied, and as a QR code. */
  link?: string | null;
}

/** A runner's problem, with what the share dialog's row says about it. */
export interface PluginRunnerProblem {
  /** In the owner's words, as a text problem. */
  text: string;
  /**
   * `setup` (the default): something to set up, the row offers "Einrichten". `waiting`: set up
   * and waiting for someone else (a number asked for), nothing to do. `plan`: the tenant's plan
   * does not have it, the row offers the plans.
   */
  kind?: "setup" | "waiting" | "plan";
  /** What the row says instead of "Noch nicht eingerichtet": "Nummer angefragt", "Ab Pro". */
  note?: { de: string; en: string };
  /** `plan`: the plan that has it, for the row's button ("Pro ansehen"). */
  plan?: string;
}

/**
 * A runner: a door a wizard runs through, beside the built-in page and chat. A `page` runner is
 * served at `/w/<token>/<id>` for every wizard that switched it on; a `channel` runner has an
 * address of its own (a number, a bot) and drives runs from its webhooks.
 */
export interface PluginRunner {
  /** Lower case, digits and "-", at most 24 characters; the sub-path of the wizard's address. */
  id: string;
  label: { de: string; en: string };
  kind: "page" | "channel";
  capabilities: PluginRunnerCapabilities;
  /** A page runner: what its address answers with. */
  page?(request: PluginRunnerRequest): Response | Promise<Response>;
  /**
   * Why the runner cannot be used in the current tenant right now, in the owner's words ("Not
   * connected: Settings → WhatsApp"), or null when it can. Asked inside the tenant whenever the
   * studio lists the runners; a runner with a problem cannot be switched on. A text is something
   * to set up: the share dialog's row says so and offers "Einrichten". An object says what kind of
   * problem it is.
   */
  problem?(): string | PluginRunnerProblem | null | Promise<string | PluginRunnerProblem | null>;
  /**
   * A channel runner: where a person reaches the wizard, for the share dialog; null while the
   * runner is not set up. Asked inside the tenant for each wizard that has the runner on.
   */
  address?(wizard: {
    id: string;
    title: string;
    token: string;
  }): PluginRunnerAddress | null | Promise<PluginRunnerAddress | null>;
}

/**
 * How a run answers a review: accept it, with edits where the review allows (a text, or the
 * data of a json step), or ask for one of the shown steps again.
 */
export type PluginReviewAction =
  | { type: "accept"; edits?: Record<string, string | Record<string, unknown>> }
  | { type: "regenerate"; target: string; note: string; items?: number[] };

/** A field of the page a run waits for, as the report lists it. */
export interface PluginRunField {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  options?: string[];
  placeholder?: string;
  help?: string;
  default?: unknown;
  value?: unknown;
  columns?: unknown;
  /** An image or file field that takes several: the value is then a list of asset ids. */
  multiple?: boolean;
  /** Answerable as a value; false for what only the person's device gives (a file, a signature). */
  inChat: boolean;
  /** A condition on earlier answers; the field is asked only while it holds. */
  when?: unknown;
  /** Whether `when` holds on what is known now. */
  shown?: boolean;
}

/** What a run waits for: a page, a review, or a question of a running step. */
export type PluginRunWaiting =
  | {
      page: string;
      title: string;
      known: Record<string, unknown>;
      fields: PluginRunField[];
      hint: string;
    }
  | { review: string; title: string; show: string[]; editable: boolean; hint: string }
  | {
      ask: string;
      kind: "confirm";
      reason: string;
      service: string;
      action: string;
      input: string;
      hint: string;
    }
  | { ask: string; kind: "login"; reason: string; site: string; hint: string };

/** What a run did so far, as the MCP tools report it: outputs with signed links, cost, errors. */
export interface PluginRunReport {
  runId: string;
  wizardId: string;
  mode: "test" | "live";
  /** The wizard's language: what to say to the person in. */
  lang: "de" | "en";
  status: "waiting_input" | "running" | "done" | "failed" | "cancelled";
  step: { id: string; type: string; title: string } | null;
  passed: string[];
  waitingFor?: PluginRunWaiting;
  error: string | null;
  credits: number;
  events: { step: string | null; type: string; message: string }[];
  outputs: {
    stepId: string;
    title: string;
    text?: string;
    json?: string;
    assets: { name: string; mime: string; url: string }[];
    /** Signed download links by format, valid one hour. */
    downloads: Record<string, string>;
    /** A signed link to the output as a PNG, for a door that shows a picture with a link; null where it is one already, or has no picture. */
    picture: string | null;
  }[];
  /** The run page, for what the door cannot do itself. */
  browserUrl: string | null;
}

/** Something changed on a run: a new event, or its status (`event` null). */
export interface PluginRunSignal {
  runId: string;
  event: {
    id: number;
    at: string;
    stepId: string | null;
    type: "step_started" | "step_done" | "tool" | "info" | "error";
    message: string;
    /** The same as the run page shows it, in both languages; null for free text. */
    note: { code: string; text: { de: string; en: string } } | null;
  } | null;
}

/**
 * Runs a plugin's door drives: the functions behind the MCP tools, on the public path. The
 * plugin keeps who the person is; the runtime keeps only a hash of it as the run's visitor, so
 * what the wizard remembers is theirs on the run page too.
 */
export interface PluginRuns {
  /** Starts a live run of a published wizard, by its share token or id, for a person of the door. */
  start(
    input: ({ token: string } | { wizardId: string }) & {
      person: { channel: string; id: string };
      /** Answers for the first page; what did not fit comes back as `refused`. */
      answers?: Record<string, unknown>;
      /** Kept on the run; default: the plugin's id. */
      runner?: string;
    },
  ): Promise<{
    runId: string;
    /** Opens the run's own routes (`/api/runs/<id>?rt=…`); `handoffUrl` carries it. */
    ticket: string;
    refused: { field: string; message: string }[] | null;
  }>;
  /**
   * The run as it stands, after waiting up to `waitSeconds` (at most 45) while it works. A door
   * that asks a page one field at a time passes what it has as `draft`: the fields' `shown` is
   * then worked out on those answers, so a field whose condition depends on another of the same
   * page comes and goes as it would on the screen.
   */
  report(
    runId: string,
    options?: { waitSeconds?: number; draft?: Record<string, unknown> },
  ): Promise<PluginRunReport>;
  /** The published wizards of the tenant that switched the given runner on: what the door offers. */
  wizards(
    runner: string,
  ): Promise<{ wizardId: string; token: string; title: string; lang: "de" | "en" }[]>;
  answerPage(runId: string, stepId: string, values: Record<string, unknown>): Promise<void>;
  review(runId: string, stepId: string, action: PluginReviewAction): Promise<void>;
  /** A running step asks before it changes something in a connected account: allow it once, or skip. */
  answerAsk(runId: string, askId: string, answer: "allow" | "skip"): Promise<void>;
  control(runId: string, action: "back" | "retry" | "cancel"): Promise<void>;
  /** Hears every change of the run until the function returned is called. */
  subscribe(runId: string, listener: (signal: PluginRunSignal) => void): () => void;
  /** The run page with the run's ticket: the link to send the person for what the door cannot do. */
  handoffUrl(runId: string): Promise<string>;
  /** A file of the person (a photo sent in the thread): the asset id goes into a field with `answerPage`. */
  upload(
    runId: string,
    file: { data: Uint8Array | ArrayBuffer; mime: string; name: string },
  ): Promise<{ assetId: string }>;
  /** What is said in a recording of the person (a voice message), written down and charged to the run. */
  transcribe(
    runId: string,
    file: { data: Uint8Array | ArrayBuffer; mime: string },
  ): Promise<{ text: string }>;
}

/** Keys a plugin keeps: sealed with the runtime's own key, as it seals a connection's tokens. */
export interface PluginSecrets {
  /** Anything that is JSON, as a sealed string to keep in a table. */
  seal(value: unknown): string;
  /** What was sealed, or null when it was sealed on another install. */
  unseal<T = unknown>(sealed: string): T | null;
}

export interface PluginServerApi {
  registerHttpRoute(route: PluginRoute): void;
  /** A runner the owner can switch on per wizard. */
  registerRunner(runner: PluginRunner): void;
  /** Runs the plugin's door drives. */
  runs: PluginRuns;
  /**
   * The tenant's realtime speech model, for a live conversation a plugin drives itself (a call):
   * the key and the model the chat's live voice runs on. Throws with the status `503` and the
   * code `no_model` while none is set up.
   */
  speech: {
    conversation(): Promise<{ provider: "openai"; apiKey: string; model: string }>;
  };
  registerTool<S extends z.ZodType>(tool: PluginTool<S>): void;
  /** A block and tools for every agent step of a space's wizards, or a block for its HTML steps. */
  registerSpaceContext(context: PluginSpaceContext): void;
  /** A tool of the space assistant. */
  registerAssistantTool<S extends z.ZodType>(tool: PluginAssistantTool<S>): void;
  /** What the space assistant is told when the admin talks to it from the plugin's own page. */
  registerAssistantContext(context: PluginAssistantPage): void;
  registerPublicRoute(route: PluginPublicRoute): void;
  /** The full address of a public route for the current tenant: what to hand to whoever calls it. */
  publicUrl(path: string): Promise<string>;
  /** The part of `publicUrl` that names the current tenant: what a shared route's call carries. */
  publicRef(): Promise<string>;
  /** A route for every tenant at once (one webhook of a service for all of them). */
  registerSharedRoute(route: PluginSharedRoute): void;
  /**
   * Keys the plugin holds across the runtime's tenants, each for one tenant at a time: a keyword
   * on a number every tenant shares, who writes to it, a number a tenant connected. A shared
   * route finds its tenant with `holder` and enters it with `inTenant`. Keys are the plugin's
   * own, 1 to 200 characters.
   */
  claims: {
    /** Takes `key` for the current tenant; false when another tenant holds it. */
    take(key: string): Promise<boolean>;
    /** Gives `key` to the current tenant, whoever held it. */
    put(key: string): Promise<void>;
    /** Gives up the current tenant's `key`; nothing when another tenant holds it. */
    drop(key: string): Promise<void>;
    /** The ref of the tenant that holds `key` (for `inTenant`), or null. Asked outside a tenant too. */
    holder(key: string): Promise<string | null>;
    /** Whether the current tenant holds `key`. */
    mine(key: string): Promise<boolean>;
  };
  /** The full address of a shared route, the same for every tenant. */
  sharedUrl(path: string): string;
  /**
   * The numbers the Manage-App gives the current tenant. `get` is null on a runtime without a
   * Manage-App; there `request` and `withdraw` throw, and `book` books nothing.
   */
  channels: {
    /** Kept for a minute. */
    get(): Promise<PluginChannels | null>;
    /**
     * A person of the tenant asks for its number. Throws with the status `403` and the code
     * `plan` on a plan without one, `409` and `has_number` when the tenant has it; asking again
     * answers the open request.
     */
    request(input: {
      userId: string;
      /** ISO 3166: `AT`. */
      country: string;
      wish?: string | null;
      lang: "de" | "en";
    }): Promise<NonNullable<PluginChannels["request"]>>;
    /** Takes the open request back; false when there was none. */
    withdraw(): Promise<boolean>;
    /**
     * Books what the tenant's number carried, at the Manage-App's prices: `sms` by segment
     * (sent or received), `call` by started minute, `whatsapp` by message sent. The same `key`
     * twice books once.
     */
    book(input: {
      kind: "sms" | "call" | "whatsapp";
      quantity: number;
      key: string;
      runId?: string | null;
    }): Promise<{ credits: number }>;
  };
  /**
   * Runs `handler` for every tenant that has the plugin, at most once per `everyMs` (a minute
   * at least), inside that tenant. When it ran is kept: a restart does not start the count again,
   * and a runtime that was off runs it once when it starts, not once per turn it missed. One turn
   * per tenant at a time; a turn that throws counts as run.
   */
  every(name: string, everyMs: number, handler: (tick: PluginTick) => void | Promise<void>): void;
  /** The space's search index, which `project_search` asks. */
  index: PluginIndex;
  /** Knowledge of a space: pages, tables and files the plugin writes, with their categories. */
  spaceData: PluginSpaceData;
  spaces: {
    /** The space's brand, of the current tenant; null for a space it does not have. */
    brand(space: string): Promise<PluginBrand | null>;
  };
  web: PluginWeb;
  documents: PluginDocuments;
  /**
   * A folder of `.sql` files with the plugin's own tables. Every tenant database gets each file
   * once, in the order of the file names. Nothing is taken back when the plugin unloads.
   */
  registerMigrations(folder: string): void;
  /** The listener runs inside the tenant the event belongs to. */
  on<E extends keyof PluginEvents>(
    event: E,
    listener: (payload: PluginEvents[E]) => void | Promise<void>,
  ): void;
  /** The database of the tenant the current request, step or event belongs to. */
  getTenantDb(): PluginDb;
  /**
   * Asks a model of the current tenant, on the models its studio is set up with; the call is
   * paid like any other of the tenant's. When no model is set up it throws an error with the
   * status 503 and the code `no_model`, which a route passes on as it is.
   */
  generate<T = undefined>(request: PluginGenerateRequest<T>): Promise<PluginGenerateResult<T>>;
  /** Accounts the plugin connects for a space, through the runtime's built-in connectors. */
  connections: PluginConnections;
  /** Keys of the plugin's own (a shop's API tokens), sealed before they go into a table. */
  secrets: PluginSecrets;
  /** A wizard the plugin brings as a template. */
  registerStarter(starter: PluginStarter): void;
  /** Something to undo when the plugin unloads or reloads: a timer, a socket. */
  onUnload(dispose: () => void | Promise<void>): void;
}

export interface WizardsPluginApi {
  plugin: PluginManifest;
  server: PluginServerApi;
  /** Settings of this install: its `.env`. Name them after the plugin (`NOTIFY_URL`). */
  config: { get(key: string): string | undefined };
  /**
   * Feature switches of the tenant at hand: the runtime's own (`teamPlans`) and the plugin's,
   * named with its id (`contacts.leadScoring`), as the Manage-App, the install's `.features`
   * file or `FEATURES` set them. Off unless something turned a switch on.
   */
  features: {
    /** `has("leadScoring")` asks for the plugin's own switch; a full name (`teamPlans`) for any. */
    has(name: string): Promise<boolean>;
    all(): Promise<Record<string, boolean>>;
  };
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  /** A file of the plugin as an absolute path. */
  resolvePath(relative: string): string;
}

export type WizardsPluginFactory = (wizards: WizardsPluginApi) => void | Promise<void>;

/** Types the factory; it does nothing else. */
export function definePlugin(factory: WizardsPluginFactory): WizardsPluginFactory {
  return factory;
}

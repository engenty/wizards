/**
 * The broker's first part (docs/plans/broker.md, "First: RWX"): the words of a space's rules.
 * A rule says who (a subject) may read, write or execute what (a resource); each flag is allow,
 * deny or unset. Unset means deny, and a deny wins over every allow from any other rule. The
 * runtime decides in apps/runtime/src/broker/rwx.ts; the studio draws the rows as sentences in
 * Fähigkeiten › Rechte (apps/web/src/studio/capabilities/rights-words.ts).
 */

/**
 * Who a rule is about. A role's id is `member`, `admin` or `owner`; a guest has none. `agent`: an
 * AI working for a person (a Work chat, a client's chat, Claude or Codex through MCP), with no id.
 */
export const RWX_SUBJECT_KINDS = [
  "guest",
  "person",
  "role",
  "goose",
  "wizard",
  "plugin",
  "agent",
] as const;
export type RwxSubjectKind = (typeof RWX_SUBJECT_KINDS)[number];

/** What a rule is about. The id is the resource's, or `*` for every resource of the kind. */
export const RWX_RESOURCE_KINDS = [
  "document",
  "table",
  "page",
  "connection",
  "mail",
  "host",
  "sandbox",
  "wizard",
  "skill",
  "setup",
  "mount",
  "data",
] as const;
export type RwxResourceKind = (typeof RWX_RESOURCE_KINDS)[number];

export const RWX_PERMS = ["r", "w", "x"] as const;
export type RwxPerm = (typeof RWX_PERMS)[number];

export const RWX_FLAGS = ["allow", "deny"] as const;
export type RwxFlag = (typeof RWX_FLAGS)[number];

/** `client`: a client of the organization, who sees only their client spaces (docs/plans/client-spaces.md). */
export const RWX_ROLES = ["member", "admin", "owner", "client"] as const;

/**
 * Who besides the space's admins sees a mounted folder of Dateien or a folder of Wissen: its team
 * (the members, who work in Work), the organization's clients (docs/plans/client-spaces.md), and
 * guests: people on a shared link or a published page, without an account. Admins always see it.
 */
export const AUDIENCES = ["team", "clients", "guests"] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * What an AI working for a person may do with a mounted folder: nothing, read it, or also write
 * drafts of its files, which a person then publishes. Drafts only where the folder may be changed.
 */
export const AGENT_ACCESS = ["none", "read", "drafts"] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];

/** Every resource of a kind. */
export const RWX_ALL = "*";

export const RWX_LIMITS = {
  /** Rules one space may hold. */
  rules: 500,
  /** Characters of a subject's or resource's id. */
  id: 200,
};

/** A rule as an admin writes it. */
export interface RwxRuleInput {
  subjectKind: RwxSubjectKind;
  subjectId: string | null;
  resourceKind: RwxResourceKind;
  resourceId: string;
  r: RwxFlag | null;
  w: RwxFlag | null;
  x: RwxFlag | null;
}

/** A rule as the studio lists it. */
export interface RwxRule extends RwxRuleInput {
  id: string;
  /** A user's id, or `seed` for the rows every space starts with. */
  createdBy: string;
  createdAt: string;
}

const EVERY_READER = ["guest", "person", "role", "goose", "wizard", "plugin", "agent"] as const;
/** Every reader but a plugin, which reads pages and documents only (`spaceData`). */
const NO_PLUGIN = ["guest", "person", "role", "goose", "wizard", "agent"] as const;
/** Goose for a person: its own rows, the person's and their role's. */
const THROUGH_GOOSE = ["person", "role", "goose"] as const;
/** A person, or an AI working for one: a Work chat, a client's chat, an outside client. */
const A_PERSON = ["person", "role", "agent"] as const;
/** A run's step: who holds the run, a guest or a person, and the wizard it runs. */
const A_RUN = ["guest", "person", "role", "wizard"] as const;

/**
 * What the runtime asks today, and so all a rule can say: per kind of resource and permission, the
 * kinds of subject a reader asks it for. A rule outside this table would be stored and never
 * asked, so the runtime refuses it (apps/runtime/src/broker/rwx.ts `refusalOf`), and the studio
 * offers nothing else. A reader that starts asking adds its line here.
 *
 * - `document`, `page`, `table` · `r`: every reader of Knowledge (the studio's routes, a run's
 *   step, a Work chat, Goose, search, a share link, the client portal); a plugin reads pages and
 *   documents. A folder's rule is a rule on its page.
 * - `page` · `w`: Goose writing a page of Knowledge for its person (`write_knowledge_page`). Not
 *   for the role `client`, and neither is the setup: a client reaches no studio (`rwxAsked`).
 * - `wizard` · `r`, `x`: `wizard_list` and `wizard_run` for a person in a Work chat or through an
 *   outside client, and the client portal's list and start. A guest reaches a wizard by its link,
 *   and a person starting one in Work or the studio is not asked.
 * - `skill` · `r`: `skill_list`, `skill_load`, `skill_read` in a step, a Work chat, for Goose and
 *   outside clients. `x`: its scripts placed in a sandbox, which Goose has none of.
 * - `setup` · `w`: Goose's writes to the space's setup.
 * - `mount` · `r`: `readableMounts`; `w`: a draft and „Veröffentlichen“ (mounts/drafts.ts), which a
 *   wizard is refused before any rule is asked. Its rules are written by its form in Dateien alone.
 * - `data` · `r`, `w`: a wizard's own database (docs/plans/wizard-data.md), its id the wizard's:
 *   `data_query` and `data_exec` in a step, and a fixed step's statement, for the run's holder and
 *   its wizard. A guest's AI step reaches the person's database alone, whatever a rule says.
 * - `connection`, `mail`, `host`, `sandbox`: nothing. A connection has its own audience and rules
 *   (broker/call.ts), which decide mail too; a run's grant decides hosts; the sandbox is a step's.
 */
export const RWX_ASKED: Record<
  RwxResourceKind,
  Partial<Record<RwxPerm, readonly RwxSubjectKind[]>>
> = {
  document: { r: EVERY_READER },
  table: { r: NO_PLUGIN },
  page: { r: EVERY_READER, w: THROUGH_GOOSE },
  wizard: { r: A_PERSON, x: A_PERSON },
  skill: { r: NO_PLUGIN, x: ["guest", "person", "role", "wizard", "agent"] },
  setup: { w: THROUGH_GOOSE },
  mount: { r: NO_PLUGIN, w: A_PERSON },
  data: { r: A_RUN, w: A_RUN },
  connection: {},
  mail: {},
  host: {},
  sandbox: {},
};

/**
 * What only Goose asks. Goose works for the people in the studio, and a client of the
 * organization reaches no studio: for the role `client` this is asked by nobody.
 */
const GOOSE_ALONE: Partial<Record<RwxResourceKind, readonly RwxPerm[]>> = {
  page: ["w"],
  setup: ["w"],
};

/**
 * Whether a reader asks `perm` on a resource of `kind` for a subject of `subject`; `subjectId`
 * tells the roles apart, where it is known.
 */
export const rwxAsked = (
  subject: RwxSubjectKind,
  kind: RwxResourceKind,
  perm: RwxPerm,
  subjectId?: string | null,
): boolean =>
  (RWX_ASKED[kind][perm]?.includes(subject) ?? false) &&
  !(subject === "role" && subjectId === "client" && GOOSE_ALONE[kind]?.includes(perm));

/**
 * Where a rule is set, and so where it is changed: the start set every space has (a role's or the
 * guests' rule on every resource of a kind), „Wer sieht diesen Ordner“ on a page of Wissen, a
 * mount's form in Dateien, „Für Kund:innen sichtbar“, or Fähigkeiten › Rechte. It is read off the
 * rule: a place that shows a rule also replaces it, whoever wrote the row.
 */
export const RWX_ORIGINS = ["start", "folder", "mount", "clients", "rights"] as const;
export type RwxOrigin = (typeof RWX_ORIGINS)[number];

/** A rule as Fähigkeiten › Rechte lists it: where it is set, and what its ids are called. */
export interface RwxRuleView extends RwxRule {
  origin: RwxOrigin;
  /** The person's, wizard's or plugin's name; null for a role, guests and the AI in Work, and where it is gone. */
  subjectName: string | null;
  /** The resource's name; null for `*`, the setup, and where it is gone. */
  resourceName: string | null;
  /** A page that is a folder of Wissen. */
  folder?: boolean;
}

/** Whom „Was darf …?“ asks about for content. */
export const RWX_ASK_WHO = ["guest", "person", "goose", "agent", "wizard", "plugin"] as const;
export type RwxAskWho = (typeof RWX_ASK_WHO)[number];

/** What „Was darf …?“ asks about for content: the kinds decided by one rule lookup. */
export const RWX_ASK_KINDS = [
  "document",
  "page",
  "table",
  "wizard",
  "skill",
  "setup",
  "data",
] as const;
export type RwxAskKind = (typeof RWX_ASK_KINDS)[number];

/** The answer of „Was darf …?“ for content (`GET /api/studio/spaces/:id/rules/ask`). */
export interface RwxAnswer {
  ok: boolean;
  /** The rule that decided; none where no rule allows it, or the runtime itself reads (a plugin's job). */
  rule: RwxRuleView | null;
  /** Why, as the broker says it: the resource's kind and id, never its content. */
  reason: string;
}

/** Something a rule or the question can name. */
export interface RwxChoice {
  id: string;
  name: string;
}

/** What Rechte picks from (`GET /api/studio/spaces/:id/rules/choices`). */
export interface RwxChoices {
  people: { id: string; name: string; role: (typeof RWX_ROLES)[number] }[];
  wizards: RwxChoice[];
  plugins: RwxChoice[];
  documents: RwxChoice[];
  /** The pages of Wissen; `folder` for one that holds others and has no text. */
  pages: (RwxChoice & { folder: boolean })[];
  tables: RwxChoice[];
  skills: RwxChoice[];
}

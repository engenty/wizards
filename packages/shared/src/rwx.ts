/**
 * The broker's first part (docs/plans/broker.md, "First: RWX"): the words of a space's rules.
 * A rule says who (a subject) may read, write or execute what (a resource); each flag is allow,
 * deny or unset. Unset means deny, and a deny wins over every allow from any other rule. The
 * runtime decides in apps/runtime/src/broker/rwx.ts; the studio will draw the rows as sentences.
 */

/** Who a rule is about. A role's id is `member`, `admin` or `owner`; a guest has none. */
export const RWX_SUBJECT_KINDS = ["guest", "person", "role", "goose", "wizard", "plugin"] as const;
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
] as const;
export type RwxResourceKind = (typeof RWX_RESOURCE_KINDS)[number];

export const RWX_PERMS = ["r", "w", "x"] as const;
export type RwxPerm = (typeof RWX_PERMS)[number];

export const RWX_FLAGS = ["allow", "deny"] as const;
export type RwxFlag = (typeof RWX_FLAGS)[number];

export const RWX_ROLES = ["member", "admin", "owner"] as const;

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

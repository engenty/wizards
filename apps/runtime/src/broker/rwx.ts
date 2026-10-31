import { featureOn } from "@engenty/wizards-shared/features";
import { note, type RunNoteCode } from "@engenty/wizards-shared/run";
import {
  RWX_ALL,
  RWX_LIMITS,
  RWX_ROLES,
  type RwxPerm,
  type RwxResourceKind,
  type RwxRule,
  type RwxRuleInput,
  type RwxSubjectKind,
} from "@engenty/wizards-shared/rwx";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import type { RunHolder, RunRow, StepContext } from "../engine/types.js";
import { currentFeatures } from "../features.js";
import type { Role } from "../manage.js";
import { currentRole, isAdminRole, MEMBERS_EDIT_ONLY, roleOf } from "../services/access.js";
import { notFound, ServiceError } from "../services/errors.js";
import { ownedSpace } from "../services/spaces.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * The broker's first part (docs/plans/broker.md, "First: RWX"): one table of permissions per
 * space, `subject × resource × R W X`, behind the `broker` switch. A reader of a document, a
 * table or a page asks here with a *who* before it hands anything out, and search asks before it
 * ranks. Unset means deny; a deny wins over every allow; a call with no subject is refused. With
 * the switch off every answer is yes, and nothing here changes what the runtime does.
 *
 * Who asks: a guest (a visitor on a shared link), a person with their role, Goose for a person
 * (the person's own rules count too), a run (its holder and its wizard), a plugin. The rows are
 * written by the space's admins (routes/rules.ts); every space starts with the seed below, so
 * turning the switch on changes nothing until an admin writes a deny.
 */

export type Perm = RwxPerm;

export interface Subject {
  kind: RwxSubjectKind;
  /** `member`, `admin` or `owner` for a role; a user's, wizard's or plugin's id; null for a guest. */
  id: string | null;
}

export interface Resource {
  kind: RwxResourceKind;
  id: string;
  /**
   * The document a page or table was made from. Reading the page is reading the document, so the
   * document's rule counts as well.
   */
  fileId?: string | null;
}

export interface Decision {
  ok: boolean;
  /** The rule that decided, where one did. */
  rule?: string;
  /** Why, in a few words: the resource's kind and id at most, never its content. */
  reason: string;
  /** What was decided on: the resource asked about, or the document behind it. */
  of: Resource;
}

/** The resource kinds this runtime asks the broker about today; the others wait for their reader. */
export const ENFORCED: readonly RwxResourceKind[] = ["document", "table", "page"];

type Rule = typeof schema.rwxRule.$inferSelect;

export async function brokerOn(): Promise<boolean> {
  return featureOn(await currentFeatures(), "broker");
}

// --- who ------------------------------------------------------------------------------------

export const subjectsOfGuest = (): Subject[] => [{ kind: "guest", id: null }];

/** A signed-in person: their own rows, and their role's. */
export const subjectsOfPerson = (userId: string, role: Role): Subject[] => [
  { kind: "person", id: userId },
  { kind: "role", id: role },
];

/** Goose for a person: its own rows for them, and the person's. */
export const subjectsOfGoose = (userId: string, role: Role): Subject[] => [
  { kind: "goose", id: userId },
  ...subjectsOfPerson(userId, role),
];

export const subjectsOfHolder = (holder: RunHolder): Subject[] =>
  holder.kind === "guest" ? subjectsOfGuest() : subjectsOfPerson(holder.id, holder.role);

/** A run's step: who holds the run (a guest or a person), and the wizard it runs. */
export function subjectsOf(ctx: Pick<StepContext, "holder" | "store">): Subject[] {
  return [
    ...(ctx.holder ? subjectsOfHolder(ctx.holder) : []),
    { kind: "wizard", id: ctx.store.wizardId },
  ];
}

/** Who holds a run: the signed-in person with their role, else the visitor of the shared link. */
export async function runHolder(
  run: Pick<RunRow, "id" | "userId" | "visitorId">,
): Promise<RunHolder> {
  if (run.userId) {
    return { kind: "person", id: run.userId, role: await roleOf(run.userId) };
  }
  return { kind: "guest", id: run.visitorId ?? run.id };
}

// --- deciding --------------------------------------------------------------------------------

const about = (rule: Rule, subjects: Subject[]) =>
  subjects.some((s) => s.kind === rule.subjectKind && (s.id ?? null) === (rule.subjectId ?? null));

const names = (rule: Rule, resource: Resource) =>
  rule.resourceKind === resource.kind &&
  (rule.resourceId === RWX_ALL || rule.resourceId === resource.id);

/** One resource against the rules, without the document behind it. */
function decideOne(rules: Rule[], subjects: Subject[], resource: Resource, perm: Perm): Decision {
  const where = `${resource.kind} ${resource.id}`;
  const of = { kind: resource.kind, id: resource.id };
  const matching = rules.filter((r) => about(r, subjects) && names(r, resource));
  const deny = matching.find((r) => r[perm] === "deny");
  if (deny) {
    return { ok: false, rule: deny.id, reason: `${where}: denied`, of };
  }
  const allow = matching.find((r) => r[perm] === "allow");
  if (allow) {
    return { ok: true, rule: allow.id, reason: `${where}: allowed`, of };
  }
  return { ok: false, reason: `${where}: no rule`, of };
}

/** The decision from rules already loaded: deny wins, then any allow, else no rule. */
export function decideWith(
  rules: Rule[],
  subjects: Subject[],
  resource: Resource,
  perm: Perm,
): Decision {
  if (!subjects.length) {
    return {
      ok: false,
      reason: `${resource.kind} ${resource.id}: no subject`,
      of: { kind: resource.kind, id: resource.id },
    };
  }
  const own = decideOne(rules, subjects, resource, perm);
  if (!(own.ok && resource.fileId)) {
    return own;
  }
  const behind = decideOne(rules, subjects, { kind: "document", id: resource.fileId }, perm);
  return behind.ok ? own : behind;
}

/** The rules of a space, seeded first where it has none yet. */
async function rulesOf(spaceId: string): Promise<Rule[]> {
  const rows = await db.query.rwxRule.findMany({ where: eq(schema.rwxRule.spaceId, spaceId) });
  if (rows.length) {
    return rows;
  }
  await seedRwx(spaceId);
  return db.query.rwxRule.findMany({ where: eq(schema.rwxRule.spaceId, spaceId) });
}

/** Whether the subjects may do `perm` on the resource. With the switch off: yes. */
export async function decide(
  spaceId: string,
  subjects: Subject[],
  resource: Resource,
  perm: Perm,
): Promise<Decision> {
  if (!(await brokerOn())) {
    return { ok: true, reason: "off", of: { kind: resource.kind, id: resource.id } };
  }
  return decideWith(await rulesOf(spaceId), subjects, resource, perm);
}

const WHAT: Record<RwxResourceKind, RunNoteCode> = {
  document: "rwxDocument",
  table: "rwxTable",
  page: "rwxPage",
  connection: "rwxConnection",
  mail: "rwxMail",
  host: "rwxHost",
  sandbox: "rwxSandbox",
};
const VERB: Record<Perm, RunNoteCode> = { r: "rwxRead", w: "rwxWrite", x: "rwxRun" };

/** The refusal: *verboten*, the resource's kind and id, nothing of its content. */
export const forbidden = (resource: Resource, perm: Perm) =>
  new ServiceError(
    "forbidden",
    note("forbidden", { what: note(WHAT[resource.kind]), verb: note(VERB[perm]), id: resource.id }),
    { resource: resource.kind, id: resource.id },
  );

/** Refuses with 403 unless the subjects may do `perm` on the resource. */
export async function assertRwx(
  spaceId: string,
  subjects: Subject[],
  resource: Resource,
  perm: Perm,
): Promise<void> {
  const decision = await decide(spaceId, subjects, resource, perm);
  if (!decision.ok) {
    throw forbidden(decision.of, perm);
  }
}

/** The resources among `items` the subjects may read, by id. With the switch off: all of them. */
export async function readable(
  spaceId: string,
  subjects: Subject[],
  items: Resource[],
): Promise<Set<string>> {
  if (!(await brokerOn())) {
    return new Set(items.map((i) => i.id));
  }
  const rules = await rulesOf(spaceId);
  return new Set(items.filter((i) => decideWith(rules, subjects, i, "r").ok).map((i) => i.id));
}

/** The ids of `kind` among `ids` the subjects may read, in their order. */
export async function readableIds(
  spaceId: string,
  subjects: Subject[],
  kind: RwxResourceKind,
  ids: string[],
): Promise<string[]> {
  const ok = await readable(
    spaceId,
    subjects,
    ids.map((id) => ({ kind, id })),
  );
  return ids.filter((id) => ok.has(id));
}

/** Pages by id with the document behind each, for `readable`. */
export async function pageResources(pageIds: string[]): Promise<Resource[]> {
  if (!pageIds.length) {
    return [];
  }
  const rows = await db.query.spacePage.findMany({
    where: inArray(schema.spacePage.id, pageIds),
    columns: { id: true, fileId: true },
  });
  return rows.map((p) => ({ kind: "page", id: p.id, fileId: p.fileId }));
}

/** Tables by id with the document behind each, for `readable`. */
export async function tableResources(tableIds: string[]): Promise<Resource[]> {
  if (!tableIds.length) {
    return [];
  }
  const rows = await db.query.spaceTable.findMany({
    where: inArray(schema.spaceTable.id, tableIds),
    columns: { id: true, fileId: true },
  });
  return rows.map((t) => ({ kind: "table", id: t.id, fileId: t.fileId }));
}

/**
 * Whether the subjects may read everything the enforced kinds hold: every kind allowed on `*`
 * and no deny for them anywhere. What is made of many items at once (a category value's
 * summary) is shown only then.
 */
export async function readsEverything(spaceId: string, subjects: Subject[]): Promise<boolean> {
  if (!(await brokerOn())) {
    return true;
  }
  const rules = await rulesOf(spaceId);
  return ENFORCED.every(
    (kind) =>
      decideWith(rules, subjects, { kind, id: RWX_ALL }, "r").ok &&
      !rules.some((r) => about(r, subjects) && r.resourceKind === kind && r.r === "deny"),
  );
}

// --- the seed ---------------------------------------------------------------------------------

/**
 * What every space starts with, so the switch can go on without changing what people can do
 * today: admins and owners read, write and execute everything of the enforced kinds, members
 * read and write, guests read. A deny an admin writes afterwards wins over these.
 */
export async function seedRwx(spaceId: string): Promise<void> {
  const seeded: RwxRuleInput[] = [];
  for (const kind of ENFORCED) {
    for (const role of ["admin", "owner"] as const) {
      seeded.push(rule("role", role, kind, { r: "allow", w: "allow", x: "allow" }));
    }
    seeded.push(rule("role", "member", kind, { r: "allow", w: "allow", x: null }));
    seeded.push(rule("guest", null, kind, { r: "allow", w: null, x: null }));
  }
  await db
    .insert(schema.rwxRule)
    .values(seeded.map((r) => row(spaceId, r, "seed")))
    .onConflictDoNothing();
}

const rule = (
  subjectKind: RwxSubjectKind,
  subjectId: string | null,
  resourceKind: RwxResourceKind,
  flags: Pick<RwxRuleInput, "r" | "w" | "x">,
): RwxRuleInput => ({ subjectKind, subjectId, resourceKind, resourceId: RWX_ALL, ...flags });

const row = (spaceId: string, r: RwxRuleInput, createdBy: string) => ({
  id: nanoid(12),
  tenantId: currentTenant(),
  spaceId,
  ...r,
  createdBy,
});

// --- the rules, for the studio ---------------------------------------------------------------

const view = (r: Rule): RwxRule => ({
  id: r.id,
  subjectKind: r.subjectKind,
  subjectId: r.subjectId,
  resourceKind: r.resourceKind,
  resourceId: r.resourceId,
  r: r.r,
  w: r.w,
  x: r.x,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
});

/** The rules are behind their switch: while it is off, they are not there. */
async function requireBroker(): Promise<void> {
  if (!(await brokerOn())) {
    throw notFound();
  }
}

/** Only the space's admins read and write its rules. */
function requireRuleAdmin(): void {
  if (!isAdminRole(currentRole())) {
    throw new ServiceError("forbidden", MEMBERS_EDIT_ONLY);
  }
}

const key = (r: RwxRuleInput) =>
  [r.subjectKind, r.subjectId ?? "", r.resourceKind, r.resourceId].join("\u0000");

/** A rule as a person wrote it, checked for what the schema cannot say. */
function checkRule(r: RwxRuleInput): void {
  const refuse = (what: string) => new ServiceError("invalid", what);
  if (r.subjectKind === "guest" && r.subjectId !== null) {
    throw refuse("A guest rule has no subject id.");
  }
  if (r.subjectKind === "role" && !(RWX_ROLES as readonly string[]).includes(r.subjectId ?? "")) {
    throw refuse("A role is member, admin or owner.");
  }
  if (r.subjectKind !== "guest" && !r.subjectId) {
    throw refuse(`A ${r.subjectKind} rule names the ${r.subjectKind}'s id.`);
  }
  if (!r.resourceId.trim()) {
    throw refuse("A rule names the resource's id, or * for all of the kind.");
  }
  if (r.r === null && r.w === null && r.x === null) {
    throw refuse("A rule sets at least one of r, w and x.");
  }
}

export async function listRules(userId: string, spaceId: string): Promise<RwxRule[]> {
  const space = await ownedSpace(userId, spaceId);
  await requireBroker();
  requireRuleAdmin();
  return (await rulesOf(space.id)).map(view);
}

/**
 * The whole list, as the page saves it: what is there is replaced. An empty list brings the seed
 * back the next time the space is read.
 */
export async function putRules(
  userId: string,
  spaceId: string,
  rules: RwxRuleInput[],
): Promise<RwxRule[]> {
  const space = await ownedSpace(userId, spaceId);
  await requireBroker();
  requireRuleAdmin();
  if (rules.length > RWX_LIMITS.rules) {
    throw new ServiceError("invalid", `A space holds at most ${RWX_LIMITS.rules} rules.`);
  }
  const seen = new Set<string>();
  for (const r of rules) {
    checkRule(r);
    if (seen.has(key(r))) {
      throw new ServiceError("invalid", "Two rules name the same subject and resource.");
    }
    seen.add(key(r));
  }
  await db.transaction(async (tx) => {
    await tx.delete(schema.rwxRule).where(eq(schema.rwxRule.spaceId, space.id));
    if (rules.length) {
      await tx.insert(schema.rwxRule).values(rules.map((r) => row(space.id, r, userId)));
    }
  });
  return (await rulesOf(space.id)).map(view);
}

export async function deleteRule(userId: string, spaceId: string, ruleId: string): Promise<void> {
  const space = await ownedSpace(userId, spaceId);
  await requireBroker();
  requireRuleAdmin();
  const gone = await db
    .delete(schema.rwxRule)
    .where(and(eq(schema.rwxRule.spaceId, space.id), eq(schema.rwxRule.id, ruleId)))
    .returning({ id: schema.rwxRule.id });
  if (!gone.length) {
    throw notFound();
  }
}

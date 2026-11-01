import { AsyncLocalStorage } from "node:async_hooks";
import { featureOn } from "@engenty/wizards-shared/features";
import { note, type RunNoteCode } from "@engenty/wizards-shared/run";
import {
  AUDIENCES,
  type Audience,
  RWX_ALL,
  RWX_LIMITS,
  RWX_ROLES,
  type RwxPerm,
  type RwxResourceKind,
  type RwxRule,
  type RwxRuleInput,
  type RwxSubjectKind,
} from "@engenty/wizards-shared/rwx";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import type { RunHolder, RunRow, StepContext } from "../engine/types.js";
import { currentFeatures } from "../features.js";
import type { Role } from "../manage.js";
import { currentRole, isAdminRole, MEMBERS_EDIT_ONLY, roleOf } from "../services/access.js";
import { notFound, ServiceError } from "../services/errors.js";
import { ownedSpace } from "../services/spaces.js";
import { currentTenant } from "../tenants/tenant.js";
import type { Who } from "./call.js";
import type { Caller } from "./caller.js";
import { logRuleChange } from "./log.js";

/**
 * The broker's first part (docs/plans/broker.md, "First: RWX"): one table of permissions per
 * space, `subject × resource × R W X`, behind the `broker` switch. A reader of a document, a
 * table or a page asks here with a *who* before it hands anything out, and search asks before it
 * ranks. Unset means deny; a deny wins over every allow; a call with no subject is refused. With
 * the switch off every answer is yes, and nothing here changes what the runtime does.
 *
 * Who asks: a guest (a visitor on a shared link), a person with their role, Goose for a person
 * (the person's own rules count too), a run (its holder and its wizard), a plugin, and the
 * runtime itself (`SYSTEM`). The rows are written by the space's admins (routes/rules.ts); every
 * space starts with the seed below, so turning the switch on changes nothing until an admin
 * writes a deny.
 */

export type Perm = RwxPerm;

export interface Subject {
  /** A kind a rule can name, or `system`: the runtime itself, which no rule names (`SYSTEM`). */
  kind: RwxSubjectKind | "system";
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
  /**
   * The Knowledge folders a document, page or table lies in, the nearest first (a folder is a
   * page). A folder's rule holds for what lies in it: its deny closes, its allow opens.
   * `readable` and `decide` look them up where the space has rules on folders.
   */
  folders?: string[];
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

/**
 * The resource kinds this runtime asks the broker about today; the others wait for their reader.
 * A wizard is run (`x`) and listed (`r`) through the tool catalogue (elements/), a skill read
 * (`r`) and its scripts placed to run (`x`), a space's setup written (`w`) by Goose.
 */
export const ENFORCED: readonly RwxResourceKind[] = [
  "document",
  "table",
  "page",
  "wizard",
  "skill",
  "setup",
];

type Rule = typeof schema.rwxRule.$inferSelect;

export async function brokerOn(): Promise<boolean> {
  return featureOn(await currentFeatures(), "broker");
}

// --- who ------------------------------------------------------------------------------------

/**
 * The runtime itself, with no person, guest or run behind it: a plugin's job (`server.every`,
 * plugins/jobs.ts). It may read, write and run everything in the space; a deny
 * written for a subject it asks beside (the plugin) still wins. It never comes from a request:
 * no helper below returns it, a rule cannot name it (`system` is no `RwxSubjectKind`),
 * `decideWith` knows it by identity rather than by its kind, and test/rwx.test.ts fails on a file
 * that uses it outside the places listed there. No subject at all stays a no.
 */
export const SYSTEM: Subject = Object.freeze({ kind: "system", id: null }) as Subject;

export const subjectsOfGuest = (): Subject[] => [{ kind: "guest", id: null }];

/** An AI working for a person: a Work chat, a client's chat, Claude or Codex through MCP. */
export const AGENT: Subject = Object.freeze({ kind: "agent", id: null }) as Subject;

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

const reader = new AsyncLocalStorage<Subject[]>();

/**
 * Runs `fn` reading as `who`, for code the runtime hands a call to without a broker caller: a
 * plugin's HTTP route reads as the person it answers, a plugin's job as the runtime itself. Code
 * outside reads as nobody, which is a no.
 */
export function readingAs<T>(who: Subject[], fn: () => Promise<T>): Promise<T> {
  return reader.run(who, fn);
}

/** Whom the code runs reading for (`readingAs`), or nobody. */
export const currentReader = (): Subject[] => reader.getStore() ?? [];

/**
 * Whom code the runtime hands a call to (a plugin's tool in a step or a Work chat) runs for: the
 * person, guest or Goose behind the caller, a fixed step's holder, and the run's wizard. Never
 * `SYSTEM`; a caller with no one behind it gives no subject, which is a no.
 */
export async function subjectsOfCaller(caller: Caller): Promise<Subject[]> {
  const wizard: Subject[] = caller.where.wizardId
    ? [{ kind: "wizard", id: caller.where.wizardId }]
    : [];
  return [...(await subjectsOfWho(caller.who)), ...wizard];
}

async function subjectsOfWho(who: Who): Promise<Subject[]> {
  switch (who.kind) {
    case "guest":
      return subjectsOfGuest();
    case "person":
    case "admin":
      return who.id ? subjectsOfPerson(who.id, await roleOf(who.id)) : [];
    case "goose":
      return who.id ? subjectsOfGoose(who.id, await roleOf(who.id)) : [];
    case "step":
      return who.for ? subjectsOfWho(who.for) : [];
    case "plugin":
      return who.id ? [{ kind: "plugin", id: who.id }] : [];
  }
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

/** A rule is about a subject of its kind with its id; a wizard rule on `*` about every wizard. */
const about = (rule: Rule, subjects: Subject[]) =>
  subjects.some(
    (s) =>
      s.kind === rule.subjectKind &&
      ((s.id ?? null) === (rule.subjectId ?? null) ||
        (rule.subjectKind === "wizard" && rule.subjectId === RWX_ALL)),
  );

const names = (rule: Rule, resource: Resource) =>
  rule.resourceKind === resource.kind &&
  (rule.resourceId === RWX_ALL || rule.resourceId === resource.id);

/** The first rule about the subjects and the resource that says `flag` for `perm`. */
const matching = (
  rules: Rule[],
  subjects: Subject[],
  resource: Resource,
  perm: Perm,
  flag: "allow" | "deny",
) => rules.find((r) => about(r, subjects) && names(r, resource) && r[perm] === flag);

/**
 * The runtime itself (`SYSTEM`): yes, unless a deny names a subject it asks beside, on the
 * resource or on the document behind it.
 */
function decideSystem(rules: Rule[], others: Subject[], resource: Resource, perm: Perm): Decision {
  const behind: Resource[] = resource.fileId ? [{ kind: "document", id: resource.fileId }] : [];
  const folders: Resource[] = (resource.folders ?? []).map((id) => ({ kind: "page", id }));
  for (const r of [{ kind: resource.kind, id: resource.id }, ...behind, ...folders]) {
    const deny = matching(rules, others, r, perm, "deny");
    if (deny) {
      return { ok: false, rule: deny.id, reason: `${r.kind} ${r.id}: denied`, of: r };
    }
  }
  return {
    ok: true,
    reason: `${resource.kind} ${resource.id}: the runtime itself`,
    of: { kind: resource.kind, id: resource.id },
  };
}

/** One resource against the rules, without the document behind it. */
function decideOne(rules: Rule[], subjects: Subject[], resource: Resource, perm: Perm): Decision {
  const where = `${resource.kind} ${resource.id}`;
  const of = { kind: resource.kind, id: resource.id };
  const deny = matching(rules, subjects, resource, perm, "deny");
  if (deny) {
    return { ok: false, rule: deny.id, reason: `${where}: denied`, of };
  }
  const allow = matching(rules, subjects, resource, perm, "allow");
  if (allow) {
    return { ok: true, rule: allow.id, reason: `${where}: allowed`, of };
  }
  return { ok: false, reason: `${where}: no rule`, of };
}

/**
 * The decision from rules already loaded: no subject is a no; the runtime itself is a yes but for
 * a deny on a subject beside it; else a deny wins, then any allow, else no rule.
 */
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
  if (subjects.includes(SYSTEM)) {
    const others = subjects.filter((s) => s !== SYSTEM);
    return decideSystem(rules, others, resource, perm);
  }
  // A folder's rule names it by id: its deny closes what lies in it, its allow opens it.
  const inFolder = (flag: "allow" | "deny") => {
    for (const id of resource.folders ?? []) {
      const r = rules.find(
        (x) =>
          about(x, subjects) &&
          x.resourceKind === "page" &&
          x.resourceId === id &&
          x[perm] === flag,
      );
      if (r) {
        return { rule: r, id };
      }
    }
    return null;
  };
  const closed = inFolder("deny");
  if (closed) {
    return {
      ok: false,
      rule: closed.rule.id,
      reason: `${resource.kind} ${resource.id}: denied in folder ${closed.id}`,
      of: { kind: resource.kind, id: resource.id },
    };
  }
  let own = decideOne(rules, subjects, resource, perm);
  const opened = own.ok ? null : inFolder("allow");
  if (opened && !own.rule) {
    own = {
      ok: true,
      rule: opened.rule.id,
      reason: `${resource.kind} ${resource.id}: allowed in folder ${opened.id}`,
      of: own.of,
    };
  }
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
  const rules = await rulesOf(spaceId);
  const [item] = await withFolders(spaceId, rules, [resource]);
  return decideWith(rules, subjects, item, perm);
}

const KNOWLEDGE_KINDS = new Set<RwxResourceKind>(["document", "page", "table"]);

/**
 * The items with the folders they lie in, where the space has a rule on a folder: a rule on a
 * page by its id. Without one, nothing is looked up.
 */
async function withFolders(spaceId: string, rules: Rule[], items: Resource[]): Promise<Resource[]> {
  const onFolders = rules.some((r) => r.resourceKind === "page" && r.resourceId !== RWX_ALL);
  const asked = items.filter((i) => KNOWLEDGE_KINDS.has(i.kind) && !i.folders);
  if (!(onFolders && asked.length)) {
    return items;
  }
  const ids = (kind: RwxResourceKind) => asked.filter((i) => i.kind === kind).map((i) => i.id);
  const [pages, files, tables] = await Promise.all([
    db.query.spacePage.findMany({
      where: eq(schema.spacePage.spaceId, spaceId),
      columns: { id: true, parentId: true },
    }),
    ids("document").length
      ? db.query.spaceFile.findMany({
          where: inArray(schema.spaceFile.id, ids("document")),
          columns: { id: true, parentId: true },
        })
      : [],
    ids("table").length
      ? db.query.spaceTable.findMany({
          where: inArray(schema.spaceTable.id, ids("table")),
          columns: { id: true, parentId: true },
        })
      : [],
  ]);
  const parentOf = new Map(pages.map((p) => [p.id, p.parentId]));
  const parentOfItem = new Map<string, string | null>([
    ...files.map((f) => [`document:${f.id}`, f.parentId] as const),
    ...tables.map((t) => [`table:${t.id}`, t.parentId] as const),
    ...pages.map((p) => [`page:${p.id}`, p.parentId] as const),
  ]);
  const chain = (from: string | null | undefined) => {
    const out: string[] = [];
    for (let at = from; at && !out.includes(at); at = parentOf.get(at)) {
      out.push(at);
    }
    return out;
  };
  return items.map((i) =>
    KNOWLEDGE_KINDS.has(i.kind) && !i.folders
      ? { ...i, folders: chain(parentOfItem.get(`${i.kind}:${i.id}`)) }
      : i,
  );
}

const WHAT: Record<RwxResourceKind, RunNoteCode> = {
  document: "rwxDocument",
  table: "rwxTable",
  page: "rwxPage",
  connection: "rwxConnection",
  mail: "rwxMail",
  host: "rwxHost",
  sandbox: "rwxSandbox",
  wizard: "rwxWizard",
  skill: "rwxSkill",
  setup: "rwxSetup",
  mount: "rwxMount",
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
  const known = await withFolders(spaceId, rules, items);
  return new Set(known.filter((i) => decideWith(rules, subjects, i, "r").ok).map((i) => i.id));
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

/**
 * The mounts of Dateien among `ids` the subjects may read: the people (a person, Goose, a guest)
 * by their rules, and a run's wizard by its own as well. A mount's rules are written with it
 * (mounts/mounts.ts): who in the space sees it, which wizards may use it.
 */
export async function readableMounts(
  spaceId: string,
  subjects: Subject[],
  ids: string[],
): Promise<Set<string>> {
  if (!(await brokerOn())) {
    return new Set(ids);
  }
  const rules = await rulesOf(spaceId);
  // The person, the run's wizard and an AI working for the person each need the mount's rules.
  const wizards = subjects.filter((s) => s.kind === "wizard");
  const agents = subjects.filter((s) => s.kind === "agent");
  const people = subjects.filter((s) => s.kind !== "wizard" && s.kind !== "agent");
  const ok = (who: Subject[], id: string) => decideWith(rules, who, { kind: "mount", id }, "r").ok;
  return new Set(
    ids.filter(
      (id) =>
        subjects.length > 0 &&
        (!people.length || ok(people, id)) &&
        (!wizards.length || ok(wizards, id)) &&
        (!agents.length || ok(agents, id)),
    ),
  );
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
  const space = await db.query.space.findFirst({
    columns: { kind: true },
    where: eq(schema.space.id, spaceId),
  });
  for (const kind of ENFORCED) {
    for (const role of ["admin", "owner"] as const) {
      seeded.push(rule("role", role, kind, { r: "allow", w: "allow", x: "allow" }));
    }
    seeded.push(rule("role", "member", kind, MEMBER_SEED[kind] ?? MEMBER_DATA));
    const guest = GUEST_SEED[kind];
    if (guest) {
      seeded.push(rule("guest", null, kind, guest));
    }
    // A client space's clients work with their own data, and run what the space lets them. A
    // space gets no rule for clients: what of it a client reads, a rule opens item by item.
    const client = space?.kind === "client" ? CLIENT_SEED[kind] : undefined;
    if (client) {
      seeded.push(rule("role", "client", kind, client));
    }
  }
  await db
    .insert(schema.rwxRule)
    .values(seeded.map((r) => row(spaceId, r, "seed")))
    .onConflictDoNothing();
}

type Flags = Pick<RwxRuleInput, "r" | "w" | "x">;

/**
 * A member's seed: documents, tables and pages read and written; a wizard read and run (building
 * it is the studio's, by the members' studio rule); a skill read and its scripts run; the space's
 * setup read and written. The same as the migration 0040 writes for spaces seeded before.
 */
const MEMBER_DATA: Flags = { r: "allow", w: "allow", x: null };
const MEMBER_SEED: Partial<Record<RwxResourceKind, Flags>> = {
  wizard: { r: "allow", w: null, x: "allow" },
  skill: { r: "allow", w: null, x: "allow" },
};

/**
 * A client's seed in their client space (docs/plans/client-spaces.md): its data read and written,
 * wizards and skills read and run; never its setup.
 */
const CLIENT_SEED: Partial<Record<RwxResourceKind, Flags>> = {
  document: { r: "allow", w: "allow", x: null },
  table: { r: "allow", w: "allow", x: null },
  page: { r: "allow", w: "allow", x: null },
  wizard: { r: "allow", w: null, x: "allow" },
  skill: { r: "allow", w: null, x: "allow" },
};

/** A guest's seed: data read, a skill read and run in its run; no wizard, no setup. */
const GUEST_SEED: Partial<Record<RwxResourceKind, Flags>> = {
  document: { r: "allow", w: null, x: null },
  table: { r: "allow", w: null, x: null },
  page: { r: "allow", w: null, x: null },
  skill: { r: "allow", w: null, x: "allow" },
};

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
  await logRuleChange({
    userId,
    spaceId: space.id,
    connectionId: "rwx",
    summary: { rules: rules.length },
    reason: `The RWX rules were replaced: ${rules.length} now.`,
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
  await logRuleChange({
    userId,
    spaceId: space.id,
    connectionId: "rwx",
    summary: { deleted: ruleId },
    reason: "An RWX rule was deleted.",
  });
}

// --- open to clients ---------------------------------------------------------------------------

/** What of a space its clients may reach: an item of its Knowledge read, a wizard run too. */
export type ClientOpenKind = "document" | "table" | "page" | "wizard";

/**
 * Opens one item of a space to the clients of its client spaces, or closes it again
 * (docs/plans/client-spaces.md): a rule for the role `client` on that item, read (and run for a
 * wizard). Its admins decide; the change is a line of the log.
 */
export async function setOpenToClients(
  userId: string,
  spaceId: string,
  resource: { kind: ClientOpenKind; id: string },
  open: boolean,
): Promise<void> {
  const space = await ownedSpace(userId, spaceId);
  await requireBroker();
  requireRuleAdmin();
  await rulesOf(space.id);
  const where = and(
    eq(schema.rwxRule.spaceId, space.id),
    eq(schema.rwxRule.subjectKind, "role"),
    eq(schema.rwxRule.subjectId, "client"),
    eq(schema.rwxRule.resourceKind, resource.kind),
    eq(schema.rwxRule.resourceId, resource.id),
  );
  await db.delete(schema.rwxRule).where(where);
  if (open) {
    const opened: RwxRuleInput = {
      subjectKind: "role",
      subjectId: "client",
      resourceKind: resource.kind,
      resourceId: resource.id,
      r: "allow",
      w: null,
      x: resource.kind === "wizard" ? "allow" : null,
    };
    await db.insert(schema.rwxRule).values(row(space.id, opened, userId));
  }
  await logRuleChange({
    userId,
    spaceId: space.id,
    connectionId: "rwx",
    summary: { [resource.kind]: resource.id, clients: open },
    reason: `${resource.kind} ${resource.id} ${open ? "opened to" : "closed to"} the space's clients.`,
  });
}

/**
 * The rules a Wissen folder's audience writes, on the folder (a page) by its id: the team and
 * guests read by the space's seed, so leaving them out closes the folder to them; clients read
 * nothing of the space by their seed, so taking them in opens it. What lies in the folder follows
 * (`withFolders`).
 */
function folderRules(folderId: string, see: Audience[]): RwxRuleInput[] {
  const on = (
    subjectKind: RwxSubjectKind,
    subjectId: string | null,
    flags: Partial<RwxRuleInput>,
  ) => ({
    subjectKind,
    subjectId,
    resourceKind: "page" as const,
    resourceId: folderId,
    r: null,
    w: null,
    x: null,
    ...flags,
  });
  return [
    ...(see.includes("team") ? [] : [on("role", "member", { r: "deny", w: "deny" })]),
    ...(see.includes("guests") ? [] : [on("guest", null, { r: "deny" })]),
    ...(see.includes("clients") ? [on("role", "client", { r: "allow" })] : []),
  ];
}

const AUDIENCE_SUBJECTS = [
  ["role", "member"],
  ["role", "client"],
  ["guest", null],
] as const;

async function knowledgeFolder(userId: string, spaceId: string, folderId: string) {
  const space = await ownedSpace(userId, spaceId);
  const folder = await db.query.spacePage.findFirst({
    columns: { id: true },
    where: and(eq(schema.spacePage.spaceId, space.id), eq(schema.spacePage.id, folderId)),
  });
  if (!folder) {
    throw notFound();
  }
  return { space, folder };
}

/** Who besides the admins sees a Wissen folder, as its rules say. */
export async function folderAudience(
  userId: string,
  spaceId: string,
  folderId: string,
): Promise<Audience[]> {
  const { space, folder } = await knowledgeFolder(userId, spaceId, folderId);
  const rules = (await rulesOf(space.id)).filter(
    (r) => r.resourceKind === "page" && r.resourceId === folder.id,
  );
  const has = (kind: string, id: string | null, flag: "allow" | "deny") =>
    rules.some((r) => r.subjectKind === kind && (r.subjectId ?? null) === id && r.r === flag);
  return AUDIENCES.filter((a) =>
    a === "team"
      ? !has("role", "member", "deny")
      : a === "guests"
        ? !has("guest", null, "deny")
        : has("role", "client", "allow"),
  );
}

/** Sets who besides the admins sees a Wissen folder and everything in it. Admins only. */
export async function setFolderAudience(
  userId: string,
  spaceId: string,
  folderId: string,
  see: Audience[],
): Promise<void> {
  const { space, folder } = await knowledgeFolder(userId, spaceId, folderId);
  await requireBroker();
  requireRuleAdmin();
  await rulesOf(space.id);
  const r = schema.rwxRule;
  for (const [kind, id] of AUDIENCE_SUBJECTS) {
    await db
      .delete(r)
      .where(
        and(
          eq(r.spaceId, space.id),
          eq(r.resourceKind, "page"),
          eq(r.resourceId, folder.id),
          eq(r.subjectKind, kind),
          id === null ? isNull(r.subjectId) : eq(r.subjectId, id),
        ),
      );
  }
  const rules = folderRules(folder.id, see);
  if (rules.length) {
    await db.insert(r).values(rules.map((x) => row(space.id, x, userId)));
  }
  await logRuleChange({
    userId,
    spaceId: space.id,
    connectionId: "rwx",
    summary: { page: folder.id, see: see.join(",") || "admins" },
    reason: `Folder ${folder.id} seen by ${see.length ? see.join(", ") : "the admins alone"}.`,
  });
}

/** The ids of each kind a space opened to its clients. */
export async function openToClients(spaceId: string): Promise<Record<ClientOpenKind, string[]>> {
  const rows = await db.query.rwxRule.findMany({
    where: and(
      eq(schema.rwxRule.spaceId, spaceId),
      eq(schema.rwxRule.subjectKind, "role"),
      eq(schema.rwxRule.subjectId, "client"),
    ),
  });
  const out: Record<ClientOpenKind, string[]> = { document: [], table: [], page: [], wizard: [] };
  for (const r of rows) {
    if (r.resourceKind in out && r.resourceId !== RWX_ALL && r.r === "allow") {
      out[r.resourceKind as ClientOpenKind].push(r.resourceId);
    }
  }
  return out;
}

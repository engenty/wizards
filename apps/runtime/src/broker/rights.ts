import type { ProtocolPerson } from "@engenty/wizards-shared/connectors";
import {
  RWX_ALL,
  type RwxChoices,
  type RwxOrigin,
  type RwxRule,
  type RwxRuleView,
} from "@engenty/wizards-shared/rwx";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { loadedPlugin, loadedPlugins } from "../plugins/registry.js";
import { ENFORCED } from "./rwx.js";

/**
 * The rules of a space as Fähigkeiten › Rechte reads them (docs/plans/capabilities-next.md, piece
 * 3): each with where it is set and with the names of who and what it is about, and what the page
 * picks from. The rules themselves, and what decides, are broker/rwx.ts.
 */

/** A page a rule names: its title, whether it is one of Wissen (no wizard's), and a folder (no text). */
interface PageFacts {
  title: string;
  wissen: boolean;
  folder: boolean;
}

/**
 * Where a rule is set. A place that shows a rule also replaces it, so the rule's own shape tells,
 * whoever wrote the row:
 *
 * - `mount`: any rule on a mount. Its form in Dateien writes them all (mounts/mounts.ts), and the
 *   rules routes refuse one.
 * - `start`: a role's or the guests' rule on every resource of an enforced kind: the seed
 *   (`created_by` `seed`), and what Rechte sets for a role on top of it.
 * - `folder`: on a page of Wissen, what „Wer sieht diesen Ordner“ writes and reads back
 *   (`folderRules`): closed to the team or to guests, open to clients. Wissen offers it on every
 *   page, a folder or not.
 * - `clients`: „Für Kund:innen sichtbar“ on a document, a table or a wizard
 *   (`setOpenToClients`): the clients read it, and run a wizard. On a page of Wissen it is the
 *   rule the folder's dialog shows.
 * - `rights`: every other rule. Rechte set it, and removes it.
 */
export function originOf(rule: RwxRule, page: PageFacts | undefined): RwxOrigin {
  if (rule.resourceKind === "mount") {
    return "mount";
  }
  const group = rule.subjectKind === "guest" || rule.subjectKind === "role";
  if (rule.resourceId === RWX_ALL) {
    return group && ENFORCED.includes(rule.resourceKind) ? "start" : "rights";
  }
  const role = rule.subjectKind === "role" ? rule.subjectId : null;
  const opensToClients =
    role === "client" &&
    rule.r === "allow" &&
    rule.w === null &&
    rule.x === (rule.resourceKind === "wizard" ? "allow" : null);
  if (rule.resourceKind === "page" && page?.wissen) {
    const closesToTeam = role === "member" && rule.r === "deny" && rule.w !== "allow" && !rule.x;
    const closesToGuests = rule.subjectKind === "guest" && rule.r === "deny" && !rule.w && !rule.x;
    if (closesToTeam || closesToGuests || opensToClients) {
      return "folder";
    }
  }
  if (opensToClients && ["document", "table", "page", "wizard"].includes(rule.resourceKind)) {
    return "clients";
  }
  return "rights";
}

/** The ids the rules name for one kind of resource or subject. */
const idsOf = (rules: RwxRule[], pick: (r: RwxRule) => string | null | undefined) => [
  ...new Set(rules.map(pick).filter((id): id is string => Boolean(id) && id !== RWX_ALL)),
];

/**
 * The rules with where each is set and with their names: a person's, a wizard's, a plugin's; a
 * document's, a page's, a table's, a wizard's, a skill's, a mount's. A name is null where there is
 * nothing to name (a role, guests, every resource of a kind, the setup) or what it named is gone.
 */
export async function describeRules(
  spaceId: string,
  rules: RwxRule[],
  people: ProtocolPerson[],
): Promise<RwxRuleView[]> {
  const of = (kind: RwxRule["resourceKind"]) =>
    idsOf(rules, (r) => (r.resourceKind === kind ? r.resourceId : null));
  const wizardIds = [
    ...new Set([
      ...of("wizard"),
      ...idsOf(rules, (r) => (r.subjectKind === "wizard" ? r.subjectId : null)),
    ]),
  ];
  const [pages, files, tables, wizards, skills, mounts] = await Promise.all([
    of("page").length
      ? db
          .select({
            id: schema.spacePage.id,
            title: schema.spacePage.title,
            wizardId: schema.spacePage.wizardId,
            blank: sql<number>`length(trim(${schema.spacePage.markdown})) = 0`,
          })
          .from(schema.spacePage)
          .where(
            and(eq(schema.spacePage.spaceId, spaceId), inArray(schema.spacePage.id, of("page"))),
          )
      : [],
    of("document").length
      ? db
          .select({ id: schema.spaceFile.id, name: schema.spaceFile.name })
          .from(schema.spaceFile)
          .where(
            and(
              eq(schema.spaceFile.spaceId, spaceId),
              inArray(schema.spaceFile.id, of("document")),
            ),
          )
      : [],
    of("table").length
      ? db
          .select({ id: schema.spaceTable.id, name: schema.spaceTable.title })
          .from(schema.spaceTable)
          .where(
            and(eq(schema.spaceTable.spaceId, spaceId), inArray(schema.spaceTable.id, of("table"))),
          )
      : [],
    wizardIds.length
      ? db
          .select({ id: schema.wizard.id, name: schema.wizard.title })
          .from(schema.wizard)
          .where(and(eq(schema.wizard.spaceId, spaceId), inArray(schema.wizard.id, wizardIds)))
      : [],
    of("skill").length
      ? db
          .select({ id: schema.spaceSkill.id, name: schema.spaceSkill.name })
          .from(schema.spaceSkill)
          .where(
            and(eq(schema.spaceSkill.spaceId, spaceId), inArray(schema.spaceSkill.id, of("skill"))),
          )
      : [],
    of("mount").length
      ? db
          .select({ id: schema.spaceMount.id, name: schema.spaceMount.name })
          .from(schema.spaceMount)
          .where(
            and(eq(schema.spaceMount.spaceId, spaceId), inArray(schema.spaceMount.id, of("mount"))),
          )
      : [],
  ]);
  const pageOf = new Map(
    pages.map((p) => [
      p.id,
      { title: p.title, wissen: !p.wizardId, folder: !p.wizardId && Boolean(p.blank) },
    ]),
  );
  const named = (rows: { id: string; name: string }[]) => new Map(rows.map((r) => [r.id, r.name]));
  const names: Partial<Record<RwxRule["resourceKind"], Map<string, string>>> = {
    document: named(files),
    table: named(tables),
    wizard: named(wizards),
    skill: named(skills),
    mount: named(mounts),
  };
  const person = new Map(people.map((p) => [p.id, p.name]));
  const subjectName = (r: RwxRule): string | null => {
    switch (r.subjectKind) {
      case "person":
      case "goose":
        return person.get(r.subjectId ?? "") ?? null;
      case "wizard":
        return names.wizard?.get(r.subjectId ?? "") ?? null;
      case "plugin":
        return loadedPlugin(r.subjectId ?? "")?.source.manifest.name ?? null;
      default:
        return null;
    }
  };
  return rules.map((r) => {
    const page = r.resourceKind === "page" ? pageOf.get(r.resourceId) : undefined;
    return {
      ...r,
      origin: originOf(r, page),
      subjectName: subjectName(r),
      resourceName: page?.title ?? names[r.resourceKind]?.get(r.resourceId) ?? null,
      ...(page?.folder ? { folder: true } : {}),
    };
  });
}

/**
 * What Rechte picks from, for a rule and for „Was darf …?“: the organization's people, and the
 * space's wizards, plugins, documents, pages of Wissen, tables and skills. All of them, whatever
 * the admin asking may read: a rule is written about what it closes too.
 */
export async function ruleChoices(spaceId: string, people: ProtocolPerson[]): Promise<RwxChoices> {
  const [wizards, documents, pages, tables, skills] = await Promise.all([
    db
      .select({ id: schema.wizard.id, name: schema.wizard.title })
      .from(schema.wizard)
      .where(eq(schema.wizard.spaceId, spaceId))
      .orderBy(asc(schema.wizard.title)),
    db
      .select({ id: schema.spaceFile.id, name: schema.spaceFile.name })
      .from(schema.spaceFile)
      .where(and(eq(schema.spaceFile.spaceId, spaceId), eq(schema.spaceFile.kind, "document")))
      .orderBy(asc(schema.spaceFile.name)),
    db
      .select({
        id: schema.spacePage.id,
        name: schema.spacePage.title,
        blank: sql<number>`length(trim(${schema.spacePage.markdown})) = 0`,
      })
      .from(schema.spacePage)
      .where(and(eq(schema.spacePage.spaceId, spaceId), isNull(schema.spacePage.wizardId)))
      .orderBy(asc(schema.spacePage.title)),
    db
      .select({ id: schema.spaceTable.id, name: schema.spaceTable.title })
      .from(schema.spaceTable)
      .where(and(eq(schema.spaceTable.spaceId, spaceId), isNull(schema.spaceTable.wizardId)))
      .orderBy(asc(schema.spaceTable.title)),
    db
      .select({ id: schema.spaceSkill.id, name: schema.spaceSkill.name })
      .from(schema.spaceSkill)
      .where(eq(schema.spaceSkill.spaceId, spaceId))
      .orderBy(asc(schema.spaceSkill.name)),
  ]);
  return {
    people: people.map((p) => ({ id: p.id, name: p.name, role: p.role })),
    wizards,
    plugins: loadedPlugins()
      .filter((p) => !p.error && p.source.entry)
      .map((p) => ({ id: p.source.id, name: p.source.manifest.name })),
    documents,
    pages: pages.map((p) => ({ id: p.id, name: p.name, folder: Boolean(p.blank) })),
    tables,
    skills,
  };
}

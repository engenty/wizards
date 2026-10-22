/**
 * The triggers that fill `live_change` (docs/plans/live-changes.md, 1). One entry per table
 * names the item a write changes; `pnpm --filter @engenty/wizards-runtime exec tsx
 * scripts/live-triggers.ts` prints the SQL that migration 0023 carries. Unlike the two-way sync's
 * triggers (0022) they have no guard, since a pulled write is a change on this side's screen too,
 * and they count wizard-owned pages and tables, which the studio shows as shared lists.
 */

export interface LiveTable {
  table: string;
  /** SQL over `$` (`new` or `old`) for the item's space, kind (a `LiveKind`), id and parent. */
  project: string;
  kind: string;
  item: string;
  parent: string;
  /** The write deletes the item itself; otherwise a delete here changes its owner (a `put`). */
  owns: boolean;
}

const ofWizard = "(SELECT project_id FROM wizard WHERE id = $.wizard_id)";

export const LIVE_TABLES: LiveTable[] = [
  { table: "project", project: "$.id", kind: "'space'", item: "$.id", parent: "NULL", owns: true },
  {
    table: "wizard",
    project: "$.project_id",
    kind: "'wizard'",
    item: "$.id",
    parent: "NULL",
    owns: true,
  },
  {
    table: "wizard_file",
    project: ofWizard,
    kind: "'wizard'",
    item: "$.wizard_id",
    parent: "NULL",
    owns: false,
  },
  {
    table: "wizard_translation",
    project: ofWizard,
    kind: "'translation'",
    item: "$.wizard_id || ':' || $.lang",
    parent: "$.wizard_id",
    owns: true,
  },
  {
    table: "wizard_message",
    project: ofWizard,
    kind: "'message'",
    item: "$.id",
    parent: "$.wizard_id",
    owns: true,
  },
  {
    table: "space_page",
    project: "$.project_id",
    kind: "'page'",
    item: "$.id",
    parent: "$.wizard_id",
    owns: true,
  },
  {
    table: "space_table",
    project: "$.project_id",
    kind: "'table'",
    item: "$.id",
    parent: "$.wizard_id",
    owns: true,
  },
  {
    table: "space_table_row",
    project: "(SELECT project_id FROM space_table WHERE id = $.table_id)",
    kind: "'row'",
    item: "$.id",
    parent: "$.table_id",
    owns: true,
  },
  {
    table: "space_category",
    project: "$.project_id",
    kind: "'category'",
    item: "$.id",
    parent: "NULL",
    owns: true,
  },
  {
    table: "space_category_value",
    project: "(SELECT project_id FROM space_category WHERE id = $.category_id)",
    kind: "'category'",
    item: "$.category_id",
    parent: "NULL",
    owns: false,
  },
  {
    table: "space_item_category",
    project: "$.project_id",
    kind: "CASE WHEN $.page_id IS NOT NULL THEN 'page' WHEN $.row_id IS NOT NULL THEN 'row' WHEN $.table_id IS NOT NULL THEN 'table' ELSE 'file' END",
    item: "COALESCE($.page_id, $.row_id, $.table_id, $.file_id)",
    parent:
      "CASE WHEN $.row_id IS NOT NULL THEN (SELECT table_id FROM space_table_row WHERE id = $.row_id) END",
    owns: false,
  },
  {
    table: "project_file",
    project: "$.project_id",
    kind: "'file'",
    item: "$.id",
    parent: "NULL",
    owns: true,
  },
  {
    table: "project_connector",
    project: "$.project_id",
    kind: "'connector'",
    item: "$.project_id || ':' || $.id",
    parent: "NULL",
    owns: true,
  },
];

const OPS = [
  { suffix: "ai", event: "INSERT", row: "new", del: false },
  { suffix: "au", event: "UPDATE", row: "new", del: false },
  { suffix: "ad", event: "DELETE", row: "old", del: true },
] as const;

/** The trigger SQL, in drizzle's statement-breakpoint form. */
export function liveTriggerSql(): string {
  const out: string[] = [];
  for (const t of LIVE_TABLES) {
    for (const op of OPS) {
      const at = (sql: string) => sql.replaceAll("$.", `${op.row}.`);
      const kind = op.del && t.owns ? "'del'" : "'put'";
      out.push(
        [
          `CREATE TRIGGER \`live_${t.table}_${op.suffix}\` AFTER ${op.event} ON \`${t.table}\` BEGIN`,
          "\tINSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)",
          `\tSELECT ${at(t.project)}, ${at(t.kind)}, ${kind}, i, ${at(t.parent)}, unixepoch() * 1000 FROM (SELECT ${at(t.item)} AS i) WHERE i IS NOT NULL;`,
          "END;",
        ].join("\n"),
      );
    }
  }
  return out.join("--> statement-breakpoint\n");
}

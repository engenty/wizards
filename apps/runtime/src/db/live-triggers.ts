/**
 * The triggers that fill `live_change` (docs/plans/live-changes.md, 1). One entry per table
 * names the item a write changes; `pnpm --filter @engenty/wizards-runtime exec tsx
 * scripts/live-triggers.ts` prints the SQL that migration 0023 carries, or with a table's name
 * that table's alone (0026). Unlike the two-way sync's triggers (0022) they have no guard, since
 * a pulled write is a change on this side's screen too, and they count wizard-owned pages and
 * tables, which the studio shows as shared lists.
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
  /** Logs an update only when this holds (SQL over `old` and `new`): a heartbeat is no change. */
  updateWhen?: string;
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
  // Migration 0026.
  {
    table: "space_skill",
    project: "$.project_id",
    kind: "'skill'",
    item: "$.id",
    parent: "NULL",
    owns: true,
  },
];

const OPS = [
  { suffix: "ai", event: "INSERT", row: "new", del: false },
  { suffix: "au", event: "UPDATE", row: "new", del: false },
  { suffix: "ad", event: "DELETE", row: "old", del: true },
] as const;

/**
 * Who is in an item (`live_presence`, migration 0024): a join, a leave, a new state or place is
 * a change of the item's presence (`presence`, `<kind>:<item>`); a heartbeat is not.
 */
export const PRESENCE_TABLE: LiveTable = {
  table: "live_presence",
  project: "NULL",
  kind: "'presence'",
  item: "$.kind || ':' || $.item",
  parent: "$.kind",
  owns: false,
  updateWhen:
    "old.state IS NOT new.state OR old.place IS NOT new.place OR old.name IS NOT new.name",
};

/** The trigger SQL of `tables`, in drizzle's statement-breakpoint form. */
export function liveTriggerSql(tables: LiveTable[] = LIVE_TABLES): string {
  const out: string[] = [];
  for (const t of tables) {
    for (const op of OPS) {
      const at = (sql: string) => sql.replaceAll("$.", `${op.row}.`);
      const kind = op.del && t.owns ? "'del'" : "'put'";
      const when = op.event === "UPDATE" && t.updateWhen ? ` WHEN ${t.updateWhen}` : "";
      const name = t.table.startsWith("live_") ? t.table : `live_${t.table}`;
      out.push(
        [
          `CREATE TRIGGER \`${name}_${op.suffix}\` AFTER ${op.event} ON \`${t.table}\`${when} BEGIN`,
          "\tINSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)",
          `\tSELECT ${at(t.project)}, ${at(t.kind)}, ${kind}, i, ${at(t.parent)}, unixepoch() * 1000 FROM (SELECT ${at(t.item)} AS i) WHERE i IS NOT NULL;`,
          "END;",
        ].join("\n"),
      );
    }
  }
  return out.join("--> statement-breakpoint\n");
}

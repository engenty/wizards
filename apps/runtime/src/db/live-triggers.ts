/**
 * The triggers that fill `live_change` (docs/plans/live-changes.md, 1). One entry per table
 * names the item a write changes; `pnpm --filter @engenty/wizards-runtime exec tsx
 * scripts/live-triggers.ts` prints the SQL that migration 0023 carries, or with a table's name
 * that table's alone (0026); 0031 carries all of them, under the space's names. Unlike the two-way sync's triggers (0022) they have no guard, since
 * a pulled write is a change on this side's screen too, and they count wizard-owned pages and
 * tables, which the studio shows as shared lists.
 */

export interface LiveTable {
  table: string;
  /** SQL over `$` (`new` or `old`) for the item's space, kind (a `LiveKind`), id and parent. */
  space: string;
  kind: string;
  item: string;
  parent: string;
  /** The write deletes the item itself; otherwise a delete here changes its owner (a `put`). */
  owns: boolean;
  /** Logs an update only when this holds (SQL over `old` and `new`): a heartbeat is no change. */
  updateWhen?: string;
}

const ofWizard = "(SELECT space_id FROM wizard WHERE id = $.wizard_id)";

export const LIVE_TABLES: LiveTable[] = [
  { table: "space", space: "$.id", kind: "'space'", item: "$.id", parent: "NULL", owns: true },
  {
    table: "wizard",
    space: "$.space_id",
    kind: "'wizard'",
    item: "$.id",
    parent: "NULL",
    owns: true,
  },
  {
    table: "wizard_file",
    space: ofWizard,
    kind: "'wizard'",
    item: "$.wizard_id",
    parent: "NULL",
    owns: false,
  },
  {
    table: "wizard_translation",
    space: ofWizard,
    kind: "'translation'",
    item: "$.wizard_id || ':' || $.lang",
    parent: "$.wizard_id",
    owns: true,
  },
  {
    table: "wizard_message",
    space: ofWizard,
    kind: "'message'",
    item: "$.id",
    parent: "$.wizard_id",
    owns: true,
  },
  {
    table: "space_page",
    space: "$.space_id",
    kind: "'page'",
    item: "$.id",
    parent: "$.wizard_id",
    owns: true,
  },
  {
    table: "space_table",
    space: "$.space_id",
    kind: "'table'",
    item: "$.id",
    parent: "$.wizard_id",
    owns: true,
  },
  {
    table: "space_table_row",
    space: "(SELECT space_id FROM space_table WHERE id = $.table_id)",
    kind: "'row'",
    item: "$.id",
    parent: "$.table_id",
    owns: true,
  },
  {
    table: "space_category",
    space: "$.space_id",
    kind: "'category'",
    item: "$.id",
    parent: "NULL",
    owns: true,
  },
  {
    table: "space_category_value",
    space: "(SELECT space_id FROM space_category WHERE id = $.category_id)",
    kind: "'category'",
    item: "$.category_id",
    parent: "NULL",
    owns: false,
  },
  {
    table: "space_item_category",
    space: "$.space_id",
    kind: "CASE WHEN $.page_id IS NOT NULL THEN 'page' WHEN $.row_id IS NOT NULL THEN 'row' WHEN $.table_id IS NOT NULL THEN 'table' ELSE 'file' END",
    item: "COALESCE($.page_id, $.row_id, $.table_id, $.file_id)",
    parent:
      "CASE WHEN $.row_id IS NOT NULL THEN (SELECT table_id FROM space_table_row WHERE id = $.row_id) END",
    owns: false,
  },
  {
    table: "space_file",
    space: "$.space_id",
    kind: "'file'",
    item: "$.id",
    parent: "NULL",
    owns: true,
  },
  {
    table: "space_connector",
    space: "$.space_id",
    kind: "'connector'",
    item: "$.space_id || ':' || $.id",
    parent: "NULL",
    owns: true,
  },
  // Migration 0030.
  {
    table: "space_skill",
    space: "$.space_id",
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
  space: "NULL",
  kind: "'presence'",
  item: "$.kind || ':' || $.item",
  parent: "$.kind",
  owns: false,
  updateWhen:
    "old.state IS NOT new.state OR old.place IS NOT new.place OR old.name IS NOT new.name",
};

/**
 * Work's chats (behind `workMode`, migration 0029): any change of a chat, its members, its held
 * calls or a section of the sidebar is a change of kind `chat` (the item: the chat, or the
 * section). The feed carries no view of it: the stream checks each against the person (a private
 * chat goes to its members only), and the studio reads the chat and the sidebar again. Messages
 * are Mastra's; a new one updates its chat's row (its last message), so it is heard through that.
 */
const ofChat = "(SELECT space_id FROM chat WHERE id = $.chat_id)";
export const CHAT_TABLES: LiveTable[] = [
  {
    table: "chat",
    space: "$.space_id",
    kind: "'chat'",
    item: "$.id",
    parent: "NULL",
    owns: true,
  },
  {
    table: "chat_member",
    space: ofChat,
    kind: "'chat'",
    item: "$.chat_id",
    parent: "NULL",
    owns: false,
  },
  {
    table: "chat_approval",
    space: ofChat,
    kind: "'chat'",
    item: "$.chat_id",
    parent: "NULL",
    owns: false,
  },
  {
    table: "chat_section",
    space: "$.space_id",
    kind: "'chat'",
    item: "$.id",
    parent: "'section'",
    owns: true,
  },
];

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
          "\tINSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)",
          `\tSELECT ${at(t.space)}, ${at(t.kind)}, ${kind}, i, ${at(t.parent)}, unixepoch() * 1000 FROM (SELECT ${at(t.item)} AS i) WHERE i IS NOT NULL;`,
          "END;",
        ].join("\n"),
      );
    }
  }
  return out.join("--> statement-breakpoint\n");
}

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One line per run that ended. The table's name begins with the plugin's id. */
export const entry = sqliteTable("run_log_entry", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  wizardId: text("wizard_id").notNull(),
  /** The space the wizard belongs to; lines kept before `0002_space.sql` have none. */
  spaceId: text("space_id"),
  title: text("title").notNull(),
  mode: text("mode", { enum: ["test", "live"] }).notNull(),
  status: text("status", { enum: ["done", "failed", "cancelled"] }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }).notNull(),
});

export type Entry = typeof entry.$inferSelect;

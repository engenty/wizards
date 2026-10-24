// Prints the triggers of `live_change` (src/db/live-triggers.ts) for a migration: the items'
// (0023), with `presence` those of `live_presence` (0024), with a table's name that table's.
import { LIVE_TABLES, liveTriggerSql, PRESENCE_TABLE } from "../src/db/live-triggers.js";

const arg = process.argv[2];
const one = LIVE_TABLES.filter((t) => t.table === arg);
process.stdout.write(
  `${arg === "presence" ? liveTriggerSql([PRESENCE_TABLE]) : one.length ? liveTriggerSql(one) : liveTriggerSql()}\n`,
);

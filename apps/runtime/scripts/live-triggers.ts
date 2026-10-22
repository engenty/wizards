// Prints the triggers of `live_change` (src/db/live-triggers.ts) for a migration: the items'
// (0023), or with `presence` those of `live_presence` (0024).
import { liveTriggerSql, PRESENCE_TABLE } from "../src/db/live-triggers.js";

process.stdout.write(
  `${process.argv[2] === "presence" ? liveTriggerSql([PRESENCE_TABLE]) : liveTriggerSql()}\n`,
);

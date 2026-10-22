// Prints the triggers of `live_change` (src/db/live-triggers.ts) for a migration.
import { liveTriggerSql } from "../src/db/live-triggers.js";

process.stdout.write(`${liveTriggerSql()}\n`);

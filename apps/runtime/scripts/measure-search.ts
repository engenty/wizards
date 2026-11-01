// Times one search of Knowledge, as the palette asks it: at once without the classifier, then with
// it. Runs against DATA_DIR's tenant, as its owner.
//
//   DATA_DIR=… FEATURES=dateien=on,knowledgeTree=on pnpm exec tsx --conditions=wizards-source \
//     scripts/measure-search.ts <spaceId> "<query>" [more queries …] [--rounds 3]
import { parseArgs } from "node:util";
import { subjectsOfPerson } from "../src/broker/rwx.js";
import { withTenant } from "../src/db/client.js";
import { searchKnowledge } from "../src/services/space-index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rounds: { type: "string", default: "3" },
    tenant: { type: "string", default: "local" },
  },
});
const [spaceId, ...queries] = positionals;
if (!spaceId || !queries.length) {
  console.error('Usage: tsx scripts/measure-search.ts <spaceId> "<query>" … [--rounds N]');
  process.exit(1);
}
const who = subjectsOfPerson("local", "owner");

await withTenant(values.tenant, async () => {
  for (const query of queries) {
    for (let round = 1; round <= Number(values.rounds); round++) {
      for (const check of [false, true]) {
        const start = performance.now();
        const found = await searchKnowledge(spaceId, query, { who, check, limit: 12 });
        const total = Math.round(performance.now() - start);
        console.log(
          JSON.stringify({
            query,
            round,
            check,
            total,
            hits: found.hits.length,
            hidden: found.hidden.length,
            candidates: found.candidates,
            checked: found.checked,
            late: found.late,
          }),
        );
      }
    }
  }
});
process.exit(0);

// Writes packages/engine/src/step-prompts.ts: the prompt sections a run's steps read, from the
// prompt files here (src/prompts), so the engine reads no files. `pnpm prompts:engine` runs it;
// test/step-prompts.test.ts fails while the module is behind the files.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stepPromptsModule } from "./step-prompts.js";

const out = join(import.meta.dirname, "../../../packages/engine/src/step-prompts.ts");
writeFileSync(out, stepPromptsModule());
console.log(`wrote ${out}`);

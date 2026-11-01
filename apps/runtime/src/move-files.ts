// `wizards move-files` where there is no `wizards` command: in the cloud runtime's container,
// `node apps/runtime/dist/move-files.js` with the runtime's environment (cli/move-files.ts).
import { moveFiles } from "./cli/move-files.js";

process.exit(await moveFiles());

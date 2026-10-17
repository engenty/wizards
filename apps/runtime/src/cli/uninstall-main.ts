import { layout } from "./home.js";
import { nodeIsCurrent } from "./machine.js";
import { parseUninstall, uninstall } from "./uninstall.js";

/**
 * `wizards uninstall` on its own: bin/wizards.mjs starts it instead of main.ts, whose modules make
 * the install folder, its data folder and a secret when they load (install-env.ts, env.ts,
 * db/client.ts). An uninstall must find the computer as it is, and leave nothing behind.
 */
if (!nodeIsCurrent()) {
  console.error(`engenty wizards needs Node.js 24.11 or newer. This is ${process.version}.`);
  process.exit(1);
}
const options = parseUninstall(process.argv.slice(2));
if (typeof options === "string") {
  console.error(options);
  process.exitCode = 2;
} else {
  process.exitCode = await uninstall(layout(), options);
}

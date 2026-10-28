import * as p from "@clack/prompts";
import {
  defaultFeatures,
  FEATURE_NAME,
  parseFeatures,
  resolveFeatures,
} from "@engenty/wizards-shared/features";
import { declaredFeatures, featuresFile, fileFeatures, writeFeature } from "../features.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { pluginDirs } from "../plugins/loader.js";
import { proModulesDir } from "../plugins/pro-state.js";
import { cmd, spelled, tilde } from "./ui.js";

/**
 * `wizards features` — the feature switches of this install, from its `.features` file. Not in
 * the help: for whoever works on a part before it is on for everyone.
 *
 *   features                 what is on, and where that comes from (in a terminal: a checkbox list)
 *   features <name> on|off   put a switch into the file
 *   features <name> default  take it out again
 */
export async function featuresCommand(args: string[]): Promise<number> {
  const [name, value] = args;
  const file = featuresFile();
  if (!name) {
    // The core's switches and those the plugins here declare, without loading them.
    const found = discoverPlugins([...pluginDirs(), proModulesDir()]).found;
    const declared = declaredFeatures(found);
    const fromEnv = parseFeatures(process.env.FEATURES ?? "");
    const fromFile = fileFeatures(file);
    const all = resolveFeatures(defaultFeatures(declared), fromEnv, fromFile);
    const names = [
      ...new Set([...Object.keys(declared), ...Object.keys(fromEnv), ...Object.keys(fromFile)]),
    ];
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return pickFeatures(names, declared, fromEnv, fromFile, all, file);
    }
    for (const n of names) {
      const source = n in fromFile ? "file" : n in fromEnv ? "FEATURES" : "default";
      const d = declared[n];
      const kind = d ? d.kind : "?";
      console.log(
        `${all[n] ? "on " : "off"}  ${n.padEnd(28)} ${kind.padEnd(8)} ${source.padEnd(9)} ${spelled(d?.label ?? "")}`,
      );
    }
    console.log(
      spelled(
        `\nFile: ${tilde(file)}\nWhile engenty wizards runs, account and organization switches apply on top of these.`,
      ),
    );
    return 0;
  }
  if (!FEATURE_NAME.test(name)) {
    console.error(`“${name}” isn’t a valid switch name (e.g. teamPlans, contacts.leadScoring).`);
    return 2;
  }
  if (value === "on" || value === "off" || value === "default") {
    writeFeature(name, value === "default" ? null : value === "on", file);
    console.log(
      value === "default"
        ? `${name} follows the default again (${tilde(file)}). engenty wizards picks this up straight away.`
        : `${name} is ${value} on this computer (${tilde(file)}). engenty wizards picks this up straight away.`,
    );
    return 0;
  }
  console.error(`Usage: ${cmd(`features ${name} on|off|default`)}`);
  return 2;
}

/**
 * The switches as a checkbox list. What is ticked is on; a switch that ends up as it would be
 * without the file leaves the file, so it follows the default again.
 */
async function pickFeatures(
  names: string[],
  declared: ReturnType<typeof declaredFeatures>,
  fromEnv: Record<string, boolean>,
  fromFile: Record<string, boolean>,
  all: Record<string, boolean>,
  file: string,
): Promise<number> {
  const without = resolveFeatures(defaultFeatures(declared), fromEnv);
  const answer = await p.multiselect({
    message: spelled("Which switches should be on? (space to switch, enter to save)"),
    options: names.map((n) => ({
      value: n,
      label: n,
      hint: [
        spelled(declared[n]?.label ?? ""),
        n in fromFile ? "set in the file" : n in fromEnv ? "set by FEATURES" : "",
      ]
        .filter(Boolean)
        .join(", "),
    })),
    initialValues: names.filter((n) => all[n]),
    required: false,
  });
  if (p.isCancel(answer)) {
    p.cancel("Nothing changed.");
    return 130;
  }
  const changed: string[] = [];
  for (const n of names) {
    const on = answer.includes(n);
    const next = on === Boolean(without[n]) ? undefined : on;
    if (next !== fromFile[n]) {
      writeFeature(n, next ?? null, file);
      changed.push(`${n} ${on ? "on" : "off"}${next === undefined ? " (default)" : ""}`);
    }
  }
  p.outro(
    changed.length
      ? spelled(
          `${changed.join(", ")}. Saved in ${tilde(file)}; engenty wizards picks this up straight away.`,
        )
      : "Nothing changed.",
  );
  return 0;
}

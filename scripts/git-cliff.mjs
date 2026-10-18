// git-cliff as `pnpm release` and `pnpm about:data` run it: with cliff.toml, from the repo root.
// The binary on PATH, the workspace's own, or `pnpm dlx` when neither is installed.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

let CLIFF = null;
function resolveCliff() {
  for (const probe of [["git-cliff"], ["pnpm", "exec", "git-cliff"]]) {
    try {
      execFileSync(probe[0], [...probe.slice(1), "--version"], { cwd: root, stdio: "ignore" });
      return probe;
    } catch {
      // try the next one
    }
  }
  console.log("  git-cliff is not installed here — using `pnpm dlx git-cliff`");
  return ["pnpm", "dlx", "git-cliff"];
}

/** Runs git-cliff with the given arguments and returns what it prints. */
export function cliff(args) {
  CLIFF = CLIFF ?? resolveCliff();
  return execFileSync(CLIFF[0], [...CLIFF.slice(1), "--config", "cliff.toml", ...args], {
    cwd: root,
    encoding: "utf8",
    // `--context` is the structured JSON of every commit: far past the 1 MB default.
    maxBuffer: 256 * 1024 * 1024,
    // git-cliff logs to stderr; only its errors are worth a line here.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** git-cliff's context: every release with its commits, the newest first. */
export function cliffContext(args = []) {
  return JSON.parse(cliff(["--context", ...args]));
}

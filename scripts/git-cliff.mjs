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

/** The pull request numbers a commit's subject ends with, `(#12)` or `(#12, #15)`. */
const prNumbers = (message) => [...message.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

/** One docs entry for a release, with the pull requests it stands for. */
function docsMessage(messages) {
  const prs = [...new Set(messages.flatMap(prNumbers))].sort((a, b) => a - b);
  return `documentation updates${prs.length > 0 ? ` (${prs.map((n) => `#${n}`).join(", ")})` : ""}`;
}

/**
 * A release's docs commits as one entry, where the first of them was: small docs changes
 * would otherwise crowd out what changed in the product. One docs commit stays as it is.
 */
export function groupDocsCommits(commits) {
  const docs = commits.filter((commit) => commit.group === "Docs");
  if (docs.length < 2) {
    return commits;
  }
  const message = docsMessage(docs.map((commit) => (commit.message ?? "").split(/\r?\n/, 1)[0]));
  return commits
    .filter((commit) => commit.group !== "Docs" || commit === docs[0])
    .map((commit) => (commit === docs[0] ? { ...commit, message, scope: null } : commit));
}

/** The same for rendered release blocks (`- DOCS …` lines), one or more `## [x.y.z]` sections. */
export function groupDocsLines(markdown) {
  return markdown
    .split(/^(?=## \[)/m)
    .map((section) => {
      const lines = section.split("\n");
      const docs = lines.filter((line) => line.startsWith("- DOCS "));
      if (docs.length < 2) {
        return section;
      }
      const line = `- DOCS ${docsMessage(docs).replace(/^./, (c) => c.toUpperCase())}`;
      return lines
        .filter((l) => !l.startsWith("- DOCS ") || l === docs[0])
        .map((l) => (l === docs[0] ? line : l))
        .join("\n");
    })
    .join("");
}

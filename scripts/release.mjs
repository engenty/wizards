#!/usr/bin/env node
// Cuts a release, locally and step by step. Reads the Conventional Commits since the last tag
// via git-cliff, shows the compact changelog, asks patch / minor / major, lets you edit the
// entry, then writes CHANGELOG.md and the app's copies under apps/web/src/about, bumps the root
// package.json and commits on a branch release/vX.Y.Z. It never pushes: the
// release reaches main as a pull request like any change. Once that is squash-merged,
// `pnpm release:tag` sets the tag vX.Y.Z on main's release commit and pushes it — the tag ships.
//
//   pnpm release               full: changelog + version bump + commit on release/vX.Y.Z
//   pnpm release --changelog   only refresh the changelog files: commits since the last tag
//                              stay under "Unreleased"; no bump, no commit
//   pnpm release --tag         (pnpm release:tag) tag main's merged release commit, push the tag
//   pnpm release --help
//
//   RELEASE_BUMP=patch|minor|major|current   skips the questions (automation)
//
// git-cliff owns parsing and the format (cliff.toml). This script is the interactive layer
// around it. git-cliff's full context is written to the root changelog.json, a generated file
// that is not tracked: scripts/write-about-data.mjs cuts the app's changelog from it.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { cliff, cliffContext } from "./git-cliff.mjs";

const root = resolve(import.meta.dirname, "..");
const PKG = join(root, "package.json");
/** The plugin's manifests: Claude Code's, and the portable one (ChatGPT, Codex, Cursor, VS Code). */
const PLUGIN_MANIFESTS = ["plugin/.claude-plugin/plugin.json", "plugin/plugin.json"];
const CHANGELOG = join(root, "CHANGELOG.md");
const CHANGELOG_JSON = join(root, "changelog.json");
const CHANGELOG_ONLY = process.argv.includes("--changelog");
const TAG_ONLY = process.argv.includes("--tag");
/** What a release commit holds. */
const RELEASE_FILES = [
  "package.json",
  ...PLUGIN_MANIFESTS,
  "CHANGELOG.md",
  "apps/web/src/about/changelog.json",
  "apps/web/src/about/oss-credits.json",
  "COPYRIGHTS.md",
];

// ── a small terminal UI ──────────────────────────────────────────────────────
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (n) => (s) => (TTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const c = {
  b: col(1),
  dim: col(2),
  red: col(31),
  green: col(32),
  yellow: col(33),
  cyan: col(36),
  gray: col(90),
};
const out = (s = "") => process.stdout.write(`${s}\n`);
const die = (m) => {
  out(`\n${c.red("✖")} ${m}`);
  process.exit(1);
};

async function select(label, options) {
  emitKeypressEvents(process.stdin);
  let i = 0;
  const draw = (first) => {
    if (!first) {
      process.stdout.write(`\x1b[${options.length}A`);
    }
    for (let j = 0; j < options.length; j++) {
      process.stdout.write("\r\x1b[K");
      const o = options[j];
      const hint = o.hint ? c.dim(`  ${o.hint}`) : "";
      out(j === i ? `  ${c.cyan("❯")} ${c.b(o.label)}${hint}` : `    ${c.gray(o.label)}${hint}`);
    }
  };
  out(`\n${c.b(label)}`);
  draw(true);
  return await new Promise((done) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    const onKey = (_s, key) => {
      if (!key) {
        return;
      }
      if (key.ctrl && key.name === "c") {
        process.exit(130);
      } else if (key.name === "up" || key.name === "k") {
        i = (i - 1 + options.length) % options.length;
        draw();
      } else if (key.name === "down" || key.name === "j") {
        i = (i + 1) % options.length;
        draw();
      } else if (key.name === "return") {
        process.stdin.removeListener("keypress", onKey);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();
        done(options[i].value);
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

// ── git ─────────────────────────────────────────────────────────────────────
const git = (args) =>
  execSync(`git ${args}`, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
const quiet = (args) => {
  try {
    execSync(`git ${args}`, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function bump(version, level) {
  const [a, b, d] = version.replace(/^v/, "").split(".").map(Number);
  if (level === "major") {
    return `${a + 1}.0.0`;
  }
  if (level === "minor") {
    return `${a}.${b + 1}.0`;
  }
  if (level === "patch") {
    return `${a}.${b}.${d + 1}`;
  }
  return `${a}.${b}.${d}`;
}

function openEditor(text) {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const file = join(tmpdir(), `engenty-wizards-release-${Date.now()}.md`);
  writeFileSync(file, text, "utf8");
  const r = spawnSync(editor, [file], { stdio: "inherit" });
  if (r.status !== 0) {
    out(c.yellow("  the editor exited non-zero — keeping the draft as it is"));
  }
  return readFileSync(file, "utf8").trimEnd();
}

/** The header of cliff.toml, for a CHANGELOG.md that does not exist yet. */
function changelogHeader() {
  const toml = readFileSync(join(root, "cliff.toml"), "utf8");
  return /^header = """\n([\s\S]*?)"""/m.exec(toml)?.[1].trim() ?? "# Changelog";
}

/**
 * Puts a release block on top of CHANGELOG.md. An "Unreleased" section and a section of the
 * same version are replaced, so running this twice leaves one block.
 */
function writeChangelogBlock(block) {
  const md = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : `${changelogHeader()}\n`;
  const heading = /^## \[([^\]]+)\]/m.exec(block)?.[1];
  const marker = md.search(/^## \[/m);
  const head = (marker === -1 ? md : md.slice(0, marker)).trimEnd();
  const sections = marker === -1 ? [] : md.slice(marker).split(/^(?=## \[)/m);
  const kept = sections.filter((section) => {
    const name = /^## \[([^\]]+)\]/.exec(section)?.[1];
    return name !== "Unreleased" && name !== heading;
  });
  const body = [block.trim(), ...kept.map((s) => s.trim())].filter(Boolean).join("\n\n");
  writeFileSync(CHANGELOG, `${head}\n\n${body}\n`, "utf8");
}

/** The root changelog.json (git-cliff's context, not tracked) and from it the app's copies. */
function writeData(context, { credits }) {
  writeFileSync(CHANGELOG_JSON, `${JSON.stringify(context)}\n`, "utf8");
  execFileSync(
    process.execPath,
    [join(root, "scripts", "write-about-data.mjs"), ...(credits ? [] : ["--changelog"])],
    { cwd: root, stdio: "inherit" },
  );
}

function help() {
  out(`
${c.b("pnpm release")} — cut a release from Conventional Commits (via git-cliff)

  pnpm release               full: changelog + bump package.json + commit on release/vX.Y.Z
  pnpm release --changelog   only refresh CHANGELOG.md and the app's copy; commits since the
                             last tag stay under "Unreleased"
  pnpm release:tag           after the release PR is merged: tag main's release commit and
                             push the tag, which ships it
  pnpm release --help

  RELEASE_BUMP=patch|minor|major|current   skips the questions

The release itself never pushes: push the branch and open a pull request.
`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }
  if (TAG_ONLY) {
    tagMerged();
    return;
  }
  if (!existsSync(join(root, "cliff.toml"))) {
    die("cliff.toml not found at the repo root.");
  }

  const current = JSON.parse(readFileSync(PKG, "utf8")).version || "0.0.0";
  let lastTag = "";
  try {
    lastTag = git('describe --tags --abbrev=0 --match "v[0-9]*"');
  } catch {
    lastTag = "";
  }
  const branch = git("rev-parse --abbrev-ref HEAD");
  out(
    `${c.dim("current")} ${c.b(`v${current}`)}   ${c.dim("last tag")} ${c.b(lastTag || "(none)")}   ${c.dim("branch")} ${branch === "main" ? branch : c.yellow(`${branch} (not main)`)}${CHANGELOG_ONLY ? c.yellow("   [changelog]") : ""}`,
  );

  const unreleased = cliffContext(["--unreleased"]).flatMap((r) => r.commits || []);

  if (CHANGELOG_ONLY) {
    if (unreleased.length > 0) {
      writeChangelogBlock(cliff(["--unreleased", "--strip", "all"]));
    }
    writeData(cliffContext(), { credits: false });
    out(
      `\n${c.green("✔")} CHANGELOG.md + the app's changelog written — ${unreleased.length} unreleased commit(s)`,
    );
    out(c.dim("  --changelog: no version bump, commit or tag."));
    return;
  }

  if (unreleased.length === 0) {
    die("No unreleased commits since the last tag. Nothing to release.");
  }
  if (!quiet("diff --cached --quiet")) {
    die("There are staged changes. Commit or unstage them first — the release is its own commit.");
  }
  out(`\n${c.b("Unreleased changes:")}`);
  out(
    cliff(["--unreleased", "--strip", "all"])
      .replace(/^## .*$/m, "")
      .trimEnd(),
  );

  // git-cliff suggests a bump; you choose. A version of package.json that was never tagged
  // (the first release) can be released as it is.
  let suggested = "patch";
  try {
    const next = cliff(["--bumped-version"]).trim().replace(/^v/, "");
    const [a, b] = current.split(".").map(Number);
    const [na, nb] = next.split(".").map(Number);
    suggested = na > a ? "major" : nb > b ? "minor" : "patch";
  } catch {
    // keep the default
  }
  const currentIsFree = !quiet(`rev-parse --quiet --verify refs/tags/v${current}`);
  const levels = [...(currentIsFree ? ["current"] : []), "patch", "minor", "major"];
  if (currentIsFree) {
    suggested = "current";
  }
  const envBump = process.env.RELEASE_BUMP;
  if (envBump && !levels.includes(envBump)) {
    die(`RELEASE_BUMP must be one of: ${levels.join(", ")}`);
  }
  const ordered = [suggested, ...levels.filter((l) => l !== suggested)];
  const level =
    envBump ??
    (await select(
      `Version  ${c.dim(`(suggested: ${suggested})`)}`,
      ordered.map((l) => ({
        label: `${l.padEnd(7)} → v${bump(current, l)}`,
        value: l,
        hint:
          l === "current"
            ? "package.json's version, not tagged yet"
            : l === suggested
              ? "suggested"
              : "",
      })),
    ));
  const version = bump(current, level);
  const tag = `v${version}`;
  if (quiet(`rev-parse --quiet --verify refs/tags/${tag}`)) {
    die(`The tag ${tag} exists already.`);
  }

  // The release block, to accept or edit.
  let block = cliff(["--unreleased", "--tag", tag, "--strip", "all"]).trim();
  const choice = envBump
    ? "accept"
    : await select(`Release ${c.b(tag)} — the entry above`, [
        { label: "Accept as it is", value: "accept" },
        { label: `Edit in $EDITOR (${process.env.EDITOR || "vi"})`, value: "edit" },
        { label: "Cancel", value: "cancel" },
      ]);
  if (choice === "cancel") {
    die("Cancelled — nothing written.");
  }
  if (choice === "edit") {
    block = openEditor(block);
  }

  // The tag does not exist yet, so git-cliff's context still calls these commits unreleased:
  // stamp the new version onto that section.
  writeChangelogBlock(block);
  const context = cliffContext();
  const stampedAt = Math.floor(Date.now() / 1000);
  for (const release of context) {
    if (release.version == null) {
      release.version = tag;
      release.timestamp = stampedAt;
    }
  }
  writeData(context, { credits: true });
  out(`\n${c.green("✔")} CHANGELOG.md + the app's changelog written for ${c.b(tag)}`);

  // Bump, commit, tag.
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  pkg.version = version;
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  // The plugin's manifests say the same version: the plugin is installed from GitHub too.
  for (const file of PLUGIN_MANIFESTS) {
    const manifest = JSON.parse(readFileSync(join(root, file), "utf8"));
    manifest.version = version;
    writeFileSync(join(root, file), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  // main takes changes only through pull requests: the release is a branch of its own.
  const releaseBranch = `release/${tag}`;
  if (git("rev-parse --abbrev-ref HEAD") !== releaseBranch) {
    git(`switch -c ${releaseBranch}`);
  }
  git(`add ${RELEASE_FILES.join(" ")}`);
  execSync(`git commit -m "chore(release): ${tag}"`, { cwd: root, stdio: "inherit" });
  out(`\n${c.green("✔")} ${c.b(tag)} committed on ${c.b(releaseBranch)}. Nothing pushed yet.`);
  out(c.dim(`  1. git push -u origin ${releaseBranch}`));
  out(c.dim(`  2. gh pr create --title "chore(release): ${tag}" --body "Release ${tag}."`));
  out(c.dim("  3. once it is squash-merged:  pnpm release:tag"));
  out(
    c.dim(
      "  The tag ships: release.yml publishes the local install, ci.yml deploys the cloud runtime.",
    ),
  );
}

/**
 * Tags main's newest commit when it is a merged release (`chore(release): vX.Y.Z`, the version
 * package.json has there) and pushes the tag. A pull request's squash commit is a new commit, so
 * the tag can only be set after the merge.
 */
function tagMerged() {
  git("fetch origin main --tags");
  const subject = git("log -1 --format=%s origin/main");
  const tag = subject.match(/^chore\(release\): (v\d+\.\d+\.\d+)(?: \(#\d+\))?$/)?.[1];
  if (!tag) {
    die(`main's newest commit is not a merged release: "${subject}"`);
  }
  const version = JSON.parse(git("show origin/main:package.json")).version;
  if (tag !== `v${version}`) {
    die(`The release commit says ${tag}, package.json on main says ${version}.`);
  }
  if (quiet(`rev-parse -q --verify refs/tags/${tag}`)) {
    die(`${tag} is tagged already.`);
  }
  git(`tag -a ${tag} -m "chore(release): ${tag}" origin/main`);
  execSync(`git push origin ${tag}`, { cwd: root, stdio: "inherit" });
  out(`\n${c.green("✔")} ${c.b(tag)} tagged on main and pushed.`);
  out(
    c.dim(
      "  The tag ships: release.yml publishes the local install, ci.yml deploys the cloud runtime.",
    ),
  );
}

main().catch((e) => die(e?.stderr?.toString().trim() || e?.message || String(e)));

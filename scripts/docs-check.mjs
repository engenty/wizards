#!/usr/bin/env node
// Which release each page of docs/content describes: `version` in its frontmatter is the release
// whose code the page was last checked against. Fails on a page without one, or with one newer
// than the root package.json; lists the pages behind the current release, with the commits since
// their release that touched apps/, packages/ or modules/ (what may have made them wrong).
//
//   pnpm docs:check
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const content = join(root, "docs", "content");
const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }
    return /\.mdx?$/.test(entry.name) ? [path] : [];
  });

const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return x[i] - y[i];
    }
  }
  return 0;
};

const commitsSince = (version) => {
  try {
    return execFileSync(
      "git",
      ["rev-list", "--count", `v${version}..HEAD`, "--", "apps", "packages", "modules"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "?";
  }
};

const problems = [];
const behind = [];
for (const file of walk(content).sort()) {
  const page = relative(content, file);
  const frontmatter = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const version = frontmatter.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  if (!version) {
    problems.push(`${page}: no version`);
  } else if (!/^\d+\.\d+\.\d+$/.test(version)) {
    problems.push(`${page}: version "${version}" is no release`);
  } else if (compare(version, current) > 0) {
    problems.push(`${page}: version ${version} is newer than the release ${current}`);
  } else if (compare(version, current) < 0) {
    behind.push({ page, version });
  }
}

if (behind.length) {
  console.log(`Pages behind ${current} (code commits since their release):`);
  for (const { page, version } of behind) {
    console.log(`  ${page}  ${version}  (${commitsSince(version)})`);
  }
} else if (!problems.length) {
  console.log(`Every page describes ${current}.`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

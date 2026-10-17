import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceFile } from "@engenty-wizards/shared/workspace";
import { env } from "../env.js";
import { getBlob } from "../files/blobs.js";

const exec = promisify(execFile);

/**
 * Skill packages a film step hands its client: folders of SKILL.md files with their references,
 * read the same way by every client. A platform package is fetched once from its source at a
 * pinned version and kept in the data folder; a wizard can also bring its own in the workspace
 * (`skills/<name>/SKILL.md`).
 */
export interface SkillPackage {
  name: string;
  /** Where it comes from and at which version — what a person checks before trusting it. */
  source: string;
  version: string;
  licence: string;
  /** A gzipped tarball; `folder` inside it holds one folder per skill. */
  tarball: string;
  folder: string;
}

export const PLATFORM_SKILLS: Record<string, SkillPackage> = {
  hyperframes: {
    name: "hyperframes",
    source: "https://github.com/heygen-com/hyperframes",
    version: "6308727b85726433e6a1e148b608d8cb11085114",
    licence: "Apache-2.0",
    tarball:
      "https://codeload.github.com/heygen-com/hyperframes/tar.gz/6308727b85726433e6a1e148b608d8cb11085114",
    folder: "skills",
  },
};

const fetching = new Map<string, Promise<string>>();

/** The folder holding a platform package's skills; fetched on first use. */
export function platformSkills(name: string): Promise<string> {
  const pkg = PLATFORM_SKILLS[name];
  if (!pkg) {
    return Promise.reject(new Error(`There is no skill package “${name}”.`));
  }
  const dir = join(env.dataDir, "skills", `${pkg.name}@${pkg.version.slice(0, 12)}`);
  if (existsSync(join(dir, ".complete"))) {
    return Promise.resolve(dir);
  }
  let pending = fetching.get(name);
  if (!pending) {
    pending = fetchPackage(pkg, dir).finally(() => fetching.delete(name));
    fetching.set(name, pending);
  }
  return pending;
}

async function fetchPackage(pkg: SkillPackage, dir: string): Promise<string> {
  const res = await fetch(pkg.tarball);
  if (!res.ok) {
    throw new Error(`The skill package “${pkg.name}” could not be loaded (${res.status}).`);
  }
  const tmp = `${dir}.part`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const archive = join(tmp, "package.tar.gz");
  await writeFile(archive, Buffer.from(await res.arrayBuffer()));
  // GitHub's tarball has one top folder (<repo>-<sha>); only its skills folder is kept.
  await exec("tar", ["-xzf", archive, "-C", tmp, "--strip-components=1", `*/${pkg.folder}/*`]);
  const skills = join(tmp, pkg.folder);
  for (const entry of await readdir(skills, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(skills, entry.name, "SKILL.md"))) {
      await rm(join(skills, entry.name), { recursive: true, force: true });
    }
  }
  await writeFile(
    join(skills, "PACKAGE.json"),
    JSON.stringify(
      { name: pkg.name, source: pkg.source, version: pkg.version, licence: pkg.licence },
      null,
      1,
    ),
  );
  await writeFile(join(skills, ".complete"), new Date().toISOString());
  await rm(dir, { recursive: true, force: true });
  await rename(skills, dir);
  await rm(tmp, { recursive: true, force: true });
  return dir;
}

/**
 * Puts the step's skill packages into `target` (one folder per skill): platform packages by
 * name, workspace packages (`skills/<name>`) from the wizard's files. Returns the skill names.
 */
export async function placeSkills(
  names: string[],
  files: WorkspaceFile[],
  target: string,
): Promise<string[]> {
  await mkdir(target, { recursive: true });
  const placed: string[] = [];
  for (const name of names) {
    if (name.startsWith("skills/")) {
      const prefix = `${name.replace(/\/+$/, "")}/`;
      const own = files.filter((f) => f.path.startsWith(prefix));
      const skill = prefix.split("/")[1];
      for (const f of own) {
        const dest = join(target, skill, f.path.slice(prefix.length));
        await mkdir(join(dest, ".."), { recursive: true });
        await writeFile(dest, await getBlob(f.hash));
      }
      placed.push(skill);
      continue;
    }
    const dir = await platformSkills(name);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await cp(join(dir, entry.name), join(target, entry.name), { recursive: true });
        placed.push(entry.name);
      }
    }
  }
  return placed;
}

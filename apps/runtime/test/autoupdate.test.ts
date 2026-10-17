import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPendingUpdate,
  autoUpdatePolicy,
  checkForUpdate,
  readUpdateState,
  type UpdateDeps,
  updateNotice,
} from "../src/cli/autoupdate.js";
import { type Layout, layout } from "../src/cli/home.js";
import {
  currentVersion,
  installedVersions,
  prune,
  RUNTIME_PACKAGE,
  switchTo,
  versionIn,
} from "../src/cli/versions.js";

// Every test works in a home folder of its own under the temp folder, never the real one.
let home: string;
let paths: Layout;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wizards-autoupdate-"));
  paths = layout(join(home, ".engenty", "wizards"));
  mkdirSync(paths.bin, { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * An npm prefix with the runtime of this version in it: under its name of now, or as `wizards`
 * (up to 0.7.4), or `launcher`: the package `wizards` of now, without the runtime.
 */
function fakePrefix(prefix: string, version: string, as: "runtime" | "legacy" | "launcher" = "runtime") {
  const name = as === "runtime" ? RUNTIME_PACKAGE : "wizards";
  const pkg = join(prefix, "node_modules", name);
  mkdirSync(join(pkg, "bin"), { recursive: true });
  if (as !== "launcher") {
    mkdirSync(join(pkg, "apps", "runtime", "dist"), { recursive: true });
  }
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(prefix, "package.json"), "{}");
}

/** An install as install.sh made it up to 0.6.2: runtime/ is the prefix itself. */
function legacyInstall(version: string) {
  fakePrefix(paths.runtime, version, "legacy");
  writeFileSync(
    join(paths.bin, "wizards"),
    `#!/bin/sh\nexec "${paths.tools}/node/bin/node" "${paths.runtime}/node_modules/wizards/bin/wizards.mjs" "$@"\n`,
  );
}

const on = { on: true, reason: "on" };

/** npm's registry naming `version` as latest; `fails` makes the install fail. */
function fakeRegistry(version: string, fails = false): UpdateDeps {
  return {
    now: () => new Date("2026-10-15T12:00:00Z"),
    fetch: (async (url: string) => {
      expect(String(url)).toBe("https://registry.npmjs.org/@engenty/wizards-runtime/latest");
      return Response.json({ name: RUNTIME_PACKAGE, version });
    }) as typeof fetch,
    npmInstall: async (_paths, prefix, spec) => {
      expect(spec).toBe(`@engenty/wizards-runtime@${version}`);
      if (fails) {
        throw new Error("npm install of the new version failed (exit 1)");
      }
      fakePrefix(prefix, version);
    },
  };
}

describe("the version folders", () => {
  it("moves an install from before them into its folder and switches, keeping the old path", () => {
    legacyInstall("0.6.2");
    expect(currentVersion(paths)).toBe("0.6.2");
    fakePrefix(join(paths.runtime, "0.7.0"), "0.7.0");
    switchTo(paths, "0.7.0");
    expect(installedVersions(paths)).toEqual(["0.6.2", "0.7.0"]);
    expect(currentVersion(paths)).toBe("0.7.0");
    // The old command's path leads to the current version.
    expect(versionIn(paths.runtime)).toBe("0.7.0");
  });

  it("refuses a version that is not complete", () => {
    legacyInstall("0.6.2");
    mkdirSync(join(paths.runtime, "0.7.0"));
    expect(() => switchTo(paths, "0.7.0")).toThrow(/no complete runtime/);
    expect(currentVersion(paths)).toBe("0.6.2");
  });

  it("reads the runtime under its old name, and not the launcher that has that name now", () => {
    fakePrefix(join(paths.runtime, "0.7.4"), "0.7.4", "legacy");
    fakePrefix(join(paths.runtime, "0.8.0"), "0.8.0", "launcher");
    expect(installedVersions(paths)).toEqual(["0.7.4"]);
    expect(() => switchTo(paths, "0.8.0")).toThrow(/no complete runtime/);
  });

  it("prunes all but the kept and the current one", () => {
    for (const v of ["0.6.0", "0.6.2", "0.7.0"]) {
      fakePrefix(join(paths.runtime, v), v);
    }
    switchTo(paths, "0.7.0");
    expect(prune(paths, ["0.6.2"])).toEqual(["0.6.0"]);
    expect(installedVersions(paths)).toEqual(["0.6.2", "0.7.0"]);
  });
});

describe("whether it updates itself", () => {
  const installed = { installed: true, note: {} };

  it("is on for an install set up in a terminal", () => {
    expect(autoUpdatePolicy(paths, { ...installed, env: {} }).on).toBe(true);
  });

  it("is never on for npx or a checkout", () => {
    expect(autoUpdatePolicy(paths, { installed: false, env: {} }).on).toBe(false);
  });

  it("is off with WIZARDS_DISABLE_AUTOUPDATE, from the terminal or the .env, even when turned on", () => {
    const note = { autoUpdate: true };
    expect(
      autoUpdatePolicy(paths, { installed: true, note, env: { WIZARDS_DISABLE_AUTOUPDATE: "1" } })
        .on,
    ).toBe(false);
    writeFileSync(paths.envFile, "WIZARDS_DISABLE_AUTOUPDATE=1\n");
    expect(autoUpdatePolicy(paths, { installed: true, note, env: {} }).on).toBe(false);
  });

  it("is off in CI and after a setup without a terminal, unless turned on", () => {
    expect(autoUpdatePolicy(paths, { ...installed, env: { CI: "true" } }).on).toBe(false);
    expect(autoUpdatePolicy(paths, { ...installed, env: { ENGENTY_WIZARDS_CI: "1" } }).on).toBe(
      false,
    );
    expect(autoUpdatePolicy(paths, { installed: true, note: { unattended: true }, env: {} }).on).toBe(
      false,
    );
    expect(
      autoUpdatePolicy(paths, { installed: true, note: { autoUpdate: true }, env: { CI: "1" } }).on,
    ).toBe(true);
  });

  it("is off when turned off", () => {
    expect(autoUpdatePolicy(paths, { installed: true, note: { autoUpdate: false }, env: {} }).on).toBe(
      false,
    );
  });
});

describe("an update", () => {
  it("installs beside the current one, and switches only at apply", async () => {
    legacyInstall("0.6.2");
    const result = await checkForUpdate(paths, { policy: on }, fakeRegistry("0.7.0"));
    expect(result).toEqual({ kind: "downloaded", version: "0.7.0" });
    // Nothing switched yet: what runs keeps running.
    expect(currentVersion(paths)).toBe("0.6.2");
    expect(versionIn(join(paths.runtime, "0.7.0"))).toBe("0.7.0");
    // A command of 0.7.4 or older finds the runtime under its old name.
    expect(
      readFileSync(join(paths.runtime, "0.7.0", "node_modules", "wizards", "package.json"), "utf8"),
    ).toContain(RUNTIME_PACKAGE);
    expect(readUpdateState(paths).pending?.version).toBe("0.7.0");
    expect(updateNotice(paths, "0.6.2").pending?.version).toBe("0.7.0");

    expect(applyPendingUpdate(paths)).toEqual({
      from: "0.6.2",
      to: "0.7.0",
    });
    expect(currentVersion(paths)).toBe("0.7.0");
    // The one before stays, to go back to.
    expect(installedVersions(paths)).toEqual(["0.6.2", "0.7.0"]);
    const { updated, pending } = updateNotice(paths, "0.7.0");
    expect(pending).toBeNull();
    expect(updated).toMatchObject({ from: "0.6.2", to: "0.7.0" });
    expect(updated?.notes).toContain("/releases/tag/v0.7.0");
    // Applied once only.
    expect(applyPendingUpdate(paths)).toBeNull();
  });

  it("keeps nothing when npm fails", async () => {
    legacyInstall("0.6.2");
    const result = await checkForUpdate(paths, { policy: on }, fakeRegistry("0.7.0", true));
    expect(result.kind).toBe("failed");
    expect(installedVersions(paths)).toEqual([]);
    expect(readUpdateState(paths).pending).toBeUndefined();
    expect(readUpdateState(paths).error).toMatch(/npm install/);
  });

  it("does nothing when off, or when it is the newest already", async () => {
    legacyInstall("0.7.0");
    const deps = fakeRegistry("0.7.0");
    expect((await checkForUpdate(paths, { policy: { on: false, reason: "x" } }, deps)).kind).toBe(
      "off",
    );
    expect((await checkForUpdate(paths, { policy: on }, deps)).kind).toBe("current");
    // Asked within the hour: not again.
    expect((await checkForUpdate(paths, { policy: on }, deps)).kind).toBe("skipped");
    expect(existsSync(join(paths.runtime, "current"))).toBe(false);
  });
});

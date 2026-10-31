import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The broker is complete only when nothing reaches outside around it (docs/plans/broker.md,
 * "What it must be", 1). This walks the source tree: the one reader of a connection's secret is
 * the broker's, and every tool and share target that reaches outside goes through `brokerCall`
 * and says what it reaches. A new tool that fetches on its own fails here.
 */

const SRC = resolve(__dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

const files = walk(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}));
const outside = (dir: string) => files.filter((f) => !f.path.startsWith(dir));

/**
 * Files that fetch on their own: `web_fetch` reads public pages as a model's search does, and the
 * guard is the fetch. `http_request` in the same file goes through `brokerHost` (A6).
 */
const OPEN_FETCHERS = new Set([
  "tools/index.ts", // web_fetch; http_request calls brokerHost
  "tools/net-guard.ts", // the guard itself
]);

describe("one reader of a connection's secret", () => {
  it("is the broker's: nothing else imports its account reader", () => {
    const importers = outside("broker/")
      .filter((f) => /broker\/account(\.js)?["']/.test(f.text))
      .map((f) => f.path);
    expect(importers).toEqual([]);
  });

  it("reads a store's secret only in the broker and the store itself", () => {
    const readers = outside("broker/")
      .filter((f) => f.path !== "store/index.ts" && /\bgetSecret(<[^>]*>)?\(/.test(f.text))
      .map((f) => f.path);
    expect(readers).toEqual([]);
  });

  it("unseals a connection's tokens only in the broker", () => {
    const readers = outside("broker/")
      .filter((f) => /unseal<(StoredTokens|StoredConnection)>/.test(f.text))
      .map((f) => f.path);
    expect(readers).toEqual([]);
  });

  it("has no connectionContext any more", () => {
    const left = files.filter((f) => /\bconnectionContext\b/.test(f.text)).map((f) => f.path);
    expect(left).toEqual([]);
  });
});

describe("every tool and share target that reaches outside", () => {
  const reaching = files.filter(
    (f) =>
      (f.path.startsWith("tools/") || f.path.startsWith("sharing/targets/")) &&
      !OPEN_FETCHERS.has(f.path),
  );

  it("never runs a connector action or a fetch on its own", () => {
    const direct = reaching
      .filter(
        (f) =>
          /\bsafeFetch\(|\bglobalThis\.fetch\b|(^|[^.\w])fetch\(/m.test(f.text) ||
          (/\.handler\(/.test(f.text) && !/\bbrokerCall\(/.test(f.text)),
      )
      .map((f) => f.path);
    expect(direct).toEqual([]);
  });

  it("goes through the broker where it holds an account's token", () => {
    const around = reaching
      .filter(
        (f) =>
          /\baccessToken\b|\bfetchImpl\b/.test(f.text) &&
          !/\bbrokerCall\(|\bctx\s*\.call\(/.test(f.text),
      )
      .map((f) => f.path);
    expect(around).toEqual([]);
  });

  it("registers what it reaches", () => {
    const silent = reaching
      .filter(
        (f) => /\bbrokerCall\(|\bctx\s*\.call\(/.test(f.text) && !/\breachesOutside\(/.test(f.text),
      )
      .map((f) => f.path);
    expect(silent).toEqual([]);
  });

  it("names every file that is still open, so a new one is noticed", () => {
    for (const path of OPEN_FETCHERS) {
      expect(files.some((f) => f.path === path)).toBe(true);
    }
  });
});

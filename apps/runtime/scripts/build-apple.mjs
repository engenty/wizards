// Builds `wizards-apple` (apple/main.swift + Shared.swift) into dist/apple/: Apple Intelligence on a Mac as a
// model for the runtime (src/harness/apple.ts). Only a Mac with Apple silicon and the macOS 26
// SDK (Xcode 26 or its command line tools) can build it; anywhere else there is nothing to
// build, and the runtime offers no Apple Intelligence. Skipped while the build is newer than
// the source.
//
//   node scripts/build-apple.mjs [--force]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sources = ["main.swift", "Shared.swift"].map((f) => join(root, "apple", f));
const out = join(root, "dist", "apple", "wizards-apple");
const force = process.argv.includes("--force");

const skip = (why) => {
  console.log(`wizards-apple: ${why}, not built`);
  process.exit(0);
};

if (process.platform !== "darwin" || process.arch !== "arm64") {
  skip("not a Mac with Apple silicon");
}
const newest = Math.max(...sources.map((f) => statSync(f).mtimeMs));
if (!force && existsSync(out) && statSync(out).mtimeMs >= newest) {
  console.log("wizards-apple: up to date");
  process.exit(0);
}
const xcrun = (args) =>
  execFileSync("xcrun", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
let swiftc;
let sdk;
let sdkPath;
try {
  swiftc = xcrun(["-f", "swiftc"]);
  sdk = xcrun(["--sdk", "macosx", "--show-sdk-version"]);
  sdkPath = xcrun(["--sdk", "macosx", "--show-sdk-path"]);
} catch {
  skip("no Swift compiler (Xcode or its command line tools)");
}
if (Number.parseInt(sdk, 10) < 26) {
  skip(`macOS SDK ${sdk} has no Foundation Models (needs 26)`);
}
mkdirSync(dirname(out), { recursive: true });
// Runs on every Mac with macOS 26, whatever SDK built it.
execFileSync(
  swiftc,
  ["-O", "-parse-as-library", "-sdk", sdkPath, "-target", "arm64-apple-macos26.0", "-o", out, ...sources],
  { stdio: "inherit" },
);
console.log(`wizards-apple: built ${out}`);

// Builds `wizards-mlx` (Sources/) into bin/: the helper and the kernels MLX runs on the GPU. Only a
// Mac with Apple silicon and Xcode with its Metal Toolchain can build it; anywhere else there is
// nothing to build, and no MLX is offered.
//
//   node mlx/build.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const bin = join(root, "bin");
const skip = (why) => {
  console.log(`wizards-mlx: ${why}, not built`);
  process.exit(0);
};
if (process.platform !== "darwin" || process.arch !== "arm64") {
  skip("not a Mac with Apple silicon");
}
try {
  execFileSync("xcrun", ["metal", "--version"], { stdio: "ignore" });
} catch {
  skip("no Metal Toolchain (xcodebuild -downloadComponent MetalToolchain)");
}
const derived = join(root, ".xcode");
execFileSync(
  "xcodebuild",
  [
    ...["build", "-scheme", "wizards-mlx", "-configuration", "Release"],
    ...["-destination", "platform=macOS,arch=arm64", "-derivedDataPath", derived],
    ...["-skipPackagePluginValidation", "-skipMacroValidation", "-quiet"],
  ],
  { cwd: root, stdio: "inherit" },
);
const products = join(derived, "Build", "Products", "Release");
const kernels = join(
  ...[products, "mlx-swift_Cmlx.bundle", "Contents", "Resources", "default.metallib"],
);
if (!existsSync(kernels)) {
  throw new Error(`No Metal kernels at ${kernels}.`);
}
rmSync(bin, { recursive: true, force: true });
mkdirSync(bin, { recursive: true });
const helper = join(bin, "wizards-mlx");
copyFileSync(join(products, "wizards-mlx"), helper);
execFileSync("strip", ["-x", helper]);
// The Swift libraries an older macOS does not bring go beside it.
execFileSync("xcrun", [
  ...["swift-stdlib-tool", "--copy", "--platform", "macosx"],
  ...["--scan-executable", helper, "--destination", bin],
]);
execFileSync("install_name_tool", ["-add_rpath", "@executable_path", helper]);
execFileSync("codesign", ["--force", "--sign", "-", helper]);
copyFileSync(kernels, join(bin, "mlx.metallib"));
console.log(`wizards-mlx: built ${bin}`);

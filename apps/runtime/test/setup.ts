import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Each test file gets a `.features` of its own: from source the runtime reads the checkout's, and
// installing a plugin writes `plugins=on` into it.
const dir = mkdtempSync(join(tmpdir(), "wizards-features-"));
process.env.FEATURES_FILE = join(dir, ".features");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

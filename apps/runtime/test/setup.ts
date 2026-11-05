import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Each test file gets a `.features` of its own: from source the runtime reads the checkout's, and
// installing a plugin writes `plugins=on` into it.
// No test reaches the Ollama of the machine it runs on: with an embedding model there, a search
// would find by meaning what the tests expect it to miss. A test that wants one answers its own.
process.env.OLLAMA_URL = "http://127.0.0.1:9/v1";

const dir = mkdtempSync(join(tmpdir(), "wizards-features-"));
process.env.FEATURES_FILE = join(dir, ".features");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

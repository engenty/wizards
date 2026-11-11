import { createServer } from "node:http";
import { ownReader } from "../../runtime/src/documents/read.js";
import { documentsServer } from "./server.js";

/**
 * The documents service's process (apps/documents/Dockerfile): reads PDFs, Word and Excel files
 * and scans for the runtime, which sends them (DOCUMENTS_URL there). Read from the environment:
 *
 *   DOCUMENTS_SECRET         what the runtime sends; 32 characters or more. Empty: off
 *   DOCUMENTS_PORT           default 8894
 *   DOCUMENTS_MAX_FILE_MB    the largest document, default 64
 *   DOCUMENTS_MAX_READS      documents read at once, default 2; the others wait
 *   DOCUMENTS_FETCH_ORIGINS  origins `/fetch` fetches from, comma-separated; empty: none
 *   TESSDATA_DIR             Tesseract's models, default /opt/tessdata (in the image)
 */
const number = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const secret = process.env.DOCUMENTS_SECRET?.trim() ?? "";
// The libraries it runs inherit the environment: the secret stays here.
delete process.env.DOCUMENTS_SECRET;
const port = number("DOCUMENTS_PORT", 8894);

if (!secret) {
  // Switched off, as the sandbox is: an API that answers nobody, instead of a container that
  // restarts without end.
  createServer((req, res) => {
    const health = req.url === "/health";
    res
      .writeHead(health ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify(health ? { ok: true, off: true } : { error: "off" }));
  }).listen(port, "0.0.0.0", () => console.log("documents: off, DOCUMENTS_SECRET is not set"));
} else if (secret.length < 32) {
  console.error(
    "DOCUMENTS_SECRET is shorter than 32 characters: the documents service doesn't start.",
  );
  process.exit(1);
} else {
  start(secret);
}

function start(secret: string) {
  const api = documentsServer({
    secret,
    reader: ownReader(process.env.TESSDATA_DIR || "/opt/tessdata"),
    maxFileBytes: number("DOCUMENTS_MAX_FILE_MB", 64) * 1024 * 1024,
    maxReads: Math.floor(number("DOCUMENTS_MAX_READS", 2)),
    fetchOrigins: (process.env.DOCUMENTS_FETCH_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
  api.server.listen(port, "0.0.0.0", () => console.log(`documents: listening on ${port}`));

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      await api.close();
      process.exit(0);
    });
  }
}

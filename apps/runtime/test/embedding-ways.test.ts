import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-embedding-ways-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
// Alone, with keys in a file of the data folder, and none from the shell or an env file.
process.env.MANAGE_URL = "";
process.env.SECRETS = "file";
process.env.MODEL_EMBEDDING = "";
for (const name of ["AI_GATEWAY_API_KEY", "OPENAI_API_KEY"]) {
  process.env[name] = "";
}

// A linked account whose credits answer.
vi.mock("../src/auth/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/account")>()),
  linkedAccount: async () => ({ userId: "u", tenantId: "t", name: "M", email: "m@example.com" }),
  accountToken: async () => "account-token",
}));

/** The gateway's catalog with the cloud's binding: EmbeddingGemma on engenty's own Ollama. */
const catalog = {
  markup: 1,
  webSearchCredits: 1,
  classes: {
    embedding: { model: "ollama:embeddinggemma-2:740m", kind: "embedding", pictures: true },
  },
};

let models: typeof import("../src/models");

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) =>
      // Ollama on this computer holds EmbeddingGemma; every other call is the gateway's.
      String(url).endsWith("/api/tags")
        ? Response.json({
            models: [{ name: "embeddinggemma-2:740m", capabilities: ["embedding", "vision"] }],
          })
        : Response.json(catalog),
    ),
  );
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  models = await import("../src/models");
  await models.loadLocalModels();
}, 60_000);

/** The model the index records, embedding the way the settings choose. */
async function refBy(embedding: "local" | "credits") {
  await models.saveLocalModels({ embedding });
  return (await models.embeddingModel())?.ref;
}

describe("EmbeddingGemma on this computer and in the cloud", () => {
  // Units record their model and only vectors of one model are compared, so a computer's
  // vectors are used in the cloud only where both name it alike (dateien-from-the-cloud.md).
  it("is named alike whether this computer's Ollama or the credits embed", async () => {
    expect(await refBy("local")).toBe("ollama:embeddinggemma-2:740m");
    expect(await refBy("credits")).toBe(await refBy("local"));
  });
});

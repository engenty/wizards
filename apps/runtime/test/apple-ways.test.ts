import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-apple-ways-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
// Alone, with keys in a file of the data folder, and none from the shell or an env file.
process.env.MANAGE_URL = "";
process.env.SECRETS = "file";
for (const name of [
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "FAL_KEY",
  "ELEVENLABS_API_KEY",
  "REPLICATE_API_TOKEN",
]) {
  process.env[name] = "";
}

/** What Apple Intelligence and ffmpeg say on this Mac, as each test sets it. */
const mac = vi.hoisted(() => ({
  apple: { supported: true, available: true, reason: null as string | null },
  ffmpeg: true,
}));

vi.mock("../src/harness/apple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/harness/apple")>()),
  appleStatus: async () => mac.apple,
}));
vi.mock("../src/media/ffmpeg", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/media/ffmpeg")>()),
  hasFfmpeg: async () => mac.ffmpeg,
}));
// Claude Code is installed and signed in on its subscription.
vi.mock("../src/harness/index", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/harness/index")>();
  return {
    ...real,
    detectHarness: async (id: string) => ({
      ...(real.harness(id) as object),
      version: "2.0.0",
      auth: "subscription",
    }),
  };
});
// A linked account whose credits answer; the gateway's catalog binds every class.
vi.mock("../src/auth/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/account")>()),
  linkedAccount: async () => ({ userId: "u", tenantId: "t", name: "M", email: "m@example.com" }),
  accountToken: async () => "account-token",
}));

const catalog = {
  markup: 1,
  webSearchCredits: 1,
  classes: {
    classifier: { model: "anthropic/claude-haiku-4.5", kind: "text" },
    standard: { model: "anthropic/claude-haiku-4.5", kind: "text" },
    high: { model: "anthropic/claude-sonnet-5.5", kind: "text" },
    highest: { model: "anthropic/claude-opus-5", kind: "text" },
    image: { model: "google/gemini-3.1-flash-image", kind: "image" },
    video: { model: "google/veo-3.1-fast-generate-001", kind: "video" },
    speech: { model: "google/gemini-3.8-flash-tts", kind: "speech" },
    audio: { model: "google/gemini-3.5-flash-lite", kind: "audio" },
  },
};

let models: typeof import("../src/models");
let settings: typeof import("../src/settings");
let appleUnavailableNote: typeof import("../src/harness/apple").appleUnavailableNote;
let openaiText: Record<string, string>;

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 })),
  );
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  models = await import("../src/models");
  settings = await import("../src/settings");
  ({ appleUnavailableNote } = await import("../src/harness/apple"));
  const { providerInfo } = await import("@engenty-wizards/shared/providers");
  openaiText = providerInfo("openai")?.text as Record<string, string>;
}, 60_000);

/** The settings as they stood before a pick: written outright, keys aside. */
async function start(source: string, bindings: Record<string, string> = {}) {
  await settings.writeSetting("models", { source, bindings });
  await models.loadLocalModels();
}

/** What Settings → Models and the setup send when Apple Intelligence is picked for text. */
const pickApple = () =>
  models.saveLocalModels({
    bindings: { classifier: "apple:default", standard: "apple:default" },
  });

/** How each text class runs: kind, by whom, on what. */
async function textWays() {
  const ways = await models.classWays();
  return Object.fromEntries(
    (["classifier", "standard", "high", "highest"] as const).map((c) => [
      c,
      { kind: ways[c].kind, by: ways[c].by, ref: ways[c].ref },
    ]),
  );
}

describe("Apple Intelligence beside the way High and Highest had", () => {
  beforeEach(() => {
    mac.apple = { supported: true, available: true, reason: null };
    mac.ffmpeg = true;
  });

  it("keeps an installed client for High and Highest, and the source with it", async () => {
    await start("claude");
    await pickApple();
    expect(models.localModelSettings().source).toBe("claude");
    expect(await textWays()).toEqual({
      classifier: { kind: "local", by: "apple", ref: "apple:default" },
      standard: { kind: "local", by: "apple", ref: "apple:default" },
      high: { kind: "client", by: "claude", ref: "claude/opus" },
      highest: { kind: "client", by: "claude", ref: "claude/opus" },
    });
    // A film of a Standard step still runs on the client, on its model of the class.
    expect(await models.filmClient("standard")).toMatchObject({ alias: "sonnet" });
  });

  it("gives the client all text again once it is picked after Apple", async () => {
    await start("claude");
    await pickApple();
    // What the page sends for the client: the source, and Apple's classes unbound.
    await models.saveLocalModels({
      source: "claude",
      bindings: { classifier: "", standard: "" },
    });
    expect(await textWays()).toEqual({
      classifier: { kind: "client", by: "claude", ref: "claude/haiku" },
      standard: { kind: "client", by: "claude", ref: "claude/sonnet" },
      high: { kind: "client", by: "claude", ref: "claude/opus" },
      highest: { kind: "client", by: "claude", ref: "claude/opus" },
    });
  });

  it("keeps an own key for High and Highest", async () => {
    await start("own", openaiText);
    await models.saveLocalModels({ keys: { openai: "sk-test" } });
    try {
      await pickApple();
      expect(models.localModelSettings().source).toBe("own");
      expect(await textWays()).toEqual({
        classifier: { kind: "local", by: "apple", ref: "apple:default" },
        standard: { kind: "local", by: "apple", ref: "apple:default" },
        high: { kind: "key", by: "openai", ref: openaiText.high },
        highest: { kind: "key", by: "openai", ref: openaiText.highest },
      });
    } finally {
      await models.saveLocalModels({ keys: { openai: "" } });
    }
  });

  it("keeps the account's credits for High and Highest", async () => {
    await start("account");
    await pickApple();
    expect(models.localModelSettings().source).toBe("account");
    expect(await textWays()).toEqual({
      classifier: { kind: "local", by: "apple", ref: "apple:default" },
      standard: { kind: "local", by: "apple", ref: "apple:default" },
      high: { kind: "credits", by: null, ref: catalog.classes.high.model },
      highest: { kind: "credits", by: null, ref: catalog.classes.highest.model },
    });
    // Picking the credits for text afterwards takes Classifier and Standard off Apple.
    await models.saveLocalModels({
      source: "account",
      bindings: { classifier: "", standard: "" },
    });
    expect((await textWays()).standard).toEqual({
      kind: "credits",
      by: null,
      ref: catalog.classes.standard.model,
    });
  });

  it("says Apple Intelligence is switched off where text thinks there", async () => {
    await start("claude");
    await pickApple();
    mac.apple = { supported: true, available: false, reason: "off" };
    const ways = await models.classWays();
    expect(ways.standard.problem).toEqual(appleUnavailableNote(mac.apple as never));
    expect(ways.high.problem).toBeNull();
  });
});

describe("voice notes on this Mac", () => {
  beforeEach(async () => {
    mac.apple = { supported: true, available: true, reason: null };
    mac.ffmpeg = true;
    await start("own", { audio: "apple:transcribe" });
  });

  it("are written down with Apple Intelligence switched off", async () => {
    mac.apple = { supported: true, available: false, reason: "off" };
    expect((await models.classWays()).audio).toEqual({
      kind: "local",
      by: "apple",
      ref: "apple:transcribe",
      problem: null,
    });
  });

  it("are not written down where the Mac cannot: before macOS 26, or without the helper", async () => {
    for (const reason of ["device", "os", "missing"]) {
      mac.apple = { supported: false, available: false, reason };
      const { problem } = (await models.classWays()).audio;
      expect(problem).toEqual(appleUnavailableNote(mac.apple as never));
      expect(problem).toBeTruthy();
    }
  });

  it("need ffmpeg for a browser's WebM or Ogg", async () => {
    mac.ffmpeg = false;
    const { audio } = models.waysIn(await models.classWays(), "en");
    expect(audio.problem).toContain("ffmpeg");
  });
});

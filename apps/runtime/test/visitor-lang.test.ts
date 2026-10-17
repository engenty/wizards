import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteText } from "@engenty-wizards/shared/run";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Lang } from "@engenty-wizards/shared/definition";

const dir = mkdtempSync(join(tmpdir(), "wizards-visitor-lang-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";

// A step that runs fails as Apple Intelligence on this Mac fails: the text is too long for it.
vi.mock("../src/engine/steps", async (original) => {
  const { appleFailure } = await import("../src/harness/apple");
  return {
    ...(await original<typeof import("../src/engine/steps")>()),
    runAutomaticStep: async () => {
      throw appleFailure({ kind: "contextWindow", message: "" });
    },
  };
});

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");

const page = (title: string, label: string) => ({
  id: "start",
  type: "page",
  title,
  fields: [{ id: "name", kind: "text", label }],
});

const english = {
  version: 1,
  title: "Call back for you",
  description: "Who you are and what it is about",
  avatar: "dome",
  steps: [
    page("Your name", "What is your name?"),
    { id: "done", type: "result", title: "All done", deliverables: [] },
  ],
};

const german = {
  version: 1,
  title: "Rückruf",
  description: "Wer du bist und worum es geht",
  avatar: "dome",
  steps: [
    page("Dein Name", "Wie heißt du?"),
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

const wizardIds: Record<Lang, string> = { en: "", de: "" };
const tokens: Record<Lang, string> = { en: "", de: "" };

/** What a browser sends as its language (`navigator.language` first). */
const ACCEPT = { en: "en-US,en;q=0.9", de: "de-AT,de;q=0.9,en;q=0.8" } as const;

const get = (path: string, lang?: Lang) =>
  app.fetch(
    new Request(`http://localhost:5181${path}`, {
      headers: lang ? { "accept-language": ACCEPT[lang] } : {},
    }),
  );
const post = (path: string, body: unknown, lang?: Lang, cookie?: string) =>
  app.fetch(
    new Request(`http://localhost:5181${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(lang ? { "accept-language": ACCEPT[lang] } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
const settings = (lang: Lang, patch: { shareEnabled?: boolean; dailyRunLimit?: number }) =>
  client.withTenant("tenant-a", () =>
    wizards.updateWizardSettings("user-a", wizardIds[lang], patch),
  );

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  wizards = await import("../src/services/wizards");
  app = (await import("../src/app")).default;
  await client.withTenant("tenant-a", async () => {
    for (const [lang, definition] of [
      ["en", english],
      ["de", german],
    ] as const) {
      wizardIds[lang] = (await wizards.createWizard("user-a", { definition })).id;
      await wizards.publishWizard("user-a", wizardIds[lang]);
      tokens[lang] = (await wizards.ownedWizard("user-a", wizardIds[lang])).shareToken;
    }
  });
}, 60_000);

describe("what the runtime answers a visitor, in the language their browser asks for", () => {
  it("says a wizard that is switched off is not available, in English or German", async () => {
    await settings("en", { shareEnabled: false });
    const en = await (await get(`/api/public/wizards/${tokens.en}`, "en")).json();
    const de = await (await get(`/api/public/wizards/${tokens.en}`, "de")).json();
    expect(en).toMatchObject({
      available: false,
      unavailableReason: "This wizard isn’t available right now.",
    });
    expect(de).toMatchObject({
      available: false,
      unavailableReason: "Dieser Wizard ist gerade nicht verfügbar.",
    });
    const started = await post(`/api/public/wizards/${tokens.en}/runs`, {}, "en");
    expect(started.status).toBe(403);
    expect(await started.json()).toEqual({ error: "This wizard isn’t available right now." });
    // Without a language the runner starts in English, and so does the answer.
    const bare = await (await get(`/api/public/wizards/${tokens.en}`)).json();
    expect(bare.unavailableReason).toBe("This wizard isn’t available right now.");
    await settings("en", { shareEnabled: true });
  });

  it("says the day's limit is reached, in English or German, whatever the wizard speaks", async () => {
    await settings("de", { dailyRunLimit: 0 });
    const en = await post(`/api/public/wizards/${tokens.de}/runs`, {}, "en");
    const de = await post(`/api/public/wizards/${tokens.de}/runs`, {}, "de");
    expect(en.status).toBe(403);
    expect((await en.json()).error).toBe(
      "This wizard has reached its limit for today. Try again tomorrow.",
    );
    expect(de.status).toBe(403);
    expect((await de.json()).error).toBe(
      "Für heute ist das Limit dieses Wizards erreicht. Versuch es morgen wieder.",
    );
    const shown = await (await get(`/api/public/wizards/${tokens.de}`, "en")).json();
    expect(shown.unavailableReason).toBe(
      "This wizard has reached its limit for today. Try again tomorrow.",
    );
    await settings("de", { dailyRunLimit: 50 });
  });

  it("answers a run's own routes in the request's language", async () => {
    const cookie = "wz_vid=visitor-lang-0123456789ab";
    const started = await post(`/api/public/wizards/${tokens.de}/runs`, {}, "en", cookie);
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };
    for (const [lang, closed, first] of [
      ["en", "This question is no longer open.", "There is no step before this one."],
      ["de", "Diese Frage ist nicht mehr offen.", "Kein vorheriger Schritt."],
    ] as const) {
      const ask = await post(`/api/runs/${runId}/ask/gone`, { type: "skip" }, lang, cookie);
      expect(ask.status).toBe(409);
      expect((await ask.json()).error).toBe(closed);
      const back = await post(`/api/runs/${runId}/back`, {}, lang, cookie);
      expect(back.status).toBe(409);
      expect((await back.json()).error).toBe(first);
    }
  });
});

describe("Apple Intelligence's failures as notes", () => {
  it("carry a note that reads in both languages; the message keeps the English line", async () => {
    const { appleFailure } = await import("../src/harness/apple");
    const { errorText, ModelUnavailableError, noteOf } = await import("../src/model-errors");
    const tooLong = appleFailure({ kind: "contextWindow", message: "" });
    expect(noteOf(tooLong)).toEqual({ code: "appleTooLong" });
    expect(tooLong.message).toContain("The text is too long");
    expect(errorText(tooLong, "en")).toContain("The text is too long for Apple Intelligence on this Mac");
    expect(errorText(tooLong, "de")).toContain("Der Text ist zu lang");

    const off = appleFailure({ kind: "unavailable", message: "appleIntelligenceNotEnabled" });
    expect(off).toBeInstanceOf(ModelUnavailableError);
    expect(noteText(noteOf(off)!, "en")).toBe(
      "Apple Intelligence is turned off on this Mac. Turn it on in System Settings → Apple Intelligence & Siri.",
    );
    expect(noteText(noteOf(off)!, "de")).toContain("ausgeschaltet");

    const other = appleFailure({ kind: "other", message: "boom" });
    expect(errorText(other, "en")).toBe("Apple Intelligence: boom");
  });

  // No request is there when a step fails: the error the run keeps is in the wizard's language.
  it("reach a run as a note: the log keeps it, the run's error is in the wizard's language", async () => {
    const runner = await import("../src/engine/runner");
    const { recentEvents } = await import("../src/engine/events");
    const step = { id: "think", type: "widget", title: "Think it over", entry: "w.html", data: {} };
    for (const [lang, definition, error] of [
      ["en", english, /^The text is too long for Apple Intelligence/],
      ["de", german, /^Der Text ist zu lang für Apple Intelligence/],
    ] as const) {
      await client.withTenant("tenant-a", async () => {
        const runId = await runner.createRun({
          wizardId: wizardIds[lang],
          definition: { ...definition, steps: [step, definition.steps[1]] } as never,
          files: [],
          version: null,
          mode: "test",
        });
        let run = await client.db.query.run.findFirst({ where: (r, { eq }) => eq(r.id, runId) });
        for (let i = 0; i < 100 && run?.status === "running"; i++) {
          await new Promise((r) => setTimeout(r, 50));
          run = await client.db.query.run.findFirst({ where: (r, { eq }) => eq(r.id, runId) });
        }
        expect(run?.status).toBe("failed");
        expect(run?.error).toMatch(error);
        const failed = (await recentEvents(runId)).find((e) => e.type === "error");
        expect(failed?.note).toEqual({ code: "appleTooLong" });
        expect(failed?.message).toContain("The text is too long");
      });
    }
  });
});

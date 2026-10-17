import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WizardDefinition } from "@engenty-wizards/shared/definition";
import {
  BUILT_IN_RUNNERS,
  type RunnerInfo,
  runnerFit,
  runnersFor,
} from "@engenty-wizards/shared/runners";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-runners-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");

const definition = {
  version: 1,
  title: "Schadensmeldung",
  description: "Ein Schaden, ein Bericht",
  avatar: "dome",
  steps: [
    {
      id: "contact",
      type: "page",
      title: "Kontakt",
      fields: [
        { id: "name", kind: "text", label: "Name", required: true },
        { id: "mail", kind: "email", label: "E-Mail" },
      ],
    },
    {
      id: "proof",
      type: "page",
      title: "Nachweis",
      fields: [
        { id: "photos", kind: "image", label: "Fotos", multiple: true },
        { id: "sign", kind: "signature", label: "Unterschrift" },
      ],
    },
    {
      id: "draft",
      type: "agent",
      title: "Bericht",
      instructions: "Schreibe den Bericht.",
      model: "standard",
    },
    { id: "picture", type: "generate", title: "Bild", asset: "image", prompt: "Der Schaden" },
    { id: "check", type: "review", title: "Prüfen", show: ["draft", "picture"] },
    {
      id: "done",
      type: "result",
      title: "Fertig",
      deliverables: [{ from: "draft", formats: ["pdf"] }],
    },
  ],
} as unknown as WizardDefinition;

/** A door that talks: text and choices, reads text, hands off by SMS. */
const voice: RunnerInfo = {
  id: "voice",
  label: { de: "Sprache", en: "Voice" },
  kind: "channel",
  capabilities: {
    input: ["text", "textarea", "number", "select", "multiselect", "toggle", "date", "email"],
    output: { shows: ["text"], pictures: [] },
    asks: ["confirm"],
    review: ["accept", "regenerate"],
    waits: true,
    handoff: ["sms"],
  },
};

describe("how a runner fits a wizard", () => {
  it("the built-in page and chat run every wizard in full", () => {
    for (const fit of runnersFor(definition, BUILT_IN_RUNNERS)) {
      expect(fit).toMatchObject({ outcome: "full", steps: [] });
    }
  });

  it("a voice door hands off the photos, the signature and the picture to look at", () => {
    const fit = runnerFit(definition, voice);
    expect(fit.outcome).toBe("handoff");
    expect(fit.steps.map((s) => [s.stepId, s.why])).toEqual([
      ["proof", "Fotos, Unterschrift"],
      ["check", "Bild"],
    ]);
  });

  it("a door that cannot hand off cannot run a wizard with a signature", () => {
    const fit = runnerFit(definition, {
      ...voice,
      capabilities: { ...voice.capabilities, handoff: [] },
    });
    expect(fit.outcome).toBe("no");
  });

  it("a door that cannot wait cannot run a wizard with a step that takes minutes", () => {
    const fit = runnerFit(definition, {
      ...voice,
      capabilities: { ...voice.capabilities, waits: false },
    });
    expect(fit.outcome).toBe("no");
    expect(fit.steps.find((s) => s.stepId === "draft")?.why).toBe("takes minutes");
  });

  it("a door that shows pictures as pictures needs no hand-off for the review", () => {
    const fit = runnerFit(definition, {
      ...voice,
      capabilities: {
        ...voice.capabilities,
        input: [...voice.capabilities.input, "image", "signature"],
        output: { shows: ["text"], pictures: ["image"] },
      },
    });
    expect(fit).toMatchObject({ outcome: "full", steps: [] });
  });
});

describe("how a wizard is offered", () => {
  let wizardId: string;
  let token: string;
  const get = (path: string) => app.fetch(new Request(`http://localhost:5181${path}`));

  beforeAll(async () => {
    client = await import("../src/db/client");
    await client.migrateControlDb();
    wizards = await import("../src/services/wizards");
    app = (await import("../src/app")).default;
    await client.withTenant("tenant-a", async () => {
      wizardId = (await wizards.createWizard("user-a", { definition })).id;
      await wizards.publishWizard("user-a", wizardId);
      token = (await wizards.ownedWizard("user-a", wizardId)).shareToken;
    });
  }, 60_000);

  it("offers the page on its link and the chat beside it, until the owner says otherwise", async () => {
    const body = await (await get(`/api/public/wizards/${token}`)).json();
    expect(body.runners).toEqual([
      { id: "steps", label: "Schritte", kind: "page", url: `http://localhost:5181/w/${token}` },
      { id: "chat", label: "Chat", kind: "page", url: `http://localhost:5181/w/${token}/chat` },
    ]);
  });

  it("lists what the pages ask, so an AI app can fill in what it knows", async () => {
    const body = await (await get(`/api/public/wizards/${token}`)).json();
    expect(body.fields).toEqual([
      { id: "name", label: "Name", kind: "text", required: true },
      { id: "mail", label: "E-Mail", kind: "email" },
      { id: "photos", label: "Fotos", kind: "image" },
      { id: "sign", label: "Unterschrift", kind: "signature" },
    ]);
  });

  it("the owner picks what the link opens and switches runners off", async () => {
    await client.withTenant("tenant-a", () =>
      wizards.updateWizardSettings("user-a", wizardId, {
        runners: { default: "chat", enabled: ["chat", "steps"] },
      }),
    );
    let body = await (await get(`/api/public/wizards/${token}`)).json();
    expect(body.runners.map((r: { id: string; url: string }) => [r.id, r.url])).toEqual([
      ["chat", `http://localhost:5181/w/${token}`],
      ["steps", `http://localhost:5181/w/${token}/steps`],
    ]);
    await client.withTenant("tenant-a", () =>
      wizards.updateWizardSettings("user-a", wizardId, {
        runners: { default: "steps", enabled: ["steps"] },
      }),
    );
    body = await (await get(`/api/public/wizards/${token}`)).json();
    expect(body.runners.map((r: { id: string }) => r.id)).toEqual(["steps"]);
  });

  it("refuses a runner there is none of, and a link that opens one switched off", async () => {
    await expect(
      client.withTenant("tenant-a", () =>
        wizards.updateWizardSettings("user-a", wizardId, {
          runners: { default: "steps", enabled: ["steps", "whatsapp"] },
        }),
      ),
    ).rejects.toThrow(/whatsapp/);
    await expect(
      client.withTenant("tenant-a", () =>
        wizards.updateWizardSettings("user-a", wizardId, {
          runners: { default: "chat", enabled: ["steps"] },
        }),
      ),
    ).rejects.toThrow(/turned on/);
  });

  it("the studio sees every runner with its fit, and the settings as they stand", async () => {
    const w = await client.withTenant("tenant-a", () => wizards.ownedWizard("user-a", wizardId));
    const { wizardRunners } = await import("../src/services/runners");
    const seen = await client.withTenant("tenant-a", () => wizardRunners(w));
    expect(seen.settings).toEqual({ default: "steps", enabled: ["steps"] });
    expect(seen.runners.map((r) => [r.id, r.fit.outcome])).toEqual([
      ["steps", "full"],
      ["chat", "full"],
      ["talk", "full"],
      ["video", "full"],
    ]);
    // A live conversation needs a model the test runtime has no key for: offered to nobody yet.
    expect(seen.runners[2].problem).toMatch(/OpenAI/);
    expect(seen.runners[3].problem).toMatch(/OpenAI/);
    await client.withTenant("tenant-a", () =>
      wizards.updateWizardSettings("user-a", wizardId, {
        runners: { default: "steps", enabled: ["steps", "talk"] },
      }),
    );
    const offered = await (await get(`/api/public/wizards/${token}`)).json();
    expect(offered.runners.map((r: { id: string }) => r.id)).toEqual(["steps"]);
  });
});

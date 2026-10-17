import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewerLang } from "@engenty-wizards/shared/definition";
import { RUNNER_TEXTS } from "@engenty-wizards/shared/runner-texts";
import { lineText } from "@engenty-wizards/shared/texts";
import {
  keepsPlaceholders,
  translateDefinition,
  wizardTexts,
} from "@engenty-wizards/shared/translation";
import { beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-translation-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5182";

/** A stand-in model: "FR:" before every text, placeholders kept; `drop` loses one. */
const llm = vi.hoisted(() => ({ calls: [] as string[][], drop: false }));
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async () => ({ model: "test-model", vendor: "test", ref: "test", gateway: false, metered: false }),
}));
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: async ({ prompt }: { prompt: string }) => {
    const texts = JSON.parse(prompt) as Record<string, string>;
    llm.calls.push(Object.keys(texts));
    const output = Object.fromEntries(
      Object.entries(texts).map(([k, v]) => [
        k,
        llm.drop ? `FR:${v.replace(/\{\{[^}]*\}\}/g, "")}` : `FR:${v}`,
      ]),
    );
    return { output, usage: {} };
  },
}));

const definition = {
  version: 1,
  title: "Speiseplan",
  description: "Plant die Woche für {{brand.name}}.",
  avatar: "sprout",
  steps: [
    {
      id: "start",
      type: "page",
      title: "Welche Woche?",
      fields: [
        { id: "kind", kind: "select", label: "Kost", options: ["Fisch", "Fleisch"] },
        { id: "slot", kind: "slot", label: "Termin", options: ["2026-10-12T09:00:00+02:00"] },
      ],
      // A run past "Fisch" needs no model: the test runtime has none.
      next: [{ when: { field: "kind", op: "equals", value: "Fisch" }, goto: "done" }],
    },
    {
      id: "plan",
      type: "agent",
      title: "Plan",
      instructions: "Plane die Woche mit {{kind}}.",
      output: { format: "markdown" },
      tools: [],
    },
    { id: "done", type: "result", title: "Fertig", message: "Dein Plan, {{kind}}.", deliverables: [] },
  ],
};

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");
let translations: typeof import("../src/services/translations");
let wizardId: string;
let shareToken: string;

const call = (path: string, init?: RequestInit) =>
  app.fetch(
    new Request(`http://localhost:5182${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    }),
  );

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  wizards = await import("../src/services/wizards");
  translations = await import("../src/services/translations");
  app = (await import("../src/app")).default;
  await client.withTenant("tenant-t", async () => {
    wizardId = (await wizards.createWizard("user-t", { definition })).id;
    await wizards.publishWizard("user-t", wizardId);
    shareToken = (await wizards.ownedWizard("user-t", wizardId)).shareToken;
  });
}, 60_000);

describe("the texts of a wizard", () => {
  it("are what the person reads, never instructions, ids or slot dates", () => {
    const texts = wizardTexts(definition as never);
    expect(texts).toContain("Welche Woche?");
    expect(texts).toContain("Fisch");
    expect(texts).toContain("Dein Plan, {{kind}}.");
    expect(texts).not.toContain("Plane die Woche mit {{kind}}.");
    expect(texts).not.toContain("2026-10-12T09:00:00+02:00");
    expect(texts).not.toContain("start");
  });

  it("are written back with the choices' values untouched", () => {
    const memory = Object.fromEntries(
      wizardTexts(definition as never).map((t) => [t, { text: `FR:${t}`, by: "machine" as const }]),
    );
    const { def, labels } = translateDefinition(definition as never, memory);
    const page = def.steps[0] as { title: string; fields: { options?: string[] }[] };
    expect(page.title).toBe("FR:Welche Woche?");
    expect(page.fields[0].options).toEqual(["Fisch", "Fleisch"]);
    expect(labels).toEqual({ Fisch: "FR:Fisch", Fleisch: "FR:Fleisch" });
    expect((def.steps[1] as { instructions: string }).instructions).toBe("Plane die Woche mit {{kind}}.");
  });

  it("keep their placeholders exactly", () => {
    expect(keepsPlaceholders("Hi {{name}}, {count} left", "Salut {count}, {{name}}")).toBe(true);
    expect(keepsPlaceholders("Hi {{name}}", "Salut")).toBe(false);
    expect(keepsPlaceholders("Hi", "Salut {{name}}")).toBe(false);
  });
});

describe("the viewer's language", () => {
  it("is any language, from the browser or the time zone", () => {
    expect(viewerLang(["fr-CA", "en"])).toBe("fr");
    expect(viewerLang(["en-GB"])).toBe("en");
    expect(viewerLang([], "Europe/Warsaw")).toBe("pl");
    expect(viewerLang([])).toBeNull();
  });

  it("writes the plural forms of any language", () => {
    const line = { one: "{n} plik", few: "{n} pliki", many: "{n} plików", other: "{n} pliku" };
    expect(lineText(line, "pl", { n: 1 })).toBe("1 plik");
    expect(lineText(line, "pl", { n: 3 })).toBe("3 pliki");
    expect(lineText(line, "pl", { n: 5 })).toBe("5 plików");
  });
});

describe("a translated wizard", () => {
  it("opens in its own language and is translated once on request", async () => {
    const plain = await (await call(`/api/public/wizards/${shareToken}?lang=fr`)).json();
    expect(plain.lang).toBe("de");
    expect(plain.translatable).toBe(true);
    expect(plain.translation).toBeNull();

    llm.calls = [];
    const made = await call(`/api/public/wizards/${shareToken}/translation`, {
      method: "POST",
      body: JSON.stringify({ lang: "fr" }),
    });
    expect(made.status).toBe(200);
    const body = await made.json();
    expect(body.title).toBe("FR:Speiseplan");
    expect(body.description).toBe("FR:Plant die Woche für {{brand.name}}.");
    expect(body.translation).toMatchObject({ lang: "fr", machine: true, labels: { Fisch: "FR:Fisch" } });
    expect(llm.calls).toHaveLength(1);

    // Kept: the next viewer reads it without a call.
    await call(`/api/public/wizards/${shareToken}/translation`, {
      method: "POST",
      body: JSON.stringify({ lang: "fr" }),
    });
    expect(llm.calls).toHaveLength(1);
    const read = await (await call(`/api/public/wizards/${shareToken}?lang=fr`)).json();
    expect(read.title).toBe("FR:Speiseplan");
  });

  it("is not offered in the language it is written in", async () => {
    const own = await call(`/api/public/wizards/${shareToken}/translation`, {
      method: "POST",
      body: JSON.stringify({ lang: "de" }),
    });
    expect(own.status).toBe(403);
  });

  it("translates only what a new version changed, and keeps the author's lines", async () => {
    await client.withTenant("tenant-t", async () => {
      const def = (await translations.publishedDefinition(
        await wizards.ownedWizard("user-t", wizardId),
      ))!;
      await translations.editTranslation(wizardId, def, "fr", { Fisch: "Poisson" });
      const w = await wizards.ownedWizard("user-t", wizardId);
      await wizards.writeDraft("user-t", wizardId, {
        definition: { ...definition, title: "Wochenplan" },
        baseRevision: w.revision,
      });
      await wizards.publishWizard("user-t", wizardId);
    });
    llm.calls = [];
    const body = await (
      await call(`/api/public/wizards/${shareToken}/translation`, {
        method: "POST",
        body: JSON.stringify({ lang: "fr" }),
      })
    ).json();
    expect(llm.calls).toEqual([["t0"]]);
    expect(body.title).toBe("FR:Wochenplan");
    expect(body.translation.labels.Fisch).toBe("Poisson");
  });

  it("refuses an answer that lost a placeholder", async () => {
    llm.drop = true;
    const res = await call(`/api/public/wizards/${shareToken}/translation`, {
      method: "POST",
      body: JSON.stringify({ lang: "it" }),
    });
    llm.drop = false;
    expect(res.status).toBe(502);
    await client.withTenant("tenant-t", async () => {
      expect(await translations.storedTranslation(wizardId, "it")).toBeNull();
    });
  });

  it("starts a run in the viewer's language: the view translated, the values original", async () => {
    const started = await call(`/api/public/wizards/${shareToken}/runs`, {
      method: "POST",
      body: JSON.stringify({ lang: "fr" }),
    });
    expect(started.status).toBe(200);
    const { runId } = await started.json();
    const cookie = started.headers.get("set-cookie")?.split(";")[0] ?? "";
    const view = await (await call(`/api/runs/${runId}`, { headers: { cookie } })).json();
    expect(view.lang).toBe("de");
    expect(view.translation).toMatchObject({ lang: "fr", labels: { Fisch: "Poisson" } });
    expect(view.step.title).toBe("FR:Welche Woche?");
    expect(view.step.fields[0].options).toEqual(["Fisch", "Fleisch"]);

    // A finished text, translated on request and kept on the run beside the original.
    await client.withTenant("tenant-t", async () => {
      const { db, schema } = client;
      const { eq } = await import("drizzle-orm");
      const row = await db.query.run.findFirst({ where: eq(schema.run.id, runId) });
      const state = { ...row!.state, outputs: { plan: { text: "Montag: Suppe", at: "now" } } };
      await db.update(schema.run).set({ state }).where(eq(schema.run.id, runId));
    });
    const asked = await call(`/api/runs/${runId}/translate-result`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ stepId: "plan" }),
    });
    expect(asked.status).toBe(200);
    const after = await (await call(`/api/runs/${runId}`, { headers: { cookie } })).json();
    expect(after.translation.results).toEqual({ plan: "FR:Montag: Suppe" });

    // Back to the original mid-run.
    const back = await call(`/api/runs/${runId}/lang`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ lang: null }),
    });
    expect(back.status).toBe(200);
    const plain = await (await call(`/api/runs/${runId}`, { headers: { cookie } })).json();
    expect(plain.translation).toBeNull();
    expect(plain.step.title).toBe("Welche Woche?");
  });

  it("is only offered as it was written once the author turns it off", async () => {
    await client.withTenant("tenant-t", () =>
      wizards.updateWizardSettings("user-t", wizardId, { translate: false }),
    );
    const res = await call(`/api/public/wizards/${shareToken}/translation`, {
      method: "POST",
      body: JSON.stringify({ lang: "fr" }),
    });
    expect(res.status).toBe(403);
    const plain = await (await call(`/api/public/wizards/${shareToken}?lang=fr`)).json();
    expect(plain.translatable).toBe(false);
    expect(plain.translation).toBeNull();
    await client.withTenant("tenant-t", () =>
      wizards.updateWizardSettings("user-t", wizardId, { translate: true }),
    );
  });
});

describe("the runner's own words", () => {
  it("are translated once per language, with that language's plural forms", async () => {
    llm.calls = [];
    const res = await call(`/api/public/wizards/${shareToken}/texts/pl`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runner["run.next"]).toBe(`FR:${RUNNER_TEXTS.en["run.next"]}`);
    const plural = Object.values(body.runner).find((line) => typeof line === "object") as Record<string, string>;
    expect(Object.keys(plural).sort()).toEqual(["few", "many", "one", "other"]);
    expect(Object.keys(body.notes).length).toBeGreaterThan(100);
    const calls = llm.calls.length;
    await call(`/api/public/wizards/${shareToken}/texts/pl`);
    expect(llm.calls.length).toBe(calls);
  });

  it("need no call for a language engenty has written", async () => {
    expect((await call(`/api/public/wizards/${shareToken}/texts/de`)).status).toBe(404);
  });
});

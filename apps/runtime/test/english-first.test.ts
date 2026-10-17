import { slotText, wizardLang, type WizardDefinition } from "@engenty-wizards/shared/definition";
import { note, noteText, saidText } from "@engenty-wizards/shared/run";
import { textOf, type Texts } from "@engenty-wizards/shared/texts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { fieldErrorsIn, readPageInput } from "../src/engine/input";
import { errorText, NotedError, saidOf } from "../src/model-errors";
import { requestLang, say } from "../src/routes/lang";
import { ServiceError } from "../src/services/errors";

const ask = async (headers: Record<string, string> = {}) => {
  const app = new Hono().get("/", (c) =>
    c.json({ lang: requestLang(c), said: say(c, "done") }),
  );
  return (await app.request("/", { headers })).json();
};

describe("English first", () => {
  it("answers a request without a language in English, a German one in German", async () => {
    expect(await ask()).toEqual({ lang: "en", said: "Done." });
    expect(await ask({ "accept-language": "fr-FR,fr;q=0.9" })).toEqual({ lang: "en", said: "Done." });
    expect(await ask({ "accept-language": "de-AT,de;q=0.9" })).toEqual({ lang: "de", said: "Erledigt." });
  });

  it("carries words in both languages through an error; its message is the English line", () => {
    const said = note("creditsUsedUp");
    const err = new ServiceError("no_credits", said);
    expect(err.message).toBe("Your credits are used up.");
    expect(err.toJSON()).toMatchObject({ error: "Your credits are used up.", code: "no_credits" });
    expect(err.toJSON("de").error).toBe("Dein Guthaben ist aufgebraucht.");
    // Passed on, the words stay in both languages.
    expect(errorText(new ServiceError("refused", saidOf(err)), "de")).toBe(
      "Dein Guthaben ist aufgebraucht.",
    );
    expect(errorText(new NotedError("plain words"), "de")).toBe("plain words");
    expect(saidText(said, "en")).toBe("Your credits are used up.");
    expect(noteText(said, "de")).toBe("Dein Guthaben ist aufgebraucht.");
  });

  it("fills a note's gaps with notes and numbers in the reader's language", () => {
    const freeTier = note("freeTier", { model: note("quoted", { text: "veo-3" }), url: "x" });
    expect(noteText(freeTier, "en")).toContain("doesn’t include “veo-3”.");
    expect(noteText(freeTier, "de")).toContain("schließt „veo-3“ aus.");
    expect(noteText(note("pageMostChars", { count: 20000 }), "en")).toBe(
      "A page can have at most 20,000 characters.",
    );
    expect(noteText(note("pageMostChars", { count: 20000 }), "de")).toBe(
      "Eine Seite hat höchstens 20.000 Zeichen.",
    );
  });

  it("picks a line's plural form by its count, English where a language lacks the line", () => {
    const texts = {
      en: { files: { one: "{count} file", other: "{count} files" }, only: "English only" },
      de: { files: { one: "{count} Datei", other: "{count} Dateien" } },
    } satisfies Texts<"files" | "only">;
    expect(textOf(texts, "files", "en", { count: 1 })).toBe("1 file");
    expect(textOf(texts, "files", "en", { count: 3 })).toBe("3 files");
    expect(textOf(texts, "files", "de", { count: 1 })).toBe("1 Datei");
    expect(textOf(texts, "files", "de", { count: 0 })).toBe("0 Dateien");
    expect(textOf(texts, "only", "de")).toBe("English only");
    expect(noteText(note("templateNeedsPlugins", { count: 2, plugins: ["a", "b"] }), "en")).toBe(
      "This template needs the plugins a, b: included with Pro on engenty.ai.",
    );
  });

  it("checks answers with messages in both languages", () => {
    const { errors } = readPageInput(
      {
        id: "start",
        type: "page",
        title: "Start",
        fields: [
          { id: "name", label: "Name", kind: "text", required: true },
          { id: "mail", label: "Email", kind: "email" },
        ],
      },
      { mail: "nope" },
    );
    expect(fieldErrorsIn(errors, "en")).toEqual([
      { field: "name", message: "Required" },
      { field: "mail", message: "Not a valid email address" },
    ]);
    expect(fieldErrorsIn(errors, "de")).toEqual([
      { field: "name", message: "Pflichtfeld" },
      { field: "mail", message: "Keine gültige E-Mail-Adresse" },
    ]);
  });

  it("takes a wizard that is not clearly German for English", () => {
    const wizard = (title: string): WizardDefinition =>
      ({ version: 1, title, description: "", steps: [] }) as unknown as WizardDefinition;
    expect(wizardLang(wizard(""))).toBe("en");
    expect(wizardLang(wizard("Angebot für die Küche und das Bad"))).toBe("de");
    // Nouns alone say nothing; the language a wizard names decides.
    expect(wizardLang(wizard("Vertrag"))).toBe("en");
    expect(wizardLang({ ...wizard("Vertrag"), lang: "de" })).toBe("de");
    expect(wizardLang({ ...wizard("Angebot für die Küche und das Bad"), lang: "en" })).toBe("en");
    expect(slotText("2026-10-13T10:30:00+02:00")).toBe("Tue 13/10/2026, 10:30");
  });
});

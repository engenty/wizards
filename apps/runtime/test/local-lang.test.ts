import { isRealLanguage, langOf, localLang, textLang, validateWizard, wizardLang, wizardSchema } from "@engenty-wizards/shared/definition";
import { describe, expect, it } from "vitest";

describe("the language beside English", () => {
  it("takes the first of the browser's languages engenty speaks, past English", () => {
    expect(localLang(["de-AT", "en"])).toBe("de");
    expect(localLang(["en-US", "de"])).toBe("de");
    expect(localLang(["fr-FR", "de-CH", "en"])).toBe("de");
  });

  it("goes by the country of the time zone where the browser names none", () => {
    expect(localLang(["en-US"], "Europe/Vienna")).toBe("de");
    expect(localLang(["en-GB"], "Europe/Zurich")).toBe("de");
  });

  it("names none where English is all there is, or the language is not spoken yet", () => {
    expect(localLang(["en-US"], "America/New_York")).toBeNull();
    expect(localLang(["en-GB"], "Europe/London")).toBeNull();
    expect(localLang(["fr-FR"], "Europe/Paris")).toBeNull();
    expect(localLang([])).toBeNull();
  });

  it("reads a language tag in any of its spellings", () => {
    expect(langOf("DE_at")).toBe("de");
    expect(langOf(" en ")).toBe("en");
    expect(langOf("pt-BR")).toBeNull();
    expect(langOf(undefined)).toBeNull();
  });
});

describe("a wizard's own language", () => {
  const base = {
    version: 1,
    title: "Saluto",
    steps: [{ id: "done", type: "result", title: "Fatto", deliverables: [] }],
  };

  it("takes any two-letter code in the schema, and the validator wants a real language", () => {
    const it = wizardSchema.parse({ ...base, lang: "it" });
    expect(wizardLang(it)).toBe("it");
    expect(validateWizard(it)).toEqual([]);
    const made = wizardSchema.parse({ ...base, lang: "xx" });
    expect(validateWizard(made).map((i) => i.message).join(" ")).toContain('"xx"');
    expect(wizardSchema.safeParse({ ...base, lang: "ita" }).success).toBe(false);
    expect(wizardSchema.safeParse({ ...base, lang: "IT" }).success).toBe(false);
  });

  it("knows real languages and reads engenty's own strings in English where they lack one", () => {
    expect(isRealLanguage("nb")).toBe(true);
    expect(isRealLanguage("qq")).toBe(false);
    expect(textLang("it")).toBe("en");
    expect(textLang("de")).toBe("de");
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-onboarding-"));
process.env.APP_URL = "http://localhost:5181";
process.env.MARKETPLACE_URL = "off";

let onboarding: typeof import("../src/services/onboarding");
let settings: typeof import("../src/settings");

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  onboarding = await import("../src/services/onboarding");
  settings = await import("../src/settings");
});

describe("what a website says about a company", () => {
  it("takes the company's part of the page title", () => {
    expect(onboarding.companyOf("Platzer Fenster & Türen – Fenster aus Oberösterreich")).toBe(
      "Platzer Fenster & Türen",
    );
    expect(onboarding.companyOf("Home | Kern Raumausstattung")).toBe("Kern Raumausstattung");
    expect(onboarding.companyOf("Studio Nord")).toBe("Studio Nord");
    expect(onboarding.companyOf("engenty wizards: describe a task, get an AI wizard")).toBe(
      "engenty wizards",
    );
  });

  it("prefers the description, else the first paragraph of prose", () => {
    const description = "Wir fertigen und montieren Fenster und Türen in Oberösterreich.";
    expect(onboarding.aboutOf(description, "")).toBe(description);
    const text =
      "# Willkommen\n\n[Kontakt](https://example.com/kontakt)\n\nSeit 1987 fertigen wir Fenster und Türen für Privathäuser und Bauträger, freundlich und auf den Punkt.\n\nMehr";
    expect(onboarding.aboutOf("", text)).toMatch(/^Seit 1987/);
  });

  it("picks telling colours, the theme colour first, and skips greys", () => {
    const colors = onboarding.brandColors({
      themeColor: "#1957d2",
      variables: [
        { name: "--grey", value: "#888888" },
        { name: "--accent", value: "rgb(232, 89, 12)" },
        { name: "--brand", value: "#1957D2" },
      ],
      frequent: ["#fff", "#f0c", "#000", "#123456"],
    });
    expect(colors.map((c) => c.value)).toEqual(["#1957d2", "#e8590c", "#ff00cc"]);
    expect(colors[1].name).toBe("accent");
  });
});

describe("the mark that the first visit is done", () => {
  it("is kept per tenant in the control database", async () => {
    expect(await settings.readSetting("onboarding:tenant-o")).toBeNull();
    await onboarding.finishOnboarding("tenant-o");
    expect(await settings.readSetting<{ doneAt: string }>("onboarding:tenant-o")).toMatchObject({
      doneAt: expect.any(String),
    });
  });

  it("is never asked of a runtime that runs alone", async () => {
    expect(
      await onboarding.needsOnboarding({ id: "u", tenantId: "tenant-o", role: "owner" }),
    ).toBe(false);
  });
});

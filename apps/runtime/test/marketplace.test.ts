import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MarketplaceExport,
  MarketplaceItem,
  MarketplacePage,
  MarketplaceSummary,
} from "@engenty-wizards/shared/marketplace";
import { searchEntries } from "@engenty-wizards/shared/marketplace-search";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-marketplace-"));
process.env.APP_URL = "http://localhost:5181";
process.env.MARKETPLACE_URL = "http://market.test/wizards";

let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");
let files: typeof import("../src/services/files");
let market: typeof import("../src/services/marketplace");

/** A runtime that runs alone: its one person's stars are the ones it keeps. */
const TENANT = "local";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);

const definition = {
  version: 1,
  title: "Grußkarte",
  description: "Eine Karte zum Anlass.",
  avatar: "round",
  steps: [
    {
      id: "start",
      type: "page",
      title: "Anlass",
      fields: [
        { id: "occasion", label: "Anlass", kind: "select", options: ["Geburtstag", "Hochzeit"] },
      ],
    },
    {
      id: "card",
      type: "agent",
      title: "Karte schreiben",
      instructions: "Schreibe eine Grußkarte zum Anlass {{occasion}}.",
      tools: [],
      output: { format: "text" },
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [{ from: "card", formats: ["txt"] }] },
  ],
};

function exportOf(id: string, over: Partial<MarketplaceExport> = {}): MarketplaceExport {
  return {
    id,
    revision: 1,
    hash: `${id}-1`,
    updatedAt: "2026-10-04T10:00:00.000Z",
    starter: true,
    language: "de",
    title: id === "card" ? "Grußkarte" : "Rechnung",
    pitch: id === "card" ? "Eine Karte zum Anlass." : "Eine Rechnung als PDF.",
    terms: id === "card" ? ["Glückwunsch"] : ["Faktura"],
    avatar: "round",
    formats: ["text"],
    industries: ["any"],
    useCases: id === "card" ? ["marketing"] : ["accounting"],
    capabilities: ["text"],
    effort: { fields: 1, required: 0, reviews: 0, minutes: 1 },
    costTier: "low",
    steps: 3,
    version: 1,
    texts: [
      { language: "de", title: "Grußkarte", pitch: "Eine Karte.", definition, machine: false },
      {
        language: "en",
        title: "Greeting card",
        pitch: "A card.",
        definition: { ...definition, title: "Greeting card" },
        machine: true,
      },
    ],
    files: { "notes.md": Buffer.from("# Anlässe").toString("base64") },
    ...over,
  };
}

/** The marketplace as the contract describes it, for the entries the test puts here. */
const remote = {
  online: true,
  entries: new Map<string, MarketplaceExport>(),
  calls: [] as string[],
};

function summaryOf(e: MarketplaceExport, lang: string): MarketplaceSummary {
  const { texts, files: _files, ...summary } = e;
  const text = texts.find((t) => t.language === lang) ?? texts[0];
  return { ...summary, language: text.language, title: text.title, pitch: text.pitch };
}

async function marketplace(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(String(input));
  remote.calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
  if (!remote.online) {
    throw new TypeError("fetch failed");
  }
  const lang = url.searchParams.get("lang") ?? "de";
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const path = url.pathname.replace("/wizards/api/v1", "");
  const all = [...remote.entries.values()];
  if (path === "/entries") {
    const ids = url.searchParams.get("ids");
    const summaries = all.map((e) => summaryOf(e, lang));
    const page: MarketplacePage = ids
      ? {
          entries: ids.split(",").flatMap((id) => summaries.find((s) => s.id === id) ?? []),
          total: 0,
          all: summaries.length,
          facets: { useCase: {}, industry: {}, format: {} },
        }
      : searchEntries(summaries, url.searchParams.get("q") ?? "", {
          useCase: (url.searchParams.get("useCase") ?? undefined) as never,
        });
    return json(page);
  }
  if (path === "/sync") {
    const named = (url.searchParams.get("ids") ?? "").split(",");
    return json({
      items: all
        .filter((e) => e.starter || named.includes(e.id))
        .map(({ id, hash, updatedAt }) => ({ id, hash, updatedAt })),
    });
  }
  const m = path.match(/^\/entries\/([^/]+)(\/export|\/installs)?$/);
  const entry = m ? remote.entries.get(decodeURIComponent(m[1])) : undefined;
  if (!entry) {
    return json({ error: "not found" }, 404);
  }
  if (m?.[2] === "/installs") {
    return new Response(null, { status: 204 });
  }
  if (m?.[2] === "/export") {
    return json(entry);
  }
  const text = entry.texts.find((t) => t.language === lang) ?? entry.texts[0];
  const item: MarketplaceItem = {
    ...summaryOf(entry, lang),
    definition: text.definition,
    files: entry.files,
  };
  return json(item);
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  wizards = await import("../src/services/wizards");
  files = await import("../src/services/files");
  market = await import("../src/services/marketplace");
});

beforeEach(() => {
  remote.online = true;
  remote.calls = [];
  remote.entries = new Map([
    ["card", exportOf("card")],
    ["invoice", exportOf("invoice", { starter: false })],
  ]);
  vi.stubGlobal("fetch", vi.fn(marketplace));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searching", () => {
  it("asks the marketplace and reads each entry against this app", async () => {
    const found = await inTenant(() =>
      market.searchMarketplace({ q: "Faktura", lang: "de", useCase: "accounting" }),
    );
    expect(found.offline).toBe(false);
    expect(found.entries.map((e) => e.id)).toEqual(["invoice"]);
    expect(found.entries[0]).toMatchObject({ usable: true, starred: false, credits: null });
    expect(remote.calls[0]).toBe(
      "GET /wizards/api/v1/entries?lang=de&limit=60&offset=0&q=Faktura&useCase=accounting",
    );
  });

  it("marks an entry written for a newer app", async () => {
    remote.entries.set("card", exportOf("card", { version: 99 }));
    const found = await inTenant(() => market.searchMarketplace({ lang: "de" }));
    expect(found.entries.find((e) => e.id === "card")?.usable).toBe(false);
  });
});

describe("what is kept for offline use", () => {
  it("is the starters and the starred entries, fetched again only when changed", async () => {
    const exports = () => remote.calls.filter((c) => c.endsWith("/export"));
    await market.syncMarketplace(true);
    expect(exports()).toEqual(["GET /wizards/api/v1/entries/card/export"]);

    // A star is kept at once; the sync it starts and this one are the same.
    await inTenant(() => market.starEntry(TENANT, "invoice", true));
    await market.syncMarketplace(true);
    expect(exports()).toEqual([
      "GET /wizards/api/v1/entries/card/export",
      "GET /wizards/api/v1/entries/invoice/export",
    ]);

    // Changed at the marketplace: its hash differs, so it comes again; the other does not.
    remote.entries.set("card", exportOf("card", { revision: 2, hash: "card-2" }));
    await market.syncMarketplace(true);
    expect(exports().slice(2)).toEqual(["GET /wizards/api/v1/entries/card/export"]);
  });

  it("answers a search when the marketplace does not, scored the same way", async () => {
    remote.online = false;
    const found = await inTenant(() => market.searchMarketplace({ q: "Faktura", lang: "en" }));
    expect(found.offline).toBe(true);
    expect(found.entries.map((e) => [e.id, e.title, e.starred])).toEqual([
      ["invoice", "Greeting card", true],
    ]);
    const starred = await inTenant(() => market.searchMarketplace({ lang: "de", starred: true }));
    expect(starred.entries.map((e) => e.id)).toEqual(["invoice"]);
  });

  it("forgets what the marketplace no longer lists", async () => {
    remote.entries.delete("card");
    await inTenant(() => market.starEntry(TENANT, "invoice", false));
    await market.syncMarketplace(true);
    remote.online = false;
    const found = await inTenant(() => market.searchMarketplace({ lang: "de" }));
    expect(found.entries).toEqual([]);
  });
});

describe("an entry", () => {
  it("shows what its wizard does, makes and costs", async () => {
    const detail = await inTenant(() => market.marketplaceDetail("card", "de"));
    expect(detail).toMatchObject({
      id: "card",
      usable: true,
      description: "Eine Karte zum Anlass.",
      outline: [
        { id: "start", type: "page", title: "Anlass" },
        { id: "card", type: "agent", title: "Karte schreiben" },
        { id: "done", type: "result", title: "Fertig" },
      ],
      results: [{ title: "Karte schreiben", kind: "text", formats: ["txt"] }],
      files: ["notes.md"],
    });
    expect(detail?.credits?.credits).toBeGreaterThan(0);
  });

  it("cannot be started where this app would lose part of its wizard", async () => {
    remote.entries.set(
      "card",
      exportOf("card", {
        texts: [
          {
            language: "de",
            title: "Grußkarte",
            pitch: "",
            definition: { ...definition, sparkle: true },
            machine: false,
          },
        ],
      }),
    );
    expect((await inTenant(() => market.marketplaceDetail("card", "de")))?.usable).toBe(false);
    await expect(inTenant(() => wizards.createWizard("u", { starterId: "card" }))).rejects.toThrow(
      /newer version/,
    );
  });

  it("becomes a wizard of its own, with its files, and is counted", async () => {
    const { id } = await inTenant(() =>
      wizards.createWizard("u", { starterId: "card", lang: "en" }),
    );
    const w = await inTenant(() => wizards.ownedWizard("u", id));
    expect(w).toMatchObject({ title: "Greeting card", starter: "card", starterRevision: 1 });
    // The starter's language goes with it: the wizard names it from the start.
    expect(w.draft.lang).toBe("en");
    expect((await inTenant(() => files.draftFiles(id))).map((f) => f.path)).toEqual(["notes.md"]);
    await vi.waitFor(() =>
      expect(remote.calls).toContain("POST /wizards/api/v1/entries/card/installs"),
    );
    await expect(inTenant(() => wizards.createWizard("u", { starterId: "nope" }))).rejects.toThrow(
      /no template/,
    );
  });

  it("leaves a blank wizard in the maker's language, English where none is given", async () => {
    for (const [lang, title, named] of [
      ["de", "Neuer Wizard", "de"],
      ["en", "New wizard", "en"],
      [undefined, "New wizard", "en"],
    ] as const) {
      const { id } = await inTenant(() => wizards.createWizard("u", { lang }));
      const w = await inTenant(() => wizards.ownedWizard("u", id));
      expect(w.draft).toMatchObject({ title, lang: named });
    }
  });
});

describe("an entry that needs plugins", () => {
  const booking = {
    ...definition,
    title: "Termin",
    steps: [
      {
        id: "book",
        type: "agent",
        title: "Buchen",
        instructions: "Buche den Termin.",
        tools: ["appointments.book"],
        output: { format: "markdown" },
      },
      { id: "done", type: "result", title: "Fertig", deliverables: [{ from: "book", formats: ["md"] }] },
    ],
  };
  const entry = () =>
    exportOf("booking", {
      starter: false,
      plugins: ["appointments"],
      plan: "pro",
      pluginStarter: "appointments.link",
      texts: [{ language: "de", title: "Termin", pitch: "Bucht.", definition: booking, machine: false }],
    });

  it("says which plugins this app lacks, and the Pro filter finds it", async () => {
    remote.entries.set("booking", entry());
    const found = await inTenant(() => market.searchMarketplace({ lang: "de" }));
    expect(found.entries.find((e) => e.id === "booking")).toMatchObject({
      plan: "pro",
      needs: ["appointments"],
    });
    expect(found.entries.find((e) => e.id === "card")?.needs).toBeUndefined();
    const pro = searchEntries(
      [...remote.entries.values()].map((e) => summaryOf(e, "de")),
      "",
      { plan: "pro" },
    );
    expect(pro.entries.map((e) => e.id)).toEqual(["booking"]);
    expect(pro.facets.plan).toEqual({ free: 2, pro: 1 });
  });

  it("cannot be started without them", async () => {
    remote.entries.set("booking", entry());
    await expect(inTenant(() => market.marketplaceWizard("booking", "de"))).rejects.toThrow(
      /appointments/,
    );
  });
});

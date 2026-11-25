import { describe, expect, it, vi } from "vitest";
import { type CatalogEntry, createCatalogSearch, memoryVectors } from "./catalog-search.js";
import { defineEmbedder } from "./embedder.js";

const entries: CatalogEntry[] = [
  { id: "schedule_set", title: "schedule set", description: "Set a task that runs at a time." },
  { id: "browser_open", title: "browser open", description: "Open a web page. It is shown." },
  { id: "invite_make", title: "invite make", description: "Make an invite for someone." },
];

// A space of three directions: time, web, people, in any language.
const about = [/time|task|erinner|freitag/i, /web|page|öffne|seite/i, /invite|someone|lade|anna/i];
const embed = (texts: string[]) =>
  Promise.resolve(texts.map((text) => about.map((word) => (word.test(text) ? 1 : 0.1))));
const embedder = (calls?: string[][], modelId = "test") =>
  defineEmbedder(
    (texts) => {
      calls?.push(texts);
      return embed(texts);
    },
    { dimensions: 3, modelId, query: embed },
  );
const quiet = { warn: () => undefined };
const ids = (result: { hits: { entry: CatalogEntry }[] }) => result.hits.map((h) => h.entry.id);

describe("catalog search", () => {
  it("finds by words what the query spells out, and nothing without a shared word", async () => {
    const search = createCatalogSearch();
    expect(ids(await search.search(entries, "make an invite"))[0]).toBe("invite_make");
    const german = await search.search(entries, "Erinnere mich am Freitag");
    expect(german).toEqual({ hits: [], by: "words", judged: false });
  });

  it("finds by meaning across languages", async () => {
    const search = createCatalogSearch({ embedder: () => embedder() });
    const result = await search.search(entries, "Erinnere mich am Freitag", { limit: 1 });
    expect(result.by).toBe("meaning");
    expect(ids(result)).toEqual(["schedule_set"]);
  });

  it("embeds each entry once, and anew in another vector space", async () => {
    const calls: string[][] = [];
    const store = memoryVectors();
    const search = createCatalogSearch({ embedder: () => embedder(calls), store });
    await search.prepare(entries);
    await search.search(entries, "Lade Anna ein");
    expect(calls.flat()).toHaveLength(new Set(calls.flat()).size);
    const texts = calls.flat().length;
    await createCatalogSearch({ embedder: () => embedder(calls, "other"), store }).prepare(entries);
    expect(calls.flat()).toHaveLength(2 * texts);
  });

  it("answers by words when the embedder is slow or fails, and keeps what comes later", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slow = defineEmbedder(async (texts) => gate.then(() => embed(texts)), {
      dimensions: 3,
      modelId: "slow",
      query: embed,
    });
    const search = createCatalogSearch({ embedder: () => slow, waitMs: 20 });
    expect((await search.search(entries, "web page")).by).toBe("words");
    open();
    await vi.waitFor(async () =>
      expect((await search.search(entries, "öffne orf.at")).by).toBe("meaning"),
    );
    const broken = defineEmbedder(() => Promise.reject(new Error("down")), {
      dimensions: 3,
      modelId: "broken",
    });
    const words = createCatalogSearch({ embedder: () => broken, log: quiet });
    expect((await words.search(entries, "web page")).by).toBe("words");
  });

  it("lets a judge bring one up, leave some out and find none", async () => {
    const judge = vi.fn(async (query: string, candidates: CatalogEntry[]) =>
      candidates.map((c) => (query === "thanks" ? 0.1 : c.id === "invite_make" ? 0.9 : 0.2)),
    );
    const search = createCatalogSearch({ embedder: () => embedder(), judge });
    const result = await search.search(entries, "Öffne die Seite für Anna");
    expect(result.judged).toBe(true);
    expect(ids(result)).toEqual(["invite_make"]);
    expect(ids(await search.search(entries, "thanks"))).toEqual([]);
  });

  it("keeps the order when the judge does not answer in time", async () => {
    const search = createCatalogSearch({
      embedder: () => embedder(),
      judge: () => new Promise(() => undefined),
      waitMs: 20,
    });
    const result = await search.search(entries, "Öffne die Seite", { limit: 1 });
    expect(result.judged).toBe(false);
    expect(ids(result)).toEqual(["browser_open"]);
  });
});

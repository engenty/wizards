import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type DecisionModel, decisionBy } from "@engenty/decision-model";
import type { SearchEmbedder } from "@engenty/search-index";
import { createOllamaEmbedder } from "@engenty/search-index/embedders";
import { createClient } from "@libsql/client";
import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunksOf } from "./chunks.js";
import { createLibsqlSearch, type SearchLog, type SearchSource } from "./search.js";
import { plain } from "./text.js";

// The search against a fake Ollama: /api/embed gives bags of words (an image:
// the words drawn on it, here "solar chart"), /v1/systemone says how many of
// the query's words a candidate has. Nothing leaves this machine and nothing
// is paid for.

const DIMS = 1024;
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const bag = (s: string) => {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of words(s)) {
    let h = 0;
    for (const ch of w) {
      h = (h * 31 + ch.charCodeAt(0)) % DIMS;
    }
    v[h] = (v[h] ?? 0) + 1;
  }
  return v;
};
/** EmbeddingGemma's prompts, without the parts every input has. */
const unprompt = (s: string) =>
  s.replace(/^task: search result \| query: /, "").replace(/^title: [^|]* \| text: /, "");

const calls = { decide: 0, embed: 0, images: 0 };
const dir = mkdtempSync(join(tmpdir(), "search-libsql-"));
const repo = join(dir, "repo");
const db = createClient({ url: `file:${join(dir, "search.db")}` });
const quiet: SearchLog = {
  error: () => undefined,
  log: () => undefined,
  warn: () => undefined,
};
let ollama: Server;
let base = "";

const write = (path: string, data: string | Buffer) => {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, data);
};

/** The files under the repo, each at the hash of its content. */
function folder(root: string): SearchSource {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    );
  return {
    read: (path) => Promise.resolve({ text: readFileSync(join(root, path), "utf8") }),
    readBytes: (path) => Promise.resolve(readFileSync(join(root, path))),
    tree: () =>
      Promise.resolve({
        files: walk(root).map((full) => ({
          path: relative(root, full),
          size: statSync(full).size,
          version: createHash("sha1").update(readFileSync(full)).digest("hex"),
        })),
        head: null,
      }),
  };
}

/** A one-page PDF with a line of text, its cross-reference table counted out. */
function pdfWith(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) {
    out += `${String(o).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function fakeOllama(): Server {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const json = (data: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url === "/api/tags") {
        return json({
          models: [
            {
              capabilities: ["embedding", "vision"],
              name: "embeddinggemma-2:740m",
            },
            { capabilities: ["decision"], name: "clef-flash:latest" },
          ],
        });
      }
      if (req.url === "/api/embed") {
        calls.embed++;
        const { input } = JSON.parse(body) as {
          input: (string | { image: string })[];
        };
        return json({
          embeddings: input.map((i) => {
            if (typeof i === "string") {
              return bag(unprompt(i));
            }
            calls.images++;
            return bag("solar chart");
          }),
        });
      }
      if (req.url === "/v1/systemone") {
        calls.decide++;
        const { state } = JSON.parse(body) as {
          state: {
            candidates: { index: number; text: string; title: string }[];
            query: string;
          };
        };
        const q = words(state.query);
        return json({
          answers: Object.fromEntries(
            state.candidates.map((c) => {
              const has = new Set(words(`${c.title} ${c.text}`));
              const noul = q.filter((w) => has.has(w)).length / q.length;
              return [`c${c.index}`, { noul, type: "noul" }];
            }),
          ),
          model: "clef-flash",
        });
      }
      res.writeHead(404);
      res.end();
    });
  });
}

beforeAll(async () => {
  ollama = fakeOllama();
  await new Promise<void>((ok) => ollama.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;

  write(
    "docs/notes/battery.md",
    "# Batteries\n\nIntro.\n\n## Home storage\n\nA home battery stores solar power for the evening.\nIts storage capacity is given in kWh.\n",
  );
  write(
    "docs/notes/tariffs.md",
    "# Tariffs\n\nThe grid fees (Netzentgelte) are lower inside an energy community.\n",
  );
  write("docs/data/prices.csv", "month,price\njanuary,12\nfebruary,13\n");
  const canvas = createCanvas(200, 120);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fa0";
  ctx.fillRect(10, 10, 80, 100);
  write("docs/shots/img-001.png", canvas.toBuffer("image/png"));
  write("docs/legal/statutes.pdf", pdfWith("Statutes of the energy community"));
});

afterAll(() => {
  ollama.close();
  db.close();
  rmSync(dir, { force: true, recursive: true });
});

/** The embedder the search asks for; a test switches it off. */
let embedderNow: SearchEmbedder | null = null;

const setup = async (source: SearchSource = folder(repo)) => {
  embedderNow ??= createOllamaEmbedder({ baseUrl: base, images: true });
  const judge: DecisionModel | null = await decisionBy("local", {
    ollamaUrl: base,
  });
  const search = createLibsqlSearch({
    db,
    embedder: () => embedderNow,
    judge,
    log: quiet,
    source,
    thumbUrl: ({ path, passage }) =>
      passage === null
        ? `/api/raw?path=${encodeURIComponent(path)}`
        : `/api/search/thumb?id=${passage}`,
  });
  await search.sync();
  await search.embedAll();
  return search;
};

describe("text", () => {
  it("keeps a passage's heading and line", () => {
    const chunks = chunksOf("md", "# A\n\nfirst\n\n## B\n\nsecond\nthird\n");
    expect(chunks.map((c) => [c.heading, c.line, c.text])).toEqual([
      ["A", 3, "first"],
      ["B", 7, "second\nthird"],
    ]);
    const table = chunksOf("csv", `h1,h2\n${"x,y\n".repeat(400)}`);
    expect(table.length).toBeGreaterThan(1);
    expect(table.every((c) => c.text.startsWith("h1,h2\n"))).toBe(true);
  });

  it("makes snippets plain text", () => {
    expect(plain("- **Why per quarter-hour:** see `§ 71`")).toBe("Why per quarter-hour: see § 71");
    expect(plain("![eFriends 3](web-03.jpg) and [the FAQ](https://x.at)")).toBe(
      "eFriends 3 and the FAQ",
    );
    expect(plain("| egon | E.ON | Austria |")).toBe("egon · E.ON · Austria");
  });
});

describe("createLibsqlSearch", () => {
  it("indexes text, images and PDF pages, with vectors", async () => {
    const search = await setup();
    const status = await search.status();
    expect(status).toMatchObject({
      embedded: 5,
      files: 5,
      images: 1,
      lastError: null,
      pages: 1,
    });
    // The image and the PDF page went in as pictures.
    expect(calls.images).toBe(2);
    // The vectors are recorded under the model's id, as peer-it's index has them.
    const refs = await db.execute("SELECT DISTINCT embedded FROM search_file");
    expect(refs.rows.map((r) => r.embedded)).toEqual(["ollama:embeddinggemma-2:740m"]);
  });

  it("finds words, at their line", async () => {
    const search = await setup();
    const found = await search.query("netzentgelte");
    expect(found.hits[0]?.path).toBe("docs/notes/tariffs.md");
    expect(found.hits[0]?.line).toBe(3);
    expect(found.meaning).toBe(true);
    expect(found.canRank).toBe(true);
  });

  it("finds an image by what it shows", async () => {
    const search = await setup();
    const found = await search.query("chart");
    const image = found.hits.find((h) => h.kind === "image");
    expect(image?.path).toBe("docs/shots/img-001.png");
    expect(image?.thumb).toBe("/api/raw?path=docs%2Fshots%2Fimg-001.png");
  });

  it("finds a PDF page, with a thumbnail", async () => {
    const search = await setup();
    const found = await search.query("statutes");
    const page = found.hits.find((h) => h.kind === "page");
    expect(page?.path).toBe("docs/legal/statutes.pdf");
    expect(page?.page).toBe(1);
    const id = Number(page?.thumb?.match(/^\/api\/search\/thumb\?id=(\d+)$/)?.[1]);
    const jpeg = await search.thumb(id);
    // A JPEG starts with FF D8.
    expect([...(jpeg ?? []).slice(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it("lets the decision model rank, and drop what does not answer", async () => {
    const search = await setup();
    const before = calls.decide;
    const found = await search.query("battery storage capacity", {
      perFile: 3,
      rerank: true,
    });
    expect(calls.decide).toBe(before + 1);
    expect(found.ranked).toBe(true);
    expect(found.hits[0]?.path).toBe("docs/notes/battery.md");
    expect(found.hits[0]?.heading).toBe("Home storage");
    expect(found.hits[0]?.line).toBe(7);
    expect(found.hits[0]?.relevance ?? 0).toBeGreaterThan(0.5);
    const dropped = await search.query("battery storage capacity", {
      drop: true,
      rerank: true,
    });
    expect(dropped.hits.every((h) => h.kind === "image" || (h.relevance ?? 0) >= 0.5)).toBe(true);
  });

  it("follows changes: only what changed is read again", async () => {
    const search = await setup();
    const embeds = calls.embed;
    write("docs/notes/tariffs.md", "# Tariffs\n\nFeed-in rates for surplus electricity.\n");
    await search.sync();
    await search.embedAll();
    // One file's passages, and nothing else.
    expect(calls.embed).toBe(embeds + 1);
    expect((await search.query("netzentgelte")).hits).toHaveLength(0);
    expect((await search.query("surplus")).hits[0]?.path).toBe("docs/notes/tariffs.md");
  });

  it("finds words only without an embedder", async () => {
    const search = await setup();
    const was = embedderNow;
    embedderNow = null;
    try {
      const found = await search.query("surplus electricity");
      expect(found.meaning).toBe(false);
      expect(found.hits[0]?.path).toBe("docs/notes/tariffs.md");
      expect((await search.query("chart")).hits).toHaveLength(0);
    } finally {
      embedderNow = was;
    }
  });

  it("suggests headings of the files given", async () => {
    const search = await setup();
    expect(
      await search.suggestions(["docs/notes/battery.md", "docs/notes/tariffs.md"]),
      // "Tariffs" is too short to be a question.
    ).toEqual(["Batteries"]);
  });

  it("reads other documents through the host's readers", async () => {
    write("docs/data/plan.sheet", "binary");
    const source = folder(repo);
    const search = createLibsqlSearch({
      db,
      documents: {
        sheet: () => Promise.resolve("# Plan\n\nwind turbine yield"),
      },
      log: quiet,
      source,
    });
    await search.sync();
    const found = await search.query("turbine");
    expect(found.hits[0]?.path).toBe("docs/data/plan.sheet");
    expect(found.hits[0]?.heading).toBe("Plan");
    rmSync(join(repo, "docs/data/plan.sheet"));
    await search.sync();
  });

  it("runs overlapping syncs one at a time, and the last change gets in", async () => {
    const plainSource = folder(repo);
    let now = 0;
    let most = 0;
    const source: SearchSource = {
      ...plainSource,
      async tree() {
        now++;
        most = Math.max(most, now);
        await new Promise((r) => setTimeout(r, 30));
        try {
          return await plainSource.tree();
        } finally {
          now--;
        }
      },
    };
    const search = createLibsqlSearch({ db, log: quiet, source });
    write("docs/notes/overlap.md", "# Overlap\n\nFirst words.\n");
    const first = search.sync();
    write("docs/notes/overlap.md", "# Overlap\n\nSecond words, written while the first run ran.\n");
    await Promise.all([first, search.sync(), search.sync()]);
    // The follow-up run the later calls asked for.
    await search.sync();
    expect(most).toBe(1);
    expect((await search.query("written while")).hits[0]?.path).toBe("docs/notes/overlap.md");
  });
});

// Measures how many pictures and PDF pages an Ollama embeds per minute, as the space index sends
// them (src/files/pictures.ts): a 768 px JPEG each, through /api/embed.
//
//   pnpm exec tsx scripts/measure-pictures.ts <folder> [--ollama http://host:11434] [--batch 4]
//
// The folder's .jpg, .jpeg, .png and .webp files count as pictures, its .pdf files as pages (the
// first 40 of each). Preparing the JPEGs is timed apart from embedding: it runs in the runtime,
// the embedding in Ollama.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { jpegOf, pdfPages } from "../src/files/pictures.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ollama: { type: "string", default: "http://localhost:11434" },
    model: { type: "string", default: "embeddinggemma-2:740m" },
    batch: { type: "string", default: "1" },
  },
});
const folder = positionals[0];
if (!folder) {
  console.error("Usage: tsx scripts/measure-pictures.ts <folder> [--ollama URL] [--batch N]");
  process.exit(1);
}
const root = values.ollama.replace(/\/+$/, "").replace(/\/v1$/, "");
const batch = Math.max(1, Number(values.batch) || 1);

async function embed(jpegs: Buffer[]) {
  const res = await fetch(`${root}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: values.model,
      input: jpegs.map((j) => ({ image: j.toString("base64") })),
      truncate: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { embeddings?: number[][] };
  if (body.embeddings?.length !== jpegs.length) {
    throw new Error("Ollama gave no vector for every picture.");
  }
}

async function measure(label: string, jpegs: Buffer[], prepared: number) {
  if (!jpegs.length) {
    return;
  }
  const started = Date.now();
  for (let i = 0; i < jpegs.length; i += batch) {
    await embed(jpegs.slice(i, i + batch));
  }
  const ms = Date.now() - started;
  const perMin = (n: number, t: number) => ((n / t) * 60_000).toFixed(1);
  console.log(
    `${label}: ${jpegs.length} | embedding ${(ms / 1000).toFixed(1)} s, ${perMin(jpegs.length, ms)}/min | preparing ${(prepared / 1000).toFixed(1)} s | both ${perMin(jpegs.length, ms + prepared)}/min`,
  );
}

const files = readdirSync(folder).filter((f) => !f.startsWith("."));
const pictures: Buffer[] = [];
let picturesPrepared = 0;
const pages: Buffer[] = [];
let pagesPrepared = 0;
for (const f of files) {
  const ext = extname(f).toLowerCase();
  const bytes = readFileSync(join(folder, f));
  const started = Date.now();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
    pictures.push(await jpegOf(bytes));
    picturesPrepared += Date.now() - started;
  } else if (ext === ".pdf") {
    for (const p of await pdfPages(bytes)) {
      pages.push(p.jpeg);
    }
    pagesPrepared += Date.now() - started;
  }
}
// The first call loads the model; it does not count.
await embed(pictures.slice(0, 1).concat(pages.slice(0, 1)).slice(0, 1));
console.log(`${root} ${values.model}, ${batch} per call`);
await measure("pictures", pictures, picturesPrepared);
await measure("PDF pages", pages, pagesPrepared);

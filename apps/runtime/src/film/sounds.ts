import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../env.js";
import { platformSkills } from "./skills.js";

/**
 * The sounds a film may use: nothing is generated, synthesized or downloaded by the client.
 * soundcn (soundcn.xyz, MIT; the sounds by Kenney, CC0) for clicks, pops, impacts, jingles,
 * switches, pages and paper; the effects HyperFrames ships with (whooshes, typing, risers).
 * Fetched once into the data folder; `catalog.json` lists every file with tags and licence.
 */

const REGISTRY = "https://soundcn.xyz/r";
/** soundcn categories that suit motion design; game noises (warcraft, laser, combat …) stay out. */
const KEEP = new Set([
  "ui",
  "click",
  "switch",
  "select",
  "maximize",
  "minimize",
  "book",
  "card",
  "cloth",
  "scratch",
  "scroll",
  "drop",
  "glass",
  "jingles",
  "pep",
  "power",
  "impact",
  "chips",
  "dice",
  "error",
  "round",
  "zap",
  "phase",
  "low",
  "metal",
  "crafting",
]);
const CATALOG_VERSION = 1;

interface Sound {
  file: string;
  source: string;
  author?: string;
  licence: string;
  duration?: number;
  description?: string;
  tags?: string[];
  keywords?: string[];
}

interface RegistryItem {
  name: string;
  categories?: string[];
  meta?: { duration?: number; license?: string; tags?: string[]; keywords?: string[] };
}

const dir = join(env.dataDir, "catalogs", `sounds-v${CATALOG_VERSION}`);
let building: Promise<string> | null = null;

/** The catalog folder (catalog.json + sfx/); built on first use. */
export function soundCatalog(): Promise<string> {
  if (existsSync(join(dir, "catalog.json"))) {
    return Promise.resolve(dir);
  }
  building ??= build().finally(() => {
    building = null;
  });
  return building;
}

async function build(): Promise<string> {
  const tmp = `${dir}.part`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(join(tmp, "sfx"), { recursive: true });
  const sounds: Sound[] = [];

  const index = (await (await fetch(`${REGISTRY}/registry.json`)).json()) as {
    items: RegistryItem[];
  };
  const picked = index.items.filter((i) => i.categories?.some((c) => KEEP.has(c)));
  let next = 0;
  const worker = async () => {
    while (next < picked.length) {
      const item = picked[next++];
      try {
        const res = await fetch(`${REGISTRY}/${item.name}.json`);
        const json = (await res.json()) as {
          author?: string;
          description?: string;
          files?: { content?: string }[];
        };
        const m = json.files?.[0]?.content?.match(/data:audio\/(\w+);base64,([A-Za-z0-9+/=]+)/);
        if (!m) {
          continue;
        }
        const ext = m[1] === "mpeg" ? "mp3" : m[1];
        await writeFile(join(tmp, "sfx", `${item.name}.${ext}`), Buffer.from(m[2], "base64"));
        sounds.push({
          file: `sfx/${item.name}.${ext}`,
          source: "soundcn",
          author: json.author ?? "Kenney",
          licence: item.meta?.license ?? "CC0",
          duration: item.meta?.duration,
          description: json.description,
          tags: item.categories?.concat(item.meta?.tags ?? []),
          keywords: item.meta?.keywords,
        });
      } catch {
        // one sound less
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  // The effects HyperFrames ships with its media skill.
  const hf = join(await platformSkills("hyperframes"), "media-use", "audio", "assets", "sfx");
  if (existsSync(hf)) {
    for (const f of await readdir(hf)) {
      if (f.endsWith(".mp3")) {
        await cp(join(hf, f), join(tmp, "sfx", `hf-${f}`));
        sounds.push({
          file: `sfx/hf-${f}`,
          source: "hyperframes",
          licence: "see CREDITS-hyperframes.md",
          description: f.replace(/\.mp3$/, "").replace(/-/g, " "),
        });
      }
    }
    if (existsSync(join(hf, "CREDITS.md"))) {
      await writeFile(join(tmp, "CREDITS-hyperframes.md"), await readFile(join(hf, "CREDITS.md")));
    }
  }
  if (!sounds.length) {
    throw new Error("The sounds for films could not be loaded.");
  }
  sounds.sort((a, b) => a.file.localeCompare(b.file));
  await writeFile(
    join(tmp, "catalog.json"),
    JSON.stringify(
      {
        note: "The only sounds this film may use. Never generate, synthesize or download audio.",
        music: [],
        sounds,
      },
      null,
      1,
    ),
  );
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  return dir;
}

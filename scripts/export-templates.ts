// Every template of the marketplace as a `.wizard` package with its standalone fit, into
// dist/templates/: what the WordPress plugin ships for sites without an account (its release
// workflow takes the ones with `fit: "full"`). Reads the marketplace as a runtime does
// (docs/marketplace-contract.md); nothing of an account is needed.
//
//   pnpm templates:export                     from MARKETPLACE_URL or https://engenty.ai/wizards
//   pnpm templates:export --only free         the free plan's entries only (default: every plan)
//   pnpm templates:export --ids a,b           just these
//
// Out: dist/templates/<id>.wizard (zip: wizard.json + files/), dist/templates/index.json with
// id, title, pitch, avatar, use cases, formats, effort, cost tier, plan, plugins and the fit.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseWizard } from "@engenty-wizards/shared/definition";
import { standaloneEntry } from "@engenty-wizards/shared/fit";
import type {
  MarketplaceExport,
  MarketplacePage,
  MarketplaceSummary,
} from "@engenty-wizards/shared/marketplace";
import { strToU8, zipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist", "templates");
const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const base = (process.env.MARKETPLACE_URL ?? "https://engenty.ai/wizards").replace(/\/+$/, "");

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base}/api/v1${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`${path}: ${res.status}`);
  }
  return (await res.json()) as T;
}

async function entries(): Promise<MarketplaceSummary[]> {
  const ids = option("ids");
  if (ids) {
    return (await get<MarketplacePage>(`/entries?ids=${encodeURIComponent(ids)}&lang=de`)).entries;
  }
  const plan = option("only");
  const found: MarketplaceSummary[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await get<MarketplacePage>(
      `/entries?lang=de&limit=100&offset=${offset}${plan ? `&plan=${plan}` : ""}`,
    );
    found.push(...page.entries);
    if (found.length >= page.total || !page.entries.length) {
      break;
    }
  }
  return found;
}

/** The package as `exportWizard` makes it: the manifest and the workspace under `files/`. */
function pack(exported: MarketplaceExport, definition: unknown): Uint8Array {
  const manifest = {
    format: "engenty-wizard",
    version: 1,
    exportedAt: new Date().toISOString(),
    definition,
    connectors: [],
    mcpServers: [],
  };
  const files: Record<string, Uint8Array> = {
    "wizard.json": strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const [path, data] of Object.entries(exported.files)) {
    files[`files/${path}`] = new Uint8Array(Buffer.from(data, "base64"));
  }
  return zipSync(files, { level: 6 });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const index: unknown[] = [];
for (const summary of await entries()) {
  const exported = await get<MarketplaceExport>(`/entries/${summary.id}/export`);
  // The English text where there is one, else the entry's own.
  const text =
    exported.texts.find((x) => x.language === "en") ??
    exported.texts.find((x) => x.language === exported.language) ??
    exported.texts[0];
  const parsed = parseWizard(text.definition, Object.keys(exported.files));
  if (!parsed.ok) {
    console.warn(`skip ${summary.id}: ${parsed.issues[0]?.message}`);
    continue;
  }
  const fit = standaloneEntry(parsed.wizard);
  writeFileSync(join(out, `${summary.id}.wizard`), pack(exported, text.definition));
  index.push({
    id: summary.id,
    file: `${summary.id}.wizard`,
    title: text.title,
    pitch: text.pitch,
    language: text.language,
    avatar: summary.avatar,
    useCases: summary.useCases,
    industries: summary.industries,
    formats: summary.formats,
    capabilities: summary.capabilities,
    effort: summary.effort,
    costTier: summary.costTier,
    steps: summary.steps,
    plan: summary.plan ?? "free",
    plugins: summary.plugins ?? [],
    hash: summary.hash,
    revision: summary.revision,
    standalone: fit,
  });
  console.log(`${fit.fit.padEnd(4)} ${summary.id}  ${text.title}`);
}
writeFileSync(
  join(out, "index.json"),
  JSON.stringify({ exportedAt: new Date().toISOString(), source: base, templates: index }, null, 2),
);
console.log(`${index.length} templates → dist/templates/`);

#!/usr/bin/env node
// Sends each wish in wishes.json to the studio's architect, as "Wizard bauen" on /studio/new does,
// and keeps what came out: the wizard, the reply, the time. Then it writes report.md with the
// shape of each wizard and the checks from each wish's "expect". Local dev only (DEV_LOGIN=1).
//   API=http://127.0.0.1:8960 node scripts/builder-eval/run.mjs <outDir> [--only id,id] [--parallel 2]
// With --report it builds nothing and writes report.md again from the files in <outDir>.
// The wizards stay in the space, so each one can be opened in the studio afterwards.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.API ?? "http://127.0.0.1:8960";
const args = process.argv.slice(2);
const outDir = args[0]?.startsWith("--") ? undefined : args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!outDir) {
  console.error("usage: run.mjs <outDir> [--only id,id] [--parallel 2]");
  process.exit(1);
}
const only = flag("only")?.split(",");
const parallel = Number(flag("parallel") ?? 2);
const here = dirname(fileURLToPath(import.meta.url));
const wishes = JSON.parse(readFileSync(join(here, "wishes.json"), "utf8")).filter(
  (w) => !only || only.includes(w.id),
);
mkdirSync(outDir, { recursive: true });

const reportOnly = args.includes("--report");
const login = reportOnly ? null : await fetch(`${base}/api/dev/login`, { method: "POST" });
const cookie = (login?.headers.getSetCookie() ?? [])
  .map((c) => c.split(";")[0])
  .join("; ");
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

/** The architect's turn, read from its event stream. */
async function chat(wizardId, message, lang) {
  const res = await fetch(`${base}/api/studio/wizards/${wizardId}/chat`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "accept-language": lang },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) throw new Error(`chat → ${res.status} ${await res.text()}`);
  const turn = { text: "", activities: [], error: null, done: null };
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const raw = block
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      let data = raw;
      try {
        data = JSON.parse(raw);
      } catch {}
      if (event === "text") turn.text += data;
      else if (event === "activity") turn.activities.push(data);
      else if (event === "error") turn.error = data?.message ?? String(data);
      else if (event === "done") turn.done = data;
    }
  }
  return turn;
}

const NO_MODEL = new Set(["form", "review", "result", "tool", "code", "widget", "wait"]);

/** What a wizard is made of, in numbers a person can compare between runs. */
export function shapeOf(def) {
  const steps = def.steps ?? [];
  const forms = steps.filter((s) => s.type === "form");
  const label = (s) =>
    s.type === "generate" ? `generate:${s.asset}` : s.type === "surface" ? "surface" : s.type;
  return {
    sequence: steps.map(label).join(" → "),
    steps: steps.length,
    pages: forms.length,
    fields: forms.reduce((n, s) => n + (s.fields?.length ?? 0), 0),
    // A view written once needs no model; one that picks its pieces per run (candidates) does.
    modelSteps: steps.filter((s) => !NO_MODEL.has(s.type) && !(s.type === "surface" && s.components))
      .length,
    images: steps.filter((s) => s.type === "generate" && s.asset === "image").length,
    branches: steps.filter((s) => Array.isArray(s.next) && s.next.length > 0).length,
    reviews: steps.filter((s) => s.type === "review").length,
    tools: steps.filter((s) => s.type === "tool").length,
    collects: Boolean(
      (def.lists ?? []).some?.((l) => l.shared) ||
        def.data?.scope === "shared" ||
        JSON.stringify(steps).includes("list_write"),
    ),
    writes: steps.some((s) => s.type === "tool" && s.call),
    keys: Object.keys(def).filter(
      (k) => !["version", "title", "description", "avatar", "intro", "lang", "steps", "requires"].includes(k),
    ),
  };
}

/** The pattern every wizard falls into today: a page of questions first, then a model step. */
const cookieCutter = (s) => s.sequence.startsWith("form") && s.modelSteps > 0;

/** The wish's "expect", checked against the shape: a line per miss. */
function misses(expect, s) {
  const out = [];
  if (expect.image === false && s.images) out.push(`${s.images} image step(s), none wanted`);
  if (expect.image === true && !s.images) out.push("no image, one wanted");
  if (expect.ai === false && s.modelSteps) out.push(`${s.modelSteps} model step(s), none needed`);
  if (expect.maxPages !== undefined && s.pages > expect.maxPages)
    out.push(`${s.pages} pages, at most ${expect.maxPages}`);
  if (expect.branch && !s.branches) out.push("no branch");
  if (expect.collect && !s.collects) out.push("collects nothing between runs");
  if (expect.write && !s.writes) out.push("no tool step writes into the other system");
  return out;
}

const space = reportOnly ? null : (await call("GET", "/api/studio/spaces")).find((s) => !s.readOnly);
const results = [];
const queue = [...wishes];
async function worker() {
  for (let wish = queue.shift(); wish; wish = queue.shift()) {
    const started = Date.now();
    const entry = { id: wish.id, wish: wish.wish, kind: wish.kind, expect: wish.expect };
    try {
      const { id } = await call("POST", "/api/studio/wizards", { spaceId: space.id, lang: wish.lang });
      entry.wizardId = id;
      const turn = await chat(id, wish.wish, wish.lang);
      const view = await call("GET", `/api/studio/wizards/${id}`);
      Object.assign(entry, {
        ms: Date.now() - started,
        reply: turn.text.trim(),
        error: turn.error,
        activities: turn.activities.length,
        issues: view.issues ?? [],
        definition: view.draft,
        shape: shapeOf(view.draft),
        studioUrl: view.studioUrl,
      });
      entry.misses = misses(wish.expect ?? {}, entry.shape);
      entry.cookieCutter = cookieCutter(entry.shape);
      entry.asked = /\?\s*$/.test(entry.reply);
    } catch (err) {
      Object.assign(entry, { ms: Date.now() - started, error: err.message });
    }
    writeFileSync(join(outDir, `${wish.id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
    console.log(
      `${wish.id}: ${entry.error ? `error: ${entry.error}` : entry.shape.sequence} (${Math.round(entry.ms / 1000)} s)`,
    );
    results.push(entry);
  }
}
if (reportOnly) {
  for (const wish of wishes) {
    try {
      const entry = JSON.parse(readFileSync(join(outDir, `${wish.id}.json`), "utf8"));
      if (entry.definition) {
        entry.shape = shapeOf(entry.definition);
        entry.misses = misses(wish.expect ?? {}, entry.shape);
        entry.cookieCutter = cookieCutter(entry.shape);
      }
      results.push(entry);
    } catch {}
  }
} else {
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
}
results.sort((a, b) => wishes.findIndex((w) => w.id === a.id) - wishes.findIndex((w) => w.id === b.id));

const ok = results.filter((r) => r.shape);
const count = (f) => ok.filter(f).length;
const lines = [
  `# Builder eval — ${new Date().toISOString().slice(0, 16)}`,
  "",
  `Server: ${base}. Wishes: ${results.length}, built: ${ok.length}, failed: ${results.length - ok.length}.`,
  "",
  `- A page of questions first, then a model step (the usual shape): ${count((r) => r.cookieCutter)} of ${ok.length}`,
  `- With an image step: ${count((r) => r.shape.images)} · wanted by the wish: ${wishes.filter((w) => w.expect?.image).length}`,
  `- Without any model step: ${count((r) => !r.shape.modelSteps)} · where none is needed: ${wishes.filter((w) => w.expect?.ai === false).length}`,
  `- Ended with a question to the admin: ${count((r) => r.asked)}`,
  `- Misses against the wishes' expectations: ${ok.reduce((n, r) => n + r.misses.length, 0)}`,
  `- Validator issues left: ${ok.reduce((n, r) => n + r.issues.length, 0)}`,
  `- Time: median ${Math.round(median(ok.map((r) => r.ms)) / 1000)} s, longest ${Math.round(Math.max(0, ...ok.map((r) => r.ms)) / 1000)} s`,
  "",
  "| wish | kind | shape | pages / fields | misses | s |",
  "|---|---|---|---|---|---|",
  ...results.map((r) =>
    r.shape
      ? `| ${r.id} | ${r.kind} | ${r.shape.sequence} | ${r.shape.pages} / ${r.shape.fields} | ${r.misses.join("; ") || "–"} | ${Math.round(r.ms / 1000)} |`
      : `| ${r.id} | ${r.kind} | error: ${r.error} | | | ${Math.round(r.ms / 1000)} |`,
  ),
  "",
  "## Replies",
  "",
  ...results.flatMap((r) => [`### ${r.id}`, "", `> ${r.wish}`, "", r.reply || r.error || "(none)", ""]),
];
writeFileSync(join(outDir, "report.md"), `${lines.join("\n")}\n`);
console.log(`\n${lines.slice(0, 11).join("\n")}\n\n${join(outDir, "report.md")}`);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

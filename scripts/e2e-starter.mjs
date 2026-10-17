#!/usr/bin/env node
// Drives one starter wizard end to end through the API: fills its pages, accepts every
// review, then fetches each deliverable in each format. Local dev only (needs DEV_LOGIN=1).
//   node scripts/e2e-starter.mjs <starterId> '<answers json: {stepId: {field: value}}>' [outDir]
// A value { "$file": "path" } (or a list of them) is uploaded first; the field gets the upload's id.
// A step that asks for a sign-in or a confirmation is answered with "skip".
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";

const base = process.env.API ?? "http://127.0.0.1:24368";
const [starterId, answersJson = "{}", outDir] = process.argv.slice(2);
const answers = JSON.parse(answersJson);

const login = await fetch(`${base}/api/dev/login`, { method: "POST" });
const cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
const call = async (method, path, body) => {
  let res;
  // The dev server restarts when a source file changes; a call made meanwhile is tried again.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

const TYPES = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

async function upload(runId, path) {
  const form = new FormData();
  const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  form.append("file", new File([readFileSync(path)], basename(path), { type }));
  const res = await fetch(`${base}/api/runs/${runId}/uploads`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  if (!res.ok) throw new Error(`upload ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

/** The page's answers with every { $file } replaced by the id of its upload. */
async function withUploads(runId, values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value) && value.some((v) => v?.$file)) {
      out[key] = await Promise.all(value.map((v) => (v?.$file ? upload(runId, v.$file) : v)));
    } else if (value?.$file) {
      out[key] = await upload(runId, value.$file);
    } else if (value?.asset?.$file) {
      // A voice note: the recording is uploaded like any file.
      out[key] = { ...value, asset: await upload(runId, value.asset.$file) };
    } else {
      out[key] = value;
    }
  }
  return out;
}

// RUN=<runId> goes on with a run started earlier instead of starting one.
let wizardId = process.env.WIZARD ?? "";
let runId = process.env.RUN ?? "";
if (!runId) {
  const [project] = await call("GET", "/api/studio/projects");
  wizardId = (await call("POST", "/api/studio/wizards", { projectId: project.id, starterId })).id;
  runId = (await call("POST", `/api/studio/wizards/${wizardId}/test-runs`)).runId;
}
console.log(`wizard ${wizardId} run ${runId}`);

const started = Date.now();
let lastEvent = 0;
for (;;) {
  const view = await call("GET", `/api/runs/${runId}`);
  for (const e of view.events.filter((e) => e.id > lastEvent)) {
    console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${e.type} ${e.message}`);
    lastEvent = e.id;
  }
  if (view.status === "failed") {
    console.log("FAILED:", view.error);
    process.exit(1);
  }
  if (view.status === "waiting_input" && view.step.type === "page") {
    console.log(`→ page ${view.step.id}`);
    await call("POST", `/api/runs/${runId}/pages/${view.step.id}`, {
      values: await withUploads(runId, { ...view.prefill, ...answers[view.step.id] }),
    });
  } else if (view.status === "waiting_input" && view.step.id === process.env.STOP_AT) {
    // Left at this step for a look in the browser.
    console.log(`STOPPED at ${view.step.id}: wizard ${wizardId} run ${runId}`);
    process.exit(0);
  } else if (view.status === "waiting_input" && view.step.type === "review") {
    console.log(`→ review ${view.step.id}: ${view.shown.map((s) => s.step.id).join(", ")}`);
    await call("POST", `/api/runs/${runId}/reviews/${view.step.id}`, { type: "accept" });
  } else if (view.status === "running" && view.ask) {
    console.log(`→ ask ${view.ask.kind}: ${view.ask.reason} (skipped)`);
    await call("POST", `/api/runs/${runId}/ask/${view.ask.id}`, { type: "skip" });
  } else if (view.status === "done") {
    console.log(`DONE in ${Math.round((Date.now() - started) / 1000)}s`);
    for (const l of view.lists ?? []) {
      console.log(`  list ${l.def.id}: ${l.rows.length} rows`);
      for (const f of l.formats) {
        const res = await fetch(
          `${base}/api/runs/${runId}/lists/${l.def.id}/download?format=${f}`,
          { headers: { cookie } },
        );
        const buf = Buffer.from(await res.arrayBuffer());
        console.log(
          `  ${l.def.id}.${f}: ${res.status} ${res.headers.get("content-type")} ${buf.length} bytes`,
        );
        if (outDir && res.ok) writeFileSync(`${outDir}/${starterId}-${l.def.id}.${f}`, buf);
      }
    }
    for (const s of view.shown) {
      for (const f of s.formats) {
        const res = await fetch(
          `${base}/api/runs/${runId}/steps/${s.step.id}/download?format=${f}`,
          { headers: { cookie } },
        );
        const buf = Buffer.from(await res.arrayBuffer());
        console.log(
          `  ${s.step.id}.${f}: ${res.status} ${res.headers.get("content-type")} ${buf.length} bytes`,
        );
        if (outDir && res.ok) writeFileSync(`${outDir}/${starterId}-${s.step.id}.${f}`, buf);
      }
      if (s.output?.json) console.log("  json:", JSON.stringify(s.output.json).slice(0, 600));
    }
    process.exit(0);
  }
  if (Date.now() - started > 40 * 60_000) {
    console.log("TIMEOUT");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2500));
}

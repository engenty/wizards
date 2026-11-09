#!/usr/bin/env node
// Once: every stored wizard definition becomes version 1 of the format as it is now. Not part of
// the product; run it where the runtime's data is, with the runtime's environment.
//
//   node apps/runtime/scripts/definition-v1.mjs            counts per tenant, writes nothing
//   node apps/runtime/scripts/definition-v1.mjs --write    converts
//
// It reads the same variables as the runtime: DATA_DIR (default ./data), DATABASE_URL and
// DATABASE_AUTH_TOKEN for the control database, TENANT_DB_URL_TEMPLATE and TENANT_DB_AUTH_TOKEN
// for tenant databases that are not files. `--data <dir>` overrides DATA_DIR.
//
// What it converts, in each tenant's database: `wizard.draft`, `wizard_version.definition`,
// `run.definition`, and the wizard records the two-way sync keeps (`sync_base`, `sync_conflict`,
// `sync_merge`). Tenant migration 0021 (2026-10-21) already renamed the classes of every
// definition of version 1 and marked it `version: 2`, so `version: 2` is what this script finds
// and sets to 1; the names stay. A definition of version 1 or none in a database past 0021 was
// written with today's names, by a build that writes version 1: it stays as it is. Run again,
// the script finds nothing to do.
//
// What changes in a definition of version 2, besides its version:
// - An agent step that is a decision (the classifier class, no tools, call, each or connections,
//   json output of only yesno, choice and score fields) becomes `type: "decision"` with its
//   instructions, its fields and `working`.
// - Condition operators take their new names in every `when`: equals → eq, notEquals → ne,
//   empty → notExists, notEmpty → exists. The others keep theirs.
// - A step of `type: "page"` becomes `type: "form"`. Nothing else stores the step type: a run's
//   state keys its pages by step id.
//
// `toVersion1` is exported for the marketplace's entries (the Manage repo), which are files.
//
// A tenant database that 0021 has not reached yet still holds the old names: the script leaves
// it and says so. Start the runtime once (it migrates every tenant), then run the script.
import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createClient } from "@libsql/client";

const args = process.argv.slice(2);
const write = args.includes("--write");
const dataIdx = args.indexOf("--data");
const dataDir = resolve(dataIdx >= 0 ? args[dataIdx + 1] : process.env.DATA_DIR || "data");
/** When tenant migration 0021_model_classes was made: drizzle keeps it as `created_at`. */
const MODEL_CLASSES_MIGRATION = 1792568616734;

const open = (url, authToken) => createClient({ url, ...(authToken ? { authToken } : {}) });

const OPS = { equals: "eq", notEquals: "ne", empty: "notExists", notEmpty: "exists" };
const DECISION_KINDS = new Set(["yesno", "choice", "score"]);

/** Whether an agent step of version 2 was a decision: the shape the app recognized it by. */
function isDecision(step) {
  const fields = step.output?.fields ?? [];
  return (
    step.type === "agent" &&
    !step.call &&
    !step.output?.schema &&
    step.model === "classifier" &&
    step.output?.format === "json" &&
    fields.length > 0 &&
    fields.every((f) => DECISION_KINDS.has(f?.kind)) &&
    !step.each &&
    !(step.tools ?? []).length &&
    !step.connections?.length
  );
}

/** The decision step an agent step of that shape becomes: its own keys, nothing of an agent's. */
function asDecision(step) {
  const { id, title, description, section, next, onFail, instructions, working } = step;
  const fields = step.output.fields.map(({ columns: _, ...field }) => field);
  return Object.fromEntries(
    Object.entries({
      id,
      type: "decision",
      title,
      description,
      section,
      instructions,
      output: { fields },
      working,
      next,
      onFail,
    }).filter(([, v]) => v !== undefined),
  );
}

/** Every `when` in a value, with the operators renamed; counts each renamed one. */
function renamedOps(value, counts) {
  if (Array.isArray(value)) {
    return value.map((v) => renamedOps(v, counts));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = key === "when" ? renamedInWhen(v, counts) : renamedOps(v, counts);
  }
  return out;
}

function renamedInWhen(when, counts) {
  if (Array.isArray(when)) {
    return when.map((w) => renamedInWhen(w, counts));
  }
  if (!when || typeof when !== "object") {
    return when;
  }
  if (typeof when.op === "string" && OPS[when.op]) {
    counts.ops++;
    return { ...when, op: OPS[when.op] };
  }
  if (Array.isArray(when.any)) {
    return { ...when, any: when.any.map((w) => renamedInWhen(w, counts)) };
  }
  if (when.not) {
    return { ...when, not: renamedInWhen(when.not, counts) };
  }
  return when;
}

/**
 * A definition of version 2 at version 1 as the format is now, with what changed counted
 * (`decisions`, `ops`, `forms`). Anything else comes back with `kind` saying why it stays.
 */
export function toVersion1(def) {
  if (!def || typeof def !== "object" || Array.isArray(def) || !Array.isArray(def.steps)) {
    return { kind: "skipped" };
  }
  if (def.version !== 2) {
    return { kind: def.version === 1 || def.version === undefined ? "current" : "skipped" };
  }
  const counts = { decisions: 0, ops: 0, forms: 0 };
  const steps = def.steps.map((step) => {
    if (step && typeof step === "object" && isDecision(step)) {
      counts.decisions++;
      return asDecision(step);
    }
    if (step && typeof step === "object" && step.type === "page") {
      counts.forms++;
      return { ...step, type: "form" };
    }
    return step;
  });
  const next = renamedOps({ ...def, version: 1, steps }, counts);
  return { kind: "v2", def: next, ...counts };
}

/** Reads JSON text, or null. */
function json(text) {
  try {
    return typeof text === "string" ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function hasTable(db, name) {
  const r = await db.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [name],
  });
  return r.rows.length > 0;
}

/**
 * Where a definition sits: the table, the key column, the JSON column, and the paths inside
 * that JSON that hold a definition (`[]`: the column is one).
 */
const PLACES = [
  { table: "wizard", key: "id", column: "draft", paths: [[]] },
  { table: "wizard_version", key: "id", column: "definition", paths: [[]] },
  { table: "run", key: "id", column: "definition", paths: [[]] },
  { table: "sync_base", key: "item", column: "record", paths: [["draft"]], wizards: true },
  ...["base", "local", "remote"].map((column) => ({
    table: "sync_conflict",
    key: "id",
    column,
    paths: [["draft"]],
    wizards: true,
  })),
  {
    table: "sync_merge",
    key: "id",
    column: "before",
    paths: [
      ["local", "draft"],
      ["remote", "draft"],
    ],
    wizards: true,
  },
];

const getAt = (obj, path) => path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

function setAt(obj, path, value) {
  if (!path.length) {
    return value;
  }
  const [k, ...rest] = path;
  return { ...obj, [k]: setAt(obj[k], rest, value) };
}

async function convertTenant(db) {
  const counts = { v2: 0, current: 0, skipped: 0, decisions: 0, ops: 0, forms: 0 };
  if (!(await hasTable(db, "wizard"))) {
    return { counts, missing: "no wizard table" };
  }
  const last = (await db.execute("SELECT max(created_at) AS at FROM __drizzle_migrations")).rows[0];
  if (Number(last?.at ?? 0) < MODEL_CLASSES_MIGRATION) {
    return { counts, missing: "before migration 0021: start the runtime once, then run again" };
  }
  const updates = [];
  for (const place of PLACES) {
    if (!(await hasTable(db, place.table))) {
      continue;
    }
    const where = place.wizards ? " WHERE kind = 'wizard'" : "";
    const rows = await db.execute(
      `SELECT rowid AS rid, "${place.column}" AS doc FROM "${place.table}"${where}`,
    );
    for (const row of rows.rows) {
      let doc = json(row.doc);
      if (doc === null) {
        continue;
      }
      let changed = false;
      for (const path of place.paths) {
        const def = getAt(doc, path);
        if (def === undefined || def === null) {
          continue;
        }
        const out = toVersion1(def);
        counts[out.kind]++;
        counts.decisions += out.decisions ?? 0;
        counts.ops += out.ops ?? 0;
        counts.forms += out.forms ?? 0;
        if (out.def) {
          doc = setAt(doc, path, out.def);
          changed = true;
        }
      }
      if (changed) {
        updates.push({
          sql: `UPDATE "${place.table}" SET "${place.column}" = ? WHERE rowid = ?`,
          args: [JSON.stringify(doc), row.rid],
        });
      }
    }
  }
  if (write && updates.length) {
    await db.batch(updates, "write");
  }
  return { counts, rows: updates.length };
}

function tenantUrl(id, dbUrl) {
  if (dbUrl) {
    return dbUrl;
  }
  if (process.env.TENANT_DB_URL_TEMPLATE) {
    return process.env.TENANT_DB_URL_TEMPLATE.replaceAll("{tenant}", id.toLowerCase());
  }
  return `file:${join(dataDir, "tenants", `${id}.db`)}`;
}

async function main() {
  const controlUrl = process.env.DATABASE_URL || `file:${join(dataDir, "control.db")}`;
  if (controlUrl.startsWith("file:") && !existsSync(controlUrl.slice(5))) {
    throw new Error(`No control database at ${controlUrl}`);
  }
  const control = open(controlUrl, process.env.DATABASE_AUTH_TOKEN);
  const tenants = (await control.execute("SELECT id, db_url FROM tenant ORDER BY id")).rows.map(
    (r) => ({ id: String(r.id), dbUrl: r.db_url ? String(r.db_url) : null }),
  );
  control.close();
  // A tenant file the control database does not list is converted too.
  const folder = join(dataDir, "tenants");
  if (existsSync(folder)) {
    for (const file of readdirSync(folder)) {
      const id = file.endsWith(".db") ? file.slice(0, -3) : null;
      if (id && !tenants.some((t) => t.id === id)) {
        tenants.push({ id, dbUrl: `file:${join(folder, file)}` });
      }
    }
  }
  const token = process.env.TENANT_DB_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN;
  console.log(`${write ? "Converting" : "Dry run, nothing written:"} ${tenants.length} tenants`);
  console.log(
    "tenant\tversion 2 → 1\tdecisions\toperators\tforms\talready 1\tnot a definition\trows",
  );
  const total = { v2: 0, decisions: 0, ops: 0, forms: 0, current: 0, skipped: 0, rows: 0 };
  const failed = [];
  for (const t of tenants) {
    const url = tenantUrl(t.id, t.dbUrl);
    if (url.startsWith("file:") && !existsSync(url.slice(5))) {
      console.log(`${t.id}\t(no database)`);
      continue;
    }
    const db = open(url, url.startsWith("file:") ? "" : token);
    try {
      const out = await convertTenant(db);
      if (out.missing) {
        console.log(`${t.id}\t(${out.missing})`);
        if (out.missing.startsWith("before")) {
          failed.push(t.id);
        }
        continue;
      }
      const c = out.counts;
      console.log(
        `${t.id}\t${c.v2}\t${c.decisions}\t${c.ops}\t${c.forms}\t${c.current}\t${c.skipped}\t${out.rows}`,
      );
      for (const k of ["v2", "decisions", "ops", "forms", "current", "skipped"]) {
        total[k] += c[k];
      }
      total.rows += out.rows;
    } catch (err) {
      console.log(`${t.id}\tfailed: ${err?.message ?? err}`);
      failed.push(t.id);
    } finally {
      db.close();
    }
  }
  console.log(
    `total\t${total.v2}\t${total.decisions}\t${total.ops}\t${total.forms}\t${total.current}\t${total.skipped}\t${total.rows}${write ? "" : " (not written)"}`,
  );
  if (failed.length) {
    console.log(`not converted: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

// Run as a script (a file, or piped in on stdin), not when imported for `toVersion1`.
const entry = process.argv[1];
if (entry === "-" || (entry && import.meta.url.endsWith(`/${basename(entry)}`))) {
  await main();
}

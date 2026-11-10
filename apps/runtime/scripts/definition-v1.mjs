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
// - An agent step that is a decision (the classifier class, no tools, call, code, each or connections,
//   json output of only yesno, choice and score fields) becomes `type: "decision"` with its
//   instructions, its fields and `working`.
// - Condition operators take their new names in every `when`: equals → eq, notEquals → ne,
//   empty → notExists, notEmpty → exists. The others keep theirs.
// - A step of `type: "page"` becomes `type: "form"`. Nothing else stores the step type: a run's
//   state keys its pages by step id.
// - An agent step with `call` becomes `type: "tool"`, one with `code` `type: "code"`: each keeps
//   its call or code, `output` without `format` (a tool's `fields` and view, a code step's
//   `fields` or `schema` and view), `working`, `retries` and the keys every step has.
// - `each` on an agent or generate step becomes `foreach`.
// - `any` in a `when` becomes `or`.
// - Every `output.schema` is written as the subset of JSON Schema the format takes now: text →
//   string (`long` → x-long), number → number (`unit` → x-unit), yesno → boolean (`yes`/`no` →
//   x-yes/x-no), choice → string with enum, ref → string with x-ref, list → array with items,
//   object → object with properties and every key required; `label` → title.
//
// Every definition, of version 2 or 1, then gets the root `requires` its steps call for, as the
// runtime works it out (`requiresOf`, packages/shared/src/requires.ts). It is read from the
// runtime's shared package: in the runtime's container it is there; in a checkout, build it first
// (`pnpm --filter @engenty/wizards-shared build`). A definition the schema refuses keeps none.
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

/** What `toVersion1` counts, as the columns of its table say it. */
const COUNTED = ["decisions", "ops", "ors", "forms", "tools", "code", "foreach", "schemas"];
const HEADS = {
  decisions: "decisions",
  ops: "operators",
  ors: "any → or",
  forms: "forms",
  tools: "tool steps",
  code: "code steps",
  foreach: "foreach",
  schemas: "schemas",
  requires: "requires filled",
  unfilled: "requires left out",
};

/** A shape in the kinds of before as the subset of JSON Schema `output.schema` takes now. */
function asJsonSchema(shape) {
  if (!shape || typeof shape !== "object" || typeof shape.kind !== "string") {
    return shape;
  }
  const { kind, label, description } = shape;
  const head = {
    ...(label !== undefined ? { title: label } : {}),
    ...(description !== undefined ? { description } : {}),
  };
  switch (kind) {
    case "text":
      return { type: "string", ...head, ...(shape.long ? { "x-long": true } : {}) };
    case "number":
      return { type: "number", ...head, ...(shape.unit ? { "x-unit": shape.unit } : {}) };
    case "yesno":
      return {
        type: "boolean",
        ...head,
        ...(shape.yes ? { "x-yes": shape.yes } : {}),
        ...(shape.no ? { "x-no": shape.no } : {}),
      };
    case "choice":
      return { type: "string", ...head, enum: shape.options };
    case "ref":
      return { type: "string", ...head, "x-ref": shape.to };
    case "list":
      return { type: "array", ...head, items: asJsonSchema(shape.of) };
    case "object": {
      const fields = shape.fields ?? {};
      return {
        type: "object",
        ...head,
        properties: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, asJsonSchema(f)])),
        required: Object.keys(fields),
      };
    }
    default:
      return shape;
  }
}
const DECISION_KINDS = new Set(["yesno", "choice", "score"]);

/** Whether an agent step of version 2 was a decision: the shape the app recognized it by. */
function isDecision(step) {
  const fields = step.output?.fields ?? [];
  return (
    step.type === "agent" &&
    !step.call &&
    !step.code &&
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

/** Only the keys given, in their order, without the missing ones. */
function picked(obj, keys) {
  return Object.fromEntries(
    keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]),
  );
}

/**
 * An agent step with `call` or `code` as the step type of its own it is now: its call or code,
 * its output without `format`, and what every step has.
 */
function asFixedStep(step, type) {
  const { format: _, surface, ...output } = step.output ?? {};
  if (type === "tool") {
    delete output.schema;
  }
  // A view a model composes needs a model: a fixed step keeps only a written one.
  if (Array.isArray(surface)) {
    output.surface = surface;
  }
  return {
    ...picked({ ...step, type }, ["id", "type", "title", "description", "section"]),
    ...picked(step, [type === "tool" ? "call" : "code"]),
    output: picked(output, ["fields", "schema", "surface"]),
    ...picked(step, ["working", "retries", "next", "onFail", "metadata"]),
  };
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
    counts.ors++;
    const { any, ...rest } = when;
    return { ...rest, or: any.map((w) => renamedInWhen(w, counts)) };
  }
  for (const key of ["or", "and"]) {
    if (Array.isArray(when[key])) {
      return { ...when, [key]: when[key].map((w) => renamedInWhen(w, counts)) };
    }
  }
  if (when.not) {
    return { ...when, not: renamedInWhen(when.not, counts) };
  }
  return when;
}

/**
 * A definition of version 2 at version 1 as the format is now, with what changed counted (see
 * COUNTED). Anything else comes back with `kind` saying why it stays.
 */
export function toVersion1(def) {
  if (!def || typeof def !== "object" || Array.isArray(def) || !Array.isArray(def.steps)) {
    return { kind: "skipped" };
  }
  if (def.version !== 2) {
    return { kind: def.version === 1 || def.version === undefined ? "current" : "skipped" };
  }
  const counts = Object.fromEntries(COUNTED.map((k) => [k, 0]));
  const steps = def.steps.map((step) => {
    if (!step || typeof step !== "object") {
      return step;
    }
    if (isDecision(step)) {
      counts.decisions++;
      return asDecision(step);
    }
    if (step.output?.schema?.kind === "object") {
      counts.schemas++;
      step = { ...step, output: { ...step.output, schema: asJsonSchema(step.output.schema) } };
    }
    if (step.type === "page") {
      counts.forms++;
      return { ...step, type: "form" };
    }
    if (step.type === "agent" && step.call) {
      counts.tools++;
      return asFixedStep(step, "tool");
    }
    if (step.type === "agent" && step.code) {
      counts.code++;
      return asFixedStep(step, "code");
    }
    if ((step.type === "agent" || step.type === "generate") && step.each !== undefined) {
      counts.foreach++;
      // The key keeps its place.
      return Object.fromEntries(
        Object.entries(step).map(([k, v]) => [k === "each" ? "foreach" : k, v]),
      );
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

/**
 * The definition with the `requires` its steps call for, before its steps; the same object where
 * it has that already, null where the schema refuses the definition.
 */
export function fillRequires(def, { wizardSchema, requiresOf }) {
  const parsed = wizardSchema.safeParse(def);
  if (!parsed.success) {
    return null;
  }
  const requires = requiresOf(parsed.data);
  if (JSON.stringify(def.requires ?? {}) === JSON.stringify(requires)) {
    return def;
  }
  const { requires: _, steps, ...rest } = def;
  return { ...rest, ...(Object.keys(requires).length ? { requires } : {}), steps };
}

/** What `fillRequires` reads, from the runtime's shared package. */
async function sharedPackage() {
  try {
    const [{ wizardSchema }, { requiresOf }] = await Promise.all([
      import("@engenty/wizards-shared/definition"),
      import("@engenty/wizards-shared/requires"),
    ]);
    return { wizardSchema, requiresOf };
  } catch (err) {
    throw new Error(
      `The runtime's shared package can't be read (${err?.message ?? err}). In a checkout, build it: pnpm --filter @engenty/wizards-shared build`,
    );
  }
}

async function convertTenant(db, shared) {
  const counts = {
    v2: 0,
    current: 0,
    skipped: 0,
    requires: 0,
    unfilled: 0,
    ...Object.fromEntries(COUNTED.map((k) => [k, 0])),
  };
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
        for (const k of COUNTED) {
          counts[k] += out[k] ?? 0;
        }
        let next = out.def ?? (out.kind === "current" ? def : null);
        if (next) {
          const filled = fillRequires(next, shared);
          if (filled === null) {
            counts.unfilled++;
          } else if (filled !== next) {
            counts.requires++;
            next = filled;
          }
        }
        if (next && next !== def) {
          doc = setAt(doc, path, next);
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
  const shared = await sharedPackage();
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
  const columns = ["v2", ...COUNTED, "requires", "unfilled", "current", "skipped"];
  const heads = { ...HEADS, v2: "version 2 → 1", current: "already 1", skipped: "not a definition" };
  console.log(["tenant", ...columns.map((k) => heads[k]), "rows"].join("\t"));
  const total = Object.fromEntries([...columns, "rows"].map((k) => [k, 0]));
  const failed = [];
  for (const t of tenants) {
    const url = tenantUrl(t.id, t.dbUrl);
    if (url.startsWith("file:") && !existsSync(url.slice(5))) {
      console.log(`${t.id}\t(no database)`);
      continue;
    }
    const db = open(url, url.startsWith("file:") ? "" : token);
    try {
      const out = await convertTenant(db, shared);
      if (out.missing) {
        console.log(`${t.id}\t(${out.missing})`);
        if (out.missing.startsWith("before")) {
          failed.push(t.id);
        }
        continue;
      }
      const c = out.counts;
      console.log([t.id, ...columns.map((k) => c[k]), out.rows].join("\t"));
      for (const k of columns) {
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
    `${["total", ...columns.map((k) => total[k]), total.rows].join("\t")}${write ? "" : " (not written)"}`,
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

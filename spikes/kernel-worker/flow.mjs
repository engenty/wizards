// Walks one run of the x-post wizard through a Worker over HTTP: start, the first page, the
// review twice (once asking for a new text, once with an edit), then reads the run back.
//   node flow.mjs [http://127.0.0.1:8787]
const base = process.argv[2] ?? "http://127.0.0.1:8787";

const call = async (path, body) => {
  const response = await fetch(
    `${base}${path}`,
    body ? { method: "POST", body: JSON.stringify(body) } : {},
  );
  return { http: response.status, ...(await response.json()) };
};
const waiting = (run) => run.rows.find((row) => !row.left && row.state === "waiting");
const rows = (run) =>
  run.rows
    .map((row) =>
      row.left
        ? `  ${row.n} ${row.step} left → ${row.to}`
        : `  ${row.n} ${row.step} ${row.type}${row.model ? `(${row.model})` : ""} ${row.state}${row.error ? `: ${row.error}` : ""}`,
    )
    .join("\n");

const wizard = await call("/");
console.log(`# GET /\n${wizard.title} · requires ${JSON.stringify(wizard.requires)}`);
console.log(`  input: ${wizard.input.fields.map((field) => field.id).join(", ")}`);

const report = (label, run) => {
  console.log(
    `\n# ${label}\nHTTP ${run.http} · run ${run.id} · ${run.error ? `error: ${run.error}` : `status ${run.status}`} · at ${run.cursor ?? "the end"}`,
  );
  if (run.rows) console.log(rows(run));
};

let run = await call("/runs", {});
report("POST /runs (no input: the first page waits)", run);
const id = run.id;

run = await call(`/runs/${id}/answer`, {
  row: waiting(run).n,
  value: {
    topic:
      "Wir eröffnen am Freitag, 20. November, um 17 Uhr unser Yoga-Studio in der Westbahnstraße 12 in Wien. Die erste Stunde ist gratis.",
    tone: "Locker",
    link: "https://example.com/eroeffnung",
  },
});
report("answer the first page", run);
console.log(
  `  post: ${JSON.stringify(run.rows.findLast((row) => row.left && row.step === "post")?.value)}`,
);

run = await call(`/runs/${id}/answer`, {
  row: waiting(run).n,
  value: { regenerate: "post", note: "Kürzer." },
});
report("review: a new text, please", run);

run = await call(`/runs/${id}/answer`, {
  row: waiting(run).n,
  value: {
    approved: true,
    edits: {
      post: "Freitag, 17 Uhr: unser Yoga-Studio in Wien öffnet. Erste Stunde gratis 🧘\n\nhttps://example.com/eroeffnung",
    },
  },
});
report("review: approved with an edit", run);

run = await call(`/runs/${id}`);
report(`GET /runs/${id}`, run);
console.log(`  output: ${JSON.stringify(run.output)}`);

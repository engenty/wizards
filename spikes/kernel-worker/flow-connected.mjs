// Walks the connected team-note wizard through a Worker: start with input, the Worker asks home
// for the note, home holds the Slack post until the user allows it, the run ends. A second run
// where the user says no. Then reads what home logged and what reached the channel.
//   node flow-connected.mjs [worker] [home]
const worker = process.argv[2] ?? "http://127.0.0.1:8787";
const home = process.argv[3] ?? "http://127.0.0.1:8791";

const call = async (path, body) => {
  const response = await fetch(
    `${worker}${path}`,
    body ? { method: "POST", body: JSON.stringify(body) } : {},
  );
  return { http: response.status, ...(await response.json()) };
};
const approval = (run) =>
  run.rows.find((row) => row.type === "approval" && row.state === "waiting");
const report = (label, run) => {
  console.log(
    `\n# ${label}\nHTTP ${run.http} · ${run.error ? `error: ${run.error}` : `status ${run.status}`} · at ${run.cursor ?? "the end"}`,
  );
  for (const row of run.rows ?? [])
    console.log(
      row.left
        ? `  ${row.n} ${row.step} left → ${row.to}`
        : `  ${row.n} ${row.step} ${row.type}${row.call ? ` ${row.call}` : ""} ${row.state}${row.error ? `: ${row.error}` : ""}`,
    );
};

for (const allow of [true, false]) {
  let run = await call("/runs", {
    input: { topic: "Freitag 15 Uhr Teammeeting im großen Raum, bitte Laptops mitbringen" },
  });
  report(`POST /runs (${run.id})`, run);
  run = await call(`/runs/${run.id}/answer`, {
    row: approval(run).n,
    value: { allow },
    by: "user",
  });
  report(`the user ${allow ? "allows" : "refuses"} the post`, run);
  if (run.output) console.log(`  output: ${JSON.stringify(run.output)}`);
}

const { log, channel } = await (await fetch(`${home}/v1/log`)).json();
console.log("\n# home: GET /v1/log");
for (const entry of log)
  console.log(
    `  ${entry.decision.padEnd(5)} ${entry.step ?? ""} ${entry.what ?? ""} ${entry.why ? `(${entry.why})` : ""}${entry.leave ? " leave given" : ""}`,
  );
console.log(`  #team: ${JSON.stringify(channel)}`);

// A stand-in for the organization's runtime, the "home" a connected deployment calls: the one
// route `POST /v1/asks`, as the runtime would serve it. In the runtime this route would hand the
// row to `kernelBatteries` (apps/runtime/src/kernel/batteries.ts), whose connector calls go
// through `brokerCall`. Here the same decisions are made in a few lines, so the Worker's side can
// be run: the deploy key says which deployment calls, the home's own copy of the wizard decides
// what the run may reach, model keys and connection secrets never leave, every call is logged.
//   node home.mjs <wizard folder> [8791]
//   GET /v1/log   what was asked, decided and done
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { grantOf, needsLeave, outside } from "../../packages/kernel/src/grant.ts";

const dir = resolve(process.argv[2] ?? "wizards/team-note");
const port = Number(process.argv[3] ?? 8791);

/** Deployments by their key: made when `wizards deploy --home` ran. One here. */
const DEPLOYMENTS = {
  [process.env.DEPLOY_KEY ?? "dev-deploy-key"]: {
    id: "dep_1",
    space: "Vertrieb",
    // The home's copy of the wizard, as installed there. The Worker's copy decides nothing here.
    file: JSON.parse(readFileSync(join(dir, "wizard.json"), "utf8")),
  },
};

/** The model, only here: the key is the home's. Without one it echoes. */
async function model(row) {
  const key = process.env.MODEL_API_KEY;
  if (!key) return { text: `Echo from home (${row.model}): ${String(row.title ?? row.step)}` };
  const response = await fetch(
    `${process.env.MODEL_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: JSON.parse(process.env.MODELS ?? "{}")[row.model] ?? "gpt-4.1-mini",
        messages: [{ role: "user", content: String(row.instructions ?? "") }],
      }),
    },
  );
  if (!response.ok) throw new Error(`The model said ${response.status}.`);
  return { text: (await response.json()).choices[0].message.content };
}

/** The connections of the space, with their secrets. One stand-in: a Slack channel in memory. */
const channel = [];
const CONNECTIONS = {
  slack: {
    "chat.postMessage": ({ channel: name, text }) => {
      channel.push({ channel: name, text });
      return { ok: true, channel: name, ts: String(Date.now() / 1000) };
    },
  },
};

const log = [];
const note = (entry) => log.push({ at: new Date().toISOString(), ...entry });

async function answer(deployment, run, row) {
  const grant = grantOf(deployment.file);
  const where = {
    deployment: deployment.id,
    space: deployment.space,
    run: run.id,
    step: row.step,
    type: row.type,
  };
  // The ask as the step made it: the kernel sets `role` to the type where the step named none.
  const reached = outside(grant, { ...row, role: row.role === row.type ? undefined : row.role });
  if (reached) {
    note({ ...where, decision: "deny", why: `the wizard does not grant "${reached}"` });
    return [
      403,
      { error: `"${row.step}" reached for "${reached}", which the wizard does not grant.` },
    ];
  }
  if (row.type === "agent") {
    if (row.tools?.length)
      return [422, { error: "This home answers an agent without tools only." }];
    const result = await model(row);
    note({ ...where, decision: "allow", what: `model ${row.model}` });
    return [200, { answer: result }];
  }
  if (row.type === "tool" && typeof row.call === "string") {
    const [connection, ...rest] = row.call.split(".");
    const action = CONNECTIONS[connection]?.[rest.join(".")];
    if (!action) return [422, { error: `The space has no connection for "${row.call}".` }];
    // The user's leave is a row of the run, on the Worker. Here only whether it was given.
    if (needsLeave(grant, row) && !row.asksLeave) {
      note({ ...where, decision: "hold", what: row.call, why: "asks the user first" });
      return [409, { needsLeave: true, error: `"${row.call}" needs the user's leave.` }];
    }
    const result = action(row.input ?? {});
    note({ ...where, decision: "allow", what: row.call, ...(row.asksLeave && { leave: "given" }) });
    return [200, { answer: result }];
  }
  return [422, { error: `The home has no battery for "${row.type}" asks.` }];
}

createServer(async (request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.method === "GET" && request.url === "/v1/log") return reply(200, { log, channel });
  if (request.method !== "POST" || request.url !== "/v1/asks")
    return reply(404, { error: "Not found." });
  const key = request.headers.authorization?.replace(/^Bearer /, "");
  const deployment = DEPLOYMENTS[key];
  if (!deployment) {
    note({ decision: "deny", why: "unknown deploy key" });
    return reply(401, { error: "This deployment is not known here." });
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const { run, row } = JSON.parse(body);
  try {
    reply(...(await answer(deployment, run, row)));
  } catch (error) {
    note({ run: run.id, step: row.step, decision: "error", why: error.message });
    reply(502, { error: error.message });
  }
}).listen(port, "127.0.0.1", () =>
  console.log(
    `home for "${DEPLOYMENTS[Object.keys(DEPLOYMENTS)[0]].file.title}" on http://127.0.0.1:${port}`,
  ),
);

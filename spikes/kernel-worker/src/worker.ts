import { runObject } from "../../../packages/kernel/src/edge.js";
import type { Wizard } from "../../../packages/kernel/src/types.js";
import { batteries } from "./batteries.js";

type Env = { RUNS: DurableObjectNamespace };
type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

/** The object keeps its run under the id "run"; the caller knows it by the object's name. */
async function named(id: string, response: Response): Promise<Response> {
  const body = (await response.json()) as Record<string, unknown>;
  return Response.json(body.error ? body : { ...body, id }, { status: response.status });
}

/**
 * One wizard as a Worker. Each run is a Durable Object named by the run's id.
 *
 *   GET  /                      the wizard: title, its first page, what it requires
 *   POST /runs                  { input? } starts a run; without input it asks for it first
 *   GET  /runs/<id>             the run
 *   POST /runs/<id>/answer      { row, value, by? }
 *   POST /runs/<id>/rewind      { row, value? }
 *   POST /runs/<id>/judge
 */
export function wizardWorker(wizard: Wizard) {
  const RunObject = runObject({ wizards: () => wizard, batteries });

  const fetch = async (request: Request, env: Env): Promise<Response> => {
    const [, first, id, action = ""] = new URL(request.url).pathname.split("/");
    if (!first) {
      const { title, description, input, requires, connections } = wizard.file;
      return Response.json({ title, description, input, requires, connections });
    }
    if (first !== "runs") return Response.json({ error: "Not found." }, { status: 404 });
    const run = id ?? crypto.randomUUID();
    const object = env.RUNS.get(env.RUNS.idFromName(run));
    if (!id) {
      if (request.method !== "POST") return Response.json({ error: "Not found." }, { status: 404 });
      const { input } = (await request.json()) as { input?: Record<string, unknown> };
      return named(
        run,
        await object.fetch(
          new Request("https://run/start", {
            method: "POST",
            body: JSON.stringify({ wizard: "wizard", input }),
          }),
        ),
      );
    }
    return named(run, await object.fetch(new Request(`https://run/${action}`, request)));
  };

  return { RunObject, fetch };
}

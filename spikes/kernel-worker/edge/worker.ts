import type { Wizard } from "@engenty/wizards-kernel";
import { runObject } from "@engenty/wizards-kernel/edge";
import { batteries } from "./batteries.js";

type Env = { RUNS: DurableObjectNamespace };
type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

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
      return object.fetch(
        new Request("https://run/start", {
          method: "POST",
          body: JSON.stringify({ wizard: "wizard", input, id: run }),
        }),
      );
    }
    return object.fetch(new Request(`https://run/${action}`, request));
  };

  return { RunObject, fetch };
}

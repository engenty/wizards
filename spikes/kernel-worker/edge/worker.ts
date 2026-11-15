import type { AskRow, Run, Wizard } from "@engenty/wizards-kernel";
import { runObject } from "@engenty/wizards-kernel/edge";
import { batteries } from "./batteries.js";
import { pageRow, viewOf } from "./view.js";

type Env = {
  RUNS: DurableObjectNamespace;
  /** The page's files: Wrangler's static assets, or a disk service on workerd. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
};
type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

const html = (lang: string, title: string) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, "&lt;")}</title><link rel="stylesheet" href="/page/page.css">
<style>html,body{margin:0;background:#faf8f5}</style></head>
<body><div id="page" class="engenty-runner"></div><script type="module" src="/page/page.js"></script></body></html>`;

/**
 * One wizard as a Worker. Each run is a Durable Object named by the run's id.
 *
 *   GET  /, /r/<id>                       the run page (a new run, or that one)
 *   GET  /page/<file>                     its script, its styles, the chunks it loads later: static assets
 *   GET  /wizard                          the wizard: title, its first page, what it requires
 *   POST /runs                            { input? } starts a run; without input it asks for it first
 *   GET  /runs/<id>                       the run, its rows
 *   POST /runs/<id>/answer                { row, value, by? }
 *   POST /runs/<id>/rewind                { row, value? }
 *   POST /runs/<id>/judge
 *   GET  /runs/<id>/page                  the run as the page draws it (a RunView)
 *   POST /runs/<id>/page/pages/<step>     { values }: the form it waits at
 *   POST /runs/<id>/page/reviews/<step>   { type: accept | decline | regenerate, edits?, note?, target? }
 *   POST /runs/<id>/page/retry            the failed ask, asked again
 */
export function wizardWorker(wizard: Wizard, page = false) {
  const RunObject = runObject({ wizards: () => wizard, batteries });
  const { file } = wizard;

  const fetch = async (request: Request, env: Env): Promise<Response> => {
    const [, first, id, action = "", ...rest] = new URL(request.url).pathname.split("/");
    if (request.method === "GET" && page && (!first || first === "r"))
      return new Response(html(file.lang ?? "en", file.title), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    // On Cloudflare the assets answer `/page/<file>` before the Worker is asked; on workerd it
    // hands the request to its disk, which says nothing of a file's type.
    if (page && first === "page") return pageFile(request, env, id ?? "");
    if (first === "wizard") {
      const { title, description, input, requires, connections } = file;
      return Response.json({ title, description, input, requires, connections });
    }
    if (first !== "runs") return Response.json({ error: "Not found." }, { status: 404 });
    const run = id ?? crypto.randomUUID();
    const object = env.RUNS.get(env.RUNS.idFromName(run));
    const to = (path: string, body?: unknown) =>
      object.fetch(
        new Request(
          `https://run/${path}`,
          body ? { method: "POST", body: JSON.stringify(body) } : {},
        ),
      );
    if (!id) {
      if (request.method !== "POST") return Response.json({ error: "Not found." }, { status: 404 });
      const { input } = (await request.json()) as { input?: Record<string, unknown> };
      return to("start", { wizard: "wizard", input, id: run });
    }
    if (action === "page") return pageCall(request, rest, to);
    return object.fetch(new Request(`https://run/${action}`, request));
  };

  /** The page's reads and commands, as the runtime's run routes take them, onto the kernel's rows. */
  async function pageCall(
    request: Request,
    [kind, step]: string[],
    to: (path: string, body?: unknown) => Promise<Response>,
  ): Promise<Response> {
    const read = await to("");
    const run = (await read.json()) as Run & { error?: string };
    if (!read.ok) return Response.json({ error: run.error }, { status: 404 });
    if (request.method === "GET") return Response.json(viewOf(run, file));
    const body = (await request.json().catch(() => ({}))) as Record<string, any>;
    let moved: Response;
    if (kind === "pages") {
      const row = pageRow(run, step);
      if (row?.type !== "form") return conflict();
      moved = await to("answer", { row: row.n, value: body.values ?? {}, by: "user" });
    } else if (kind === "reviews") {
      const row = pageRow(run, step);
      if (row?.type !== "review" && row?.type !== "approval") return conflict();
      moved = await to("answer", { row: row.n, value: reviewAnswer(row, body), by: "user" });
    } else if (kind === "retry") {
      const failed = run.rows.findLast(
        (row): row is AskRow => !("left" in row) && row.state === "failed",
      );
      if (!failed) return conflict();
      moved = await to("rewind", { row: failed.n });
    } else {
      return Response.json({ error: "This page cannot do that here." }, { status: 409 });
    }
    const after = (await moved.json()) as Run & { error?: string };
    if (!moved.ok) {
      // The kernel's sentence for a required field: `"topic" is missing.`
      const field = after.error?.match(/^"([^"]+)" is missing\.$/)?.[1];
      return Response.json(
        { error: after.error, ...(field && { fields: [{ field, message: after.error }] }) },
        { status: field ? 422 : 409 },
      );
    }
    return Response.json(viewOf(after, file));
  }

  return { RunObject, fetch };
}

/** A file of the page from the disk, with the type its name says; a hashed chunk never changes. */
async function pageFile(request: Request, env: Env, name: string): Promise<Response> {
  if (!env.ASSETS) return Response.json({ error: "Not found." }, { status: 404 });
  const file = await env.ASSETS.fetch(request);
  if (!file.ok) return file;
  return new Response(file.body, {
    headers: {
      "content-type": name.endsWith(".css") ? "text/css" : "text/javascript",
      "cache-control":
        name === "page.js" || name === "page.css"
          ? "public, max-age=0, must-revalidate"
          : "public, max-age=31536000, immutable",
    },
  });
}

const conflict = () => Response.json({ error: "The run has moved on." }, { status: 409 });

/** A review's answer as the step reads it; the leave for an action as `{ allow }`. As the runtime's `reviewStep`. */
function reviewAnswer(row: AskRow, body: Record<string, any>) {
  const yes = body.type === "accept";
  if (row.type === "approval") return { allow: yes };
  if (body.type === "regenerate")
    return {
      approved: false,
      regenerate: body.target,
      note: String(body.note ?? "").slice(0, 2000),
    };
  const shows = (row.show as string[] | undefined) ?? [];
  const edits =
    yes && row.edit === true
      ? Object.fromEntries(Object.entries(body.edits ?? {}).filter(([id]) => shows.includes(id)))
      : {};
  return {
    approved: yes,
    ...(body.note ? { note: body.note } : {}),
    ...(Object.keys(edits).length ? { edits } : {}),
  };
}

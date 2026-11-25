import { mkdirSync } from "node:fs";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { ClientSetup } from "./clients.js";
import type { OllamaModels } from "./local-models.js";
import type { Tested } from "./models.js";
import type { Terminals } from "./terminal.js";

/** What setting up a key or a local server came to. */
export interface SourceOutcome {
  ok: boolean;
  /** Why not, as the person reads it. */
  message: string | null;
  /** The model the app now writes with on it; null: none, so it does not end the setup. */
  text: string | null;
}

/** The host's models, as the setup's routes need them. */
export interface SetupModels {
  /** The source the person picked. */
  source(): string;
  /** The pick and what belongs to it, as the host's page reads them. */
  settings(c: Context): unknown;
  /** Keeps what the page sends; refuses what it does not know. */
  save(c: Context, body: unknown): Promise<void>;
  /** The kinds of model a test call may name; the first is the default. */
  classes: readonly [string, ...string[]];
  /** One short call on the picked source, as the app would make it. */
  test(cls: string): Promise<{ ref: string; text: string }>;
  /** The providers whose keys the setup takes. */
  providers: readonly [string, ...string[]];
  /** Tests a key (without one: the stored one) and keeps it when it works. */
  key(c: Context, provider: string, key: string | undefined): Promise<SourceOutcome>;
  /** Tests an Ollama at that address and uses it when it works. */
  ollama(c: Context, url: string): Promise<SourceOutcome>;
}

export interface SetupHost {
  clients: ClientSetup;
  terminals: Terminals;
  /** The folder a terminal starts in; made when missing. */
  workDir: () => string;
  models: SetupModels;
  tested: Tested;
  /** The models in Ollama on this computer. */
  ollama: OllamaModels;
}

/** The source own keys and a local server stand for. */
const OWN = "own";

const size = z.object({
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(4).max(200).optional(),
});

/** A model as Ollama names it: `name`, `name:tag`, `namespace/name:tag` or `hf.co/…`. */
const modelName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\w.:/-]+$/);

/** The request's JSON; an empty object when it has none. */
const bodyOf = (c: Context): Promise<unknown> => c.req.json().catch(() => ({}));

/**
 * The routes of the setup. Nothing here asks who is there: a host mounts them behind its own
 * sign-in, and only where it runs on the person's own computer.
 */
export function setupRoutes(host: SetupHost): Hono {
  const { clients, terminals, models, tested, ollama } = host;
  const workDir = () => {
    const dir = host.workDir();
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  return (
    new Hono()
      .get("/models", (c) => c.json(models.settings(c) as object))
      .put("/models", async (c) => {
        await models.save(c, await c.req.json());
        return c.json(models.settings(c) as object);
      })
      // One short call, as the app would make it: shows that the way to the model is open.
      .post("/models/test", async (c) => {
        const { cls } = z
          .object({ cls: z.enum(models.classes).default(models.classes[0]) })
          .parse(await bodyOf(c));
        const started = Date.now();
        // The source this call runs on: the person may pick another one while it is under way.
        const source = models.source();
        try {
          const { ref, text } = await models.test(cls);
          // A working call is what ends the setup, for the source it ran on.
          await tested.mark(source);
          return c.json({
            ok: true,
            ref,
            reply: text.trim().slice(0, 200),
            ms: Date.now() - started,
          });
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          return c.json({ ok: false, error: message.slice(0, 500), ms: Date.now() - started });
        }
      })
      // The test of one key, or of Ollama: a working one is put to use and ends the setup.
      .post("/keys/:provider", async (c) => {
        const provider = z.enum(models.providers).parse(c.req.param("provider"));
        const { key } = z.object({ key: z.string().max(400).optional() }).parse(await bodyOf(c));
        const outcome = await models.key(c, provider, key);
        if (outcome.ok && outcome.text) {
          await tested.mark(OWN);
        }
        return c.json(outcome);
      })
      .post("/ollama", async (c) => {
        const { url } = z.object({ url: z.string().url().max(200) }).parse(await c.req.json());
        const outcome = await models.ollama(c, url);
        if (outcome.ok) {
          await tested.mark(OWN);
        }
        return c.json(outcome);
      })
      // --- the models in Ollama on this computer: listed, pulled, removed; none is loaded -----
      .get("/local-models", async (c) => c.json(await ollama.state()))
      .post("/local-models/pull", async (c) => {
        const { model } = z.object({ model: modelName }).parse(await c.req.json());
        await ollama.pull(model);
        return c.json(await ollama.state());
      })
      .delete("/local-models", async (c) => {
        try {
          await ollama.remove(modelName.parse(c.req.query("model")));
        } catch (err) {
          if (err instanceof z.ZodError) {
            throw err;
          }
          const { message } = err as Error;
          return c.json({ error: message, message }, 400);
        }
        return c.json(await ollama.state());
      })
      // Ollama installed (on a Mac) and started.
      .post("/local-models/ollama", async (c) => {
        ollama.start();
        return c.json(await ollama.state());
      })
      // --- the AI clients on this computer: looked at afresh, installed and signed in --------
      .get("/clients", async (c) => c.json({ clients: await clients.detectAll() }))
      .post("/harness/:id/detect", async (c) => {
        const id = c.req.param("id");
        return clients.client(id)
          ? c.json({ harness: await clients.detect(id, true) })
          : c.notFound();
      })
      .post("/harness/:id/install", async (c) => {
        const command = await clients.install(c.req.param("id"));
        if (!command) {
          return c.notFound();
        }
        const { cols, rows } = size.parse(await bodyOf(c));
        // The page asks again once the command is over: then the client is there, or its output says why not.
        const terminal = await terminals.open({ ...command, cwd: workDir(), cols, rows });
        return c.json({ terminal });
      })
      .post("/harness/:id/login", async (c) => {
        const id = c.req.param("id");
        const command = await clients.login(id);
        if (!command) {
          return c.notFound();
        }
        const { cols, rows } = size.parse(await bodyOf(c));
        const terminal = await terminals.open({
          ...command,
          cwd: workDir(),
          cols,
          rows,
          // Signed in: the client says so on its own, and the app learns it right away.
          until: () => clients.signedIn(id),
          onDone: () => void clients.detect(id, true),
        });
        return c.json({ terminal });
      })
      .get("/terminal/:id/stream", (c) => {
        const id = c.req.param("id");
        return streamSSE(c, async (stream) => {
          let ended = false;
          // One write after the other, and all of them out before the stream ends: the last one is
          // the exit, and a page that comes after the end gets everything at once.
          let written = Promise.resolve();
          const done = new Promise<void>((resolve) => {
            const unsubscribe = terminals.subscribe(id, (event) => {
              written = written.then(() =>
                stream.writeSSE({ event: event.type, data: JSON.stringify(event) }),
              );
              if (event.type === "exit") {
                ended = true;
                resolve();
              }
            });
            stream.onAbort(() => {
              unsubscribe();
              resolve();
            });
          });
          // The page keeps the stream open while the terminal lives; a heartbeat keeps proxies from closing it.
          const beat = setInterval(() => {
            if (!ended) {
              void stream.writeSSE({ event: "ping", data: "" });
            }
          }, 15_000);
          await done;
          clearInterval(beat);
          await written;
        });
      })
      .post("/terminal/:id/input", async (c) => {
        const { data } = z.object({ data: z.string().max(10_000) }).parse(await c.req.json());
        terminals.write(c.req.param("id"), data);
        return c.json({ ok: true });
      })
      .post("/terminal/:id/resize", async (c) => {
        const { cols, rows } = size.required().parse(await c.req.json());
        terminals.resize(c.req.param("id"), cols, rows);
        return c.json({ ok: true });
      })
      .delete("/terminal/:id", (c) => {
        terminals.close(c.req.param("id"));
        return c.json({ ok: true });
      })
  );
}

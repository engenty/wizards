/**
 * The three host calls of a run on a loopback port, in the wire format of
 * `@engenty/wizards-engine/host-api`, so its `hostApi` client reaches this host as it reaches a
 * runtime: `GET <url>/api/peer/runs/<run>/state`, `GET …/changes?since=&after=` (NDJSON, held
 * open, a blank line every 15 s) and `POST …/events`.
 *
 * Only 127.0.0.1. Every call carries `Authorization: Bearer <secret>`: a secret the host makes at
 * its start and hands to whoever started it. It is not the runtime's peer ticket (this host has
 * no `authSecret`), and the tenant header the client sends is not read.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type HostActor,
  type HostChange,
  type HostState,
  hostEventSchema,
  PEER_RUNS_PATH,
} from "@engenty/wizards-engine/host-api";
import type { RunEvent } from "@engenty/wizards-shared/run";
import type { FlowEvent } from "@engenty/wizards-shared/transition";
import { HostRefusal } from "./host-refusal.js";

/** What the loopback asks of the host. */
export interface LoopbackHost {
  runId: string;
  port: number;
  state(): Promise<HostState>;
  send(event: FlowEvent, by?: HostActor): Promise<{ rev: number }>;
  /** The run's revision now, the log's lines after `after`, and whether the run moved past `since`. */
  changes(since: number, after: number): { rev: number; events: RunEvent[]; moved: boolean };
  lastEvent(): number;
  watch(listener: (change: HostChange) => void): () => void;
}

export interface Loopback {
  url: string;
  secret: string;
  close(): Promise<void>;
}

/** How often a held-open stream of changes says something, if only a blank line. */
const KEEP_ALIVE_MS = 15_000;
/** An event is a page's answers at most. */
const BODY_LIMIT = 1024 * 1024;

export async function serveLoopback(host: LoopbackHost): Promise<Loopback> {
  const secret = randomBytes(32).toString("base64url");
  const base = `${PEER_RUNS_PATH}/${encodeURIComponent(host.runId)}/`;
  const streams = new Set<() => void>();

  const server = createServer((req, res) => {
    void answer(req, res).catch((err) => {
      console.error(`[run ${host.runId}] host call:`, err);
      if (!res.headersSent) {
        json(res, 500, { error: "The run's host failed." });
      } else {
        res.end();
      }
    });
  });

  async function answer(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!authorized(req.headers.authorization, secret)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    const call = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : null;
    if (call === "state" && req.method === "GET") {
      json(res, 200, await host.state());
    } else if (call === "changes" && req.method === "GET") {
      changes(req, res, url.searchParams);
    } else if (call === "events" && req.method === "POST") {
      await events(req, res);
    } else {
      json(res, 404, { error: "Not found." });
    }
  }

  function changes(req: IncomingMessage, res: ServerResponse, query: URLSearchParams) {
    const since = count(query.get("since"));
    const after = query.has("after") ? count(query.get("after")) : host.lastEvent();
    if (since === null || after === null) {
      json(res, 400, { error: "since: a revision; after: a line of the log" });
      return;
    }
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    });
    let rev = since;
    let told = after;
    const look = () => {
      const now = host.changes(rev, told);
      if (now.moved || now.events.length) {
        rev = now.rev;
        told = now.events.at(-1)?.id ?? told;
        res.write(`${JSON.stringify({ rev, events: now.events } satisfies HostChange)}\n`);
      }
    };
    const stop = host.watch(look);
    const keepAlive = setInterval(() => res.write("\n"), KEEP_ALIVE_MS);
    keepAlive.unref();
    const end = () => {
      stop();
      clearInterval(keepAlive);
      streams.delete(end);
      res.end();
    };
    streams.add(end);
    req.on("close", end);
    look();
  }

  async function events(req: IncomingMessage, res: ServerResponse) {
    const text = await bodyOf(req);
    if (text === null) {
      json(res, 413, { error: "The request is too large." });
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = hostEventSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      json(res, 400, {
        error: `${issue?.path.join(".") || "body"}: ${issue?.message ?? "not an event"}`,
      });
      return;
    }
    try {
      json(res, 200, await host.send(parsed.data.event, parsed.data.by));
    } catch (err) {
      if (err instanceof HostRefusal) {
        json(res, err.status, {
          error: err.message,
          ...(err.fields === undefined ? {} : { fields: err.fields }),
        });
        return;
      }
      throw err;
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(host.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    async close() {
      for (const end of [...streams]) {
        end();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function authorized(header: string | undefined, secret: string): boolean {
  const given = Buffer.from(header?.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? "");
  const wanted = Buffer.from(secret);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function count(value: string | null): number | null {
  const n = Number(value);
  return value !== null && value !== "" && Number.isInteger(n) && n >= 0 ? n : null;
}

/** The request's body as text; null past the limit. */
async function bodyOf(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) {
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

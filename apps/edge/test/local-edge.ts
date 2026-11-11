/**
 * The Worker and its runs' objects on a local workerd, through Miniflare (the version wrangler
 * 4.153.0 runs, as spike 0.3 did): what a test drives the objects with. Nothing is deployed and
 * nothing leaves the machine: the objects' own `fetch` (the run's services) goes to `outbound`.
 *
 * Each object keeps its storage and its alarm under `persist`: a second `localEdge` on the same
 * folder after `dispose()` is the same objects after a restart.
 */
import { fileURLToPath } from "node:url";
import type { Plugin } from "esbuild";
import { Miniflare } from "miniflare";
import { buildWorker, QUICKJS_WASM } from "../scripts/build.mjs";
import { MOVE_LINE } from "./probe-transition.js";

export interface LocalEdgeOptions {
  /** Where the objects keep their storage and alarms. */
  persist: string;
  /** The origin the objects reach the run's services at (`SERVICES_URL`). */
  services: string;
  /** Every request an object sends out. */
  outbound(request: Request): Promise<Response>;
  /** Each move of the flow written to the log (`probe-transition.ts`), for `moves`. */
  probe?: boolean;
  /** The watchdog of an object's call, in ms. */
  watchdogMs?: number;
}

export interface LocalEdge {
  /** Where workerd listens: `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** A request to the Worker, as a door or the tenant sends it. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** What the objects wrote to their log, in order. */
  readonly logs: string[];
  /** The flow's moves so far, `{ wizard, move }`, with `probe`. */
  moves(): { wizard: string; move: string }[];
  /** Stops workerd; what the objects stored stays under `persist`. */
  dispose(): Promise<void>;
}

/** The path and query a client's request goes to, for `fetch`. */
export function pathOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return `${url.pathname}${url.search}`;
}

const builds = new Map<boolean, ReturnType<typeof buildWorker>>();

/** Points the bundle's `transition` at the probe, which imports the real one. */
const probe: Plugin = {
  name: "probe-transition",
  setup(b) {
    const shim = fileURLToPath(new URL("./probe-transition.ts", import.meta.url));
    b.onResolve({ filter: /^@engenty\/wizards-shared\/transition$/ }, (args) =>
      args.importer === shim ? undefined : { path: shim },
    );
  },
};

export async function localEdge(options: LocalEdgeOptions): Promise<LocalEdge> {
  const probed = options.probe ?? false;
  if (!builds.has(probed)) {
    builds.set(probed, buildWorker({ plugins: probed ? [probe] : [] }));
  }
  const { script, wasm } = await (builds.get(probed) as ReturnType<typeof buildWorker>);
  const logs: string[] = [];
  const mf = new Miniflare({
    modules: [
      { type: "ESModule", path: "/edge/worker.js", contents: script },
      { type: "CompiledWasm", path: `/edge/${QUICKJS_WASM}`, contents: new Uint8Array(wasm) },
    ],
    modulesRoot: "/edge",
    compatibilityDate: "2026-07-01",
    durableObjects: { RUN: { className: "RunObject", useSQLite: true } },
    bindings: {
      SERVICES_URL: options.services,
      ...(options.watchdogMs ? { WATCHDOG_MS: String(options.watchdogMs) } : {}),
    },
    outboundService: (request: Request) => options.outbound(request),
    durableObjectsPersist: options.persist,
    handleStructuredLogs: (log) => {
      logs.push(log.message);
      if (log.level === "error" || log.level === "warn") {
        console.error(`[workerd] ${log.message}`);
      }
    },
  } as ConstructorParameters<typeof Miniflare>[0]);
  const url = (await mf.ready).origin;
  return {
    url,
    fetch: (path, init) =>
      mf.dispatchFetch(`http://edge.local${path}`, init as never) as unknown as Promise<Response>,
    logs,
    moves: () =>
      logs
        .filter((line) => line.startsWith(MOVE_LINE))
        .map((line) => JSON.parse(line.slice(MOVE_LINE.length))),
    dispose: () => mf.dispose(),
  };
}

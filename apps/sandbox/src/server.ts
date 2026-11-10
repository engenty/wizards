import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type MakeVm, NotFound, publicHost, type Vm } from "./vm.ts";

/**
 * The sandbox's API, for the runner only (apps/runtime/src/sandbox/agentos-remote.ts):
 *
 *   GET    /health                       no secret: { ok, vms, maxVms }
 *   PUT    /vms/<run>         { hosts }  makes the run's VM; 201, or 200 when it is there already
 *   POST   /vms/<run>/exec    { command, cwd?, env?, timeoutMs? } → { stdout, stderr, exitCode }
 *   PUT    /vms/<run>/files?path=…       the body is the file
 *   GET    /vms/<run>/files?path=…       the file
 *   GET    /vms/<run>/list?path=…        [{ name, type }]
 *   DELETE /vms/<run>                    204
 *
 * Every route but /health wants `Authorization: Bearer <SANDBOX_SECRET>`. One VM per run, never
 * shared; at most `maxVms` at once (429 beyond); a VM nobody asked anything for `idleMs` is
 * destroyed. A VM that isn't there answers 404 `{ error: "no-vm" }`.
 */
export interface SandboxServerOptions {
  secret: string;
  maxVms: number;
  idleMs: number;
  /** The longest a command may run; a longer `timeoutMs` is cut to it. */
  maxExecMs: number;
  /** The largest file the API takes. */
  maxFileBytes: number;
  makeVm: MakeVm;
  log?: (line: string) => void;
}

/** A run id as the runtime makes them: letters, digits, `_`, `-`, `.`, `:`. */
const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_HOSTS = 200;

interface Entry {
  /** Settled once the VM is up; a VM that failed to start leaves the map. */
  vm: Promise<Vm>;
  lastUsed: number;
  /** Requests working on it right now: an idle sweep leaves it alone while there are any. */
  busy: number;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function sandboxServer(options: SandboxServerOptions) {
  const log = options.log ?? ((line: string) => console.log(line));
  const secret = digest(options.secret);
  const vms = new Map<string, Entry>();

  const authorized = (req: IncomingMessage) => {
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer ") && timingSafeEqual(digest(header.slice(7)), secret);
  };

  async function destroy(runId: string, why: string) {
    const entry = vms.get(runId);
    if (!entry) {
      return false;
    }
    vms.delete(runId);
    const vm = await entry.vm.catch(() => null);
    await vm?.dispose().catch((err) => log(`vm ${runId}: dispose failed: ${err}`));
    log(`vm ${runId}: destroyed (${why}), ${vms.size} left`);
    return true;
  }

  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const [runId, entry] of vms) {
        if (!entry.busy && now - entry.lastUsed > options.idleMs) {
          void destroy(runId, "idle");
        }
      }
    },
    Math.max(1000, Math.min(options.idleMs / 2, 30_000)),
  );
  sweep.unref();

  function create(runId: string, hosts: readonly string[]): { entry: Entry; created: boolean } {
    const existing = vms.get(runId);
    if (existing) {
      return { entry: existing, created: false };
    }
    if (vms.size >= options.maxVms) {
      throw new HttpError(429, "full", `All ${options.maxVms} VMs are in use.`);
    }
    const entry: Entry = { vm: options.makeVm(hosts), lastUsed: Date.now(), busy: 0 };
    vms.set(runId, entry);
    entry.vm.then(
      () => log(`vm ${runId}: made, ${hosts.length} hosts, ${vms.size} of ${options.maxVms}`),
      (err) => {
        if (vms.get(runId) === entry) {
          vms.delete(runId);
        }
        log(`vm ${runId}: failed to start: ${err}`);
      },
    );
    return { entry, created: true };
  }

  /** The run's VM, held busy while `work` runs. */
  async function use<T>(runId: string, work: (vm: Vm) => Promise<T>): Promise<T> {
    const entry = vms.get(runId);
    if (!entry) {
      throw new HttpError(404, "no-vm", `There is no VM for ${runId}.`);
    }
    entry.busy++;
    entry.lastUsed = Date.now();
    try {
      return await work(await entry.vm);
    } finally {
      entry.busy--;
      entry.lastUsed = Date.now();
    }
  }

  async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
    const declared = Number(req.headers["content-length"]);
    if (declared > limit) {
      throw new HttpError(413, "too-large", `More than ${limit} bytes.`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) {
        throw new HttpError(413, "too-large", `More than ${limit} bytes.`);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = (await body(req, MAX_JSON_BYTES)).toString("utf8");
    try {
      const value = raw ? JSON.parse(raw) : {};
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch {}
    throw new HttpError(400, "bad-json");
  }

  function pathParam(url: URL): string {
    const path = url.searchParams.get("path");
    if (!path || path.includes("\0")) {
      throw new HttpError(400, "bad-path");
    }
    return path;
  }

  function hostsOf(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > MAX_HOSTS) {
      throw new HttpError(400, "bad-hosts", "`hosts` is a list of host names.");
    }
    const hosts = value.map((host) => String(host).toLowerCase());
    const refused = hosts.filter((host) => !publicHost(host));
    if (refused.length) {
      throw new HttpError(400, "bad-hosts", `Not a public host name: ${refused.join(", ")}`);
    }
    return [...new Set(hosts)];
  }

  function execRequest(input: Record<string, unknown>) {
    const { command, cwd, env, timeoutMs } = input;
    if (typeof command !== "string" || !command) {
      throw new HttpError(400, "bad-command");
    }
    if (cwd !== undefined && typeof cwd !== "string") {
      throw new HttpError(400, "bad-cwd");
    }
    const vars: Record<string, string> = {};
    if (env !== undefined) {
      if (!env || typeof env !== "object" || Array.isArray(env)) {
        throw new HttpError(400, "bad-env");
      }
      for (const [key, value] of Object.entries(env)) {
        vars[key] = String(value);
      }
    }
    const asked = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : options.maxExecMs;
    return { command, cwd, env: vars, timeoutMs: Math.min(asked, options.maxExecMs) };
  }

  const send = (res: ServerResponse, status: number, value?: unknown) => {
    if (value === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  };

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://sandbox");
    const method = req.method ?? "GET";
    if (url.pathname === "/health" && method === "GET") {
      send(res, 200, { ok: true, vms: vms.size, maxVms: options.maxVms });
      return;
    }
    if (!authorized(req)) {
      throw new HttpError(401, "unauthorized");
    }
    const [, root, runId, action, ...rest] = url.pathname.split("/");
    if (root !== "vms" || !runId || rest.length) {
      throw new HttpError(404, "not-found");
    }
    if (!RUN_ID.test(runId)) {
      throw new HttpError(400, "bad-run-id");
    }
    const at = `${method} ${action ?? ""}`;
    switch (at) {
      case "PUT ": {
        const { created } = create(runId, hostsOf((await json(req)).hosts));
        await use(runId, async () => undefined);
        send(res, created ? 201 : 200, { created });
        return;
      }
      case "DELETE ":
        await destroy(runId, "asked");
        send(res, 204);
        return;
      case "POST exec": {
        const request = execRequest(await json(req));
        send(res, 200, await use(runId, (vm) => vm.exec(request)));
        return;
      }
      case "PUT files": {
        const path = pathParam(url);
        const data = await body(req, options.maxFileBytes);
        await use(runId, (vm) => vm.writeFile(path, new Uint8Array(data)));
        send(res, 204);
        return;
      }
      case "GET files": {
        const path = pathParam(url);
        const data = await use(runId, (vm) => vm.readFile(path));
        res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(data));
        return;
      }
      case "GET list": {
        const path = pathParam(url);
        send(res, 200, await use(runId, (vm) => vm.list(path)));
        return;
      }
      default:
        throw new HttpError(405, "not-allowed");
    }
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.code, message: err.message });
        return;
      }
      if (err instanceof NotFound) {
        send(res, 404, { error: "no-file", message: err.message });
        return;
      }
      log(`${req.method} ${req.url}: ${err instanceof Error ? err.stack : err}`);
      send(res, 500, { error: "failed", message: err instanceof Error ? err.message : String(err) });
    });
  });

  return {
    server,
    vms: () => vms.size,
    /** Stops taking requests and destroys every VM. */
    async close() {
      clearInterval(sweep);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await Promise.all([...vms.keys()].map((runId) => destroy(runId, "stopping")));
    },
  };
}

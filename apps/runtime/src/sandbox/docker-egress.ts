import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, request } from "node:http";
import { connect, type Socket } from "node:net";
import { promisify } from "node:util";
import { connectPublic } from "../tools/net-guard.js";
import type { SandboxEgress } from "./types.js";

/*
 * A Docker sandbox's way out. Its container sits on a Docker network with no way out of its own
 * (`--internal`); the only other machine there is a relay container, which passes each
 * connection on to a proxy in the runtime. The proxy knows the run by the token in the proxy
 * address (`HTTPS_PROXY=http://run:<token>@…`), asks the broker for each connection
 * (`SandboxEgress.open`, `brokerHost`) and opens only those to public addresses, on ports 80 and
 * 443. A request to anywhere else is refused, and the broker logs either.
 */

const exec = promisify(execFile);

/** The Docker network of the sandboxes: no route out, only the relay. */
export const EGRESS_NETWORK = "wizards-sandbox";
/** Marks the relay containers; the value is the port of the proxy it passes connections to. */
const RELAY_LABEL = "engenty-wizards.egress";
const RELAY_PORT = 3128;
const PORTS = new Set([80, 443]);

/** The relay: every connection to it, piped to the runtime's proxy. Runs on the sandbox image's Node. */
const relayScript = (port: number) =>
  `require("net").createServer((c) => { const u = require("net").connect(${port}, "host.docker.internal");` +
  ` c.pipe(u).pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); }).listen(${RELAY_PORT});`;

/** The runs whose containers are up, by the token in their proxy address. */
const runs = new Map<string, SandboxEgress>();

const docker = async (...args: string[]) =>
  (await exec("docker", args, { timeout: 60_000 })).stdout.trim();

const refuse = (socket: Socket, status: string, extra = "") =>
  socket.end(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);

function egressOf(req: IncomingMessage): SandboxEgress | null {
  const auth = req.headers["proxy-authorization"];
  if (!auth?.startsWith("Basic ")) {
    return null;
  }
  const token = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":")[1] ?? "";
  return runs.get(token) ?? null;
}

/** `host:port` of a CONNECT, the brackets of an IPv6 address taken off. */
function target(authority: string): { host: string; port: number } | null {
  try {
    const url = new URL(`http://${authority}`);
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) };
  } catch {
    return null;
  }
}

async function open(egress: SandboxEgress, host: string, port: number): Promise<Socket | null> {
  if (!PORTS.has(port)) {
    return null;
  }
  return egress.open(host, () => connectPublic(host, port));
}

function startProxy(listenOn: string): Promise<number> {
  const server = createServer(async (req, res) => {
    // Plain HTTP through the proxy: an absolute URL in the request line.
    const egress = egressOf(req);
    if (!egress) {
      res.writeHead(407, { "Proxy-Authenticate": "Basic" }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const upstream =
      url.protocol === "http:"
        ? await open(egress, url.hostname, Number(url.port || 80)).catch(() => null)
        : null;
    if (!upstream) {
      res.writeHead(403).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    // One request per connection to the host: the next one may be for another host.
    headers.connection = "close";
    const out = request(
      {
        createConnection: () => upstream,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    out.on("error", () => res.destroy());
    req.pipe(out);
  });

  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => undefined);
    const egress = egressOf(req);
    if (!egress) {
      refuse(client, "407 Proxy Authentication Required", "Proxy-Authenticate: Basic\r\n");
      return;
    }
    const to = target(req.url ?? "");
    const upstream = to ? await open(egress, to.host, to.port).catch(() => null) : null;
    if (!upstream) {
      refuse(client, "403 Forbidden");
      return;
    }
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) {
      upstream.write(head);
    }
    upstream.pipe(client).pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, listenOn, () => {
      server.unref();
      resolve((server.address() as { port: number }).port);
    });
  });
}

/**
 * Where the relay reaches this computer as `host.docker.internal`: on Linux the address of
 * Docker's own bridge (`host-gateway`), elsewhere Docker Desktop or OrbStack, which pass it to
 * loopback.
 */
async function listenAddress(): Promise<string> {
  if (process.platform !== "linux") {
    return "127.0.0.1";
  }
  return docker("network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}");
}

function listening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Relays of runtimes that are gone: their proxy's port no longer answers. */
async function removeStaleRelays(listenOn: string, ours: number) {
  const lines = await docker(
    "ps",
    "-a",
    "--filter",
    `label=${RELAY_LABEL}`,
    "--format",
    `{{.Names}} {{.Label "${RELAY_LABEL}"}}`,
  ).catch(() => "");
  for (const line of lines.split("\n").filter(Boolean)) {
    const [name, port] = line.split(" ");
    if (Number(port) !== ours && !(await listening(listenOn, Number(port)))) {
      await docker("rm", "-f", name).catch(() => undefined);
    }
  }
}

async function ensureNetwork() {
  const exists = await docker("network", "inspect", EGRESS_NETWORK).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await docker("network", "create", "--internal", "--label", RELAY_LABEL, EGRESS_NETWORK).catch(
      (err) => {
        if (!/already exists/.test(String(err))) {
          throw err;
        }
      },
    );
  }
}

async function ensureRelay(image: string, port: number): Promise<string> {
  const name = `wizards-egress-${port}`;
  const running = await docker("inspect", "-f", "{{.State.Running}}", name).catch(() => "");
  if (running === "true") {
    return name;
  }
  await docker("rm", "-f", name).catch(() => undefined);
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${RELAY_LABEL}=${port}`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--memory",
    "64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--entrypoint",
    "node",
    image,
    "-e",
    relayScript(port),
  );
  await docker("network", "connect", EGRESS_NETWORK, name);
  return name;
}

let relay: Promise<string> | null = null;

/** The proxy and the relay, started once per runtime on the first sandbox that needs them. */
function egressRelay(image: string): Promise<string> {
  relay ??= (async () => {
    const listenOn = await listenAddress();
    const port = await startProxy(listenOn);
    await removeStaleRelays(listenOn, port);
    await ensureNetwork();
    return ensureRelay(image, port);
  })().catch((err) => {
    relay = null;
    throw err;
  });
  return relay;
}

/**
 * What one run's container needs to reach outside through the broker: the network to join and
 * the proxy address in its environment. `release` forgets the run's token when the container goes.
 */
export async function dockerEgress(
  image: string,
  egress: SandboxEgress,
): Promise<{ network: string; env: Record<string, string>; release: () => void }> {
  const name = await egressRelay(image);
  const token = randomBytes(24).toString("hex");
  runs.set(token, egress);
  const proxy = `http://run:${token}@${name}:${RELAY_PORT}`;
  return {
    network: EGRESS_NETWORK,
    env: {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      // Node reads the proxy from the environment only when asked to.
      NODE_USE_ENV_PROXY: "1",
    },
    release: () => runs.delete(token),
  };
}

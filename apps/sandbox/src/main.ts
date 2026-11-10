import { createServer } from "node:http";
import { agentOsVms } from "./agentos.ts";
import { sandboxServer } from "./server.ts";

/**
 * The sandbox container's process (deploy/Dockerfile.sandbox): agentOS's helper and the API in
 * front of it. Read from the environment:
 *
 *   SANDBOX_SECRET            what the runner sends; 32 characters or more. Empty: off
 *   SANDBOX_MAX_VMS           VMs at once, default 4
 *   SANDBOX_IDLE_MINUTES      a VM nobody used this long is destroyed, default 30
 *   SANDBOX_MAX_EXEC_SECONDS  the longest a command runs, default 600
 *   SANDBOX_MAX_FILE_MB       the largest file in or out, default 64
 *   SANDBOX_PORT              default 8892
 *   AGENTOS_DIR               where agentOS is installed, default /opt/engines/agentos
 */
const number = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const secret = process.env.SANDBOX_SECRET?.trim() ?? "";
// agentOS's helper and every program it starts inherit the environment: the secret stays here.
delete process.env.SANDBOX_SECRET;
const port = number("SANDBOX_PORT", 8892);

if (!secret) {
  // Switched off (compose.cloud.yaml until the runner's SANDBOX is on): no agentOS, and an API
  // that answers nobody, instead of a container that restarts without end.
  createServer((req, res) => {
    const health = req.url === "/health";
    res
      .writeHead(health ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify(health ? { ok: true, off: true } : { error: "off" }));
  }).listen(port, "0.0.0.0", () => console.log("sandbox: off, SANDBOX_SECRET is not set"));
} else {
  if (secret.length < 32) {
    console.error("SANDBOX_SECRET is shorter than 32 characters: the sandbox doesn't start.");
    process.exit(1);
  }
  await start(secret);
}

async function start(secret: string) {
  const maxVms = Math.floor(number("SANDBOX_MAX_VMS", 4));
  const maxExecMs = number("SANDBOX_MAX_EXEC_SECONDS", 600) * 1000;
  const dir = process.env.AGENTOS_DIR || "/opt/engines/agentos";
  const agentOs = await agentOsVms(dir, maxVms, maxExecMs);
  const api = sandboxServer({
    secret,
    maxVms,
    idleMs: number("SANDBOX_IDLE_MINUTES", 30) * 60_000,
    maxExecMs,
    maxFileBytes: number("SANDBOX_MAX_FILE_MB", 64) * 1024 * 1024,
    makeVm: agentOs.makeVm,
  });
  api.server.listen(port, "0.0.0.0", () =>
    console.log(`sandbox: listening on ${port}, at most ${maxVms} VMs`),
  );

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      await api.close();
      await agentOs.stop().catch(() => undefined);
      process.exit(0);
    });
  }
}

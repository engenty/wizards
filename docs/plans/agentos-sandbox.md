# agentOS as the sandbox without Docker

Decided 2026-10-17 after a spike with agentOS 0.4.1. Built the same day: the engine
(`apps/runtime/src/sandbox/agentos.ts`), the installer of engines outside the package
(`install.ts`, with agentOS's part in `agentos-package.ts`), `wizards sandbox`, and the image's
`SANDBOX_ENGINES` build argument. 2026-11-09: agentOS 0.4.7, and the cloud's sandbox in a
container of its own ("The cloud" below).

## Why it came back

#32 (2026-10-15) dropped agentOS 0.2.22: it added about 1.75 GB on Linux, most of it
four coding agents nobody here uses (Pi, Claude Code, Codex, opencode). agentOS 0.4.1
(2026-10-12) no longer depends on them, and it runs a lot more than 0.2.22 did.

It stays out of `package.json`. `wizards sandbox add`, `pnpm sandbox:add agentos` or the image's
`SANDBOX_ENGINES=agentos` install it into a folder of its own (`engines/agentos` in
`SANDBOX_ENGINES_DIR`), and the engine loads it from there with `import()`. A computer without it
gets no sandbox, as before.

## Engines

agentOS is one engine among several. Each is a `SandboxEngine` (`sandbox/types.ts`): a name for
`SANDBOX`, whether it is ready here, what it runs (the agent's tool descriptions are written from
that) and a sandbox per run. `ENGINES` in `sandbox/index.ts` lists them in the order one is
picked when `SANDBOX` names none: `docker`, then `agentos`.

Mastra has the same idea, `WorkspaceSandbox`, with providers for Docker, E2B, Daytona and the
local machine. `MastraRunSandbox` (`sandbox/mastra.ts`) makes any of them a run's sandbox; Docker
already goes through it. agentOS has no Mastra provider, so it has its own class.

An engine whose package is not a dependency of the runtime lists it in `ENGINE_PACKAGES`
(`sandbox/install.ts`): its packages at exact versions, its size for the messages, and an
optional `prepare` that runs after npm. `wizards sandbox add <name>` installs it, `wizards status`
shows it and says when this release wants another version, and the engine loads it with
`importFromEngine`. E2B, for example, would look like this:

```ts
// install.ts
e2b: { label: "E2B", version: "0.14.1", packages: ["@mastra/e2b@0.14.1"], size: "about 170 MB" },

// sandbox/e2b.ts, listed in ENGINES
export const e2bEngine: SandboxEngine = {
  name: "e2b",
  ready: () => Boolean(process.env.E2B_API_KEY) && installedVersion(dir()) !== null,
  capabilities: () => E2B_CAPABILITIES,
  create: (runId) =>
    new MastraRunSandbox(E2B_CAPABILITIES, async () => {
      const { E2BSandbox } = (await importFromEngine("e2b", dir(), "@mastra/e2b")) as typeof import("@mastra/e2b");
      return new E2BSandbox({ id: `wizards-${runId}`, template: "engenty-sandbox" });
    }),
};
```

A Mastra provider depends on `@mastra/core` as a peer; npm installs a copy of it into the
engine's folder. The adapter only calls the provider's methods, so the second copy does no harm,
but it is most of the size: `@mastra/e2b` 0.14.1 makes a folder of 172 MB, 90 MB of it Mastra
(tried 2026-10-17: it loads from there, and without `E2B_API_KEY` it says so when it starts).
Linking the runtime's own `@mastra/core` into the folder would save that; not done yet.
E2B's own cloud keeps data in the US; for the EU it runs self-hosted or in our own cloud account,
so it would be an engine people choose, never the default.

## What the spike found (2026-10-17)

| | Linux x64 | macOS arm64 (Darwin 25, Node 24.14) |
|---|---|---|
| Install | 485 MB as npm installs it; 346 MB after the installer drops `googleapis`, the AWS SDK and `better-sqlite3`, which the core never imports. About 20 s | 330 MB, 20 s (`pnpm sandbox:add agentos`); 12 s again from npm's cache. The helper comes from `agentos-runtime-sidecar-darwin-arm64` |
| Start | A VM in about 160 ms. The helper process takes about 330 MB, each VM 10–20 MB more; 5 VMs after Python about 640 MB, one VM with pandas loaded about 880 MB | The helper takes 50–85 MB before the first VM, about 410 MB with one; at most 835 MB in the tests (pandas). A real agent step with pandas: at most 580 MB, 357 MB after it |
| Shell | bash and about 120 coreutils commands, sed, grep, gawk, find, diff, tar, gzip | The same: every promised command is on the PATH |
| Extra programs | curl, git, jq, sqlite3, zip and unzip ship with the core as WebAssembly but are off the PATH. The `@agentos-software/*` packages (0.3.3) are in a format 0.4 refuses. The installer packs the core's own binaries into a package folder; its files need mode 755 | The packed folder works: jq, sqlite3 and curl run |
| Node | `node`, `npm`, `npx` (Node 22 API). `node file.ts` does not strip types; TypeScript runs only through agentOS's own API | `node` runs; `npm install` from the registry takes about 4 s for a small package |
| Python | 3.13 as Pyodide, from the shell. numpy and pandas load offline. Other pure-Python packages install with `micropip` (`python3 -c "import micropip; await micropip.install('x')"`) and stay for the run. No `pip` command. Pillow, matplotlib and scipy are listed but fail to load | pandas loads. `micropip` installs from PyPI in about 30 s, most of it loading micropip; only the top-level `await` form works, `asyncio.run_until_complete` fails |
| Python's directory | Python starts in `$HOME`, not in the shell's directory. The engine puts a `python3` function before every command that passes `HOME=$PWD` | The same |
| Network | `default: deny` with rules `dns://<host>` + `tcp://<host>:443` lets exactly those hosts through; `dns://*.example.com` works too. Loopback (127.0.0.1) and 169.254.169.254 are refused with `EACCES` | Loopback is refused with `EACCES`; a host not on the list doesn't resolve (`curl: (6)`); npm and PyPI get through |
| Timeouts | A command over its limit ends as `timed_out`; the VM keeps working | The same |
| Logs | The helper prints a line on stderr for every V8 engine it keeps warm, several per command. The installer writes `sidecar.sh`, which filters them; `AGENTOS_SIDECAR_BIN` points agentOS to it | `sidecar.sh` filters them with macOS's bash 3.2: 146 lines from the tests without it, none with it. The server's log stays at its two start lines through an agent step |

On macOS a real AI step ran with `SANDBOX=agentos` and with `SANDBOX=docker` ("a CSV of 1 to 20 and
their squares with Python and pandas"): both returned `squares.csv` as a file. The `engenty-sandbox`
image has no pandas, so in Docker the agent installed it with `pip` first.

The runtime image built on macOS (linux/arm64): with `SANDBOX_ENGINES=agentos` 3.01 GB on disk,
726 MB compressed, `/opt/engines/agentos` 343 MB with `engine.json` 0.4.1; without it 2.51 GB and
589 MB, `/opt/engines` empty.

Not checked: how the VM behaves with real agent steps over hours, and agentOS inside the
linux/arm64 image (the image was only built and looked into).

## What runs where

| Engine | Where | Runs |
|---|---|---|
| `docker` | the host's Docker, one container per run | everything in the `engenty-sandbox` image, native programs included |
| `agentos` | the helper process beside the runtime, one VM per run | the table above: calculations, tables, file conversion, data from APIs |
| `agentos-remote` | the `sandbox` container, one VM per run, over HTTP | the same as `agentos` |
| `off` | | no shell/code tool |

Unset, `SANDBOX` is `docker` when the image is on the machine, else `agentos` when it is
installed, else `off`. Video, PDFs and the browser don't need the sandbox: the runtime does them
with its own tools.

## agentOS 0.4.7 (2026-11-09)

From 0.4.1 to 0.4.7 the API the engines use stayed as it was (`createSidecar`, `create`,
`process.exec`, `filesystem`, `agentos-package.json`, `AGENTOS_SIDECAR_BIN`). What changed for us:

- The core no longer depends on `googleapis`, the AWS SDK or `better-sqlite3`: the installer
  doesn't take them out any more.
- The helper got much bigger: 283 MB on macOS arm64 (126 MB in 0.4.1), 623 MB on Linux x64 (151 MB),
  most of it debug symbols. An install is about 480 MB on macOS. The sandbox image strips them.
- Fixes Rivet lists: `fs.rm` and symlinks (0.4.4, 0.4.6), a cap on each isolate's ArrayBuffer
  memory (0.4.5), and VMs on one helper no longer answering each other's callbacks (0.4.7).
- A Node script stops after 30 s of CPU time unless `limits.jsRuntime.cpuTimeLimitMs` says
  otherwise; the container sets it to the command's longest time. Python keeps a budget of 30 s CPU
  time that no option raises (the Pyodide runner leaves `jsRuntime` out; 0.4.1 had the same).
  Importing pandas takes a few seconds of it on macOS. In a Linux container on a Mac (OrbStack) at
  a load of 150 to 300 the budget ran out even for `python3 -c 'print(1)'`, with 0.4.1 as with
  0.4.7: the CPU time inside OrbStack's VM grows with the wait. Not checked on the VPS yet.

## The cloud

Built 2026-11-09. agentOS runs in a container of its own, `sandbox`, behind a small API of ours;
the runner reaches it, nothing else does. agentOS's security model draws its line between the
helper and the guest code, calls itself beta and leaves the helper's container to the operator.
So the container holds nothing worth taking: no tenant data, no volume, no secret but the one it
shares with the runner. Rivet's hosted mode (a control plane plus `rivetdev/services`) was set
aside: it adds a stateful service we don't need. Docker per run is out: it needs the host's Docker
socket. A computer keeps the in-process `agentos` engine: only one organization's data is there.

| Part | Where |
|---|---|
| The API: one VM per run, a cap, idle VMs destroyed, the secret | `apps/sandbox/src/server.ts` |
| The VMs: agentOS from the installer's folder, the network policy | `apps/sandbox/src/agentos.ts`, `vm.ts` |
| The image: Node, agentOS 0.4.7 from the runtime's installer, the API | `deploy/Dockerfile.sandbox` |
| The engine in the runtime | `apps/runtime/src/sandbox/agentos-remote.ts` |
| The service, its network, its limits | `compose.cloud.yaml` |
| Built and published with the other images | `.github/workflows/ci.yml`, job `images` |

**The API.** `PUT /vms/<run>` with `{ hosts }` makes the run's VM, `POST /vms/<run>/exec` runs a
command, `PUT`/`GET /vms/<run>/files?path=` write and read a file, `GET /vms/<run>/list?path=`
lists a folder, `DELETE /vms/<run>` destroys it. Every route but `/health` wants
`Authorization: Bearer <SANDBOX_SECRET>`. A VM serves one run and is never shared. At most
`SANDBOX_MAX_VMS` (4) run at once; one more is refused with 429, and the agent hears that the
sandbox is full. A VM nobody used for `SANDBOX_IDLE_MINUTES` (30) is destroyed; the runner
destroys it when the run stops. A command runs at most `SANDBOX_MAX_EXEC_SECONDS` (600), a file
in or out has at most `SANDBOX_MAX_FILE_MB` (64). Without `SANDBOX_SECRET` the container starts
agentOS not at all and answers every request with 503.

**The network.** The runner sends the hosts with the VM: the npm and PyPI registries and what the
run's grant allows (`agentOsHosts`, as for the in-process engine). The container applies them:
agentOS's `default: "deny"` plus `dns://<host>` and `tcp://<host>:443` for each. It takes public
DNS names only: no IP address, no `localhost`, no single label like `runner`, nothing under
`.internal`, `.local` or `.arpa`.

**The runtime.** `SANDBOX=agentos-remote` with `SANDBOX_URL` and `SANDBOX_SECRET` picks the engine;
`run_command`, the file tools and skill scripts use it as they use the others. The VM is made on
the first call. When the container no longer has it (idle, a restart), the engine makes it again
once, empty. `SANDBOX_GUESTS=agentos-remote` gives a guest's run one too; the default stays `off`.

**Hardening** (compose.cloud.yaml): user 1000, a read-only root file system with a tmpfs on
`/tmp` (512 MB), all capabilities dropped, `no-new-privileges`, 4 GB of memory without swap, 2 CPUs,
512 processes. No volume, no `/data`, no host mounts, no host functions or mounts in agentOS. The
container has its own network, `sandbox` (172.30.6.0/24, bridge `br-wz-sandbox`), with the runner
and nothing else. The API takes the secret out of its environment before agentOS starts, so the
helper and the VMs never inherit it.

**Measured** (2026-11-09, a Mac with OrbStack at a load of 140 to 370, the image built for
linux/arm64): the image is 668 MB, agentOS in it 386 MB (the helper stripped to 193 MB). The
container started as compose.cloud.yaml says (user 1000, read-only, 4 GB, 2 CPUs, no mounts, only
the `sandbox` network) and answered `/health`. A VM took 12 s to make; after a Python command the
container held about 570 MB. Inside a VM the user is `agentos`, `/data` doesn't exist, the bridge's
gateway (the host) and 169.254.169.254 are refused, and `example.com`, not on the list, doesn't
resolve.

A runtime from this checkout with `SANDBOX=agentos-remote` ran a test run of a one-step wizard
("a CSV of 1 to 20 and their squares with Python and pandas"): the AI step worked in the
container's VM for 6 minutes and handed `squares.csv` back as the run's file; the container made
the VM with the registries' 3 hosts and destroyed it when the run stopped. pandas itself ran out
of Python's CPU budget there (see "agentOS 0.4.7"), so the agent wrote the file with bash. The same
VM code on macOS without a container (`apps/sandbox/test/agentos.test.ts`) wrote the CSV with
pandas. pandas in the container on the VPS is the first thing to check when it is switched on.

### Switching it on (Coolify, the VPS)

Not done yet; Matthias switches it on. The release with this change brings the `sandbox` service
into the `runtime` resource, off.

1. **The secret.** In the `runtime` resource's environment, `SANDBOX_SECRET` = `openssl rand -hex 32`.
   The `sandbox` service takes it from there; the runner too once the lines below are in.
2. **The runner.** In `compose.cloud.yaml` (a PR), the runner's `SANDBOX: "off"` becomes the four
   commented lines below it: `SANDBOX: agentos-remote`, `SANDBOX_URL: http://172.30.6.13:8892`,
   `SANDBOX_SECRET`, and `SANDBOX_GUESTS: agentos-remote` if guests get it too. A release deploys it.
3. **The network in Coolify's file.** Coolify writes its own compose file. On the VPS:
   `docker inspect <sandbox container> --format '{{json .NetworkSettings.Networks}}'` must show
   only the `…_sandbox` network. If Coolify added its own network (the resource's uuid, or
   `coolify`), the container reaches the other services there: switch "Connect to Predefined
   Network" off for the resource and deploy again. `/data/coolify/applications/<uuid>/docker-compose.yaml`
   shows what Coolify made of the file.
4. **The host's firewall.** A bridge network reaches the host and, through it, the private networks.
   On the VPS, before the first VM runs, and kept across reboots (iptables-persistent or a
   systemd unit):

   ```sh
   # The sandbox reaches the runner, the runner reaches it; the internet answers back.
   iptables -I DOCKER-USER -s 172.30.6.0/24 -d 172.30.6.0/24 -j RETURN
   iptables -I DOCKER-USER 2 -s 172.30.6.0/24 -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10 -j DROP
   # Nothing from the sandbox's bridge to the host itself (Coolify on :8000, Traefik, SSH).
   iptables -I INPUT -i br-wz-sandbox -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
   iptables -I INPUT 2 -i br-wz-sandbox -j DROP
   ```

5. **The check.** From the sandbox container (`docker exec -it <sandbox> sh`; it has `node`):
   - `node -e "fetch('http://172.30.6.1:8000').then(r=>console.log(r.status),e=>console.log('blocked',e.cause?.code))"`
     says `blocked` (Coolify on the host).
   - The same with `http://172.30.5.10:9222` (the browser), the Turso and S3 addresses from the
     runtime's environment as far as they are private, and `http://169.254.169.254`: `blocked`.
   - `https://pypi.org/simple/` answers 200 (the internet).
   - `ls /data` says there is no such folder; `env` shows no secret (the API took it out).
   - From the runner: `curl -s http://172.30.6.13:8892/health` answers `{"ok":true,…}`, and a
     `PUT /vms/x` without the secret answers 401.
   - `python3 -c "import pandas"` in a VM (`POST /vms/x/exec`) ends with exit code 0, not with
     "exceeded the CPU-time budget".
   - A test run with a step that runs Python returns its file; the sandbox's log shows
     `vm <run>: made` and, when the run stops, `destroyed (asked)`.

## Later

- A full Linux engine for the wizards that need native programs (ffmpeg, ImageMagick,
  LibreOffice in the sandbox): MicroVMs on a NixOS host, behind the same API.
- agentOS 0.4 has a terminal, `software.install` from a URL and filesystem mounts; none is
  used yet.

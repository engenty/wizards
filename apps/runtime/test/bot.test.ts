import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error: plain JavaScript beside the launcher, without types
import * as bot from "../../../bin/bot.mjs";
// @ts-expect-error: plain JavaScript beside the launcher, without types
import * as relay from "../../../bin/bot-tunnel.mjs";

// `wizards bot`, without a release, a service or npm: what it reads and writes. Every test has a
// home folder of its own; the install itself is proven by hand (the PR says how).

let user: string;
const saved = { ...process.env };
let said: string[];
beforeEach(() => {
  user = mkdtempSync(join(tmpdir(), "wizards-bot-"));
  process.env.HOME = user;
  delete process.env.ENGENTY_HOME;
  delete process.env.WIZARDS_BOT_DATA;
  delete process.env.XDG_CONFIG_HOME;
  said = [];
  vi.spyOn(console, "log").mockImplementation((line) => said.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line) => said.push(String(line)));
});
afterEach(() => {
  vi.restoreAllMocks();
  // Key by key: os.homedir() reads the real environment, which a new process.env object isn't.
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, saved);
  rmSync(user, { recursive: true, force: true });
});

describe("wizards bot", () => {
  it("puts everything into ~/.engenty/wizards and the data into ~/.wizards-bot", () => {
    const paths = bot.layout(process.env);
    expect(paths.current).toBe(join(user, ".engenty", "wizards", "bot", "current"));
    expect(paths.command).toBe(join(user, ".engenty", "wizards", "bin", "wizards-bot"));
    expect(paths.pathLink).toBe(join(user, ".local", "bin", "wizards-bot"));
    expect(paths.data).toBe(join(user, ".wizards-bot"));
    const moved = bot.layout({ ENGENTY_HOME: join(user, "e"), WIZARDS_BOT_DATA: join(user, "d") });
    expect(moved.bot).toBe(join(user, "e", "wizards", "bot"));
    expect(moved.data).toBe(join(user, "d"));
  });

  it("gets the same Node as install.sh", () => {
    const installer = readFileSync(join(__dirname, "../../web/public/install.sh"), "utf8");
    expect(installer).toContain(`ENGENTY_WIZARDS_NODE_VERSION:-${bot.NODE_VERSION}}`);
  });

  it("runs the home on Node 24.11 or newer", () => {
    expect(bot.newEnough("v24.11.0")).toBe(true);
    expect(bot.newEnough("26.7.0")).toBe(true);
    expect(bot.newEnough("v24.10.1")).toBe(false);
    expect(bot.newEnough("v22.20.0")).toBe(false);
    expect(bot.older("0.1.0", "0.1.1")).toBe(true);
    expect(bot.older("0.2.0", "0.1.9")).toBe(false);
  });

  it("reads a home's address as a name, a host or a whole address", () => {
    expect(bot.homeAddress("ada")).toBe("https://ada.wizards.bot");
    expect(bot.homeAddress("ada.wizards.bot")).toBe("https://ada.wizards.bot");
    expect(bot.homeAddress("https://me.example.com/")).toBe("https://me.example.com");
    expect(bot.homeAddress("192.168.1.5:4747")).toBe("https://192.168.1.5:4747");
  });

  it("reads its options", () => {
    expect(bot.parse(["install", "--version", "v0.2.0", "--port", "4800", "--no-open"])).toMatchObject({
      command: "install",
      version: "0.2.0",
      port: 4800,
      open: false,
    });
    expect(bot.parse(["setup", "--link", "ada", "K7QM-2RXD"]).link).toEqual(["ada", "K7QM-2RXD"]);
    expect(bot.parse(["uninstall", "--purge", "-y"])).toMatchObject({ purge: true, yes: true });
    expect(bot.parse(["status", "--help"]).command).toBe("help");
  });

  it("refuses what it doesn't know, in one line", async () => {
    expect(await bot.main(["install", "--port", "x"])).toBe(1);
    expect(await bot.main(["fly"])).toBe(1);
    expect(said.join("\n")).toContain("wizards bot has no command fly");
  });

  it("writes a command with the home's Node, port and data folder", () => {
    const paths = bot.layout(process.env);
    const text = bot.commandText(paths, {
      node: "/n/bin/node",
      bin: "apps/home/src/cli.ts",
      port: 4748,
      data: "/d",
    });
    expect(text).toContain('export WIZARDS_BOT_PORT="${WIZARDS_BOT_PORT:-4748}"');
    expect(text).toContain('export WIZARDS_BOT_DATA="${WIZARDS_BOT_DATA:-/d}"');
    expect(text).toContain(`exec '/n/bin/node' '${join(paths.current, "apps/home/src/cli.ts")}' "$@"`);
  });

  it("writes a LaunchAgent and a systemd unit that start the command", () => {
    const paths = bot.layout(process.env);
    const agent = bot.agentText(paths, bot.LABEL, ["start"], "/l/bot.log");
    expect(agent).toContain(`<string>${bot.LABEL}</string>`);
    expect(agent).toContain(`<string>${paths.command}</string>\n    <string>start</string>`);
    expect(agent).toContain(`<key>HOME</key>\n    <string>${user}</string>`);
    const unit = bot.unitText(paths, "wizards.bot, your home", ["link"]);
    expect(unit).toContain(`ExecStart="${paths.command}" "link"`);
    expect(unit).toContain(`Environment="HOME=${user}"`);
    expect(unit).toContain("Restart=on-failure");
  });

  it("says when nothing is installed", async () => {
    expect(await bot.main(["status"])).toBe(0);
    expect(said.join("\n")).toContain("wizards.bot isn’t installed on this computer");
    expect(await bot.main(["uninstall"])).toBe(0);
    expect(await bot.main(["update"])).toBe(1);
    expect(await bot.main(["setup"])).toBe(1);
  });

  it("takes the next free port when one is taken", async () => {
    const taken: Server = createServer();
    await new Promise<void>((done) => taken.listen({ port: 0, host: "0.0.0.0" }, done));
    const port = (taken.address() as { port: number }).port;
    try {
      expect(await bot.freePort(port)).toBeGreaterThan(port);
    } finally {
      taken.close();
    }
  });

  it("puts a home into a folder of its own, named after the folder", () => {
    process.env.WIZARDS_BOT_DATA = join(user, "elsewhere");
    const dir = join(user, "demo", "test01");
    const paths = bot.layout(process.env, dir);
    expect(paths.folder).toBe(dir);
    expect(paths.current).toBe(join(dir, "program", "current"));
    expect(paths.settings).toBe(join(dir, "wizards-bot.json"));
    expect(paths.command).toBe(join(dir, "wizards-bot"));
    expect(paths.data).toBe(join(dir, "data"));
    expect(paths.log).toBe(join(dir, "logs", "bot.log"));
    expect(paths.pathLink).toBeNull();
    expect(paths.label).toMatch(/^com\.engenty\.wizards\.bot\.test01-[0-9a-f]{6}$/);
    expect(paths.linkLabel).toBe(`${paths.label}.link`);
    expect(paths.unitName).toMatch(/^wizards-bot-test01-[0-9a-f]{6}\.service$/);
    // Two folders of the same name are two homes; the one without a folder keeps its names.
    const other = bot.layout(process.env, join(user, "other", "test01"));
    expect(other.label).not.toBe(paths.label);
    expect(bot.layout(process.env).label).toBe(bot.LABEL);
    expect(bot.folderId("/x/My Bot Server!")).toMatch(/^my-bot-server-[0-9a-f]{6}$/);
    expect(bot.folderId("/x/...")).toMatch(/^folder-[0-9a-f]{6}$/);
  });

  it("reads a folder after the command", () => {
    expect(bot.parse(["install", "."])).toMatchObject({ command: "install", folder: "." });
    expect(bot.parse(["install", "./test01", "--port", "4800"])).toMatchObject({
      folder: "./test01",
      port: 4800,
    });
    expect(bot.parse(["setup", "--link", "ada", "K7QM-2RXD", "./test01"])).toMatchObject({
      link: ["ada", "K7QM-2RXD"],
      folder: "./test01",
    });
    expect(bot.parse(["tunnel", "--off"])).toMatchObject({ command: "tunnel", off: true });
    expect(() => bot.parse(["install", "a", "b"])).toThrow("One folder at a time");
  });

  it("keeps a home out of your home folder and the other homes' folders", () => {
    const refused = (dir: string) => bot.folderRefusal(bot.layout(process.env, dir));
    expect(refused(user)).toContain("too wide");
    expect(refused(join(user, ".engenty", "wizards-bot", "x"))).toContain("Mac app");
    expect(refused(join(user, ".wizards-bot"))).toContain("wizards bot install");
    expect(refused(join(user, ".engenty", "wizards", "bot"))).toContain("engenty wizards");
    expect(refused(join(user, "demo", "test01"))).toBeNull();
  });

  it("never takes 4747, the Mac app's port, nor a port another home keeps", async () => {
    expect(await bot.freePort(bot.MAC_APP_PORT)).not.toBe(bot.MAC_APP_PORT);
    const probe: Server = createServer();
    await new Promise<void>((done) => probe.listen({ port: 0, host: "127.0.0.1" }, done));
    const port = (probe.address() as { port: number }).port;
    // Something on 127.0.0.1 alone holds the port too.
    expect(await bot.portFree(port)).toBe(false);
    probe.close();
    await new Promise((done) => setTimeout(done, 50));
    expect(await bot.freePort(port, new Map([[port, "the Bot Server in ~/x"]]))).toBeGreaterThan(port);
    expect(await bot.main(["install", join(user, "t"), "--port", String(bot.MAC_APP_PORT)])).toBe(1);
    expect(said.join("\n")).toContain("4747 is the port of the wizards.bot Mac app");
    expect(existsSync(join(user, "t"))).toBe(false);
  });

  it("says which program holds a port", async () => {
    const taken: Server = createServer();
    await new Promise<void>((done) => taken.listen({ port: 0, host: "0.0.0.0" }, done));
    const port = (taken.address() as { port: number }).port;
    try {
      expect(bot.portHolder(port)).toContain(`pid ${process.pid}`);
      expect(await bot.main(["install", join(user, "t"), "--port", String(port)])).toBe(1);
      expect(said.join("\n")).toContain(`Port ${port} is taken by`);
    } finally {
      taken.close();
    }
    expect(
      bot.programName("/Applications/wizards.app/Contents/Resources/node/bin/node /x/cli.ts start"),
    ).toBe("wizards.app");
    expect(bot.programName("/usr/bin/python3 -m http.server")).toBe("python3");
    expect(bot.programName(`/n/bin/node ${user}/a/cli.ts start`)).toBe("node ~/a/cli.ts");
  });

  it("finds the homes in folders by their services, with the ports they keep", async () => {
    const dir = join(user, "demo", "test01");
    const paths = bot.layout(process.env, dir);
    mkdirSync(dirname(paths.agent), { recursive: true });
    mkdirSync(dirname(paths.unit), { recursive: true });
    writeFileSync(paths.agent, bot.agentText(paths, paths.label, ["start"], paths.log));
    writeFileSync(paths.unit, bot.unitText(paths, "wizards.bot", ["start"]));
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.settings, JSON.stringify({ port: 4790, data: paths.data }));
    const main = bot.layout(process.env);
    expect(bot.folderInstalls(main)).toEqual([dir]);
    expect(bot.folderInstalls(paths)).toEqual([]);
    expect(bot.claimedPorts(main).get(4790)).toBe("the Bot Server in ~/demo/test01");
    expect(await bot.main(["status"])).toBe(0);
    expect(said.join("\n")).toContain("In folders");
    expect(said.join("\n")).toContain("~/demo/test01");
  });

  it("takes a folder's home away and keeps its data", async () => {
    const dir = join(user, "demo", "test01");
    const paths = bot.layout(process.env, dir);
    mkdirSync(join(paths.bot, "0.1.4"), { recursive: true });
    mkdirSync(paths.data, { recursive: true });
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(join(paths.data, "home.db"), "");
    writeFileSync(paths.command, "#!/bin/sh\n");
    writeFileSync(paths.log, "");
    writeFileSync(paths.settings, JSON.stringify({ port: 4790, data: paths.data }));
    expect(await bot.main(["uninstall", dir])).toBe(0);
    expect(existsSync(paths.bot)).toBe(false);
    expect(existsSync(paths.command)).toBe(false);
    expect(existsSync(paths.settings)).toBe(false);
    expect(existsSync(paths.logs)).toBe(false);
    expect(existsSync(join(paths.data, "home.db"))).toBe(true);
    expect(said.join("\n")).toContain("wizards.bot is off ~/demo/test01");
    expect(await bot.main(["setup", dir])).toBe(1);
    expect(said.join("\n")).toContain("No wizards.bot is installed in ~/demo/test01");
  });

  it("writes the public address into the command once a tunnel is open", () => {
    const paths = bot.layout(process.env, join(user, "t"));
    const text = bot.commandText(paths, {
      node: "/n/bin/node",
      bin: "cli.ts",
      port: 4749,
      data: paths.data,
      url: "https://mac.tail1.ts.net:8443",
    });
    expect(text).toContain('export WIZARDS_BOT_URL="${WIZARDS_BOT_URL:-https://mac.tail1.ts.net:8443}"');
  });

  it("reads the paired devices from wizards-bot status", () => {
    const status = (devices: string) =>
      `Bot Server at http://x:4748\n\nAgents\n  Ada (main): 0 waiting for you\n\nDevices\n${devices}\nModels, in the order the Bot Server tries them\n  ollama/x\n`;
    expect(bot.devicesIn(status("  none\n"))).toBe(0);
    expect(bot.devicesIn(status("  iPhone (phone), last seen 2026-11-23\n  Mac (computer), last seen 2026-11-23\n"))).toBe(2);
    expect(bot.devicesIn("something else")).toBeNull();
  });

  it("opens Funnel on a port that serves this home or nothing", () => {
    const host = "mac.tail1.ts.net";
    expect(bot.funnelPort({}, host, 4748)).toBe(443);
    expect(bot.funnelPort(null, host, 4748)).toBe(443);
    const busy = {
      TCP: { 443: { HTTPS: true } },
      Web: { [`${host}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    };
    expect(bot.funnelPort(busy, host, 4748)).toBe(8443);
    const ours = {
      TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
      Web: {
        [`${host}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
        [`${host}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4748" } } },
      },
    };
    expect(bot.funnelPort(ours, host, 4748)).toBe(8443);
    expect(bot.funnelPort(ours, host, 4749)).toBe(10000);
    const full = { TCP: { 443: {}, 8443: {}, 10000: {} } };
    expect(bot.funnelPort(full, host, 4748)).toBeNull();
  });
});

// The tunnel through our relay at <name>.wizards.host: what `wizards bot tunnel` writes and asks
// the account (Manage's /v1/tunnels/*), against a fake account. The relay itself isn't here.

const openssl = spawnSync("openssl", ["version"]).status === 0;

/** A self-signed certificate that ends in `days`, made with openssl. */
function certFor(days: number) {
  const made = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", String(days), "-subj", "/CN=ada.wizards.host", "-keyout", "/dev/null"],
    { encoding: "utf8" },
  );
  return made.stdout;
}

type Fake = { url: string; calls: { method: string; path: string; auth?: string; body: unknown }[]; close: () => void };

/** The account's tunnel API, as the contract has it: each answer pending once, then ready. */
async function fakeAccount(cert: string): Promise<Fake> {
  const calls: Fake["calls"] = [];
  let redeemed = 0;
  let asked = 0;
  const server = createHttpServer(async (req: IncomingMessage, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: req.method || "", path: req.url || "", auth: req.headers.authorization, body });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url === "/v1/tunnels/start") {
      return json(200, { deviceCode: "dc1", userCode: "K7QF-2MXD", url: `${fake.url}/tunnel?code=K7QF-2MXD`, interval: 3, expiresIn: 900 });
    }
    if (req.url === "/v1/tunnels/redeem") {
      return ++redeemed < 2
        ? json(202, { state: "pending" })
        : json(200, { key: "wbn_test", name: "test01.ada.wizards.host", server: "wizards.host", serverPort: 443 });
    }
    if (req.url === "/v1/tunnels/cert" && req.method === "POST") {
      return json(202, { id: "o1", state: "pending" });
    }
    if (req.url === "/v1/tunnels/cert/o1") {
      return ++asked < 2 ? json(200, { state: "pending" }) : json(200, { state: "ready", cert, notAfter: "2027-02-21T00:00:00Z" });
    }
    if (req.url === "/v1/tunnels/key" && req.method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }
    json(404, { error: "Not found.", code: "unknown" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const fake: Fake = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    calls,
    close: () => server.close(),
  };
  return fake;
}

describe("wizards bot tunnel", () => {
  it("reads --name and --tailscale", () => {
    expect(bot.parse(["tunnel", "./t", "--name", "Test01"])).toMatchObject({ folder: "./t", name: "test01" });
    expect(bot.parse(["tunnel", "--tailscale"])).toMatchObject({ tailscale: true, name: null });
    expect(() => bot.parse(["tunnel", "--name"])).toThrow("--name needs a word");
    expect(bot.labelOk("test01")).toBe(true);
    expect(bot.labelOk("a-b")).toBe(true);
    expect(bot.labelOk("-a")).toBe(false);
    expect(bot.labelOk("a.b")).toBe(false);
    expect(bot.labelOk("x".repeat(33))).toBe(false);
    expect(bot.accountUrl({})).toBe("https://account.engenty.ai");
    expect(bot.accountUrl({ WIZARDS_ACCOUNT_URL: "http://localhost:5182/" })).toBe("http://localhost:5182");
  });

  it("pins frpc's checksum for every machine it downloads for", () => {
    expect(bot.FRP_VERSION).toBe("0.72.0");
    expect(Object.keys(bot.FRP_SHA256).sort()).toEqual(
      ["darwin_amd64", "darwin_arm64", "linux_amd64", "linux_arm64", "windows_amd64"],
    );
    for (const sum of Object.values(bot.FRP_SHA256)) {
      expect(sum).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(bot.frpMachine("darwin", "arm64")).toBe("darwin_arm64");
    expect(bot.frpMachine("linux", "x64")).toBe("linux_amd64");
    expect(bot.frpMachine("win32", "x64")).toBe("windows_amd64");
  });

  it("writes frpc's settings: wss to the relay, the key, TLS ended here", () => {
    const text = relay.frpcConfig({
      dir: "/h/tunnel",
      name: "ada.wizards.host",
      key: "wbn_x",
      server: "wizards.host",
      serverPort: 443,
      port: 4748,
      adminPort: 23456,
      adminPassword: "pw",
    });
    for (const line of [
      'serverAddr = "wizards.host"',
      "serverPort = 443",
      'transport.protocol = "wss"',
      "transport.tls.useSystemCa = true",
      "transport.heartbeatInterval = 30",
      'metadatas.token = "wbn_x"',
      'webServer.addr = "127.0.0.1"',
      "webServer.port = 23456",
      'name = "ada.wizards.host"',
      'type = "https"',
      'customDomains = ["ada.wizards.host"]',
      'type = "https2http"',
      'localAddr = "127.0.0.1:4748"',
      'crtPath = "/h/tunnel/cert.pem"',
      'keyPath = "/h/tunnel/key.pem"',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toContain("hostHeaderRewrite");
    expect(text).not.toContain("auth.token");
  });

  it("makes a certificate request for the name with a key that stays here", () => {
    const key = relay.makeKey();
    expect(key).toContain("BEGIN PRIVATE KEY");
    const csr = relay.csrFor("test01.ada.wizards.host", key);
    expect(csr).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----\n/);
    if (!openssl) {
      return;
    }
    const file = join(user, "t.csr");
    writeFileSync(file, csr);
    const read = spawnSync("openssl", ["req", "-in", file, "-verify", "-noout", "-text"], { encoding: "utf8" });
    expect(read.status).toBe(0);
    expect(`${read.stdout}${read.stderr}`).toMatch(/verify OK/i);
    expect(read.stdout).toContain("CN=test01.ada.wizards.host");
    expect(read.stdout).toContain("DNS:test01.ada.wizards.host");
    expect(read.stdout).toContain("ecdsa-with-SHA256");
  });

  it("names the tunnel's service after the home's and keeps it out of the folder homes", () => {
    const main = bot.layout(process.env);
    expect(main.tunnelLabel).toBe(`${bot.LABEL}.tunnel`);
    expect(main.tunnelUnitName).toBe("wizards-bot-tunnel.service");
    expect(main.tunnel).toBe(join(user, ".wizards-bot", "tunnel"));
    const dir = join(user, "demo", "test01");
    const paths = bot.layout(process.env, dir);
    expect(paths.tunnelLabel).toBe(`${paths.label}.tunnel`);
    expect(paths.tunnelUnitName).toMatch(/^wizards-bot-test01-[0-9a-f]{6}-tunnel\.service$/);
    expect(paths.tunnel).toBe(join(dir, "tunnel"));
    const agent = bot.agentText(paths, paths.tunnelLabel, [join(paths.tunnel, "run.mjs"), paths.tunnel], paths.tunnelLog, "/n/bin/node");
    expect(agent).toContain(`<string>/n/bin/node</string>\n    <string>${join(paths.tunnel, "run.mjs")}</string>`);
    const unit = bot.unitText(paths, "wizards.bot, the tunnel", ["run.mjs"], "/n/bin/node");
    expect(unit).toContain('ExecStart="/n/bin/node" "run.mjs"');
    // The tunnel's own service is no home in a folder.
    mkdirSync(dirname(paths.agent), { recursive: true });
    mkdirSync(dirname(paths.unit), { recursive: true });
    for (const p of [main, paths]) {
      writeFileSync(p.tunnelAgent, bot.agentText(p, p.tunnelLabel, ["x"], "/l", "/n/bin/node"));
      writeFileSync(p.tunnelUnit, bot.unitText(p, "t", ["x"], "/n/bin/node"));
    }
    expect(bot.folderInstalls(main)).toEqual([]);
  });

  it("writes the tunnel's files, the secret ones for you alone", () => {
    const dir = join(user, "demo", "tunnel");
    bot.writeTunnel(dir, { name: "ada.wizards.host", key: "wbn_x", server: "wizards.host", serverPort: 443, port: 4748, adminPort: 23456, adminPassword: "pw" });
    expect(statSync(join(dir, "tunnel.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "frpc.toml")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "frpc.toml"), "utf8")).toContain('metadatas.token = "wbn_x"');
    expect(readFileSync(join(dir, "run.mjs"), "utf8")).toContain("export async function run(dir)");
  });

  it("refuses to open a tunnel while no device is paired", async () => {
    const dir = join(user, "demo", "test01");
    const paths = bot.layout(process.env, dir);
    const health = createHttpServer((_req, res) => {
      res.writeHead(200);
      res.end("{}");
    });
    await new Promise<void>((done) => health.listen(0, "127.0.0.1", done));
    const port = (health.address() as { port: number }).port;
    const account = await fakeAccount("");
    process.env.WIZARDS_ACCOUNT_URL = account.url;
    try {
      mkdirSync(join(paths.bot, "0.1.4"), { recursive: true });
      writeFileSync(join(paths.bot, "0.1.4", "package.json"), JSON.stringify({ version: "0.1.4" }));
      symlinkSync("0.1.4", paths.current);
      writeFileSync(paths.settings, JSON.stringify({ port, data: paths.data, node: process.execPath, bin: "cli.ts" }));
      writeFileSync(paths.command, '#!/bin/sh\nprintf "Devices\\n  none\\n"\n');
      chmodSync(paths.command, 0o755);
      expect(await bot.main(["tunnel", dir])).toBe(1);
      expect(said.join("\n")).toContain("No device is paired with this home yet");
      expect(account.calls).toEqual([]);
      expect(existsSync(paths.tunnel)).toBe(false);
    } finally {
      health.close();
      account.close();
    }
  });

  it("gets a name and a certificate from the account", async () => {
    const cert = openssl ? certFor(90) : "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n";
    const account = await fakeAccount(cert);
    try {
      const given = await bot.signIn(account.url, { label: "test01", open: false, every: 10 });
      expect(given).toEqual({ key: "wbn_test", name: "test01.ada.wizards.host", server: "wizards.host", serverPort: 443 });
      expect(account.calls[0]).toMatchObject({ method: "POST", path: "/v1/tunnels/start", body: { label: "test01" } });
      expect(said.join("\n")).toContain("K7QF-2MXD");
      expect(account.calls.filter((c) => c.path === "/v1/tunnels/redeem")).toHaveLength(2);

      const key = relay.makeKey();
      const got = await relay.orderCertificate(account.url, "wbn_test", relay.csrFor(given.name, key), { every: 10 });
      expect(got).toBe(cert);
      const order = account.calls.find((c) => c.path === "/v1/tunnels/cert");
      expect(order?.auth).toBe("Bearer wbn_test");
      expect((order?.body as { csr: string }).csr).toContain("BEGIN CERTIFICATE REQUEST");
      expect(account.calls.filter((c) => c.path === "/v1/tunnels/cert/o1")).toHaveLength(2);
    } finally {
      account.close();
    }
  });

  it("says why a name wasn't given", async () => {
    const server = createHttpServer((req, res) => {
      res.writeHead(req.url === "/v1/tunnels/start" ? 200 : 403, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url === "/v1/tunnels/start"
            ? { deviceCode: "d", userCode: "A", url: "u", interval: 1, expiresIn: 60 }
            : { error: "Declined.", code: "denied" },
        ),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      await expect(
        bot.signIn(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { open: false, every: 10 }),
      ).rejects.toThrow("declined on the account page");
    } finally {
      server.close();
    }
  });

  it.skipIf(!openssl)("renews the certificate 30 days before it ends", async () => {
    const fresh = certFor(90);
    const account = await fakeAccount(fresh);
    const dir = join(user, "tunnel");
    mkdirSync(dir);
    writeFileSync(join(dir, "key.pem"), relay.makeKey());
    const tunnel = { dir, account: account.url, key: "wbn_test", name: "ada.wizards.host" };
    try {
      writeFileSync(join(dir, "cert.pem"), fresh);
      expect(relay.needsRenewal(fresh)).toBe(false);
      expect(await relay.renewIfDue(tunnel)).toBe(false);
      expect(account.calls).toEqual([]);
      const ending = certFor(10);
      expect(relay.needsRenewal(ending)).toBe(true);
      expect(relay.needsRenewal(null)).toBe(true);
      writeFileSync(join(dir, "cert.pem"), ending);
      // Waits 3 s between asks in the service; the fake answers on the second.
      expect(await relay.renewIfDue(tunnel)).toBe(true);
      expect(readFileSync(join(dir, "cert.pem"), "utf8")).toBe(fresh);
    } finally {
      account.close();
    }
  }, 15_000);
});

describe("the service's PATH", () => {
  /** A runnable file at `<home>/<rel>`. */
  function command(home: string, rel: string) {
    const file = join(home, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }

  it("adds the folder of a Codex under nvm that the shell's PATH misses, the newest Node first", () => {
    const home = mkdtempSync(join(tmpdir(), "bot-path-"));
    command(home, ".nvm/versions/node/v22.3.0/bin/codex");
    command(home, ".nvm/versions/node/v24.14.0/bin/codex");
    command(home, ".local/bin/claude");
    const env = { PATH: ["/usr/bin", join(home, ".local/bin")].join(":") };
    expect(bot.agentFolders(env, home, [])).toEqual([join(home, ".nvm/versions/node/v24.14.0/bin")]);
  });

  it("adds nothing when the commands are on the PATH already, or nowhere", () => {
    const home = mkdtempSync(join(tmpdir(), "bot-path-"));
    command(home, "tools/codex");
    expect(bot.agentFolders({ PATH: join(home, "tools") }, home, [])).toEqual([]);
    const empty = mkdtempSync(join(tmpdir(), "bot-path-"));
    expect(bot.agentFolders({ PATH: "/nowhere" }, empty, [])).toEqual([]);
  });
});

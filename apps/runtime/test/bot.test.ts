import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error: plain JavaScript beside the launcher, without types
import * as bot from "../../../bin/bot.mjs";

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

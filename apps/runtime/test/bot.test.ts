import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});

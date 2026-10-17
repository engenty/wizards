import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localTicketExpiry, mintLocalTicket } from "../src/auth/local-ticket.js";
import { loginItemText, unitText } from "../src/cli/autostart.js";
import { installCommand } from "../src/cli/clients.js";
import { inherited, runtimeEnv, runtimePath } from "../src/cli/environment.js";
import { layout, readEnvFile, wizardsHome } from "../src/cli/home.js";
import { CLIENTS, findChrome, nodeIsCurrent, suggestedClient } from "../src/cli/machine.js";
import { entryUrl, readSecret } from "../src/cli/start.js";
import { clearRunning, readRunning, writeRunning } from "../src/running.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wizards-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the home folder", () => {
  it("is ~/.engenty/wizards, and ENGENTY_HOME moves it", () => {
    expect(wizardsHome({})).toBe(join(homedir(), ".engenty", "wizards"));
    expect(wizardsHome({ ENGENTY_HOME: "/srv/engenty" })).toBe("/srv/engenty/wizards");
  });

  it("keeps data, runtime, tools and clients apart", () => {
    const paths = layout("/h");
    expect(paths.data).toBe("/h/data");
    expect(paths.runtime).toBe("/h/runtime");
    expect(paths.clients).toBe("/h/clients");
    expect(paths.envFile).toBe("/h/.env");
  });

  it("reads its .env the way the runtime does", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "API_PORT=8900\n# a comment\nAPP_URL='http://localhost:8900'\nlower=no\n");
    expect(readEnvFile(file)).toEqual({ API_PORT: "8900", APP_URL: "http://localhost:8900" });
    expect(readEnvFile(join(dir, "missing"))).toEqual({});
  });
});

describe("what the runtime inherits from the terminal", () => {
  const shell = {
    HOME: "/Users/x",
    PATH: "/usr/bin:/bin",
    API_HOST: "127.0.0.1",
    MODEL_STANDARD: "ollama:qwen3",
    // Exported for other projects: none of it is ours to use.
    OPENAI_API_KEY: "sk-other-project",
    DATABASE_URL: "libsql://other",
    MANAGE_URL: "https://manage.example",
    APP_SECRET: "other",
  };
  const start = { port: 8891, url: "http://localhost:8891", dataDir: "/h/data", accessKey: "k" };

  it("passes settings of this install and nothing else", () => {
    expect(inherited(shell)).toEqual({
      HOME: "/Users/x",
      API_HOST: "127.0.0.1",
      MODEL_STANDARD: "ollama:qwen3",
    });
    const env = runtimeEnv(layout("/h"), start, shell, {}, "linux");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.MANAGE_URL).toBeUndefined();
    expect(env).toMatchObject({
      NODE_ENV: "production",
      API_PORT: "8891",
      APP_URL: "http://localhost:8891",
      DATA_DIR: "/h/data",
      LOCAL_ACCESS_KEY: "k",
      PLUGINS_DIR: "/h/plugins",
    });
    expect(env.SECRETS).toBeUndefined();
  });

  it("looks for plugins in the install's folder unless the install names another", () => {
    const at = (shellEnv: NodeJS.ProcessEnv, fileEnv: Record<string, string>) =>
      runtimeEnv(layout("/h"), start, shellEnv, fileEnv, "linux").PLUGINS_DIR;
    expect(at({ ...shell, PLUGINS_DIR: "/else" }, {})).toBe("/else");
    // The runtime reads the install's `.env` itself.
    expect(at(shell, { PLUGINS_DIR: "/from-file" })).toBeUndefined();
  });

  it("keeps keys in the Keychain on a Mac unless the install says otherwise", () => {
    expect(runtimeEnv(layout("/h"), start, shell, {}, "darwin").SECRETS).toBe("keychain");
    expect(runtimeEnv(layout("/h"), start, shell, { SECRETS: "" }, "darwin").SECRETS).toBeUndefined();
    expect(runtimeEnv(layout("/h"), start, { ...shell, SECRETS: "file" }, {}, "darwin").SECRETS).toBe(
      "file",
    );
  });

  it("puts the installed clients and this Node first on the PATH", () => {
    expect(runtimePath(layout("/h"), shell, "/h/tools/node/bin/node")).toBe(
      "/h/clients/bin:/h/tools/node/bin:/usr/bin:/bin:/Users/x/.local/bin",
    );
  });
});

describe("the ticket of the local one-time link", () => {
  const now = 1_800_000_000_000;

  it("is good for a minute, for the secret that signed it", () => {
    const ticket = mintLocalTicket("secret", now);
    expect(localTicketExpiry("secret", ticket, now)).toBe(now + 60_000);
    expect(localTicketExpiry("secret", ticket, now + 59_000)).toBe(now + 60_000);
    expect(localTicketExpiry("secret", ticket, now + 60_000)).toBeNull();
    expect(localTicketExpiry("another", ticket, now)).toBeNull();
  });

  it("is refused when changed or made up", () => {
    const [expires, signature] = mintLocalTicket("secret", now).split(".");
    expect(localTicketExpiry("secret", `${Number(expires) + 1}.${signature}`, now)).toBeNull();
    // A later expiry than a ticket can have, even if somebody could sign it.
    expect(localTicketExpiry("secret", `${now + 3_600_000}.${signature}`, now)).toBeNull();
    expect(localTicketExpiry("secret", "", now)).toBeNull();
    expect(localTicketExpiry("secret", "nonsense", now)).toBeNull();
  });
});

describe("the secret the command signs with", () => {
  it("is APP_SECRET of the install's .env, else the data folder's; never the terminal's", () => {
    const paths = layout(dir);
    expect(readSecret(paths, {})).toBeNull();
    expect(entryUrl({ url: "http://localhost:8891" }, paths, {})).toBe("http://localhost:8891/");
    // The runtime the command starts never sees the terminal's APP_SECRET.
    expect(readSecret(paths, { APP_SECRET: "from-terminal" })).toBeNull();
    mkdirSync(paths.data, { recursive: true });
    writeFileSync(join(paths.data, "secret"), "from-file\n");
    expect(readSecret(paths, {})).toBe("from-file");
    expect(readSecret(paths, { APP_SECRET: "from-terminal" })).toBe("from-file");
    expect(entryUrl({ url: "http://localhost:8891" }, paths, {})).toMatch(/\/api\/local\/enter\?t=/);
    writeFileSync(paths.envFile, "APP_SECRET=from-env-file\n");
    expect(readSecret(paths, { APP_SECRET: "from-terminal" })).toBe("from-env-file");
    writeFileSync(join(dir, ".env.local"), "APP_SECRET=from-env-local\n");
    expect(readSecret(paths, {})).toBe("from-env-local");
  });
});

describe("the note of a running runtime", () => {
  const note = { port: 8891, url: "http://localhost:8891", startedAt: "2026-10-04T00:00:00.000Z" };

  it("names the runtime while its process exists", () => {
    writeRunning(dir, { ...note, pid: process.pid });
    expect(readRunning(dir)).toMatchObject({ pid: process.pid, port: 8891 });
    clearRunning(dir);
    expect(readRunning(dir)).toBeNull();
  });

  it("counts for nothing once the process is gone", () => {
    // No process has this id: above the largest a system hands out.
    writeRunning(dir, { ...note, pid: 2 ** 30 });
    expect(readRunning(dir)).toBeNull();
  });

  it("is left alone by a runtime that did not write it", () => {
    writeRunning(dir, { ...note, pid: process.pid });
    clearRunning(dir, process.pid + 1);
    expect(JSON.parse(readFileSync(join(dir, "running.json"), "utf8")).pid).toBe(process.pid);
  });
});

describe("the machine", () => {
  it("needs Node 24.11", () => {
    expect(nodeIsCurrent("24.11.0")).toBe(true);
    expect(nodeIsCurrent("26.1.0")).toBe(true);
    expect(nodeIsCurrent("24.10.9")).toBe(false);
    expect(nodeIsCurrent("22.20.0")).toBe(false);
  });

  it("finds the browser the runtime starts: CHROME_PATH, else one on the machine", () => {
    const home = mkdtempSync(join(tmpdir(), "wizards-chrome-"));
    const browser = join(home, "chromium");
    writeFileSync(browser, "#!/bin/sh\n", { mode: 0o755 });
    expect(findChrome({ CHROME_PATH: browser })).toBe(browser);
    expect(findChrome({ CHROME_PATH: join(home, "gone") })).toBeNull();
    if (process.platform !== "darwin") {
      expect(findChrome({ PATH: home })).toBe(browser);
    }
    rmSync(home, { recursive: true, force: true });
  });

});

describe("the AI clients", () => {
  const codex = CLIENTS.find((c) => c.id === "codex");
  const claude = CLIENTS.find((c) => c.id === "claude");

  it("installs one from npm into the install's own prefix, quoted when it has to be", () => {
    expect(codex && installCommand(codex, layout("/h"))).toBe(
      "npm install --global --prefix /h/clients @openai/codex",
    );
    expect(codex && installCommand(codex, layout("/Users/a b/w"))).toBe(
      "npm install --global --prefix '/Users/a b/w/clients' @openai/codex",
    );
    expect(claude && installCommand(claude, layout("/h"))).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
  });

  it("suggests the first when no vendor app says otherwise", () => {
    const missing = CLIENTS.filter((c) => c.id !== "codex").map((c) => ({
      client: { ...c, app: undefined },
    }));
    expect(suggestedClient(missing)?.client.id).toBe("claude");
    expect(suggestedClient([])).toBeNull();
  });
});

describe("starting at login on Linux", () => {
  it("is a user service that runs the install's command without opening a browser", () => {
    const unit = unitText("/home/a/.engenty/wizards/bin/wizards");
    expect(unit).toContain('ExecStart="/home/a/.engenty/wizards/bin/wizards" start --no-open');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("starting at login on a Mac", () => {
  it("is a LaunchAgent that runs the install's command without opening a browser", () => {
    const plist = loginItemText("/Users/a&b/.engenty/wizards/bin/wizards", "/tmp/a.log");
    expect(plist).toContain("<string>com.engenty.wizards.login</string>");
    expect(plist).toContain(
      "<string>/Users/a&amp;b/.engenty/wizards/bin/wizards</string>\n    <string>start</string>\n    <string>--no-open</string>",
    );
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<string>/tmp/a.log</string>");
  });
});

import "./install-env.js";
import { accountCommand } from "./account.js";
import { apps, connectCommand } from "./connect.js";
import { featuresCommand } from "./features.js";
import { command, layout, packageVersion, readInstallNote } from "./home.js";
import { startedIn } from "./install-env.js";
import { CLIENTS, nodeIsCurrent } from "./machine.js";
import { mcp } from "./mcp.js";
import { menu } from "./menu.js";
import { logsCommand, reportCommand } from "./report.js";
import { sandboxCommand } from "./sandbox.js";
import { setup } from "./setup.js";
import { open, start, studio } from "./start.js";
import { autostart, restart, status, stop } from "./status.js";
import { cmd, cyan, tilde } from "./ui.js";
import { autoUpdateCommand, update } from "./update.js";
import { validateCommand } from "./validate.js";

/** One line of the help: the name padded, then coloured, so the columns stay straight. */
const line = (name: string, what: string) => `  ${cyan(name.padEnd(command().length + 12))}${what}`;
const more = (what: string) => `  ${" ".repeat(command().length + 12)}${what}`;

const HELP = `engenty wizards ${packageVersion()}
engenty wizards runs the studio and your wizards on this computer. Below, “it” means engenty wizards.

Usage
  ${command()} [command] [options]

Commands
${line(command(), "show the status and a menu (start, stop, update…); runs the setup the first time")}
${more("(needs a terminal)")}
${line(`${command()} start`, "start it in this terminal and open the studio (Ctrl-C stops it)")}
${line(`${command()} studio`, "open the studio, starting it in the background if needed")}
${line(`${command()} setup`, "set up your engenty account, an AI client, ffmpeg and start at login")}
${line(`${command()} account`, "show your engenty account; add sign-in or sign-out to change it")}
${line(`${command()} open`, "sign this browser in to the running studio (--print: only print the link)")}
${line(`${command()} status`, "show what’s installed and running")}
${line(`${command()} doctor`, "show the status and check for problems")}
${line(`${command()} logs`, `print the last log lines (${command()} logs 500 for more)`)}
${line(`${command()} report`, "send the status, model settings and last log lines to your account for support")}
${line(`${command()} stop`, "stop it (your data is kept)")}
${line(`${command()} restart`, "restart it, e.g. to switch to a newly installed version")}
${line(`${command()} update`, "install the latest version")}
${line(`${command()} autoupdate`, "updates by themselves: add on or off (WIZARDS_DISABLE_AUTOUPDATE=1 is off too)")}
${more("(downloaded in the background, used from the next start; never during a run)")}
${line(`${command()} sandbox`, "the sandbox where AI steps run code, without Docker: add or remove")}
${more("(agentOS unless you name another engine, about 340 MB; used from the next start)")}
${line(`${command()} autostart`, "start it when you log in to this computer: add on or off")}
${more("(macOS: a LaunchAgent; Linux: a systemd user service)")}
${line(`${command()} connect`, "add your wizards to your AI apps: every app found, or the ones you name:")}
${more(
  apps(layout())
    .map((app) => app.id)
    .join(", "),
)}
${line(`${command()} disconnect`, "remove your wizards from those apps (same names)")}
${line(`${command()} mcp`, "run the MCP server over stdio (AI apps start this)")}
${line(`${command()} uninstall`, "take it off this computer: shows the plan, asks about your data (kept by default)")}
${more("--dry-run only shows it; --yes asks nothing and keeps your data; --yes --delete-data")}
${line(`${command()} validate`, "check wizards without the studio: .wizard files, unpacked packages, wizard JSON")}
${more("--json prints the issues as JSON. A space’s connectors and plugins are checked on import.")}

Options
  --yes, -y           don’t ask; skip everything optional
  --local             set up without an account; nothing leaves this computer
  --client <name>     install this AI client without asking: ${CLIENTS.map((c) => c.id).join(", ")}
  --no-open           start without opening the browser
  --background, -s    start in the background, detached from this terminal (${command()} stop stops it)
  --version, -v       print the version
  --help, -h          print this help

Everything lives in ${tilde(layout().home)} (ENGENTY_HOME moves it). Settings go in its .env file.
`;

/** After a mistake on the command line: one line, not the whole help. */
const SEE_HELP = `Run ${cmd("help")} to see every command.`;

interface Args {
  command: string;
  /** What follows the command: \`autostart on\`, \`account sign-in\`. */
  value: string;
  /** What follows \`sandbox add\` and \`sandbox remove\`: the engine. */
  engine: string;
  /** What follows \`connect\`, \`disconnect\` and \`features\`. */
  apps: string[];
  /** The paths \`validate\` checks. */
  paths: string[];
  json: boolean;
  yes: boolean;
  local: boolean;
  open: boolean;
  service: boolean;
  print: boolean;
  clients: string[];
}

function parse(argv: string[]): Args | string {
  const args: Args = {
    command: "",
    value: "",
    engine: "",
    apps: [],
    paths: [],
    json: false,
    yes: false,
    local: false,
    open: true,
    service: false,
    print: false,
    clients: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") {
      args.yes = true;
    } else if (arg === "--local") {
      args.local = true;
    } else if (arg === "--no-open") {
      args.open = false;
    } else if (arg === "--background" || arg === "--service" || arg === "-s") {
      args.service = true;
    } else if (arg === "--print") {
      args.print = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--client") {
      const id = argv[++i];
      if (!CLIENTS.some((client) => client.id === id)) {
        return `--client takes one of these: ${CLIENTS.map((c) => c.id).join(", ")}.`;
      }
      args.clients.push(id);
    } else if (arg === "--help" || arg === "-h") {
      args.command = "help";
    } else if (arg === "--version" || arg === "-v") {
      args.command = "version";
    } else if (arg.startsWith("-")) {
      return `Unknown option ${arg}.`;
    } else if (
      ["autostart", "autoupdate", "logs", "account", "sandbox"].includes(args.command) &&
      !args.value
    ) {
      args.value = arg;
    } else if (args.command === "sandbox" && !args.engine) {
      args.engine = arg;
    } else if (["connect", "disconnect", "features"].includes(args.command)) {
      args.apps.push(arg);
    } else if (args.command === "validate") {
      args.paths.push(arg);
    } else if (args.command) {
      return `Unexpected argument “${arg}”.`;
    } else {
      args.command = arg;
    }
  }
  return args;
}

async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  if (typeof args === "string") {
    console.error(`${args} ${SEE_HELP}`);
    return 2;
  }
  const paths = layout();
  const setupOptions = { yes: args.yes, clients: args.clients, local: args.local };
  if (!args.command) {
    // Without a command: the menu, which needs a terminal. Starting is \`start\`.
    if (args.service || !args.open || args.print) {
      console.error(`Those options belong to start: ${cmd(`start ${argv.join(" ")}`)}`);
      return 2;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(
        `The menu needs a terminal. To start engenty wizards: ${cmd("start")}\n\n${HELP}`,
      );
      return 2;
    }
    return menu(paths, setupOptions, HELP);
  }
  switch (args.command) {
    case "help":
      console.log(HELP);
      return 0;
    case "version":
      console.log(packageVersion());
      return 0;
    case "start": {
      // The first start on a terminal begins with the setup.
      const first = !readInstallNote(paths).setupAt;
      if (first && !args.yes && process.stdin.isTTY && process.stdout.isTTY) {
        // You asked to start it: once the setup is done, it starts.
        if (!(await setup(paths, { ...setupOptions, next: "start" }))) {
          return 130;
        }
      }
      return start(paths, { open: args.open, background: args.service });
    }
    case "setup":
      return (await setup(paths, setupOptions)) ? 0 : 130;
    case "studio":
      return studio(paths);
    case "open":
      return open(paths, args.print);
    case "status":
      return status(paths, false);
    case "doctor":
      return status(paths, true);
    case "logs":
      return logsCommand(paths, args.value);
    case "report":
      return reportCommand(paths);
    case "stop":
      return stop(paths);
    case "restart":
      return restart(paths);
    case "update":
      return update(paths);
    case "autostart":
      return autostart(paths, args.value);
    case "autoupdate":
      return autoUpdateCommand(paths, args.value);
    case "account":
      return accountCommand(paths, args.value, { yes: args.yes });
    case "sandbox":
      return sandboxCommand(paths, args.value, args.engine);
    case "connect":
    case "disconnect":
      return connectCommand(paths, args.apps, args.command === "disconnect");
    case "mcp":
      return mcp(paths);
    case "features":
      return featuresCommand(args.apps);
    case "validate":
      // The paths are the person's, from where they typed the command (install-env.ts).
      process.chdir(startedIn);
      return validateCommand(args.paths, args.json);
    default:
      console.error(`Unknown command “${args.command}”. ${SEE_HELP}`);
      return 2;
  }
}

if (!nodeIsCurrent()) {
  console.error(`engenty wizards needs Node.js 24.11 or newer. This is ${process.version}.`);
  process.exit(1);
}
process.exitCode = await main(process.argv.slice(2));

import { homedir } from "node:os";
import { emitKeypressEvents } from "node:readline";
import { styleText } from "node:util";
import * as p from "@clack/prompts";
import { command } from "./home.js";

const colours = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/** The name on engenty's orange. */
export const badge = (text: string) =>
  colours ? `\x1b[48;2;224;83;27m\x1b[97m\x1b[1m ${text} \x1b[0m` : text;

export const dim = (text: string) => styleText("dim", text);
export const bold = (text: string) => styleText("bold", text);
export const cyan = (text: string) => styleText("cyan", text);
export const ok = styleText("green", "✓");
export const no = styleText("yellow", "–");
export const bad = styleText("red", "✗");
export const live = styleText("green", "●");

/** A path as the person would write it. */
export const tilde = (path: string) =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;

/** A command as the person types it, with this install's prefix: `cmd("stop")` → wizards stop. */
export const cmd = (args = "") => cyan(args ? `${command()} ${args}` : command());

/**
 * A spinner on a terminal; where nobody watches, only what came of it. The message ends in "…"
 * ("Checking status…"); clack animates its own dots in its place.
 */
export function busy(message: string) {
  if (!process.stdout.isTTY) {
    return { stop: (text: string) => p.log.step(text), fail: (text: string) => p.log.warn(text) };
  }
  exitOnCtrlC();
  const spinner = p.spinner();
  spinner.start(message.replace(/…$/, ""));
  return {
    stop: (text: string) => spinner.stop(text),
    fail: (text: string) => spinner.error(text),
  };
}

let watching = false;

/**
 * Ctrl-C under a spinner: clack ends the process itself, with code 0, as if all went well. The
 * key is noted before clack sees it (this listener comes first), and the process ends with 130
 * instead, as a command stopped by Ctrl-C does: `wizards setup && …` goes no further.
 */
function exitOnCtrlC() {
  if (watching || !process.stdin.isTTY) {
    return;
  }
  watching = true;
  let pressed = false;
  emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", (_text: string, key?: { ctrl?: boolean; name?: string }) => {
    if (key?.ctrl && key.name === "c") {
      pressed = true;
    }
  });
  process.on("exit", () => {
    if (pressed) {
      process.exitCode = 130;
    }
  });
}

import * as p from "@clack/prompts";
import {
  accountOverview,
  type KnownTeam,
  knownTeam,
  type LinkedAccount,
  linkedAccount,
  unlink,
} from "../auth/account.js";
import { DeviceSignInError, requestDeviceCode, waitForDeviceSignIn } from "../auth/device.js";
import { migrateControlDb } from "../db/client.js";
import { env } from "../env.js";
import { featuresFile, fileFeatures, writeFeature } from "../features.js";
import { type Layout, readInstallNote, writeInstallNote } from "./home.js";
import type { SetupOptions } from "./setup.js";
import { openBrowser, runningRuntime, settings } from "./start.js";
import { bold, busy, cmd, cyan, dim, tilde } from "./ui.js";

/**
 * The account of this install, from the terminal. `wizards account` says where it stands,
 * `sign-in` runs the device flow (auth/device.ts), `sign-out` ends the link the way the
 * studio does. The setup's first step is the same sign-in. `--local` keeps an install off the
 * account altogether: `account=off` in the install's `.features` hides every account surface
 * (packages/shared/src/feature-flags.ts), and a note in install.json says so.
 *
 * Everything here reads and writes the install's settings and vault through the runtime's own
 * modules, with or without a runtime running (install-env.ts puts this process where the
 * runtime is). A runtime that runs reads the account from the settings as it goes; what it
 * holds from its start is brought in line by a restart, which is offered.
 */

export const INTRO =
  "Your team, its space and your wizards live in the account. This computer joins the space.";

export type AccountState =
  | { kind: "local" }
  | { kind: "none" }
  | { kind: "linked"; account: LinkedAccount; team: KnownTeam | null };

let prepared: Promise<void> | null = null;

/** The control database as the runtime keeps it: a fresh install has none until something opens it. */
function ready(): Promise<void> {
  prepared ??= migrateControlDb();
  return prepared;
}

/** Set up with `--local`: the install's `.features` says `account=off`. */
export function isLocalOnly(file = featuresFile()): boolean {
  return fileFeatures(file).account === false;
}

/** `--local`: the switch into the file, the note into install.json. */
export function localOnly(paths: Layout, file = featuresFile()): void {
  writeFeature("account", false, file);
  writeInstallNote({ ...readInstallNote(paths), local: true }, paths);
}

/** A sign-in ends local-only: the switch follows the default again, the note goes. */
export function joinedAccount(paths: Layout, file = featuresFile()): void {
  if (isLocalOnly(file)) {
    writeFeature("account", null, file);
  }
  const note = readInstallNote(paths);
  if (note.local) {
    const { local: _, ...rest } = note;
    writeInstallNote(rest, paths);
  }
}

/** Where the account stands, from this machine alone: no round trip. */
export async function accountState(): Promise<AccountState> {
  if (isLocalOnly()) {
    return { kind: "local" };
  }
  await ready();
  const account = await linkedAccount();
  if (!account) {
    return { kind: "none" };
  }
  return { kind: "linked", account, team: await knownTeam() };
}

/** "Matthias · team Platzer Fenster & Türen · 120 credits", as far as it is known. */
export function described(
  account: LinkedAccount,
  team: { name: string; balanceCredits: number } | null,
  credits = true,
): string {
  const parts = [account.name || account.email];
  if (team) {
    // "Team Anna" and "New team" say it themselves: not "team Team Anna".
    parts.push(/\bteam\b/i.test(team.name) ? team.name : `team ${team.name}`);
    if (credits) {
      parts.push(`${team.balanceCredits} credits`);
    }
  }
  return parts.join(" · ");
}

/** One line for the menu and `wizards status`, after the symbol. */
export function describeAccount(state: AccountState): string {
  switch (state.kind) {
    case "local":
      return "only on this computer, no account";
    case "none":
      return "not signed in";
    default:
      return described(state.account, state.team, false);
  }
}

/** The account's site, as people know it: engenty.ai for account.engenty.ai. */
const host = () => new URL(env.local.accountUrl).host.replace(/^account\./, "");

/** `wizards account`: where it stands, with the Manage-App's word when it answers. */
async function status(): Promise<number> {
  const state = await accountState();
  if (state.kind === "local") {
    console.log(
      `Only on this computer, no account. ${dim(`To connect one: ${cmd("account sign-in")}`)}`,
    );
    return 0;
  }
  if (state.kind === "none") {
    console.log(`Not signed in. ${dim(`To sign in: ${cmd("account sign-in")}`)}`);
    return 0;
  }
  const overview = await accountOverview();
  const team = overview?.tenant ?? state.team;
  console.log(
    `Signed in as ${described(state.account, team)} · ${host()}${
      overview
        ? ""
        : dim(`  (${host()} didn’t respond${team ? ", so this is from last time" : ""})`)
    }`,
  );
  return 0;
}

/** A code as people read it off a screen: ABCD-EFGH. */
export function groupedCode(code: string): string {
  const plain = code.replace(/[\s-]+/g, "").toUpperCase();
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : code;
}

/** Whether a new account needs an invitation code, as the account's own pages say. */
async function signupByCode(): Promise<boolean> {
  try {
    const res = await fetch(`${env.local.accountUrl}/api/config`, {
      signal: AbortSignal.timeout(3000),
    });
    return ((await res.json()) as { signup?: string }).signup === "code";
  } catch {
    return false;
  }
}

/**
 * Enter and Esc on a terminal while it waits for the browser (Ctrl-C stays the spinner's: it
 * ends the command). Returns what gives the keys back.
 */
function onKeys(keys: { enter: () => void; escape: () => void }) {
  const input = process.stdin;
  if (!input.isTTY) {
    return () => undefined;
  }
  const raw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  const read = (data: Buffer) => {
    const key = data.toString();
    if (key === "\r" || key === "\n") {
      keys.enter();
    } else if (key === "\x1b") {
      keys.escape();
    }
  };
  input.on("data", read);
  return () => {
    input.off("data", read);
    input.setRawMode(raw);
    input.pause();
  };
}

/**
 * The device flow on the terminal: the link and the code, the browser opened where there is
 * one, then a wait while the person signs in, or creates their account, and allows it. On a
 * terminal, Enter opens the page again and Esc goes on without an account: someone without an
 * invitation code yet is not stuck in the wait. Null when it ended without an account.
 */
async function deviceSignIn(interactive: boolean): Promise<LinkedAccount | null> {
  let code: Awaited<ReturnType<typeof requestDeviceCode>>;
  try {
    code = await requestDeviceCode();
  } catch (err) {
    p.log.error((err as Error).message);
    return null;
  }
  const shown = groupedCode(code.userCode);
  // The complete link carries the code: the page only asks to check it.
  const link = code.verificationUriComplete ?? code.verificationUri;
  p.log.message(
    code.verificationUriComplete
      ? `Open ${cyan(link)}\nThe page shows the code ${bold(shown)}: check that it matches.`
      : `Open ${cyan(link)} and enter the code ${bold(shown)}.`,
  );
  const opened = openBrowser(link);
  const newHere = (await signupByCode())
    ? "New here? Create your account on that page with your invitation code, or join the waitlist there."
    : "New here? Your account is created on that page.";
  const keys = interactive ? "Enter opens the page again · Esc signs in later" : "";
  p.log.message(
    dim(
      [opened ? "The page opens in your browser." : "", newHere, keys].filter(Boolean).join("\n"),
    ),
  );
  const spinner = busy("Waiting for you in the browser…");
  const later = new AbortController();
  const release = interactive
    ? onKeys({ enter: () => void openBrowser(link), escape: () => later.abort() })
    : () => undefined;
  try {
    const account = await waitForDeviceSignIn(code, { signal: later.signal });
    const overview = await accountOverview();
    spinner.stop(`Signed in as ${described(account, overview?.tenant ?? null)}.`);
    return account;
  } catch (err) {
    if (err instanceof DeviceSignInError && err.reason === "skipped") {
      spinner.stop("Not signed in yet.");
      return null;
    }
    spinner.fail(
      err instanceof DeviceSignInError
        ? err.message
        : `The sign-in didn’t work. ${(err as Error).message}`,
    );
    return null;
  } finally {
    release();
  }
}

/**
 * A runtime that runs reads the account from the settings as it goes, but holds a few things
 * from its start: the Pro modules it loaded, which source the models run on, what was sent to
 * the cloud. A restart brings it in line; the person is asked, or told how.
 */
async function pickUp(paths: Layout, interactive: boolean, why: string): Promise<void> {
  if (!(await runningRuntime(settings(paths).dataDir))) {
    return;
  }
  if (!interactive) {
    p.log.info(`Run ${cmd("restart")} so ${why}.`);
    return;
  }
  const answer = await p.confirm({
    message: `Restart engenty wizards now, so ${why}?`,
    initialValue: true,
  });
  if (p.isCancel(answer) || !answer) {
    p.log.info(dim(`To do it later: ${cmd("restart")}`));
    return;
  }
  // status.ts shows the account; loaded here when needed, so neither module waits on the other.
  const { restart } = await import("./status.js");
  await restart(paths);
}

const SIGNED_IN = "your plan’s Pro modules load and your published wizards arrive in the cloud";

async function signIn(paths: Layout, interactive: boolean): Promise<number> {
  await ready();
  const linked = await linkedAccount();
  if (linked && isLocalOnly()) {
    // Set up with --local by an older version, which kept the link: it only needs switching on.
    joinedAccount(paths);
    p.log.success(`Signed in as ${described(linked, await knownTeam(), false)} again.`);
    await pickUp(paths, interactive, SIGNED_IN);
    return 0;
  }
  if (linked) {
    p.log.info(
      `Already signed in as ${described(linked, await knownTeam(), false)}. ${dim(
        `To switch accounts, run ${cmd("account sign-out")} first.`,
      )}`,
    );
    return 0;
  }
  const account = await deviceSignIn(interactive);
  if (!account) {
    p.log.info(dim(`To sign in later: ${cmd("account sign-in")}`));
    return 1;
  }
  joinedAccount(paths);
  p.log.message(dim("What you publish here runs in the cloud too."));
  await pickUp(paths, interactive, SIGNED_IN);
  return 0;
}

/**
 * Ends the link to the account: the same as the studio's sign-out (DELETE /api/studio/account).
 */
async function disconnect(): Promise<void> {
  await unlink();
  // The same as the studio's sign-out (DELETE /api/studio/account): what was sent to the cloud
  // is forgotten, the entitlement goes with the account's plan, and models that ran on its
  // credits run on own keys again. This process never loaded Pro modules or models, so only the
  // settings change here; a runtime that runs lets go of its modules on restart.
  const [{ forgetCloud }, { refreshPro }, models] = await Promise.all([
    import("../services/cloud.js"),
    import("../plugins/pro.js"),
    import("../models.js"),
  ]);
  await forgetCloud();
  await refreshPro();
  await models.loadLocalModels();
  if (models.localModelSettings().source === "account") {
    await models.saveLocalModels({ source: "own" });
  }
}

async function signOut(paths: Layout, interactive: boolean): Promise<number> {
  await ready();
  // A link kept from an older --local counts as well: it is still on this computer.
  const linked = await linkedAccount();
  if (!linked) {
    console.log(
      isLocalOnly()
        ? "No account is connected, so there’s nothing to sign out of."
        : "Not signed in.",
    );
    return 0;
  }
  const spinner = busy(`Signing out ${linked.name || linked.email}…`);
  await disconnect();
  spinner.stop("Signed out. Your wizards and results stay on this computer.");
  await pickUp(paths, interactive, "it disconnects from the account");
  return 0;
}

/** `wizards account [sign-in|sign-out]`. */
export async function accountCommand(
  paths: Layout,
  value: string,
  options: { yes: boolean },
): Promise<number> {
  const interactive = !options.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  switch (value) {
    case "":
      return status();
    case "sign-in":
    case "signin":
    case "login":
      return signIn(paths, interactive);
    case "sign-out":
    case "signout":
    case "logout":
      return signOut(paths, interactive);
    default:
      console.error(`Usage: ${cmd("account [sign-in|sign-out]")}`);
      return 2;
  }
}

/** The menu's "Account": where it stands, and the way in or out. */
export async function accountMenu(paths: Layout): Promise<void> {
  await status();
  const state = await accountState();
  const action = await p.select<"sign-in" | "sign-out" | "back">({
    message: "Account",
    options: [
      state.kind === "linked"
        ? { value: "sign-out", label: "Sign out", hint: "your wizards and results stay here" }
        : { value: "sign-in", label: "Sign in", hint: "with a code, in your browser" },
      { value: "back", label: "Back" },
    ],
  });
  if (p.isCancel(action) || action === "back") {
    return;
  }
  if (action === "sign-in") {
    await signIn(paths, true);
  } else {
    await signOut(paths, true);
  }
}

/**
 * The setup's first step. `--local` keeps the install off the account; else the person is
 * asked to sign in, unless the setup runs without a terminal (`--yes`), which says how to do
 * it later.
 */
export async function accountStep(
  paths: Layout,
  options: SetupOptions,
  interactive: boolean,
): Promise<"cancelled" | undefined> {
  if (options.local) {
    await ready();
    const linked = await linkedAccount();
    if (linked) {
      // "Nothing leaves this computer" holds only without the link.
      const spinner = busy(`Signing out ${linked.name || linked.email}…`);
      await disconnect();
      spinner.stop(`Signed out ${linked.name || linked.email}.`);
    }
    localOnly(paths);
    p.log.warn(
      `No account: nothing leaves this computer. Your wizards, your space and results stay in ${tilde(settings(paths).dataDir)}. Links work only on this computer.`,
    );
    p.log.message(dim(`To connect an account any time: ${cmd("account sign-in")}`));
    return;
  }
  const state = await accountState();
  if (state.kind === "local") {
    p.log.info(
      `Only on this computer, no account. ${dim(`To connect one: ${cmd("account sign-in")}`)}`,
    );
    return;
  }
  if (state.kind === "linked") {
    const overview = await accountOverview();
    p.log.success(`Signed in as ${described(state.account, overview?.tenant ?? state.team)}.`);
    return;
  }
  p.note(INTRO, "Your engenty account");
  if (!interactive) {
    p.log.info(dim(`To sign in later: ${cmd("account sign-in")}`));
    return;
  }
  const answer = await p.confirm({
    message: "Sign in or create your account now?",
    initialValue: true,
  });
  if (p.isCancel(answer)) {
    p.cancel(`Setup stopped. To run it again: ${cmd("setup")}`);
    return "cancelled";
  }
  if (!answer) {
    p.log.info(dim(`To sign in later: ${cmd("account sign-in")}`));
    return;
  }
  const account = await deviceSignIn(interactive);
  if (!account) {
    p.log.info(dim(`To sign in later: ${cmd("account sign-in")}`));
    return;
  }
  joinedAccount(paths);
  p.log.message(dim("What you publish here runs in the cloud too."));
  await pickUp(paths, interactive, SIGNED_IN);
}

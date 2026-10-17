/**
 * The mobile app (the apps repo engenty-wizards-apps, mobile/) shows the runner in a WebView on `/w/<token>?app=1` and puts
 * `window.engentyApp` into the page before it loads, as the desktop app puts
 * `window.engentyDesktop` into the studio. The runner asks it before it uses a browser API and
 * falls back to the web's way for everything the bridge does not name: an older app shows a newer
 * runner, and a runner that knows no bridge still runs in the app.
 *
 * The bridge only offers what the person sees and confirms each time (the scanner, the share
 * sheet, a saved file, the sign-in sheet).
 */

/** What an app may offer; each is a method of `call`. */
export type AppAbility =
  /** `scan()` → the text of a QR code or barcode, null when the person closed the scanner. */
  | "scan"
  /** `share({ url, filename?, mime? })` a file, or `share({ link, title? })` an address. */
  | "share"
  /** `download({ url, filename, mime? })`: into the app's results, from there to Files and other apps. */
  | "download"
  /** `keepAwake(on)`: the screen stays on. */
  | "keepAwake"
  /** `notify({ title, body, tag })`: a local notification, or a buzz while the app is open. */
  | "notify"
  /** `notifyPermission()` → whether the person allows notifications. */
  | "notifyPermission"
  /** `signIn({ url })`: the system's sign-in sheet for connecting an account. */
  | "signIn"
  /** `run({ token, runId })`: a run was started or opened; the app keeps it in its results. */
  | "run"
  /** `transcribe({ audio, mime, lang })` → `{ text }`: a recording written down on the phone; null when it cannot. */
  | "transcribe"
  /** `think({ system, prompt, schema })` → `{ text }`: the phone's own model answers a short call (runner/device.ts). */
  | "think";

export interface EngentyApp {
  /** The bridge's own version, raised when a method changes its meaning. */
  version: number;
  can: AppAbility[];
  call(method: AppAbility, args?: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    engentyApp?: EngentyApp;
  }
}

function read(): EngentyApp | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = window.engentyApp;
  return bridge && typeof bridge.call === "function" && Array.isArray(bridge.can) ? bridge : null;
}

const bridge = read();

/**
 * The page runs inside the app. `?app=1` is read once: the address loses it with the first step,
 * the WebView stays the same. A runner without a bridge in the app still drops its web chrome.
 */
export const IN_APP =
  bridge !== null ||
  (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("app") === "1");

// In the app the runner reads like the app around it: the system's font (styles/app.css).
if (IN_APP && typeof document !== "undefined") {
  document.documentElement.classList.add("in-app");
}

/** Whether the app around this page offers `ability`. */
export const appCan = (ability: AppAbility): boolean => bridge?.can.includes(ability) === true;

/** Asks the app; resolves with its answer, rejects when the app failed or has no such ability. */
export function appCall<T = unknown>(ability: AppAbility, args?: unknown): Promise<T> {
  if (!(bridge && appCan(ability))) {
    return Promise.reject(new Error(`the app cannot ${ability}`));
  }
  return bridge.call(ability, args) as Promise<T>;
}

/** Tells the app without waiting for an answer; nothing happens outside the app. */
export function appTell(ability: AppAbility, args?: unknown) {
  if (appCan(ability)) {
    void appCall(ability, args).catch(() => undefined);
  }
}

/**
 * A download link's click inside the app: the app fetches the file into its results. Returns
 * whether the app took it; the link's own way runs otherwise.
 */
export function appDownload(
  event: { preventDefault(): void },
  href: string,
  filename?: string,
): boolean {
  if (!appCan("download")) {
    return false;
  }
  event.preventDefault();
  void appCall("download", { url: new URL(href, window.location.href).href, filename }).catch(
    () => undefined,
  );
  return true;
}

/** The app's own scheme: a phone's browser offers to open the wizard there. */
export const appLink = (url: string) => `engenty-wizards://w?url=${encodeURIComponent(url)}`;

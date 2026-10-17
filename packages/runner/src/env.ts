import type { ComponentType } from "react";
import { type Api, createApi } from "./api.js";
import { type Lang, setRunnerLang } from "./i18n.js";

/**
 * What the runner needs of the page around it, given once by the host before anything renders:
 * the studio (apps/web) with its base path, its mobile-app bridge and its engenty; the WordPress
 * plugin with its REST routes and its own engenty. The runner itself knows no server.
 */

/** What a mobile app around the page may offer (apps/web/src/lib/app.ts names them). */
export type AppAbility =
  | "scan"
  | "share"
  | "download"
  | "keepAwake"
  | "notify"
  | "notifyPermission"
  | "signIn"
  | "run"
  | "transcribe"
  | "think";

export interface AppBridge {
  can(ability: AppAbility): boolean;
  call<T = unknown>(ability: AppAbility, args?: unknown): Promise<T>;
  tell(ability: AppAbility, args?: unknown): void;
  /** A download link's click: the app fetches the file itself. Returns whether it took it. */
  download(event: { preventDefault(): void }, href: string, filename?: string): boolean;
}

export interface MascotProps {
  kind: string;
  size?: number;
  fluffy?: boolean;
}

export interface ShareResultProps {
  runId: string;
  title: string;
  initial: { url: string; expiresAt: string | null } | null;
}

export interface RunnerEnv {
  lang: Lang;
  /** The run's API: `/api/runs/<id>` on a runtime, `/wp-json/engenty/v1/local/runs/<id>` in WordPress. */
  runBase(runId: string): string;
  /** A root-relative address as the browser must request it (a base path, a remote runtime). */
  withBase(path: string): string;
  /** A file of the host's public folder (`ai-labels/…`, `icons/…`). */
  asset(path: string): string;
  /** Where the service worker for notifications lives; none where the host has none. */
  serviceWorker?: string;
  /** The mobile app's bridge; a page in a browser has none. */
  app?: AppBridge;
  /** The wizard's engenty. */
  Mascot: ComponentType<MascotProps>;
  /** The result's share button; a host without shared results has none. */
  ShareResultButton?: ComponentType<ShareResultProps>;
  /** Told of every answer of 500 and above, e.g. to send it to the host's log. */
  onServerError?: (line: string) => void;
  /** Extra headers on every request (a WordPress nonce). */
  headers?: Record<string, string>;
  /**
   * A host that runs wizards on its own (the WordPress plugin): its server writes no PDF, so the
   * runner writes one from a written output in the browser (pdf.ts); an HTML download of a
   * written output is a page to print.
   */
  standalone?: boolean;
}

const none: AppBridge = {
  can: () => false,
  call: (ability) => Promise.reject(new Error(`the app cannot ${ability}`)),
  tell: () => undefined,
  download: () => false,
};

let env: RunnerEnv | null = null;

/** The host names its environment once, before the first render. */
export function configureRunner(next: RunnerEnv) {
  env = next;
  api = createApi(next.withBase, next.headers, next.onServerError);
  setRunnerLang(next.lang);
}

export function runnerEnv(): RunnerEnv {
  if (!env) {
    throw new Error("configureRunner() first");
  }
  return env;
}

export let api: Api = createApi((path) => path);

export const withBase = (path: string) => runnerEnv().withBase(path);
export const asset = (path: string) => runnerEnv().asset(path);
export const runBase = (runId: string) => runnerEnv().runBase(runId);

export const appCan = (ability: AppAbility) => (env?.app ?? none).can(ability);
export const appCall = <T = unknown>(ability: AppAbility, args?: unknown) =>
  (env?.app ?? none).call<T>(ability, args);
export const appTell = (ability: AppAbility, args?: unknown) =>
  (env?.app ?? none).tell(ability, args);
export const appDownload = (event: { preventDefault(): void }, href: string, filename?: string) =>
  (env?.app ?? none).download(event, href, filename);
export const standalone = () => env?.standalone === true;

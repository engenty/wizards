import {
  type ModelClass,
  TEXT_CLASSES,
  type WizardDefinition,
} from "@engenty-wizards/shared/definition";
import type {
  AssetSection,
  BrandColor,
  BrandFont,
  BrandGradient,
  BrandPattern,
  BrandRule,
  ColorSection,
  LogoSection,
  ProjectFact,
  TextStyle,
} from "@engenty-wizards/shared/projects";
import type { WorkspaceFile } from "@engenty-wizards/shared/workspace";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { ApiError, api } from "./api";
import { STUDIO, withBase } from "./base";
import { type Lang, setLang, storedLang } from "./i18n";

/** An AI client installed on this machine that can think for the app, on its own subscription. */
export type HarnessId = "claude" | "codex" | "antigravity" | "cursor";

export interface HarnessStatus {
  id: HarnessId;
  name: string;
  /** How to install it in a terminal; the setup's Install button runs the same command. */
  install: string;
  /** The vendor's desktop app on this machine ("Claude"): the subscription is most likely there. */
  app: string | null;
  /** Null: not installed. */
  version: string | null;
  auth: "subscription" | "api_key" | "none";
  /** The sign-in opens the client's own app, which closes by itself once signed in. */
  interactiveLogin: boolean;
  /** It makes images on the sign-in as well (Codex); video and audio no client makes. */
  images: boolean;
}

export interface LocalModels {
  /** A client's id = that installed client; `account` = the linked account; `own` = own keys or a local model. */
  source: HarnessId | "account" | "own";
  bindings: Record<ModelClass, string>;
  ollamaUrl: string;
  /** Which providers have a key stored, by provider id. */
  keys: Partial<Record<string, boolean>>;
}

/** Apple Intelligence as the runtime sees it: supported by the machine, answering, or why not. */
export interface AppleStatus {
  supported: boolean;
  available: boolean;
  reason: "device" | "os" | "missing" | "off" | "loading" | null;
}

/**
 * Apple Intelligence thinks the text classes bound to it (`apple:default`) beside any source, so
 * picking another way for text unbinds them; voice notes (`apple:transcribe`) stay.
 */
export function withoutApple(
  bindings: Partial<Record<ModelClass, string>>,
): Partial<Record<ModelClass, string>> {
  return Object.fromEntries(
    TEXT_CLASSES.filter((c) => bindings[c]?.startsWith("apple:")).map((c) => [c, ""]),
  );
}

/** What the person says about themselves; the avatar shows the name's initials. */
export interface UserProfile {
  name: string;
  about: string;
  email: string;
  phone: string;
}

/** The first letters of a name's words, at most two: what an avatar without a picture shows. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export interface Me {
  user: { id: string; name: string; email: string; image?: string | null };
  profile: UserProfile;
  /** The language the person picked, kept with them; null until they pick one. */
  lang: Lang | null;
  tenant: {
    id: string;
    role: "owner" | "admin" | "member";
    /** The plan the team is on (Free, Pro, Team, …); null alone. */
    plan: { id: string; name: string } | null;
  };
  /** The plan's feature switches; alone, everything is on. `ownKeys`: own API keys here. */
  features: Record<string, boolean>;
  /** The studio assistant's developer mode may be switched on (ASSISTANT_DEV; platform admins when managed). */
  assistantDev?: boolean;
  /** `managed`: signed in at the Manage-App. `local`: this runtime runs alone (desktop app, own machine). */
  mode: "managed" | "local";
  /** The tenant's balance; null where no credits are involved. */
  credits: number | null;
  /** Where account, members, API keys and credits are managed. */
  manageUrl: string | null;
  /** The account a local runtime is linked to. */
  account: {
    name: string;
    email: string;
    /** The team the account's space belongs to; null while the Manage-App has not answered. */
    team: string | null;
    credits: number | null;
    /** What of the credits ends on a date, the nearest first. */
    expiring: ExpiringCredits[];
    url: string;
    /** The account's cloud: what is published here also runs there. */
    cloudUrl: string;
    signedIn: boolean;
  } | null;
  models: LocalModels | null;
  /** Apple Intelligence on this Mac: offered where the machine can run it, picked once it answers. */
  apple: AppleStatus | null;
  /** The AI clients this runtime can think with — installed or not, and how each is signed in. */
  harnesses: HarnessStatus[];
  /** Installed AI clients whose subscription can answer the studio chat. */
  subscriptions: "claude"[];
  /** A runtime that runs alone walks the person through its setup on first start. */
  setupDone: boolean;
  /** The cloud studio's first visit: the short wizard that names the team and fills the space. */
  onboarding: boolean;
  /** What answers the studio chat. */
  chatEngine: "models" | "claude";
  aiReady: boolean;
  /** Where an admin's own MCP client (Claude Code, Cursor, Codex) connects. */
  mcpUrl: string;
  /**
   * `projects`: how many projects the tenant works with, null for as many as wanted. `build:
   * false`: nothing is made or changed on this runtime; the studio shows what the person's
   * local install published. `create`: this person makes and deletes here (builds, and is no
   * mere member). `members`: the people the plan allows, null for no limit.
   */
  limits: { projects: number | null; build: boolean; create: boolean; members: number | null };
}

/** A part of the account's credits that ends on a date. */
export interface ExpiringCredits {
  kind: "start" | "monthly" | "gift";
  credits: number;
  expiresAt: string;
}

/** Whether the studio deals with several projects at all: with one, there is nothing to switch. */
export function useManyProjects(): boolean {
  const projects = useMe().data?.limits.projects;
  return projects === null || (projects ?? 1) > 1;
}

/** Whether wizards and projects are made and changed on this runtime at all. */
export function useMayBuild(): boolean {
  return useMe().data?.limits.build ?? true;
}

/** Whether this person makes and deletes here: builds at all, and is no mere member of the team. */
export function useMayCreate(): boolean {
  return useMe().data?.limits.create ?? true;
}

/** Whether this person manages the team: its owner or an admin, or alone. */
export function useIsAdmin(): boolean {
  const me = useMe().data;
  return !me || me.mode === "local" || me.tenant.role !== "member";
}

/** The credits a person can spend right now, wherever they come from. */
export function spendableCredits(me: Me): number | null {
  if (me.mode === "managed") {
    return me.credits;
  }
  return me.models?.source === "account" ? (me.account?.credits ?? null) : null;
}

/** Switches the language and keeps it with the person: another browser or device opens in it. */
export function usePickLang() {
  const qc = useQueryClient();
  return (next: Lang) => {
    setLang(next);
    qc.setQueryData<Me | null>(["me"], (me) => (me ? { ...me, lang: next } : me));
    void api.put("/api/studio/lang", { lang: next }).catch(() => undefined);
  };
}

/**
 * Once the person is known, the language they picked anywhere wins over this browser's. A pick
 * this browser kept from before goes to them once, so nobody loses theirs.
 */
export function useAccountLang(me: Me | null | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!me) {
      return;
    }
    if (me.lang) {
      setLang(me.lang);
      return;
    }
    const kept = storedLang();
    if (kept) {
      qc.setQueryData<Me | null>(["me"], (now) => (now ? { ...now, lang: kept } : now));
      void api.put("/api/studio/lang", { lang: kept }).catch(() => undefined);
    }
  }, [me, qc]);
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.get<Me>("/api/studio/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return null;
        }
        throw err;
      }
    },
    staleTime: 30_000,
  });
}

export interface Project {
  id: string;
  name: string;
  brand: {
    name?: string;
    about?: string;
    colors?: BrandColor[];
    colorSections?: ColorSection[];
    gradients?: BrandGradient[];
    patterns?: BrandPattern[];
    colorRules?: BrandRule[];
    logoSections?: LogoSection[];
    assetSections?: AssetSection[];
    fonts?: BrandFont[];
    textStyles?: TextStyle[];
    typeRules?: BrandRule[];
    logoRules?: BrandRule[];
  };
  facts: ProjectFact[];
  mcpServers: { id: string; name: string; url: string; headers?: Record<string, string> }[];
  wizardCount: number;
  /** `local`: sent here by a local install, where it is changed. */
  origin: "local" | null;
  syncedAt: string | null;
  /** Shown here, changed elsewhere: a local install's project, or nothing is built on this runtime. */
  readOnly: boolean;
}

export function useProjects(enabled = true) {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/api/studio/projects"),
    enabled,
  });
}

const KEY = "wz.project";

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The pick, shared by every component that asks: the switcher and the list it switches. */
let picked = readStored();
const listeners = new Set<() => void>();

function pick(next: string) {
  picked = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // per-browser convenience only
  }
  for (const listener of listeners) {
    listener();
  }
}

/** The project the studio is looking at; remembered per browser. */
export function useCurrentProject() {
  const projects = useProjects();
  const id = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => picked,
  );
  const list = projects.data ?? [];
  // A pick that is gone (deleted, another tenant) falls back to the first project.
  const current = list.find((p) => p.id === id) ?? list[0] ?? null;
  return { project: current, projects: list, select: pick, loading: projects.isLoading };
}

export interface WizardSummary {
  id: string;
  projectId: string;
  title: string;
  description: string;
  avatar: string;
  revision: number;
  published: boolean;
  publishedVersion: number | null;
  shareToken: string;
  shareEnabled: boolean;
  dailyRunLimit: number;
  /** How it is offered: the runner its link opens, the ones switched on. Null: steps, chat beside it. */
  runners: { default: string; enabled: string[] } | null;
  /** Its page offers it in the viewer's language, translated on request. */
  translate: boolean;
  stepCount: number;
  updatedAt: string;
  /**
   * In a list: where the wizard stands in the cloud of the account a local install is linked
   * to; null where none is linked or the runtime is managed.
   */
  cloud?: CloudState | null;
}

export interface WizardDetail extends WizardSummary {
  draft: WizardDefinition;
  files: WorkspaceFile[];
  issues: { stepId?: string; message: string }[];
  blank: boolean;
  dirty: boolean;
  /** Shown and run here, changed elsewhere: its project is read-only. */
  readOnly: boolean;
  messages: {
    id: string;
    role: "user" | "assistant";
    content: string;
    changed: boolean;
    source: "studio" | "mcp";
    client: string | null;
  }[];
  mcpServers: { id: string; name: string }[];
  shareUrl: string;
  studioUrl: string;
}

/**
 * What keeps a wizard from running in the cloud as it does at home. `blocking`: no run can
 * finish there. `detail` is the server's own text: a validator's sentence, a model class and why
 * it is missing, or the names of what is missing.
 */
export interface ServerProblem {
  code: "invalid" | "model" | "sandbox" | "mcp" | "connector";
  blocking: boolean;
  steps: { id: string; title: string }[];
  detail: string;
}

/** A local wizard's copy in the cloud of the linked account. */
export interface CloudCopy {
  shareUrl: string;
  /** The copy's ID for the mobile app; a cloud before it knew IDs sent none. */
  code?: string;
  /** The version last sent from here. */
  version: number;
  /** The version runs start on in the cloud; null when none could be published there. */
  publishedVersion: number | null;
  runnable: boolean;
  problems: ServerProblem[];
  syncedAt: string;
}

/** Where a local wizard stands in the cloud: its copy, and why the last try did not arrive. */
export interface CloudState {
  copy: CloudCopy | null;
  /**
   * `reason`: `space_limit`, `signed_out`, `unreachable` or `refused`. `again`: when the runtime
   * tries by itself once more; null where only the person can help.
   */
  error: {
    message: string;
    reason?: string;
    at: string;
    tries: number;
    again: string | null;
  } | null;
}

/** A local wizard in the cloud, as this install knows it; `linked`: an account is linked at all. */
export type CloudAnswer = CloudState & { linked: boolean };

/** Where a local wizard stands in the cloud of the linked account. */
export function useCloud(wizardId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["cloud", wizardId],
    queryFn: () => api.get<CloudAnswer>(`/api/studio/wizards/${wizardId}/cloud`),
    enabled,
  });
}

/** What publishing answers; `cloud` is null where no account is linked or the runtime is managed. */
export interface PublishResult {
  version: number;
  shareUrl: string;
  shareEnabled: boolean;
  cloud: CloudState | null;
}

/** The server's sentence when a write was refused because nothing is changed here; else null. */
export function readOnlyError(err: unknown): string | null {
  return err instanceof ApiError && err.body?.code === "read_only" ? err.message : null;
}

export async function signOut() {
  const res = await fetch(withBase("/api/auth/sign-out"), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const { account } = (await res.json().catch(() => ({}))) as { account?: string | null };
  if (!account) {
    window.location.href = `${STUDIO}/`;
    return;
  }
  // Signed in through the account: that sign-in ends as well, and the account sends the browser
  // back to the studio's start page.
  const form = document.createElement("form");
  form.method = "POST";
  form.action = account;
  const back = document.createElement("input");
  back.type = "hidden";
  back.name = "return";
  back.value = `${window.location.origin}${STUDIO}/`;
  form.append(back);
  document.body.append(form);
  form.submit();
}

/**
 * Sign-in happens at the Manage-App; it sends the person back to `returnTo`. A `wish` (the
 * guest start page's) goes along, so the sign-in page shows what is about to be built.
 */
export function signIn(returnTo = window.location.pathname, wish?: string) {
  const query = new URLSearchParams({ return: returnTo });
  if (wish?.trim()) {
    query.set("wish", wish.trim());
  }
  window.location.href = withBase(`/api/auth/login?${query}`);
}

// What a guest asked to be built on the start page, kept in this browser across the sign-in
// (and the team's first visit) until the new-wizard page has built it.
const WISH_KEY = "wizards.wish";
/** A wish older than this is not built any more: the person has moved on. */
const WISH_DAYS = 1;

export function keepWish(text: string) {
  try {
    localStorage.setItem(WISH_KEY, JSON.stringify({ text, at: Date.now() }));
  } catch {
    // Without storage the wish still travels in the sign-in's way back.
  }
}

/** The wish a guest asked to be built, or null. */
export function pendingWish(): string | null {
  try {
    const kept = JSON.parse(localStorage.getItem(WISH_KEY) ?? "null") as {
      text?: unknown;
      at?: unknown;
    } | null;
    if (
      typeof kept?.text === "string" &&
      typeof kept.at === "number" &&
      Date.now() - kept.at < WISH_DAYS * 86_400_000
    ) {
      return kept.text;
    }
  } catch {
    // Nothing readable is nothing kept.
  }
  return null;
}

export function dropWish() {
  try {
    localStorage.removeItem(WISH_KEY);
  } catch {
    // Nothing to drop.
  }
}

import type { RunTheme } from "@engenty/wizards-shared/run";
import type { Look } from "./look";

/**
 * The portal's calls: its own server's session, and the client contract (`/api/v1/client`)
 * through it. Nothing here decides who sees what: the runtime does, as the signed-in client.
 */

export class CallError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function answer<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    throw new CallError(res.status, body.error ?? res.statusText, body.code);
  }
  return body as T;
}

export interface PageWizard {
  slug: string;
  title: string;
  description: string;
  runUrl: string;
}

export interface Face {
  team: { id: string; name: string; slug: string; lang: string };
  page: {
    title: string;
    headline?: string;
    intro?: string;
    brand: { name: string; logoUrl: string | null; theme: Look };
    wizards: PageWizard[];
  } | null;
  portal: boolean;
}

export interface SessionInfo {
  face: Face | null;
  person: { name: string; email: string; role: string; here: boolean } | null;
}

export const session = () => fetch("/portal/api/session").then((r) => answer<SessionInfo>(r));

export const signOut = () => fetch("/portal/auth/logout", { method: "POST" });

export const signInUrl = (returnTo = location.pathname) =>
  `/portal/auth/login?return=${encodeURIComponent(returnTo)}`;

/** One call of the client contract; `space` for a call about one client space. */
export async function call<T>(name: string, space?: string, input: object = {}): Promise<T> {
  const path = space
    ? `/portal/api/client/spaces/${encodeURIComponent(space)}/${name}`
    : `/portal/api/client/${name}`;
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  return (await answer<{ result: T }>(res)).result;
}

export const fileUrl = (space: string, fileId: string) =>
  `/portal/api/client/spaces/${encodeURIComponent(space)}/files/${encodeURIComponent(fileId)}`;

/** The firm's brand on a client space, as the runtime gives it (`brandView`). */
export interface Brand {
  name: string;
  accent: string | null;
  logoUrl: string | null;
  theme: RunTheme;
}

export interface ClientSpace {
  id: string;
  name: string;
  slug: string;
  firm: { name: string; brand: Brand };
}

export interface Result {
  runId: string;
  wizardId: string;
  title: string;
  status: string;
  mine: boolean;
  sharedAt: string | null;
  updatedAt: string;
}

export interface Wizard {
  id: string;
  slug: string;
  title: string;
  description: string;
}

export interface ForYou {
  waiting: Result[];
  shared: Result[];
  wizards: Wizard[];
}

export interface Chat {
  id: string;
  title: string;
  updatedAt: string;
  last: { name: string; text: string } | null;
  answering: boolean;
}

export interface ChatMessages {
  chat: { id: string; title: string; answering: boolean };
  messages: {
    id: string;
    author: { kind: "person" | "ai"; name: string; me: boolean };
    text: string;
    createdAt: string;
  }[];
}

export interface SpaceFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

/** A run's ticket, as the contract gave it: the run's own routes open with it. */
const tickets = new Map<string, string>();

export const keepTicket = (runId: string, ticket: string) => tickets.set(runId, ticket);

/** Where a run's routes are, through the portal server, with its ticket. */
export const runBase = (runId: string) =>
  `/api/run/${encodeURIComponent(runId)}/${encodeURIComponent(tickets.get(runId) ?? "none")}`;

export async function openRun(space: string, runId: string): Promise<void> {
  if (!tickets.has(runId)) {
    const { ticket } = await call<{ ticket: string }>("run_open", space, { runId });
    keepTicket(runId, ticket);
  }
}

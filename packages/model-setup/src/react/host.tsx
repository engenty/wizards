import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import { type SetupText, type SetupVars, setupText } from "../texts.js";
import type { TerminalEvent } from "../types.js";

/** What the setup's parts need of the app that shows them. Paths are below the setup's routes. */
export interface SetupHostApi {
  lang: "en" | "de";
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<unknown>;
  /** Follows a terminal until its end; the answer stops following. */
  follow(terminal: string, on: (event: TerminalEvent) => void): () => void;
  /** Opens a page in the person's own browser. */
  open(url: string): void;
  /** Something changed: a client was looked at again, a test worked, a key was kept. */
  changed(): unknown;
}

const Host = createContext<SetupHostApi | null>(null);

export function SetupProvider({ host, children }: { host: SetupHostApi; children: ReactNode }) {
  return <Host.Provider value={host}>{children}</Host.Provider>;
}

export function useSetupHost(): SetupHostApi {
  const host = useContext(Host);
  if (!host) {
    throw new Error("The setup's parts need a SetupProvider.");
  }
  return host;
}

/** The setup's words in the host's language. */
export function useText() {
  const { lang } = useSetupHost();
  return useCallback((key: SetupText, vars?: SetupVars) => setupText(lang, key, vars), [lang]);
}

/** A call the person starts: whether it runs, what came of it. A newer call replaces an older one. */
export function useCall<A extends unknown[], T>(call: (...args: A) => Promise<T>) {
  const [state, setState] = useState<{ busy: boolean; data?: T; error?: string }>({ busy: false });
  const latest = useRef(call);
  latest.current = call;
  const round = useRef(0);
  const run = useCallback(async (...args: A): Promise<T | undefined> => {
    const mine = ++round.current;
    setState({ busy: true });
    try {
      const data = await latest.current(...args);
      if (mine === round.current) {
        setState({ busy: false, data });
      }
      return data;
    } catch (err) {
      if (mine === round.current) {
        setState({ busy: false, error: (err as Error).message });
      }
      return undefined;
    }
  }, []);
  const reset = useCallback(() => {
    round.current++;
    setState({ busy: false });
  }, []);
  return { ...state, run, reset };
}

import { createEmulator } from "@executor-js/emulate";

/**
 * A service that keeps state, for tests: `@executor-js/emulate` started for one service, on a
 * port of its own. What a test asks of it is here: a token for a person, the calls it took, a
 * fault to answer with, and a clean slate between tests.
 *
 * Only for tests: `@executor-js/emulate` is a dev dependency of the packages that import this.
 */
export type Emulated = {
  url: string;
  /** A token the service takes as `login`'s, of the kind executor applies as `Bearer …`. */
  token(login: string): Promise<string>;
  /** The operations it was called for, oldest first; `prefix` keeps those that start with it. */
  calls(prefix?: string): Promise<string[]>;
  /** Answers calls matching `match` with `response` from now on, until `reset`. */
  fail(
    match: { method?: string; pathPattern: string },
    response: { status: number; body?: unknown },
  ): Promise<void>;
  /** The seed again, no faults, no calls. */
  reset(): Promise<void>;
  /** Asks it as a person signed in with `token` would. */
  get(path: string, token?: string): Promise<any>;
  close(): Promise<void>;
};

/** A port per test process, so test files that run side by side do not meet. */
const portOf = (base: number) => base + (process.pid % 500);

export async function emulate(
  service: "google",
  options: { seed?: Record<string, unknown>; port?: number } = {},
): Promise<Emulated> {
  const emulator = await createEmulator({
    service,
    port: options.port ?? portOf(4300),
    ...(options.seed ? { seed: { [service]: options.seed } } : {}),
  } as Parameters<typeof createEmulator>[0]);
  const url = emulator.url;
  const json = async (path: string, init?: RequestInit) =>
    (await fetch(url + path, init)).json() as Promise<any>;
  const post = (path: string, body: unknown) =>
    json(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    url,
    token: async (login) =>
      (await post("/_emulate/credentials", { type: "bearer-token", login })).credential.token,
    calls: async (prefix = "") =>
      ((await json("/_emulate/ledger")).entries as { operationId?: string }[])
        .map((entry) => entry.operationId)
        .filter((id): id is string => typeof id === "string" && id.startsWith(prefix))
        .reverse(), // the ledger lists the newest first
    fail: async (match, response) => void (await post("/_emulate/faults", { match, response })),
    reset: async () => {
      emulator.reset();
      await fetch(`${url}/_emulate/ledger`, { method: "DELETE" });
    },
    get: (path, token) =>
      json(path, token ? { headers: { authorization: `Bearer ${token}` } } : undefined),
    close: () => emulator.close(),
  };
}

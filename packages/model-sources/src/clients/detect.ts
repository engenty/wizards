import { type ClientAuth, type EnvSpec, forgetEnv, ProbeUndecided, resolveEnv } from "./env.js";

/** A client as detection needs it: how it signs in, and its version. */
export interface Detectable extends EnvSpec {
  /** Null: not installed. Throws ProbeUndecided when the probe could not finish on a busy machine. */
  version(env: NodeJS.ProcessEnv): Promise<string | null>;
}

/** A client on this computer as it is now. */
export interface ClientStatus {
  /** Null: not installed. */
  version: string | null;
  auth: ClientAuth;
}

/** How long a look at a client holds: it may get installed or signed in meanwhile. */
const FRESH_MS = 60_000;

const detected = new Map<string, { at: number; value: ClientStatus }>();

/**
 * Whether a client is installed and signed in, asked again after a minute. `force` asks now and
 * reads the login shell again: the person may just have signed in or set a key. A probe that
 * could not finish on a busy machine keeps what the last look found.
 */
export async function detectClient(client: Detectable, force = false): Promise<ClientStatus> {
  const hit = detected.get(client.id);
  if (!force && hit && Date.now() - hit.at < FRESH_MS) {
    return hit.value;
  }
  if (force) {
    forgetEnv(client.id);
  }
  let value: ClientStatus = { version: null, auth: "none" };
  try {
    const { env, auth } = await resolveEnv(client);
    const version = await client.version(env);
    if (version) {
      value = { version, auth };
    }
  } catch (err) {
    if (err instanceof ProbeUndecided && hit?.value.version) {
      // The machine is busy (another client is working): the client was there, it still is.
      value = hit.value;
    }
  }
  detected.set(client.id, { at: Date.now(), value });
  return value;
}

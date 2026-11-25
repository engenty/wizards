import { createSandbox, type Sandbox } from "../sandbox/index.js";

/**
 * An outside client's sandbox, where its `run_command` runs commands and the scripts of the
 * space's skills (docs/plans/skills.md). One per key, made on its first command and kept while
 * it is in use, so a file one call writes is there for the next; gone after IDLE_MS without a
 * command, or when the runtime stops.
 */

/** An outside client's sandbox goes after this long without a command. */
export const IDLE_MS = 30 * 60_000;

interface Kept {
  sandbox: Sandbox;
  timer: NodeJS.Timeout;
}

const kept = new Map<string, Kept>();

const drop = (key: string) => {
  const k = kept.get(key);
  if (k) {
    kept.delete(key);
    clearTimeout(k.timer);
    void k.sandbox.destroy().catch(() => undefined);
  }
};

/** The sandbox kept under this key, made on first use; each use keeps it IDLE_MS longer. */
export function outsideClientSandbox(key: string): Sandbox {
  let k = kept.get(key);
  if (k) {
    clearTimeout(k.timer);
  } else {
    k = { sandbox: createSandbox(key), timer: undefined as never };
    kept.set(key, k);
  }
  k.timer = setTimeout(() => drop(key), IDLE_MS).unref();
  return k.sandbox;
}

/** Ends every outside client's sandbox: the runtime stops. */
export async function dropOutsideSandboxes(): Promise<void> {
  const all = [...kept.values()];
  kept.clear();
  await Promise.all(
    all.map((k) => {
      clearTimeout(k.timer);
      return k.sandbox.destroy().catch(() => undefined);
    }),
  );
}

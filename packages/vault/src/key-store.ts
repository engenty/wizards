import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

// Where the 32 bytes of a key come from. A store only loads and creates the key: what it seals
// is the ring's business (seal.ts). Every store keeps the key outside the database it protects.

export interface KeyStore {
  /** What the store is, for a message: "environment", "file", "keychain". */
  readonly kind: string;
  /** The key, or null when the store holds none yet. A key that is there but unusable throws. */
  load(): Promise<Buffer | null>;
  /** Keeps a new key. Absent on a store that can't make one (the environment). */
  create?(key: Buffer): Promise<void>;
}

/**
 * The store's key, made and kept on first use when the store can keep one. A store that holds no
 * key and can't make one throws: a vault never starts without its key.
 */
export async function loadOrCreateKey(store: KeyStore): Promise<Buffer> {
  const found = await store.load();
  if (found) {
    return found;
  }
  if (!store.create) {
    throw new Error(`No key in the ${store.kind}, and it can't keep a new one.`);
  }
  const key = randomBytes(32);
  await store.create(key);
  // Read it back: another process may have kept its own key first.
  const kept = await store.load();
  if (!kept) {
    throw new Error(`The ${store.kind} didn't keep the new key.`);
  }
  return kept;
}

/** 32 bytes as base64, nothing else. */
export function parseKey(text: string): Buffer {
  const trimmed = text.trim();
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32 || key.toString("base64") !== trimmed) {
    throw new Error("A key is exactly 32 bytes, written as base64.");
  }
  return key;
}

/** A key from a setting, such as an environment variable: 32 bytes as base64. */
export function environmentKeyStore(value: string | undefined): KeyStore {
  return {
    kind: "environment",
    async load() {
      return value?.trim() ? parseKey(value) : null;
    },
  };
}

const PRIVATE = 0o077;

/**
 * A key in a file of its own: 32 raw bytes, readable by its owner only. A file others may read
 * is refused, not used. The folder is made private when the store makes it.
 */
export function fileKeyStore(path: string): KeyStore {
  const windows = process.platform === "win32";
  return {
    kind: "file",
    async load() {
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
      if (!windows && (info.mode & PRIVATE) !== 0) {
        throw new Error(`The key file ${path} may be read by others: make it 0600.`);
      }
      const key = await readFile(path);
      if (key.length !== 32) {
        throw new Error(`The key file ${path} doesn't hold a key of 32 bytes.`);
      }
      return key;
    },
    async create(key) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        // "wx": never over a key that is there.
        file = await open(path, "wx", 0o600);
        await file.writeFile(key);
        await file.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return;
        }
        throw error;
      } finally {
        await file?.close();
      }
    },
  };
}

/** Runs `security` with arguments and the given input; what it printed and its exit code. */
export type SecurityRunner = (
  args: readonly string[],
  input?: string,
) => Promise<{ code: number; stdout: string }>;

const runSecurity: SecurityRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.end(input ?? "");
  });

/** `security` answers 44 when the Keychain holds no such item. */
const NOT_FOUND = 44;

/**
 * A key in the macOS Keychain, as a generic password of `service` and `account`, written as
 * base64. A new key goes to `security` on its standard input, never as an argument other
 * processes could list.
 */
export function keychainKeyStore(options: {
  service: string;
  account: string;
  run?: SecurityRunner;
}): KeyStore {
  const run = options.run ?? runSecurity;
  const { service, account } = options;
  if (!options.run && process.platform !== "darwin") {
    throw new Error("The Keychain is on macOS only.");
  }
  if (/["\\\s]/.test(service + account)) {
    throw new Error("A Keychain service or account has no quotes, backslashes or spaces.");
  }
  return {
    kind: "keychain",
    async load() {
      const found = await run(["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (found.code === NOT_FOUND) {
        return null;
      }
      if (found.code !== 0) {
        throw new Error(
          `The Keychain didn't answer for ${service} (security exited ${found.code}).`,
        );
      }
      return parseKey(found.stdout);
    },
    async create(key) {
      // `security -i` reads its commands from the standard input. Without -U it never replaces
      // an item that is there; when one is, the add fails and `loadOrCreateKey` reads that one.
      await run(
        ["-i"],
        `add-generic-password -s "${service}" -a "${account}" -w "${key.toString("base64")}"\n`,
      );
    },
  };
}

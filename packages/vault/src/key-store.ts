import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

// Where the 32 bytes of a key come from. A store only loads and creates the key: what it seals
// is the ring's business (seal.ts). Every store keeps the key outside the database it protects.
// A key is loaded once, when the app starts and before it opens anything sealed, so the stores
// are synchronous: an app can build its ring where it builds its database.

export interface KeyStore {
  /** What the store is, for a message: "environment", "file", "keychain". */
  readonly kind: string;
  /** The key, or null when the store holds none yet. A key that is there but unusable throws. */
  load(): Buffer | null;
  /** Keeps a new key. Absent on a store that can't make one (the environment). */
  create?(key: Buffer): void;
}

/**
 * The store's key, made and kept on first use when the store can keep one. A store that holds no
 * key and can't make one throws: a vault never starts without its key.
 */
export function loadOrCreateKey(store: KeyStore): Buffer {
  const found = store.load();
  if (found) {
    return found;
  }
  if (!store.create) {
    throw new Error(`No key in the ${store.kind}, and it can't keep a new one.`);
  }
  store.create(randomBytes(32));
  // Read it back: another process may have kept its own key first.
  const kept = store.load();
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
    load() {
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
    load() {
      const info = statSync(path, { throwIfNoEntry: false });
      if (!info) {
        return null;
      }
      if (!windows && (info.mode & PRIVATE) !== 0) {
        throw new Error(`The key file ${path} may be read by others: make it 0600.`);
      }
      const key = readFileSync(path);
      if (key.length !== 32) {
        throw new Error(`The key file ${path} doesn't hold a key of 32 bytes.`);
      }
      return key;
    },
    create(key) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      let file: number;
      try {
        // "wx": never over a key that is there.
        file = openSync(path, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return;
        }
        throw error;
      }
      try {
        writeSync(file, key);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
    },
  };
}

/** Runs `security` with arguments and the given input; what it printed and its exit code. */
export type SecurityRunner = (
  args: readonly string[],
  input?: string,
) => { code: number; stdout: string };

const runSecurity: SecurityRunner = (args, input) => {
  const result = spawnSync("/usr/bin/security", args, {
    input: input ?? "",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (result.error) {
    throw result.error;
  }
  return { code: result.status ?? 1, stdout: result.stdout };
};

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
    load() {
      const found = run(["find-generic-password", "-s", service, "-a", account, "-w"]);
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
    create(key) {
      // `security -i` reads its commands from the standard input. Without -U it never replaces
      // an item that is there; when one is, the add fails and `loadOrCreateKey` reads that one.
      run(
        ["-i"],
        `add-generic-password -s "${service}" -a "${account}" -w "${key.toString("base64")}"\n`,
      );
    },
  };
}

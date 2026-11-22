import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  environmentKeyStore,
  fileKeyStore,
  keychainKeyStore,
  loadOrCreateKey,
  parseKey,
  type SecurityRunner,
} from "./key-store.js";

describe("environmentKeyStore", () => {
  it("reads 32 bytes of base64", () => {
    const key = randomBytes(32);
    expect(environmentKeyStore(key.toString("base64")).load()).toEqual(key);
  });

  it("holds nothing when the setting is empty, and can't make a key", () => {
    expect(environmentKeyStore("").load()).toBeNull();
    expect(() => loadOrCreateKey(environmentKeyStore(undefined))).toThrow(/can't keep/);
  });

  it("refuses a key of another length or not base64", () => {
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseKey("not base64 at all, really not")).toThrow(/32 bytes/);
  });
});

describe.skipIf(process.platform === "win32")("fileKeyStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("makes a private key on first use and reads the same one after", () => {
    const path = join(dir, "data", "secrets.key");
    const store = fileKeyStore(path);
    expect(store.load()).toBeNull();
    const key = loadOrCreateKey(store);
    expect(key.length).toBe(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "data")).mode & 0o777).toBe(0o700);
    expect(loadOrCreateKey(fileKeyStore(path))).toEqual(key);
  });

  it("never writes over a key that is there", () => {
    const path = join(dir, "secrets.key");
    const first = randomBytes(32);
    writeFileSync(path, first, { mode: 0o600 });
    fileKeyStore(path).create?.(randomBytes(32));
    expect(readFileSync(path)).toEqual(first);
  });

  it("refuses a file others may read, or one of another length", () => {
    const path = join(dir, "secrets.key");
    writeFileSync(path, randomBytes(32), { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => fileKeyStore(path).load()).toThrow(/0600/);
    writeFileSync(path, randomBytes(31));
    chmodSync(path, 0o600);
    expect(() => fileKeyStore(path).load()).toThrow(/32 bytes/);
  });
});

describe("keychainKeyStore", () => {
  function fakeKeychain() {
    const items = new Map<string, string>();
    const calls: { args: readonly string[]; input?: string }[] = [];
    const run: SecurityRunner = (args, input) => {
      calls.push({ args, input });
      if (args[0] === "find-generic-password") {
        const found = items.get(`${args[2]}/${args[4]}`);
        return found ? { code: 0, stdout: `${found}\n` } : { code: 44, stdout: "" };
      }
      const match = /-s "([^"]+)" -a "([^"]+)" -w "([^"]+)"/.exec(input ?? "");
      if (match && !items.has(`${match[1]}/${match[2]}`)) {
        items.set(`${match[1]}/${match[2]}`, match[3] as string);
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    };
    return { items, calls, run };
  }

  it("makes a key on first use, passing it on the standard input only", () => {
    const keychain = fakeKeychain();
    const store = keychainKeyStore({
      service: "dev.engenty.vault",
      account: "key-v1",
      run: keychain.run,
    });
    const key = loadOrCreateKey(store);
    expect(key.length).toBe(32);
    const add = keychain.calls.find((c) => c.args[0] === "-i");
    expect(add?.args).toEqual(["-i"]);
    expect(add?.input).toContain(key.toString("base64"));
    expect(keychain.calls.every((c) => !c.args.join(" ").includes(key.toString("base64")))).toBe(
      true,
    );
    expect(loadOrCreateKey(store)).toEqual(key);
  });

  it("reads the key another process kept first", () => {
    const keychain = fakeKeychain();
    const theirs = randomBytes(32);
    const store = keychainKeyStore({
      service: "dev.engenty.vault",
      account: "key-v1",
      run: keychain.run,
    });
    keychain.items.set("dev.engenty.vault/key-v1", theirs.toString("base64"));
    expect(loadOrCreateKey(store)).toEqual(theirs);
  });

  it("refuses names that would break the command", () => {
    expect(() =>
      keychainKeyStore({ service: 'a"b', account: "x", run: fakeKeychain().run }),
    ).toThrow(/quotes/);
  });
});

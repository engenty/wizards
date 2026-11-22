import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  it("reads 32 bytes of base64", async () => {
    const key = randomBytes(32);
    expect(await environmentKeyStore(key.toString("base64")).load()).toEqual(key);
  });

  it("holds nothing when the setting is empty, and can't make a key", async () => {
    expect(await environmentKeyStore("").load()).toBeNull();
    await expect(loadOrCreateKey(environmentKeyStore(undefined))).rejects.toThrow(/can't keep/);
  });

  it("refuses a key of another length or not base64", () => {
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseKey("not base64 at all, really not")).toThrow(/32 bytes/);
  });
});

describe.skipIf(process.platform === "win32")("fileKeyStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vault-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("makes a private key on first use and reads the same one after", async () => {
    const path = join(dir, "data", "secrets.key");
    const store = fileKeyStore(path);
    expect(await store.load()).toBeNull();
    const key = await loadOrCreateKey(store);
    expect(key.length).toBe(32);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "data"))).mode & 0o777).toBe(0o700);
    expect(await loadOrCreateKey(fileKeyStore(path))).toEqual(key);
  });

  it("never writes over a key that is there", async () => {
    const path = join(dir, "secrets.key");
    const first = randomBytes(32);
    await writeFile(path, first, { mode: 0o600 });
    await fileKeyStore(path).create?.(randomBytes(32));
    expect(await readFile(path)).toEqual(first);
  });

  it("refuses a file others may read, or one of another length", async () => {
    const path = join(dir, "secrets.key");
    await writeFile(path, randomBytes(32), { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(fileKeyStore(path).load()).rejects.toThrow(/0600/);
    await writeFile(path, randomBytes(31));
    await chmod(path, 0o600);
    await expect(fileKeyStore(path).load()).rejects.toThrow(/32 bytes/);
  });
});

describe("keychainKeyStore", () => {
  function fakeKeychain() {
    const items = new Map<string, string>();
    const calls: { args: readonly string[]; input?: string }[] = [];
    const run: SecurityRunner = async (args, input) => {
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

  it("makes a key on first use, passing it on the standard input only", async () => {
    const keychain = fakeKeychain();
    const store = keychainKeyStore({
      service: "dev.engenty.vault",
      account: "key-v1",
      run: keychain.run,
    });
    const key = await loadOrCreateKey(store);
    expect(key.length).toBe(32);
    const add = keychain.calls.find((c) => c.args[0] === "-i");
    expect(add?.args).toEqual(["-i"]);
    expect(add?.input).toContain(key.toString("base64"));
    expect(keychain.calls.every((c) => !c.args.join(" ").includes(key.toString("base64")))).toBe(
      true,
    );
    expect(await loadOrCreateKey(store)).toEqual(key);
  });

  it("reads the key another process kept first", async () => {
    const keychain = fakeKeychain();
    const theirs = randomBytes(32);
    const store = keychainKeyStore({
      service: "dev.engenty.vault",
      account: "key-v1",
      run: keychain.run,
    });
    keychain.items.set("dev.engenty.vault/key-v1", theirs.toString("base64"));
    expect(await loadOrCreateKey(store)).toEqual(theirs);
  });

  it("refuses names that would break the command", () => {
    expect(() =>
      keychainKeyStore({ service: 'a"b', account: "x", run: fakeKeychain().run }),
    ).toThrow(/quotes/);
  });
});
